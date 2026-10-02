"""DOI-first bibliography and map discovery, using fixed scholarly API responses."""
import threading
import re
from urllib.parse import unquote, urlsplit

from fastapi.testclient import TestClient
import pytest

from papeer.core import citations, discovery, reference_catalog, scholarly_lookup, web_research
from papeer.core.config import Settings
from papeer.core.storage import Library
from papeer.providers import Cancelled
from sidecar import deps
from sidecar.app import app
from sidecar.schemas.discovery import DiscoveryResult
from test_citations import add_paper


def test_doi_bibliography_keeps_pdf_extras_and_provenance(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "The reading paper", '[1] A. Smith, “Learning robust control policies”, 2020. doi:10.1234/shared.\n[2] B. Doe, “PDF exclusive adaptive systems”, 2021.', doi="10.1234/source")
    target = add_paper(lib, 2, "Learning robust control policies", doi="10.1234/shared")
    calls = []

    def request(url, cancel):
        calls.append(url)
        if "semanticscholar" in url:
            if "offset=100" in url:
                return {"data": [{"citedPaper": {"title": "An API exclusive research paper", "year": 2022, "externalIds": {"DOI": "10.1234/api"}}}]}
            return {"data": [{"citedPaper": {"title": "Learning robust control policies", "year": 2020, "externalIds": {"DOI": "10.1234/SHARED"}}}], "next": 100}
        return {"message": {"reference": [{"DOI": "10.1234/shared", "article-title": "Learning robust control policies"},
                                           {"article-title": "Crossref exclusive research paper", "year": "2019"}]}}

    monkeypatch.setattr(scholarly_lookup, "_request", request)
    reference_catalog.refresh(lib, source, threading.Event(), lambda _: None)
    graph = citations.citation_graph(lib)
    refs = [r for r in graph["references"] if r["source"] == source]
    assert len(refs) == 4
    shared = next(r for r in refs if r["target"] == target)
    assert shared["id"] == source + ":0"
    assert shared["page"] == 2 and shared["label"] == "1"
    assert [p["provider"] for p in shared["provenance"]] == ["Semantic Scholar", "Crossref", "PDF"]
    assert "Smith" in shared["raw"]
    assert any(r["title"] == "PDF exclusive adaptive systems" for r in refs)
    api_only = next(r for r in refs if r["doi"] == "10.1234/api")
    assert api_only["page"] is None
    assert api_only["citation_status"] == "unverified"
    assert not any(e["source"] == source and e["target"] == api_only["target"] for e in graph["edges"])
    mapped = discovery.build(lib, source)
    candidate = next(n for n in mapped["nodes"] if n["id"] == api_only["target"])
    assert "references" not in candidate["roles"] and "related" in candidate["roles"]
    assert any(e["source"] == source and e["target"] == candidate["id"] and e["kind"] == "candidate" for e in mapped["edges"])
    assert web_research.reference_entry(lib, source, api_only["id"])["title"] == api_only["title"]
    before = len(calls)
    reference_catalog.refresh(lib, source, threading.Event(), lambda _: None)
    assert len(calls) == before  # Seven-day persisted reuse.
    # Editing the origin DOI must not reuse another paper's bibliography.
    lib.update(source, doi="10.1234/changed")
    assert len([r for r in citations.citation_graph(lib)["references"] if r["source"] == source]) == 2


