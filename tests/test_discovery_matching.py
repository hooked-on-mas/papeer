"""Speedups must preserve the original conservative identity and title decisions."""
from difflib import SequenceMatcher
import random
import threading

import pytest

from papeer.core import citations, discovery, scholarly_lookup
from papeer.core.storage import Library
from test_citations import add_paper
from test_discovery import work, graph_api


def original_titles_match(title, other):
    title, other = scholarly_lookup._normal(title), scholarly_lookup._normal(other)
    return bool(title and other and (title == other or (len(title) >= 20 and SequenceMatcher(None, title, other).ratio() >= .95)))


def original_match(known, nodes):
    exact, titles = [], []
    for node in nodes:
        if any(known.get(k) and node.get(k) and known[k].casefold() != node[k].casefold() for k in ("doi", "arxiv_id")): continue
        if known["id"] == node["id"] or known["id"] == node.get("external_id") or any(
                known.get(k) and node.get(k) and known[k].casefold() == node[k].casefold() for k in ("doi", "arxiv_id")):
            exact.append(node["id"])
        elif len(citations.normalized(known["title"])) >= 20 and original_titles_match(known["title"], node["title"]):
            if known.get("year") and node.get("year") and known["year"] != node["year"]: continue
            if known.get("first_author") and node.get("first_author") and (
                    known["first_author"].casefold().split()[-1] != node["first_author"].casefold().split()[-1]): continue
            titles.append(node["id"])
    found = list(dict.fromkeys(exact or titles))
    return found[0] if len(found) == 1 else None


def node(key, title="A conservative study of autonomous excavation", **changes):
    return dict(id=key, title=title, doi="", arxiv_id="", year="", first_author="", **changes)


@pytest.mark.parametrize("title,other", [
    ("", ""), ("short", "short"), ("short", "shorter"),
    ("abcde" * 40, "abcde" * 39 + "xxxxx"),
    ("a" * 38, "a" * 38 + "bbbb"), ("a" * 42, "a" * 38),
    ("自律掘削計画についての長い論文タイトルを検討する", "自律掘削計画についての長い論文タイトルを検討します"),
    ("ＡＵＴＯＮＯＭＯＵＳ — planning policies", "autonomous planning policies"),
    ("abcde" * 50 + "x", "abcde" * 50 + "y"),
])
def test_title_bounds_preserve_threshold_unicode_and_autojunk(title, other):
    assert scholarly_lookup.titles_match(title, other) == original_titles_match(title, other)


def test_index_matches_original_for_conflicts_ambiguity_and_generated_titles():
    rng = random.Random(6241)
    nodes = []
    for i in range(80):
        title = "".join(rng.choice("abcdefghijklmno ") for _ in range(rng.randrange(16, 75)))
        item = node(str(i), title)
        item.update(doi=f"10.1234/{i}" if i % 4 == 0 else "", arxiv_id=f"2401.{i:05d}" if i % 7 == 0 else "",
                    year="2020" if i % 3 == 0 else "", first_author="Alice Smith" if i % 5 == 0 else "")
        nodes.append(item)
    # Equal and nearly equal titles must still remain ambiguous when neither is identified.
    nodes.extend([node("same1"), node("same2"), node("alias") | {"external_id": "external-alias"}])
    index = discovery.IdentityIndex(nodes)
    for item in nodes:
        for title in (item["title"], item["title"] + "x", item["title"].swapcase()):
            known = {**item, "id": "unknown", "title": title}
            assert index.match(known) == original_match(known, nodes)
        for changes in ({"doi": "10.1234/CONFLICT"}, {"year": "2021"}, {"first_author": "Bob Jones"}):
            known = {**item, "id": "unknown", **changes}
            assert index.match(known) == original_match(known, nodes)
    known = node("external-alias", "A different title")
    assert index.match(known) == original_match(known, nodes) == "alias"


def test_index_replaces_old_metadata_and_keeps_exact_ambiguity():
    first = node("first") | {"doi": "10.1234/old", "external_id": "old-alias"}
    second = node("second") | {"doi": "10.1234/new", "external_id": "new-alias"}
    index = discovery.IdentityIndex([first])
    updated = {**first, "doi": "10.1234/new", "external_id": "new-alias", "title": "A wholly different reference title"}
    index.update(updated)
    for known in (node("old-alias", "short"), node("new-alias", "short"), node("unknown") | {"doi": "10.1234/old"}):
        assert index.match(known) == original_match(known, [updated])
    index.update(second)
    assert index.match(node("unknown") | {"doi": "10.1234/new"}) is None
    assert index.match(node("unknown")) == "second"  # Title ambiguity disappeared after replacement.


def test_exact_index_avoids_title_scan_without_weakening_conflict_check(monkeypatch):
    nodes = [node(str(i), f"Unrelated research in autonomous planning number {i}") | {"doi": f"10.1234/{i}"} for i in range(1000)]
    index = discovery.IdentityIndex(nodes)
    monkeypatch.setattr(scholarly_lookup, "titles_match", lambda *_: pytest.fail("Exact identifiers must not scan titles"))
    assert index.match(node("unknown", "short") | {"doi": "10.1234/987"}) == "987"
    assert index.match(node("987", "short") | {"doi": "10.1234/conflict"}) is None


def test_empty_fetch_stages_reuse_rankings_and_final_map_is_built_once(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "A uniquely identified research origin", doi="10.1234/origin")
    seed = work(1, "A uniquely identified research origin", "10.1234/origin")
    graph_api(monkeypatch, [seed])
    result = discovery.discover(lib, source, source, threading.Event(), lambda _: None)
    assert not result["stale"]
    builds = next(step for step in result["timing"]["steps"] if step["key"] == "/map_build")
    assert builds["count"] == 3  # Initial local map, root metadata, final result.
    saved = discovery.build(lib, source)
    assert saved == result
