"""The library's full-text index (search_index) and the library search that uses it (reading_tools.library_search)."""
from __future__ import annotations
from tests._memos import set_memo

from contextlib import closing
import hashlib
import itertools
import shutil
import sqlite3
import threading
import time
import uuid

import pytest

from papeer.core import drive_sync, search_index
from papeer.core.paths import PaperFiles, device_directory, search_index_path
from papeer.core.reading_tools import library_search
from papeer.core.search_index import SearchIndex, trigram_query
from papeer.core.storage import Library


@pytest.fixture(autouse=True)
def settled(monkeypatch):
    """Files written by the test count as written long ago, so their keys are recorded at once."""
    monkeypatch.setattr(search_index, "_now_ns", lambda: time.time_ns() + 10 * search_index.RACY_NS)


def add_paper(lib: Library, title: str, pages: list[str], sections: list[tuple[int, str]] | None = None,
              note: str = "", tags: str = "[]", venue: str = "") -> str:
    """A paper as the library holds it (without a PDF): its row, its pages and its translation.md."""
    paper_id = uuid.uuid4().hex
    lib.folder(paper_id).mkdir()
    with lib.connection() as db:
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status,note,tags,venue) VALUES(?,?,?,?,?,?,?,?,?)",
                   (paper_id, hashlib.sha256(paper_id.encode()).hexdigest(), title, f"{title}.pdf", len(pages),
                    "translated", note, tags, venue))
        db.executemany("INSERT INTO pages(paper_id,number,text) VALUES(?,?,?)",
                       [(paper_id, number, text) for number, text in enumerate(pages, 1)])
    if sections is not None:
        write_translation(lib, paper_id, sections)
    return paper_id


def write_translation(lib: Library, paper_id: str, sections: list[tuple[int, str]]) -> None:
    body = "".join(f"## p.{page} / p{page}b{index}\n\n{text}\n\n" for index, (page, text) in enumerate(sections))
    PaperFiles(lib.folder(paper_id)).translation_md.write_text("# 日本語訳\n\n" + body, "utf-8")


def looked_through(lib: Library, query: str) -> set[tuple]:
    """What looking through every text finds (library_search before the index), as a set."""
    term = query.strip().casefold()
    found = set()
    def add(paper, side, page, text):
        offset = text.casefold().find(term)
        if offset >= 0:
            found.add((paper["id"], side, page, text[max(0, offset - 45):offset + len(term) + 90].replace("\n", " ")))
    for paper in lib.papers():
        add(paper, "metadata", None, " ".join([paper["title"], paper["first_author"], paper["publication_year"],
                                              paper["original_name"], paper["collection_name"], paper["venue"],
                                              paper["doi"], paper["arxiv_id"], *paper["tags"]]))

        for number, text in lib.page_texts(paper["id"]):
            add(paper, "original", number, text)
        for page, _, text in PaperFiles(lib.folder(paper["id"])).translation_sections():
            add(paper, "translated", page, text)
    return found


def as_set(result: dict) -> set[tuple]:
    return {(hit["paper_id"], hit["side"], hit["page"], hit["snippet"]) for hit in result["results"]}


@pytest.fixture
def lib(tmp_path):
    lib = Library(tmp_path / "library")
    add_paper(lib, "Adaptive Control", ["The Network is deﬁned by Straße.\nSecond line", "A NETWORK of networks"],
              [(1, "ネットワークを定義する。推定量を用いる。"), (2, "ネットワークの網。")], note="制御のメモ")
    add_paper(lib, "Estimation", ["推定 of 提案手法: a_b is 50% of \"quoted\" text; it's ﬁne.", "ｆｕｌｌ width ＡＢＣ"],
              [(1, "提案手法による推定。ひらがな カタカナ"), (1, "二つ目の節で推定する。")], tags='["推定"]', venue="NeurIPS")
    add_paper(lib, "No translation", ["network theory"], note="ネットワークの本を読む")
    return lib


QUERIES = ["network", "NETWORK", "networks", "Network is", "defined", "fi", "ﬁ", "strasse", "STRASSE", "推定", "推",
           "提案手法", "推定量を", "ネットワーク", "の", "網", "a_b", "50%", "%", "_", '"quoted"', "it's", "' OR 1=1 --",
           "ｆｕｌｌ", "full", "ＡＢＣ", "abc", "ひらがな カタカナ", "カタカナ", "かたかな", "neurips", "memo", "制御の",
           "zzz", "e", "ne"]


