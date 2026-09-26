"""Reading metadata and library-wide search."""
from __future__ import annotations

import re

from paperdesk.core.storage import Library

DEFAULT_TEMPLATE = "\n\n".join("## " + heading for heading in (
    "何を解決する論文？", "新しい点", "主な結果", "前提・限界", "自分に使えそうな点", "疑問・次に調べること"))


def library_search(lib: Library, query: str, limit: int = 200) -> dict:
    term = query.strip().casefold()
    if not term:
        return {"results": [], "limited": False}
    if len(term) > 200:
        raise ValueError("検索語は200文字までです。")
    results = []
    def add(paper, side, page, text):
        offset = text.casefold().find(term)
        if offset >= 0:
            results.append({"paper_id": paper["id"], "title": paper["title"], "side": side, "page": page,
                            "snippet": text[max(0, offset - 45):offset + len(term) + 90].replace("\n", " ")})
    for paper in lib.papers():
        add(paper, "metadata", None, " ".join([paper["title"], paper["first_author"], paper["publication_year"],
                                              paper["original_name"], paper["collection_name"], *paper["tags"]]))
        add(paper, "note", None, paper["note"])
        with lib.connection() as db:
            for row in db.execute("SELECT number,text FROM pages WHERE paper_id=? ORDER BY number", (paper["id"],)):
                add(paper, "original", row["number"], row["text"])
        markdown = lib.folder(paper["id"]) / "translation.md"
        if markdown.exists():
            parts = re.split(r"^## p\.(\d+) / \S+[ \t]*$", markdown.read_text("utf-8"), flags=re.M)
            for page, text in zip(parts[1::2], parts[2::2]):
                add(paper, "translated", int(page), text)
        if len(results) >= limit:
            return {"results": results[:limit], "limited": True}
    return {"results": results, "limited": False}
