"""Search across the library: metadata, memos, pages and translated sections, with the index (search_index)."""
from __future__ import annotations

import sqlite3

from papeer.core import search_index
from papeer.core.library_papers import search_forms
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library


def _metadata_text(paper: dict) -> str:
    return " ".join([paper["title"], paper["first_author"], paper["publication_year"], paper["original_name"],
                     paper["collection_name"], paper.get("venue", ""), paper.get("doi", ""), paper.get("arxiv_id", ""),
                     *paper["tags"]])


def library_search(lib: Library, query: str, limit: int = 200) -> dict:
    """_library_search for the composed (NFC) and the decomposed (NFD) form of `query`, the results joined:
    what was kept decomposed (names from macOS, before they were composed) is found by either."""
    terms = [form.casefold() for form in search_forms(query)]
    found = _library_search(lib, terms[0], limit)
    for term in terms[1:]:
        more = _library_search(lib, term, limit)
        seen = {(r["paper_id"], r["side"], r["page"], r["snippet"]) for r in found["results"]}
        found["results"] += [r for r in more["results"] if (r["paper_id"], r["side"], r["page"], r["snippet"]) not in seen]
        found["limited"] = found["limited"] or more["limited"] or len(found["results"]) > limit
        found["results"] = found["results"][:limit]
    return found


def _library_search(lib: Library, term: str, limit: int) -> dict:
    """Where `query` occurs across the library (casefolded, as a whole): at most `limit` places, one for each
    paper's metadata, memo, page ("original") and translated section that contains it.

    The most relevant papers come first, as `limit` may cut the rest: those whose metadata contain it, then
    those whose memo does, then the others; within each group those with more pages and sections containing
    it first (a term shorter than a trigram is not counted), then in the library's order (newest first).
    Within a paper: metadata, memo, pages, sections. The index (search_index) says where to look; each place
    is checked against the text itself, and papers it does not cover yet are looked through whole.
    """
    if not term:
        return {"results": [], "limited": False}
    if len(term) > 200:
        raise ValueError("検索語は200文字までです。")
    papers = lib.papers()
    index = search_index.SearchIndex(lib.root)
    try:
        unindexed = index.refresh(lib, search_index.BUILD_SECONDS)
        with index.reader() as reader:
            counts = reader.counts(term) if len(term) >= search_index.TRIGRAM else None
            candidates = []
            for position, paper in enumerate(papers):
                in_metadata = term in _metadata_text(paper).casefold()
                in_note = term in paper["note"].casefold()
                count = counts.get(paper["id"], 0) if counts is not None else 0
                # A short term is not counted: any paper may have it, and each is checked in turn.
                if in_metadata or in_note or count or counts is None or paper["id"] in unindexed:
                    candidates.append((0 if in_metadata else 1 if in_note else 2, -count, position, paper))
            candidates.sort(key=lambda candidate: candidate[:3])
            return _search_places(lib, term, limit, (
                (paper, None if paper["id"] in unindexed else reader.places(term, paper["id"])) for *_, paper in candidates))
    except (sqlite3.Error, OSError) as exc:
        # The index is never a reason for the search to fail (an unwritable device folder, a full disk):
        # it then looks through everything, as it did before the index. A damaged one is removed, for the
        # next search to build again; the library's database being damaged instead costs that rebuild only.
        if search_index.corrupt(exc):
            index.discard()
        return _search_places(lib, term, limit, ((paper, None) for paper in papers))


def _search_places(lib: Library, term: str, limit: int, candidates) -> dict:
    """library_search's results from `candidates`: (paper, places) in order, places being (side, page, section)
    of the pages and translated sections to check, or None for all of them."""
    results = []
    def add(paper, side, page, text):
        offset = text.casefold().find(term)
        if offset >= 0:
            results.append({"paper_id": paper["id"], "title": paper["title"], "side": side, "page": page,
                            "snippet": text[max(0, offset - 45):offset + len(term) + 90].replace("\n", " ")})
    with lib.connection() as db:
        for paper, places in candidates:
            add(paper, "metadata", None, _metadata_text(paper))
            add(paper, "note", None, paper["note"])
            pages = None if places is None else {page for side, page, _ in places if side == "original"}
            if pages is None or pages:
                for number, text in db.execute("SELECT number,text FROM pages WHERE paper_id=? ORDER BY number", (paper["id"],)):
                    if pages is None or number in pages:
                        add(paper, "original", number, text)
            sections = None if places is None else {section for side, _, section in places if side == "translated"}
            if sections is None or sections:
                for section, (page, _, text) in enumerate(PaperFiles(lib.folder(paper["id"])).translation_sections()):
                    if sections is None or section in sections:
                        add(paper, "translated", page, text)
            if len(results) >= limit:
                return {"results": results[:limit], "limited": True}
    return {"results": results, "limited": False}