@pytest.mark.parametrize("query", QUERIES)
def test_the_index_finds_what_looking_through_everything_finds(lib, query):
    assert as_set(library_search(lib, query)) == looked_through(lib, query)


def test_what_the_search_matches_is_unchanged_by_the_index(lib):
    """Casefolded as a whole, as before: full folding ("ﬁ" is "fi", "ß" is "ss"), no width or kana folding."""
    def sides(query):
        return sorted((hit["side"], hit["page"]) for hit in library_search(lib, query)["results"])
    assert ("original", 1) in sides("DEFINED") and ("original", 1) in sides("strasse")
    assert sides("full") == [] and sides("かたかな") == []  # Full-width letters and katakana stay apart.
    assert ("original", 2) in sides("ｆｕｌｌ")
    # Two characters: shorter than a trigram, found in the stored texts.
    assert [hit["side"] for hit in library_search(lib, "推定")["results"]].count("translated") == 3


def test_papers_come_by_relevance(lib):
    first = add_paper(lib, "Network Survey", ["nothing here"])
    many = add_paper(lib, "Many", ["network", "network", "network", "network"])
    order = list(dict.fromkeys(hit["paper_id"] for hit in library_search(lib, "network")["results"]))
    titles = {paper["id"]: paper["title"] for paper in lib.papers()}
    # The title first, then a memo, then the most pages containing it.
    assert order[0] == first
    assert order[1] == many
    assert [titles[paper_id] for paper_id in order[2:]] == ["Adaptive Control", "No translation"]
    notes = list(dict.fromkeys(hit["paper_id"] for hit in library_search(lib, "ネットワーク")["results"]))
    assert titles[notes[0]] == "Adaptive Control"  # Memos are not searched in stage B.


def test_the_index_follows_changes(lib):
    paper_id = next(paper["id"] for paper in lib.papers() if paper["title"] == "No translation")
    assert not library_search(lib, "翻訳した段落")["results"]
    write_translation(lib, paper_id, [(1, "翻訳した段落です。")])
    assert [hit["side"] for hit in library_search(lib, "翻訳した段落")["results"]] == ["translated"]
    write_translation(lib, paper_id, [(1, "書き直した段落です。長くしました。")])
    assert not library_search(lib, "翻訳した段落")["results"]
    assert library_search(lib, "書き直した")["results"]
    PaperFiles(lib.folder(paper_id)).translation_md.unlink()
    assert not library_search(lib, "書き直した")["results"]
    set_memo(lib, paper_id, note="新しいメモ")
    assert library_search(lib, "新しいメモ")["results"] == []
    lib.delete_paper(paper_id)
    assert not library_search(lib, "theory")["results"]
    with sqlite3.connect(search_index_path(lib.root)) as db:
        assert not db.execute("SELECT 1 FROM entries WHERE paper_id=?", (paper_id,)).fetchone()
        assert not db.execute("SELECT 1 FROM sources WHERE paper_id=?", (paper_id,)).fetchone()


def test_an_unchanged_library_is_not_read_again(lib, monkeypatch):
    index = SearchIndex(lib.root)
    assert index.refresh(lib) == set()
    read = []
    original = search_index._read_translation
    monkeypatch.setattr(search_index, "_read_translation", lambda path: read.append(path) or original(path))
    library_search(lib, "network")
    assert read == []
    paper_id = lib.papers()[0]["id"]
    write_translation(lib, paper_id, [(1, "変更。")])
    library_search(lib, "network")
    assert len(read) == 1 and paper_id in read[0]


def test_a_translation_written_just_now_is_read_again(lib, monkeypatch):
    monkeypatch.setattr(search_index, "_now_ns", time.time_ns)
    index = SearchIndex(lib.root)
    index.refresh(lib)
    read = []
    original = search_index._read_translation
    monkeypatch.setattr(search_index, "_read_translation", lambda path: read.append(path) or original(path))
    index.refresh(lib)
    # Two papers have a translation.md, both written within RACY_NS: a write in the same tick could go unseen.
    assert len(read) == 2