def test_partial_failure_and_missing_pdf_preserve_api_results(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source", doi="10.1234/source")
    def request(url, cancel):
        if "semanticscholar" in url:
            return {"data": [{"citedPaper": {"title": "API referenced paper", "externalIds": {"DOI": "10.1234/ref"}}}]}
        raise OSError("rate limited")
    monkeypatch.setattr(scholarly_lookup, "_request", request)
    reference_catalog.refresh(lib, source, threading.Event(), lambda _: None)
    (lib.folder(source) / "document.json").unlink()
    graph = citations.citation_graph(lib)
    assert len(graph["references"]) == 1 and len(graph["warnings"]) == 2
    monkeypatch.setattr(scholarly_lookup, "_request", lambda *_: (_ for _ in ()).throw(OSError("offline")))
    reference_catalog.refresh(lib, source, threading.Event(), lambda _: None)
    assert len(citations.citation_graph(lib)["references"]) == 1


def test_null_bibliography_rows_and_optional_fields_keep_valid_references(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source", doi="10.1234/source")
    def request(address, cancel):
        if "semanticscholar" in address:
            return {"data": [None, {"citedPaper": None}, {"citedPaper": {"title": "A valid reference", "authors": None,
                "externalIds": {"DOI": "10.1234/ref"}, "journal": None, "openAccessPdf": None}}]}
        return {"message": {"reference": None}}
    monkeypatch.setattr(scholarly_lookup, "_request", request)
    reference_catalog.refresh(lib, source, threading.Event(), lambda _: None)
    cache = reference_catalog.read(lib, source, "10.1234/source")
    assert cache["checked_at"] and not cache["warnings"]
    assert len(cache["Semantic Scholar"]) == 1 and cache["Crossref"] == []
    assert citations.citation_graph(lib)["references"][0]["doi"] == "10.1234/ref"


def test_null_required_list_keeps_previous_and_partially_fetched_references(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source", doi="10.1234/source")
    discovery.write_cache(lib, source, reference_catalog.CACHE_KEY, {"doi": "10.1234/source",
        "Semantic Scholar": [{"title": "Saved reference", "doi": "10.1234/saved"}]})
    def request(address, cancel):
        if "crossref" in address: return {"message": {"reference": []}}
        if "offset=100" in address: return {"data": None}
        return {"data": [{"citedPaper": {"title": "New reference", "externalIds": {"DOI": "10.1234/new"}}}], "next": 100}
    monkeypatch.setattr(scholarly_lookup, "_request", request)
    reference_catalog.refresh(lib, source, threading.Event(), lambda _: None)
    cache = reference_catalog.read(lib, source, "10.1234/source")
    assert {row["doi"] for row in cache["Semantic Scholar"]} == {"10.1234/saved", "10.1234/new"}
    assert not cache["checked_at"]
    assert "サービスの応答にありません" in cache["warnings"][0]
    assert "NoneType" not in str(cache["warnings"])


def test_merge_rejects_identifier_conflict_and_ambiguous_titles(tmp_path):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source", doi="10.1234/source")
    cache = {"doi": "10.1234/source", "Semantic Scholar": [
        {"title": "Learning robust control policies", "doi": "10.1234/a"},
        {"title": "Learning robust control policies", "doi": "10.1234/b"}]}
    discovery.write_cache(lib, source, reference_catalog.CACHE_KEY, cache)
    pdf = [{"title": "Learning robust control policies", "raw": "Learning robust control policies, 2020.", "year": "2020", "label": "1", "page": 8}]
    refs, _ = reference_catalog.merged(lib, source, "10.1234/source", pdf)
    assert len(refs) == 3
    assert refs[-1]["page"] == 8


@pytest.mark.parametrize("doi", ["", "10.48550/arxiv.2308.11478"])
def test_arxiv_bibliography_is_fetched_and_pdf_locations_are_retained(tmp_path, monkeypatch, doi):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Towards Autonomous Excavation Planning",
        '[1] Jud, D. (2021). HEAP - The autonomous walking excavator. Automation in Construction.')
    lib.update(source, arxiv_id="2308.11478", doi=doi)
    calls = []
    def request(url, cancel):
        calls.append(url)
        return {"data": [{"citedPaper": {"title": "HEAP - The autonomous walking excavator",
            "year": 2021, "externalIds": {"DOI": "10.1016/j.autcon.2021.103783"}}}]}
    monkeypatch.setattr(scholarly_lookup, "_request", request)
    reference_catalog.refresh(lib, source, threading.Event(), lambda _: None)
    assert len(calls) == 1 and "/paper/ARXIV:2308.11478/references?" in calls[0]
    refs = citations.citation_graph(lib)["references"]
    assert len(refs) == 1 and refs[0]["page"] == 2 and refs[0]["label"] == "1"
    assert [p["provider"] for p in refs[0]["provenance"]] == ["Semantic Scholar", "PDF"]
    reference_catalog.refresh(lib, source, threading.Event(), lambda _: None)
    assert len(calls) == 1
    lib.update(source, arxiv_id="2308.99999")
    assert reference_catalog.read(lib, source, doi) == {}
    reference_catalog.refresh(lib, source, threading.Event(), lambda _: None)
    assert "/paper/ARXIV:2308.99999/references?" in calls[-1]


def test_semantic_prose_and_incomplete_corporate_matches_do_not_become_citations(tmp_path):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Reading paper", doi="10.1234/source")
    cache = {"doi": "10.1234/source", "Semantic Scholar": [
        {"title": "A local workspace planner that determines how to move dirt around the excavator"},
        {"title": "U.S. Bureau of Labor Statistics", "doi": "10.1097/00006199-196701610-00048", "first_author": "Taylor"},
        {"title": "Leica Geosystems - Laser Scanners", "publication_year": "2023"},
        {"title": "Valid API exclusive control paper", "publication_year": "2022", "doi": "10.1234/valid"}]}
    discovery.write_cache(lib, source, reference_catalog.CACHE_KEY, cache)
    pdf = [{"title": "Leica Geosystems - Laser Scanners", "raw": "Leica Geosystems (2023). Leica Geosystems - Laser Scanners.",
            "doi": "", "arxiv_id": "", "year": "2023", "label": "", "page": 8}]
    refs, warnings = reference_catalog.merged(lib, source, "10.1234/source", pdf)
    assert len(refs) == 2
    assert {r["title"] for r in refs} == {"Leica Geosystems - Laser Scanners", "Valid API exclusive control paper"}
    leica = next(r for r in refs if r["page"] == 8)
    assert [p["provider"] for p in leica["provenance"]] == ["Semantic Scholar", "PDF"]
    assert "候補2件" in warnings[0]


def test_external_topic_candidates_outrank_generic_shared_foundations(tmp_path):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Autonomous excavation planning", doi="10.1234/source")
    works = [work(1, "Autonomous excavation planning", "10.1234/source", [2, 3]),
             work(2, "Coverage path planning fundamentals"), work(3, "Cellular decomposition"),
             work(4, "Multi-AUV multi-region coverage path planner", refs=[2, 3]),
             work(5, "Autonomous excavation planning with soil-adaptive control", refs=[2])]
    cache = {"nodes": [discovery.semantic_graph.normalize(w) for w in works]}
    data = discovery.build(lib, source, cache=cache)
    orange = next(n for n in data["nodes"] if n["external_id"].endswith(sid(4)))
    excavation = next(n for n in data["nodes"] if n["external_id"].endswith(sid(5)))
    assert "共通の参考文献が2件" in orange["reasons"]
    assert "タイトル・抄録の語句が近い" in excavation["reasons"]
    assert excavation["score"] > orange["score"]
    assert not any(e["source"] == source and e["target"] == orange["id"] for e in data["edges"])


def sid(number):
    return f"{number:040x}"


def url(number):
    return "https://www.semanticscholar.org/paper/" + sid(number)


def work(number, title, doi="", refs=(), related=(), year=2020):
    return {"paperId": sid(number), "title": title, "externalIds": {"DOI": doi}, "year": year,
            "references": [{"paperId": sid(i)} for i in refs], "referenceCount": len(set(refs)),
            "_related": [sid(i) for i in related], "citationCount": 42}


def graph_api(monkeypatch, works, *, bibliography=(), queries=None, fail_ids=(), cancel=None):
    """Native Semantic Scholar GET/POST responses; fail any other graph host."""
    queries = queries if queries is not None else []
    def find(identifier):
        return next((w for w in works if w["paperId"] == identifier or
                     identifier == "DOI:" + w["externalIds"].get("DOI", "")), None)
    def post(address, event, body):
        assert address.startswith("https://api.semanticscholar.org/graph/v1/paper/batch?")
        queries.append("batch:" + "|".join(str(int(i, 16)) if re.fullmatch(r"[0-9a-f]{40}", i) else i for i in body["ids"]))
        if any(i in fail_ids for i in body["ids"]):
            if cancel is not None: cancel.set()
            else: raise OSError("rate limit while expanding references")
        return [find(i) for i in body["ids"]]
    def request(address, event):
        assert "openalex" not in address
        if "api.crossref.org" in address: return {"message": {"reference": []}}
        assert "api.semanticscholar.org" in address
        path = unquote(urlsplit(address).path)
        if path.startswith("/recommendations/"):
            seed = find(path.rsplit("/", 1)[-1])
            return {"recommendedPapers": [{k: v for k, v in w.items() if k != "references"}
                for i in (seed or {}).get("_related", []) if (w := find(i))]}
        if path.endswith("/references"):
            return {"data": [{"citedPaper": w} for w in bibliography]}
        if path.endswith("/citations"):
            identity = path.split("/")[-2]
            queries.append("cites:" + str(int(identity, 16)))
            return {"data": [{"citingPaper": w} for w in works
                if any(r["paperId"] == identity for r in w["references"])]}
        if path.endswith("/search"): return {"data": []}
        return find(path.removeprefix("/graph/v1/paper/")) or {}
    monkeypatch.setattr(scholarly_lookup, "_request", request)
    monkeypatch.setattr(scholarly_lookup, "_post_request", post)
    return queries


def test_map_fetch_fuses_relations_without_inventing_citations(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Modern research origin", doi="10.1234/source")
    seed = work(1, "Modern research origin", "10.1234/source", [3], [2])
    related = work(2, "Different external neighbor", refs=[3])
    prior = work(3, "Historical foundations", year=1990)
    following = work(4, "Future developments", refs=[1, 2, 2], year=2025)
    requested = graph_api(monkeypatch, [seed, related, prior, following])
    result = discovery.discover(lib, source, source, threading.Event(), lambda _: None)
    DiscoveryResult.model_validate(result)
    assert not result["stale"]
    assert len([n for n in result["nodes"] if n["doi"] == "10.1234/source"]) == 1
    ancestor = next(n for n in result["nodes"] if n["id"].endswith(sid(3)))
    assert ancestor["prior_count"] == 2 and set(ancestor["roles"]) == {"references", "prior"}
    descendant = next(n for n in result["nodes"] if n["id"].endswith(sid(4)))
    assert descendant["following_count"] == 2 and "following" in descendant["roles"]
    assert any(e["kind"] == "citation" and e["source"].endswith(sid(2)) and e["target"].endswith(sid(3)) for e in result["edges"])
    assert not any(e["source"] == source and e["target"].endswith(sid(2)) for e in result["edges"])
    assert not any(e["kind"] == "citation" and e["source"] == source and e["target"].endswith(sid(2)) for e in result["edges"])
    assert requested.count("cites:1") == 1  # Fetch origin citations separately and only once.
    assert "cites:2" in requested and "cites:3" in requested
    selected = discovery.prepare_record(lib, source, source, url(2))
    assert selected["sources"] and selected["title"] == related["title"]
    assert discovery.build(lib, source, url(2))["origin"] == url(2)
    # Importing a discovered candidate reuses its selected identity, even without new metadata.
    imported = add_paper(lib, 2, "The manually imported PDF")
    selected["paper_id"] = imported
    web_research.save_record(lib, source, selected)
    assert discovery.build(lib, source, source)["nodes"]
    rebuilt = discovery.build(lib, source, source)
    assert any(n["id"] == imported and "related" in n["roles"] for n in rebuilt["nodes"])
    assert discovery.build(lib, source, url(2))["origin"] == imported


def test_vocabulary_similarity_and_unique_prior_counts(tmp_path):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Neural adaptive vibration damping control", '[1] A. Smith, Shared foundation text, 1990. doi:10.1234/base.\n[2] A. Smith, Shared foundation text, 1990. doi:10.1234/base.')
    close = add_paper(lib, 2, "Adaptive vibration damping control policies")
    result = discovery.build(lib, source)
    node = next(n for n in result["nodes"] if n["id"] == close)
    assert "related" in node["roles"] and "タイトル・抄録の語句が近い" in node["reasons"]
    assert not any("prior" in n["roles"] for n in result["nodes"])
    assert citations.citation_graph(lib)["edges"]


def test_cancel_and_unidentified_origin_leave_local_results(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Unidentified research origin")
    cancel = threading.Event(); cancel.set()
    monkeypatch.setattr(scholarly_lookup, "_request", lambda *_: pytest.fail("Cancelled jobs must not query APIs"))
    with pytest.raises(Cancelled):
        discovery.discover(lib, source, source, cancel, lambda _: None)
    monkeypatch.setattr(scholarly_lookup, "_request", lambda *_: {"results": []})
    result = discovery.discover(lib, source, source, threading.Event(), lambda _: None)
    assert result["origin"] == source and result["warnings"] and result["stale"]


def test_discovery_api_auth_schema_and_disabled_setting(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source")
    monkeypatch.setattr(deps, "get_library", lambda: lib)
    monkeypatch.setattr(deps, "get_settings", lambda: Settings(paper_discovery_enabled=False))
    monkeypatch.setenv("PAPEER_TOKEN", "test-token")
    monkeypatch.delenv("PAPEER_DEV_NO_AUTH", raising=False)
    client = TestClient(app)
    assert client.get(f"/api/papers/{source}/discovery").status_code == 401
    headers = {"Authorization": "Bearer test-token"}
    response = client.get(f"/api/papers/{source}/discovery", headers=headers)
    assert response.status_code == 200
    DiscoveryResult.model_validate(response.json())
    assert client.post(f"/api/papers/{source}/discovery", headers=headers, json={}).status_code == 400


def test_discovery_job_is_unique_and_does_not_block_read_actions(tmp_path):
    from sidecar.jobs import ConcurrencyConflict, JobManager
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source")
    manager = JobManager()
    release = threading.Event()
    def blocked(result):
        def action(cancel, progress, ready):
            release.wait(5)
            return result
        return action
    try:
        manager.submit_job("paper-discovery", blocked(discovery.build(lib, source)), source)
        with pytest.raises(ConcurrencyConflict):
            manager.submit_job("paper-discovery", blocked(discovery.build(lib, source)), source)
        manager.submit_job("article", blocked({"content": "summary"}), source)
        record = web_research.normalized_record({}, "Unknown reference", "a" * 32)
        manager.submit_job("reference-research", blocked(record), source)
        with pytest.raises(ConcurrencyConflict):
            with manager.idle("Cannot delete a discovery origin", source):
                pytest.fail("Destructive operations must wait")
        with pytest.raises(ConcurrencyConflict):
            manager.submit_job("backup", blocked({}), None)
    finally:
        release.set()
        assert manager.wait_idle(5)
        manager.close()


def test_expired_bibliography_shows_saved_results_while_refreshing(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source", doi="10.1234/source")
    discovery.write_cache(lib, source, reference_catalog.CACHE_KEY, {"doi": "10.1234/source", "checked_at": "2020-01-01T00:00:00+00:00",
        "Semantic Scholar": [{"title": "Saved reference", "doi": "10.1234/ref"}]})
    assert len(citations.citation_graph(lib)["references"]) == 1
    calls = []
    monkeypatch.setattr(scholarly_lookup, "_request", lambda url, cancel: calls.append(url) or {"data": [], "message": {}})
    reference_catalog.refresh(lib, source, threading.Event(), lambda _: None)
    assert len(calls) == 2
    assert not citations.citation_graph(lib)["references"]


def test_discovery_finished_event_and_doi_changes_refresh_the_map(tmp_path, monkeypatch):
    from sidecar.jobs import JobManager
    from sidecar.job_types import JobFinishedEvent
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source", doi="10.1234/source")
    cache = {"nodes": [], "checked_at": "2099-01-01T00:00:00+00:00", "origin_identity": "10.1234/source", "version": discovery.CACHE_VERSION}
    discovery.write_cache(lib, source, source, cache)
    result = discovery.build(lib, source)
    assert not result["stale"]
    manager = JobManager()
    events = []
    monkeypatch.setattr(manager, "broadcast", events.append)
    try:
        job = manager.submit_job("paper-discovery", lambda *_: result, source)
        assert manager.wait_idle(5)
        assert job.status == "succeeded"
        assert isinstance(events[-1], JobFinishedEvent)
        assert events[-1].result.model_dump()["origin"] == source
    finally:
        manager.close()
    lib.update(source, doi="10.1234/new-origin")
    assert discovery.build(lib, source)["stale"]


def test_two_hop_shared_citations_outrank_recommendations_and_keep_real_paths(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Reading modern developments", doi="10.1234/origin")
    registered = add_paper(lib, 2, "Shared historical foundation", doi="10.1234/base")
    works = [work(1, "Reading modern developments", "10.1234/origin", [2, 3], [9]),
             work(2, "First direct bibliography work", refs=[4, 4, 5, 7]),
             work(3, "Second direct bibliography work", refs=[4, 5]),
             work(4, "Shared historical foundation", "10.1234/base", year=1990),
             work(5, "Another shared foundation", year=1995),
             work(7, "A single branch only", year=1998),
             work(9, "Topic-only recommendation", year=2025),
             work(6, "Later research citing bibliography", refs=[2, 3, 3], year=2026)]
    queries = graph_api(monkeypatch, works)
    result = discovery.discover(lib, source, source, threading.Event(), lambda _: None)
    DiscoveryResult.model_validate(result)
    base = next(n for n in result["nodes"] if n["id"] == registered)
    topic = next(n for n in result["nodes"] if n["id"].endswith(sid(9)))
    assert base["score"] > topic["score"]
    assert set(base["roles"]) == {"related", "prior"}
    assert "直接の参考文献のうち2件が引用" in base["reasons"]
    assert base["prior_count"] == 2  # The repeated W4 entry contributes only once.
    assert len([n for n in result["nodes"] if n["doi"] == "10.1234/base"]) == 1
    assert {e["source"] for e in result["edges"] if e["target"] == registered} == {url(2), url(3)}
    assert not any(e["source"] == source and e["target"] == registered for e in result["edges"])
    assert not any(n["id"].endswith(sid(7)) for n in result["nodes"])
    assert queries.index("batch:2|3") < queries.index("batch:4|5")
    assert "related" in next(n for n in discovery.build(lib, source)["nodes"] if n["id"] == registered)["roles"]
    later = next(n for n in result["nodes"] if n["id"].endswith(sid(6)))
    assert later["following_count"] == 2
    assert set(e["target"] for e in result["edges"] if e["source"] == later["id"]) == {url(2), url(3)}


def test_second_hop_uses_doi_bibliography_missing_from_graph_seed(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Origin with a partial catalog", doi="10.1234/origin")
    root = work(1, "Origin with a partial catalog", "10.1234/origin", [2])
    first = work(2, "First reference in multiple catalogs", "10.1234/first", refs=[4])
    extra = work(3, "Reference only in DOI bibliography", "10.1234/extra", refs=[4])
    base = work(4, "A commonly cited foundation")
    graph_api(monkeypatch, [root, first, extra, base], bibliography=[extra])
    result = discovery.discover(lib, source, source, threading.Event(), lambda _: None)
    ancestor = next(n for n in result["nodes"] if n["id"] == url(4))
    assert "直接の参考文献のうち2件が引用" in ancestor["reasons"]
    assert sum("references" in n["roles"] for n in result["nodes"]) == 2


def test_old_map_cache_refreshes_and_second_hop_failure_keeps_first_hop(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Origin", doi="10.1234/origin")
    discovery.write_cache(lib, source, source, {"nodes": [], "checked_at": "2099-01-01T00:00:00+00:00", "origin_identity": "10.1234/origin"})
    assert discovery.build(lib, source)["stale"]
    root = work(1, "Origin", "10.1234/origin", [2, 3])
    direct = [work(2, "First actual reference", refs=[4]), work(3, "Second actual reference", refs=[4])]
    graph_api(monkeypatch, [root, *direct], fail_ids=[sid(4)])
    result = discovery.discover(lib, source, source, threading.Event(), lambda _: None)
    assert result["stale"] and result["warnings"]
    assert sum("references" in n["roles"] for n in result["nodes"]) == 2
    assert len(result["edges"]) == 2


@pytest.mark.parametrize("cancel_shared", [False, True])
def test_second_hop_budget_and_cancellation_do_not_repeat_or_discard_first_hop(tmp_path, monkeypatch, cancel_shared):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Origin", doi="10.1234/origin")
    works = [work(1, "Origin", "10.1234/origin", [2, 3]), work(2, "First bibliography", refs=[4, 5]),
             work(3, "Second bibliography", refs=[4, 5]), work(4, "First shared ancestor"), work(5, "Second shared ancestor")]
    cancel = threading.Event()
    monkeypatch.setattr(discovery, "MAX_SHARED", 1)
    queries = graph_api(monkeypatch, works, fail_ids=[sid(4)] if cancel_shared else [],
                        cancel=cancel if cancel_shared else None)
    if cancel_shared:
        with pytest.raises(Cancelled): discovery.discover(lib, source, source, cancel, lambda _: None)
    else:
        result = discovery.discover(lib, source, source, cancel, lambda _: None)
        assert not result["stale"] and result["warnings"]
        assert any(n["id"].endswith(sid(4)) for n in result["nodes"])
        assert not any(n["id"].endswith(sid(5)) for n in result["nodes"])
    assert queries.count("batch:2|3") == 1
    assert queries.count("batch:4") == 1
    saved = discovery.build(lib, source)
    assert sum("references" in n["roles"] for n in saved["nodes"]) == 2
    if cancel_shared: assert saved["stale"]
