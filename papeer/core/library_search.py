"""Search across the library: metadata, pages and translated sections, with the index (search_index)."""
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
    """Where `query` occurs across the library (casefolded, as a whole): at most `limit` places, one for each
    paper's metadata, page ("original") and translated section that contains it.

    What was kept decomposed (NFD: names from macOS, before they were composed) is found as well: a place
    counts if it contains the composed form of `query` or the decomposed one (dropped when it is over 200
    characters, which only the composed form is held to).

    The most relevant papers come first, as `limit` may cut the rest: those whose metadata contain it, then
    the others; within each group those with more pages and sections containing
    it first (a term shorter than a trigram is not counted), then in the library's order (newest first).
    Within a paper: metadata, pages, sections. The index (search_index) says where to look; each place
    is checked against the text itself, and papers it does not cover yet are looked through whole.
    """
    forms = search_forms(query)
    if not forms[0]:
        return {"results": [], "limited": False}
    if len(forms[0]) > 200:
        raise ValueError("検索語は200文字までです。")
    terms = [form.casefold() for form in forms if len(form) <= 200]
    # Every item the library lists: metadata/tags and pages' text (after OCR for a notebook).
    # Memo search is a later stage. The hit opens in the reader by paper_id whatever its kind.
    papers = lib.items()
    index = search_index.SearchIndex(lib.root)
    try:
        unindexed = index.refresh(lib, search_index.BUILD_SECONDS)
        with index.reader() as reader:
            counted = all(len(term) >= search_index.TRIGRAM for term in terms)
            counts: dict = {}
            for term in terms if counted else []:
                for paper_id, count in reader.counts(term).items():
                    counts[paper_id] = max(counts.get(paper_id, 0), count)  # Not summed: one place may hold both forms.
            candidates = []
            for position, paper in enumerate(papers):
                metadata = _metadata_text(paper).casefold()
                in_metadata = any(term in metadata for term in terms)
                count = counts.get(paper["id"], 0)
                # A short term is not counted: any paper may have it, and each is checked in turn.
                if in_metadata or count or not counted or paper["id"] in unindexed:
                    candidates.append((0 if in_metadata else 1, -count, position, paper))
            candidates.sort(key=lambda candidate: candidate[:3])

            def places(paper):
                if paper["id"] in unindexed:
                    return None
                return {tuple(place) for term in terms for place in reader.places(term, paper["id"])}
            return _search_places(lib, terms, limit, ((paper, places(paper)) for *_, paper in candidates))
    except (sqlite3.Error, OSError) as exc:
        # The index is never a reason for the search to fail (an unwritable device folder, a full disk):
        # it then looks through everything, as it did before the index. A damaged one is removed, for the
        # next search to build again; the library's database being damaged instead costs that rebuild only.
        if search_index.corrupt(exc):
            index.discard()
        return _search_places(lib, terms, limit, ((paper, None) for paper in papers))


def _search_places(lib: Library, terms: list[str], limit: int, candidates) -> dict:
    """library_search's results from `candidates`: (paper, places) in order, places being (side, page, section)
    of the pages and translated sections to check, or None for all of them."""
    results = []
    def add(paper, side, page, text):
        folded = text.casefold()
        found = [(folded.find(term), term) for term in terms if term in folded]
        if found:  # One place is one result, whichever form it contains (the earlier one gives the snippet).
            offset, term = min(found)
            results.append({"paper_id": paper["id"], "title": paper["title"], "side": side, "page": page,
                            "snippet": text[max(0, offset - 45):offset + len(term) + 90].replace("\n", " ")})
    with lib.connection() as db:
        for paper, places in candidates:
            add(paper, "metadata", None, _metadata_text(paper))
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
