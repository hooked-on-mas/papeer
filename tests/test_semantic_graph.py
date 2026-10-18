"""Semantic Scholar graph responses, bounds, migration and credential isolation."""
import io
import json
import threading
from urllib.parse import parse_qs, urlsplit

import pytest

from papeer.core import discovery, semantic_graph, scholarly_lookup as lookup
from papeer.core.storage import Library
from papeer.providers import Cancelled
from test_citations import add_paper
from test_discovery import graph_api, sid, url, work


def test_batch_handles_nulls_and_rejects_identifier_conflicts(monkeypatch):
    calls = []
    def post(address, cancel, body):
        calls.append(body)
        return [None, work(2, "Wrong record", "10.1234/wrong"), work(3, "Correct record", "10.1234/right")]
    monkeypatch.setattr(lookup, "_post_request", post)
    result = list(semantic_graph.works_by_doi(["10.1234/missing", "10.1234/expected", "10.1234/right"], threading.Event()))
    assert [n["id"] for n in result[0]] == [url(3)]
    assert calls[0]["ids"] == ["DOI:10.1234/missing", "DOI:10.1234/expected", "DOI:10.1234/right"]


def test_batch_sizes_bounds_and_cancel_prevent_more_requests(monkeypatch):
    calls = []
    event = threading.Event()
    def post(address, cancel, body):
        calls.append(body["ids"])
        return [work(int(i, 16), "A bounded graph record") for i in body["ids"]]
    monkeypatch.setattr(lookup, "_post_request", post)
    iterator = semantic_graph.works([url(i) for i in range(1, 25)], event)
    assert len(next(iterator)) == 10
    event.set()
    with pytest.raises(Cancelled): next(iterator)
    assert len(calls) == 1
    record = work(1, "Large bibliography", refs=range(2, 1200))
    node = semantic_graph.normalize(record)
    assert len(node["referenced_works"]) == 1000 and node["references_truncated"]


def test_citation_paging_keeps_only_evidenced_edges_and_stops_at_cap(monkeypatch):
    calls = []
    def request(address, cancel):
        params = parse_qs(urlsplit(address).query)
        offset = int(params["offset"][0]); calls.append(offset)
        return {"next": offset + 100, "data": [{"citingPaper": work(4, "Following research", refs=[8])},
                                                {"citingPaper": None}]}
    monkeypatch.setattr(lookup, "_request", request)
    batches = list(semantic_graph.citing([url(1), url(1)], threading.Event()))
    assert calls == [0, 100]
    assert all(n["referenced_works"] == [url(1)] for batch in batches for n in batch)


@pytest.mark.parametrize("field,fetch", [
    ("data", lambda: list(semantic_graph.citing([url(1)], threading.Event()))),
    ("recommendedPapers", lambda: list(semantic_graph.recommendations(url(1), threading.Event()))),
    ("data", lambda: semantic_graph.resolve({"id": "local", "title": "Search without DOI"}, threading.Event())),
])
def test_null_graph_lists_report_incomplete_response_without_iteration_error(monkeypatch, field, fetch):
    monkeypatch.setattr(lookup, "_request", lambda *_: {field: None})
    with pytest.raises(ValueError, match="サービスの応答にありません"): fetch()


def test_resolve_checks_title_year_author_and_uses_arxiv_id(monkeypatch):
    candidate = work(1, "A uniquely identified research paper", "", year=2020)
    candidate.update(authors=[{"name": "Alice Smith"}], externalIds={"ArXiv": "2308.11478"})
    calls = []
    monkeypatch.setattr(lookup, "_request", lambda address, _: calls.append(address) or candidate)
    known = dict(id="local", title=candidate["title"], doi="10.48550/arxiv.2308.11478", arxiv_id="2308.11478")
    assert semantic_graph.resolve(known, threading.Event())["id"] == url(1)
    assert "/ARXIV:2308.11478?" in calls[0]
    monkeypatch.setattr(lookup, "_request", lambda *_: {"data": [candidate]})
    assert semantic_graph.resolve(dict(id="local", title=candidate["title"], first_author="Bob Jones"), threading.Event()) is None
    assert semantic_graph.resolve(dict(id="local", title=candidate["title"], year="2021"), threading.Event()) is None


