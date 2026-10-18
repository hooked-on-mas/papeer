"""Search across the library: metadata, pages, translated sections and HTML documents, with the index (search_index)."""
from __future__ import annotations

import sqlite3

from papeer.core import html_text, search_index
from papeer.core.library_papers import search_forms
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library


def _metadata_text(paper: dict) -> str:
    return " ".join([paper["title"], paper["first_author"], paper["publication_year"], paper["original_name"],
                     paper["collection_name"], paper.get("venue", ""), paper.get("doi", ""), paper.get("arxiv_id", ""),
                     *paper["tags"]])


def library_search(lib: Library, query: str, limit: int = 200) -> dict:
    """Where `query` occurs across the library (casefolded, as a whole): at most `limit` places, one for each
    paper's metadata, page ("original"), translated section and HTML document that contains it.

    What was kept decomposed (NFD: names from macOS, before they were composed) is found as well: a place
    counts if it contains the composed form of `query` or the decomposed one (dropped when it is over 200
    characters, which only the composed form is held to).

    The most relevant papers come first, as `limit` may cut the rest: those whose metadata contain it, then
    the others; within each group those with more pages and sections containing
    it first (a term shorter than a trigram is not counted), then in the library's order (newest first).
    Within a paper: metadata, pages, sections, documents. The index (search_index) says where to look; each
    place is checked against the text itself, and papers it does not cover yet are looked through whole.

    The HTML documents an item holds (html_text: the text of the markup, read without running it) are not in
    the index: they are looked through whole each time, their text kept in memory while the file is the same.
    An item with a match in one is a candidate whatever its pages say, and the hit is the item with side
    "html", no page and the document's id and name.
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
    documents = _document_places(lib, terms, {paper["id"] for paper in papers})
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
                count = counts.get(paper["id"], 0) + (len(documents.get(paper["id"], ())) if counted else 0)
                # A short term is not counted: any paper may have it, and each is checked in turn.
                if in_metadata or count or not counted or paper["id"] in unindexed or paper["id"] in documents:
                    candidates.append((0 if in_metadata else 1, -count, position, paper))
            candidates.sort(key=lambda candidate: candidate[:3])

            def places(paper):
                if paper["id"] in unindexed:
                    return None
                return {tuple(place) for term in terms for place in reader.places(term, paper["id"])}
            return _search_places(lib, terms, limit, ((paper, places(paper)) for *_, paper in candidates), documents)
    except (sqlite3.Error, OSError) as exc:
        # The index is never a reason for the search to fail (an unwritable device folder, a full disk):
        # it then looks through everything, as it did before the index. A damaged one is removed, for the
        # next search to build again; the library's database being damaged instead costs that rebuild only.
        if search_index.corrupt(exc):
            index.discard()
        return _search_places(lib, terms, limit, ((paper, None) for paper in papers), documents)


def _document_places(lib: Library, terms: list[str], owners: set[str]) -> dict[str, list[tuple[str, str, str]]]:
    """The HTML documents that contain a term, by the item that holds them: (id, name, snippet) in the
    document order of the item. Only items of `owners` (what the library lists) are looked through."""
    found: dict[str, list[tuple[str, str, str]]] = {}
    for source in html_text.sources(lib, owners):
        folded = source.text.casefold()
        matches = [(folded.find(term), term) for term in terms if term in folded]
        if matches:
            offset, term = min(matches)
            # casefold may change the length of a text (ß), and then only the folded text has the offset.
            text = source.text if len(folded) == len(source.text) else folded
            snippet = text[max(0, offset - 45):offset + len(term) + 90].replace("\n", " ")
            found.setdefault(source.owner_id, []).append((source.attachment_id, source.title, snippet))
    return found


def _search_places(lib: Library, terms: list[str], limit: int, candidates, documents=None) -> dict:
    """library_search's results from `candidates`: (paper, places) in order, places being (side, page, section)
    of the pages and translated sections to check, or None for all of them. `documents` (_document_places)
    adds the HTML documents of each paper after its other places."""
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
            for attachment_id, name, snippet in (documents or {}).get(paper["id"], ()):
                results.append({"paper_id": paper["id"], "title": paper["title"], "side": "html", "page": None,
                                "attachment_id": attachment_id, "attachment_title": name, "snippet": snippet})
            if len(results) >= limit:
                return {"results": results[:limit], "limited": True}
    return {"results": results, "limited": False}
