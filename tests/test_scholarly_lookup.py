"""Database priority, conservative identity checks and shared API limits."""
import io
import threading
from urllib.error import HTTPError

import pytest

from papeer.core import scholarly_lookup as lookup
from papeer.providers import Cancelled


def semantic(**changes):
    return {"paperId": "a" * 40, "title": "Robust control of systems", "authors": [{"name": "Alice Smith"}],
            "year": 2020, "venue": "Control Journal", "externalIds": {"DOI": "10.1234/abc"},
            "abstract": "We study robust control.", "url": "https://www.semanticscholar.org/paper/" + "a" * 40,
            "openAccessPdf": {"url": "https://repository.example/paper.pdf"}, **changes}


def crossref(**changes):
    return {"title": ["Robust control of systems"], "DOI": "10.1234/abc",
            "author": [{"given": "Alice", "family": "Smith"}], "issued": {"date-parts": [[2020]]},
            "container-title": ["Crossref Journal"], "abstract": "<jats:p>Verified <jats:italic>abstract</jats:italic>.</jats:p>",
            "link": [{"URL": "https://repository.example/crossref.pdf", "content-type": "application/pdf"}], **changes}


KNOWN = {"title": "Robust control of systems", "doi": "10.1234/abc", "raw": 'A. Smith, "Robust control of systems", 2020.'}


def test_complete_semantic_record_skips_crossref(monkeypatch):
    calls = []

    def request(url, cancel):
        calls.append(url)
        return semantic()

    monkeypatch.setattr(lookup, "_request", request)
    record = lookup.lookup(KNOWN, threading.Event())
    assert len(calls) == 1 and "paper/DOI:10.1234%2Fabc" in calls[0]
    assert record["venue"] == "Control Journal" and not lookup.missing_fields(record)
    assert record["sources"][0]["title"] == "Semantic Scholar"


def test_crossref_fills_missing_fields_without_overwriting_semantic(monkeypatch):
    calls = []

    def request(url, cancel):
        calls.append(url)
        return semantic(abstract=None, venue="", journal={}) if "semanticscholar" in url else {"message": crossref()}

    monkeypatch.setattr(lookup, "_request", request)
    record = lookup.lookup(KNOWN, threading.Event())
    assert len(calls) == 2
    assert record["venue"] == "Crossref Journal" and record["abstract"] == "Verified abstract."
    assert record["first_author"] == "Alice Smith"
    assert [s["title"] for s in record["sources"]] == ["Semantic Scholar", "Crossref"]


@pytest.mark.parametrize("failure", ["missing", "limited"])
def test_crossref_runs_after_semantic_miss_or_limit(monkeypatch, failure):
    def request(url, cancel):
        if "semanticscholar" in url:
            if failure == "limited":
                raise HTTPError(url, 429, "Limited", {}, io.BytesIO())
            return {}
        return {"message": crossref()}

    monkeypatch.setattr(lookup, "_request", request)
    record = lookup.lookup(KNOWN, threading.Event())
    assert record["sources"][0]["title"] == "Crossref"
    assert bool(record["warnings"]) == (failure == "limited")


def test_title_search_checks_year_author_and_ambiguity(monkeypatch):
    known = {**KNOWN, "doi": "", "year": "2020"}
    values = [semantic(), semantic(externalIds={"DOI": "10.1234/other"}, paperId="b" * 40)]

    def request(url, cancel):
        return {"data": values} if "semanticscholar" in url else {"message": {"items": []}}

    monkeypatch.setattr(lookup, "_request", request)
    assert not lookup.lookup(known, threading.Event())["sources"]
    for item in (semantic(year=2021), semantic(authors=[{"name": "Bob Jones"}]),
                 semantic(title="Robust control of a different system")):
        values[:] = [item]
        assert not lookup.lookup(known, threading.Event())["sources"]
    values[:] = [semantic()]
    assert lookup.lookup(known, threading.Event())["doi"] == "10.1234/abc"


def test_crossref_conflicting_identifier_is_not_merged(monkeypatch):
    monkeypatch.setattr(lookup, "_request", lambda url, cancel: semantic(abstract=None) if "semanticscholar" in url
                        else {"message": crossref(DOI="10.1234/other")})
    record = lookup.lookup(KNOWN, threading.Event())
    assert record["abstract"] == "" and len(record["sources"]) == 1


def test_exact_journal_title_is_preferred_to_similar_conference_version(monkeypatch):
    known = {**KNOWN, "doi": "", "year": "2020"}
    items = [semantic(title="A robust control of systems", externalIds={"DOI": "10.1234/conf"}), semantic()]
    monkeypatch.setattr(lookup, "_request", lambda url, cancel: {"data": items})
    assert lookup.lookup(known, threading.Event())["doi"] == "10.1234/abc"


def test_cancel_prevents_next_service(monkeypatch):
    cancel = threading.Event()
    calls = []

    def request(url, event):
        calls.append(url)
        event.set()
        return {}

    monkeypatch.setattr(lookup, "_request", request)
    with pytest.raises(Cancelled):
        lookup.lookup(KNOWN, cancel)
    assert len(calls) == 1


def test_rate_limit_cooldown_prevents_five_jobs_repeating_requests(monkeypatch):
    monkeypatch.setattr(lookup, "_COOLDOWN", {})
    monkeypatch.setattr(lookup, "_NEXT", {})
    monkeypatch.setattr(lookup, "_CACHE", {})
    calls = []

    class Opener:
        def open(self, request, timeout):
            calls.append(request.full_url)
            raise HTTPError(request.full_url, 429, "Limited", {"Retry-After": "120"}, io.BytesIO())

    monkeypatch.setattr(lookup, "build_opener", lambda *args: Opener())
    with pytest.raises(HTTPError):
        lookup._request("https://api.semanticscholar.org/graph/v1/paper/first", threading.Event())
    for index in range(4):
        with pytest.raises(ValueError, match="利用制限"):
            lookup._request(f"https://api.semanticscholar.org/graph/v1/paper/{index}", threading.Event())
    assert len(calls) == 1