def test_optional_recommendation_failure_still_fetches_citing_papers(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Reading research", doi="10.1234/origin")
    graph_api(monkeypatch, [work(1, "Reading research", "10.1234/origin"), work(2, "Later research", refs=[1])])
    request = lookup._request
    def without_recommendations(address, cancel):
        if "/recommendations/" in address: raise OSError("unavailable")
        return request(address, cancel)
    monkeypatch.setattr(lookup, "_request", without_recommendations)
    result = discovery.discover(lib, source, source, threading.Event(), lambda _: None)
    assert any("推薦" in warning for warning in result["warnings"])
    assert "incoming" in next(n for n in result["nodes"] if n["id"] == url(2))["roles"]


def test_legacy_external_origin_remains_usable_after_provider_switch(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Reading research")
    old_id = "https://openalex.org/W123"
    legacy = dict(id=old_id, title="Former external origin", doi="10.1234/origin", year="2020", url=old_id,
                  referenced_works=[], related_works=[], external_citations=42)
    discovery.write_cache(lib, source, source, {"nodes": [legacy]})
    selected = discovery.prepare_record(lib, source, source, old_id)
    assert selected["sources"][0]["title"] == "OpenAlex"
    graph_api(monkeypatch, [work(1, legacy["title"], legacy["doi"], refs=[2]), work(2, "A cited foundation")])
    result = discovery.discover(lib, source, old_id, threading.Event(), lambda _: None)
    assert result["origin"] == url(1)
    assert discovery.build(lib, source, old_id)["origin"] == url(1)
    assert all("openalex.org" not in n["id"] for n in result["nodes"])
    assert discovery.prepare_record(lib, source, old_id, url(2))["sources"][0]["title"] == "Semantic Scholar"


def test_unverified_reference_is_not_promoted_by_same_provider_graph(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Reading research", '[1] A. Smith, Confirmed control foundation, 2020. doi:10.1234/confirmed.', doi="10.1234/origin")
    works = [work(1, "Reading research", "10.1234/origin", refs=[2, 3]),
             work(2, "Confirmed control foundation", "10.1234/confirmed"),
             work(3, "Unconfirmed control foundation", "10.1234/unconfirmed")]
    graph_api(monkeypatch, works, bibliography=works[1:])
    result = discovery.discover(lib, source, source, threading.Event(), lambda _: None)
    candidate = next(n for n in result["nodes"] if n["doi"] == "10.1234/unconfirmed")
    assert "references" not in candidate["roles"]
    assert not any(e["source"] == source and e["target"] == candidate["id"] and e["kind"] == "citation" for e in result["edges"])


def test_transport_scopes_key_and_cache_to_host_body_and_credentials(monkeypatch):
    monkeypatch.setattr(lookup, "_NEXT", {})
    monkeypatch.setattr(lookup, "_COOLDOWN", {})
    monkeypatch.setattr(lookup, "_CACHE", {})
    monkeypatch.setattr(lookup, "_SEMANTIC_KEY", "test-key")
    calls = []
    class Event:
        def wait(self, delay): pass
        def is_set(self): return False
    class Opener:
        def open(self, request, timeout):
            calls.append(request)
            return io.BytesIO(b'[]' if request.data else b'{}')
    monkeypatch.setattr(lookup, "build_opener", lambda *_: Opener())
    address = semantic_graph.BASE + "batch?fields=title"
    for ids in ([sid(1)], [sid(1)], [sid(2)]): lookup._post_request(address, Event(), {"ids": ids})
    assert len(calls) == 2
    assert calls[0].get_header("X-api-key") == "test-key" and calls[0].get_method() == "POST"
    assert json.loads(calls[1].data)["ids"] == [sid(2)]
    lookup.set_semantic_api_key("new-key")
    lookup._post_request(address, Event(), {"ids": [sid(1)]})
    assert len(calls) == 3
    lookup._request("https://api.crossref.org/works/10.1234/test", Event())
    assert not calls[-1].get_header("X-api-key")
    with pytest.raises(ValueError): lookup._request("https://api.openalex.org/works", Event())
    with pytest.raises(ValueError): lookup.set_semantic_api_key("bad\nheader")


def test_semantic_key_from_environment_is_optional_and_can_be_cleared(monkeypatch):
    monkeypatch.setattr(lookup, "_SEMANTIC_KEY", None)
    monkeypatch.setenv("PAPEER_SEMANTIC_SCHOLAR_API_KEY", "launch-key")
    assert lookup.semantic_api_key() == "launch-key"
    lookup.set_semantic_api_key("")
    assert lookup.semantic_api_key() == ""


def test_edited_library_identifier_overrides_saved_semantic_identity(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Reading research", doi="10.1234/old")
    old = work(1, "Reading research", "10.1234/old")
    graph_api(monkeypatch, [old])
    discovery.discover(lib, source, source, threading.Event(), lambda _: None)
    lib.update(source, doi="10.1234/new")
    graph_api(monkeypatch, [old, work(2, "Reading research", "10.1234/new")])
    result = discovery.discover(lib, source, source, threading.Event(), lambda _: None)
    current = next(n for n in result["nodes"] if n["id"] == source)
    assert current["external_id"] == url(2) and current["doi"] == "10.1234/new"
    assert not result["stale"]