def test_papers_not_indexed_yet_are_looked_through(lib, monkeypatch):
    monkeypatch.setattr(search_index, "BUILD_SECONDS", -1.0)
    for query in ("network", "推定", "ネットワーク"):
        assert as_set(library_search(lib, query)) == looked_through(lib, query)
    assert SearchIndex(lib.root).refresh(lib, -1.0) == {paper["id"] for paper in lib.papers()}
    monkeypatch.setattr(search_index, "BUILD_SECONDS", 60.0)
    library_search(lib, "network")
    assert SearchIndex(lib.root).refresh(lib, -1.0) == set()


def test_the_search_works_without_the_index(lib, monkeypatch):
    def broken(*_args):
        raise sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(SearchIndex, "refresh", broken)
    for query in ("network", "推定"):
        assert as_set(library_search(lib, query)) == looked_through(lib, query)


def test_an_unreadable_or_older_index_is_built_again(lib, monkeypatch):
    path = search_index_path(lib.root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not a database" * 100)
    assert as_set(library_search(lib, "network")) == looked_through(lib, "network")
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT value FROM info WHERE name='format'").fetchone() == (str(search_index.INDEX_FORMAT),)
    monkeypatch.setattr(search_index, "INDEX_FORMAT", search_index.INDEX_FORMAT + 1)
    assert SearchIndex(lib.root).refresh(lib, -1.0) == {paper["id"] for paper in lib.papers()}
    assert as_set(library_search(lib, "推定量")) == looked_through(lib, "推定量")


def test_the_index_stays_on_this_pc(lib):
    """Kept in the device folder, the index changes nothing that is backed up or synced."""
    before = drive_sync.fingerprint(lib)
    library_search(lib, "network")
    assert search_index_path(lib.root).parent == device_directory()
    assert search_index_path(lib.root).is_file()
    assert not any(path.suffix == ".sqlite3" and path.name != "library.sqlite3" for path in lib.root.rglob("*"))
    assert drive_sync.fingerprint(lib) == before


def test_trigram_query_quotes_each_trigram():
    assert trigram_query('ab"cd') == '"ab""" AND "b""c" AND """cd"'
    assert trigram_query("aaaa") == '"aaa"'


def test_limit(lib):
    for index in range(3):
        add_paper(lib, f"Many {index}", ["network"] * 90)
    result = library_search(lib, "network")
    assert len(result["results"]) == 200 and result["limited"]
    assert not library_search(lib, "theory")["limited"]


def test_page_search_reads_only_the_papers_asked_for(lib):
    papers = {paper["title"]: paper["id"] for paper in lib.papers()}
    everywhere = lib.search_pages("network", limit=10)
    assert {page["paper_id"] for page in everywhere} == set(papers.values())
    chosen = lib.search_pages("network", limit=10, paper_ids={papers["No translation"], papers["Estimation"]})
    assert [(page["paper_id"], page["number"], page["score"]) for page in chosen] == sorted(
        [(papers["No translation"], 1, 1), (papers["Estimation"], 1, 0), (papers["Estimation"], 2, 0)],
        key=lambda page: (-page[2], page[0], page[1]))
    assert lib.search_pages("network", limit=10, paper_ids=set()) == []


def test_only_papers_the_index_names_are_read(lib, monkeypatch):
    looked = []
    original = search_index.IndexReader.places
    monkeypatch.setattr(search_index.IndexReader, "places",
                        lambda self, term, paper_id: looked.append(paper_id) or original(self, term, paper_id))
    titles = {paper["id"]: paper["title"] for paper in lib.papers()}
    assert library_search(lib, "network")["results"]
    assert sorted(titles[paper_id] for paper_id in looked) == ["Adaptive Control", "No translation"]
    looked.clear()
    # A term shorter than a trigram is looked for in each paper's stored texts.
    library_search(lib, "ne")
    assert sorted(titles[paper_id] for paper_id in looked) == sorted(titles.values())


def integrity(path) -> str:
    """PRAGMA integrity_check's answer ("ok"), or the error a damaged file gives instead."""
    try:
        with closing(sqlite3.connect(path)) as db:
            return db.execute("PRAGMA integrity_check").fetchone()[0]
    except sqlite3.DatabaseError as exc:
        return str(exc)


def test_a_damaged_index_is_built_again(lib):
    """Pages of the index overwritten (the file still opens): the search looks through everything meanwhile."""
    for index in range(4):
        add_paper(lib, f"More {index}", [f"network page {index} " * 200] * 5, [(1, "ネットワーク " * 300)])
    path = search_index_path(lib.root)
    SearchIndex(lib.root).refresh(lib)
    with closing(sqlite3.connect(path)) as db:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    size = path.stat().st_size
    with open(path, "r+b") as stream:
        stream.seek(size // 4)
        stream.write(b"\xff" * (size // 2))
    assert integrity(path) != "ok"
    for _ in range(2):
        assert as_set(library_search(lib, "network")) == looked_through(lib, "network")
        assert as_set(library_search(lib, "ネットワーク")) == looked_through(lib, "ネットワーク")
    assert integrity(path) == "ok"
    assert SearchIndex(lib.root).refresh(lib, -1.0) == set()


def test_a_busy_index_is_not_removed(lib, monkeypatch):
    index = SearchIndex(lib.root)
    index.refresh(lib)
    def locked(self):
        raise sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(SearchIndex, "_connect", locked)
    with pytest.raises(sqlite3.OperationalError):
        index.refresh(lib)
    assert as_set(library_search(lib, "network")) == looked_through(lib, "network")
    monkeypatch.undo()
    assert integrity(index.path) == "ok"
    assert index.refresh(lib, -1.0) == set()  # Still all there.


@pytest.mark.parametrize("indexed", [0, 1, 2, 4, 5])
def test_a_partly_built_index_finds_the_same(lib, monkeypatch, indexed):
    """The time runs out after `indexed` papers: those come from the index, the others are looked through."""
    add_paper(lib, "Fourth", ["network 推定"], [(1, "推定する。")])
    add_paper(lib, "Fifth", ["no match"], note="network")
    clock = itertools.count()
    monkeypatch.setattr(search_index, "_monotonic", lambda: next(clock))
    monkeypatch.setattr(search_index, "PAPERS_PER_COMMIT", 1)
    monkeypatch.setattr(search_index, "BUILD_SECONDS", indexed + 0.5)
    for query in ("network", "推定", "ne", "ネットワーク", "zzz"):
        SearchIndex(lib.root).discard()
        assert as_set(library_search(lib, query)) == looked_through(lib, query)
        assert len(SearchIndex(lib.root).refresh(lib, -1.0)) == 5 - indexed


def test_searches_at_the_same_time(lib, monkeypatch):
    for index in range(6):
        add_paper(lib, f"More {index}", [f"network {index}"] * 3, [(1, f"ネットワーク{index}")])
    monkeypatch.setattr(search_index, "PAPERS_PER_COMMIT", 2)
    queries = ["network", "ネットワーク", "推定", "ne"]
    expected = {query: looked_through(lib, query) for query in queries}
    for _ in range(3):
        SearchIndex(lib.root).discard()
        start = threading.Barrier(2)
        failures, found = [], []
        def search():
            try:
                start.wait()
                found.extend((query, as_set(library_search(lib, query))) for query in queries)
            except BaseException as exc:  # noqa: BLE001 - reported below, as a thread cannot fail the test.
                failures.append(exc)
        threads = [threading.Thread(target=search) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert failures == []
        assert len(found) == 2 * len(queries)
        assert all(result == expected[query] for query, result in found)
    assert integrity(search_index_path(lib.root)) == "ok"


def test_indexes_of_libraries_no_longer_there_are_removed(tmp_path, monkeypatch):
    moved = Library(tmp_path / "old")
    add_paper(moved, "Old", ["network"])
    library_search(moved, "network")
    old_index = search_index_path(moved.root)
    assert old_index.is_file()
    current = Library(tmp_path / "new")
    add_paper(current, "New", ["network"])
    library_search(current, "network")
    assert old_index.is_file()  # Its library is still there.
    shutil.rmtree(moved.root)
    monkeypatch.setattr(search_index, "_TIDIED", set())  # As in the next process.
    assert library_search(current, "network")["results"]
    assert not old_index.exists()
    assert search_index_path(current.root).is_file()
