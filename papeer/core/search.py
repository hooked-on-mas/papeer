"""Find text in one paper, in the original or in the Japanese translation."""
from __future__ import annotations

from typing import Any

from papeer.core.paths import PaperFiles
from papeer.core.service import cached_page_texts
from papeer.core.storage import Library

MAX_RESULTS = 200
MAX_TERM_LENGTH = 200


def search_paper(lib: Library, paper_id: str, query: str, side: str = "original") -> dict[str, Any]:
    """Matches with a snippet and the vertical position on the page, at most MAX_RESULTS."""
    if side not in {"original", "translated"}:
        raise ValueError("検索対象が不正です。")
    term = query.strip().casefold()
    if not term:
        return {"results": [], "total": 0}
    if len(term) > MAX_TERM_LENGTH:
        raise ValueError("検索語が長すぎます。")
    files = PaperFiles(lib.folder(paper_id))
    document = lib.document(paper_id)
    results: list[dict[str, Any]] = []
    translated_pages: dict[int, list[tuple[str, str]]] = {}
    if side == "translated":
        for number, block_id, text in files.translation_sections():
            translated_pages.setdefault(number, []).append((block_id, text))
    source_by_id = {block["id"]: block for block in document["blocks"]}
    source_by_page: dict[int, list[dict[str, Any]]] = {}
    for block in document["blocks"]:
        source_by_page.setdefault(block["page"], []).append(block)
    cached = None  # cached_page_texts, made once for all pages that need it.
    for info in document["pages"]:
        if len(results) >= MAX_RESULTS:
            break
        number = info["number"]
        sections = (source_by_page.get(number, []) if side == "original" else
                    [{"text": body, "bbox": source_by_id.get(block_id, {}).get("bbox", [0, 0, 0, 0])}
                     for block_id, body in translated_pages.get(number, [])])
        content = info["text"] if side == "original" else "\n".join(body for _, body in translated_pages.get(number, []))
        if side == "translated" and not content:
            # A page without sections in translation.md (an unfinished translation) takes the saved translations.
            cached = cached if cached is not None else cached_page_texts(files.folder, document)
            content = "\n".join(cached.get(number, []))
        anchors = [max(0.0, min(1.0, block["bbox"][1] / info["height"]))
                   for block in sections for _ in range(block["text"].casefold().count(term))]
        folded = content.casefold()
        offset = 0
        occurrence = 0
        while len(results) < MAX_RESULTS:
            found = folded.find(term, offset)
            if found < 0:
                break
            results.append({"page": number, "snippet": content[max(0, found - 45):found + len(term) + 65].replace("\n", " "),
                            "anchor_y": anchors[occurrence] if occurrence < len(anchors) else 0})
            occurrence += 1
            offset = found + max(1, len(term))
    return {"results": results, "total": len(results), "limited": len(results) == MAX_RESULTS}
