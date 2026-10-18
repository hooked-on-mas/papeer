"""Library's sticky notes and highlights (the bookmarks table) and freehand ink (pdf_ink)."""
from __future__ import annotations

import json
import sqlite3

from papeer.core.errors import NotFound
from papeer.core.library_base import LibraryBase


# The colours a passage can be highlighted in (frontend features/reader/highlights.ts), and how an
# exported PDF paints them (pdf_ink.annotated_pdf).
HIGHLIGHT_COLORS = {"yellow": "#facc15", "green": "#4ade80", "blue": "#60a5fa", "pink": "#f472b6", "purple": "#c084fc"}
# Rectangles of one highlight: a passage over a page or two of lines, with room to spare.
MAX_HIGHLIGHT_RECTS = 400


def _highlight_rects(rects: list) -> list[list[float]]:
    """A highlight's rectangles checked to lie on the page, rounded to keep the database small."""
    if not rects or len(rects) > MAX_HIGHLIGHT_RECTS:
        raise ValueError("ハイライトする範囲が不正です。")
    result = []
    for rect in rects:
        if not isinstance(rect, (list, tuple)) or len(rect) != 4 \
                or not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in rect):
            raise ValueError("ハイライトする範囲が不正です。")
        x, y, width, height = (float(value) for value in rect)
        # NaN fails every comparison, so it is refused here too.
        if not (0 <= x <= 1 and 0 <= y <= 1 and 0 < width <= 1 and 0 < height <= 1
                and x + width <= 1.00002 and y + height <= 1.00002):
            raise ValueError("ハイライトする範囲がページの外にはみ出しています。")
        # Kept on the page once rounded: the edges are rounded, and the size taken from them.
        left, top = round(x, 5), round(y, 5)
        right, bottom = min(1.0, round(x + width, 5)), min(1.0, round(y + height, 5))
        if right <= left or bottom <= top:
            raise ValueError("ハイライトする範囲が小さすぎます。")
        result.append([left, top, round(right - left, 5), round(bottom - top, 5)])
    return result


class Annotations(LibraryBase):
    """Sticky notes, highlights and ink of each paper, side and page."""

    @staticmethod
    def _bookmark(row: sqlite3.Row) -> dict:
        item = dict(row)
        item["rects"] = json.loads(item.get("rects") or "[]")
        return item

    def bookmarks(self, paper_id: str) -> list[dict]:
        """The paper's sticky notes and highlights (kind 'note' or 'highlight')."""
        self.paper(paper_id)
        with self.connection() as db:
            return [self._bookmark(row) for row in db.execute(
                "SELECT * FROM bookmarks WHERE paper_id=? ORDER BY page,id", (paper_id,))]

    def sticky_notes(self) -> list[dict]:
        with self.connection() as db:
            return [self._bookmark(row) for row in db.execute(
                "SELECT b.*, p.title AS paper_title, p.original_name AS paper_name "
                "FROM bookmarks b JOIN papers p ON p.id=b.paper_id ORDER BY b.id DESC")]

    def add_bookmark(self, paper_id: str, page: int, side: str, quote: str,
                     label: str = "重要", note: str = "", anchor_y: float = 0, anchor_x: float = 0,
                     *, kind: str = "note", color: str = "", rects: list | None = None) -> dict:
        """A sticky note, or with kind='highlight' a highlight of `quote` over `rects` (see _highlights)."""
        paper = self.paper(paper_id)
        if not 1 <= page <= paper["pages"] or side not in {"original", "translated"} or not 0 <= anchor_y <= 1 or not 0 <= anchor_x <= 1:
            raise ValueError("ページまたは原文・訳文の指定が不正です。")
        quote = quote.strip()[:2000]
        if kind == "highlight":
            boxes = _highlight_rects(rects or [])
            if color not in HIGHLIGHT_COLORS or not quote:
                raise ValueError("ハイライトの色または文章の指定が不正です。")
        elif kind == "note":
            color, boxes = "", []
        else:
            raise ValueError("付箋の種類が不正です。")
        with self.connection() as db:
            cursor = db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,label,note,anchor_y,anchor_x,kind,color,rects)"
                                " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                                (paper_id, page, side, quote, label[:40], note[:1000], anchor_y, anchor_x,
                                 kind, color, json.dumps(boxes, separators=(",", ":"))))
            return self._bookmark(db.execute("SELECT * FROM bookmarks WHERE id=?", (cursor.lastrowid,)).fetchone())

    def update_bookmark(self, paper_id: str, bookmark_id: int, label: str | None = None, note: str | None = None,
                        *, anchor_x: float | None = None, anchor_y: float | None = None,
                        color: str | None = None) -> dict:
        """Edits a sticky note or highlight; what is None stays as it is (a PATCH of the colour alone keeps the
        label and memo). A highlight may have no label, and changes colour with `color`."""
        self.paper(paper_id)
        if color is not None and color not in HIGHLIGHT_COLORS:
            raise ValueError("ハイライトの色の指定が不正です。")
        label = None if label is None else label.strip()[:40]
        with self.connection() as db:
            updated = db.execute("UPDATE bookmarks SET label=CASE WHEN ? IS NULL THEN label WHEN kind='highlight' THEN ? ELSE ? END,"
                                 "note=COALESCE(?,note),anchor_x=COALESCE(?,anchor_x),anchor_y=COALESCE(?,anchor_y),"
                                 "color=CASE WHEN kind='highlight' THEN COALESCE(?,color) ELSE color END"
                                 " WHERE paper_id=? AND id=?",
                                 (label, label, (label or "重要") if label is not None else None,
                                  None if note is None else note[:1000], anchor_x, anchor_y, color, paper_id, bookmark_id))
            if not updated.rowcount:
                raise NotFound("付箋が見つかりません。")
            return self._bookmark(db.execute("SELECT * FROM bookmarks WHERE id=?", (bookmark_id,)).fetchone())

    def highlights_by_page(self, paper_id: str, side: str) -> dict[int, list[dict]]:
        """Each page's highlights on one side, as an exported PDF paints them: colour (#rrggbb) and rectangles."""
        pages: dict[int, list[dict]] = {}
        with self.connection() as db:
            for row in db.execute("SELECT page,color,rects FROM bookmarks WHERE paper_id=? AND side=? AND kind='highlight'"
                                  " ORDER BY page,id", (paper_id, side)):
                pages.setdefault(row["page"], []).append(
                    {"color": HIGHLIGHT_COLORS.get(row["color"], HIGHLIGHT_COLORS["yellow"]), "rects": json.loads(row["rects"])})
        return pages

    def delete_bookmark(self, paper_id: str, bookmark_id: int) -> bool:
        self.paper(paper_id)
        with self.connection() as db:
            return db.execute("DELETE FROM bookmarks WHERE paper_id=? AND id=?",
                              (paper_id, bookmark_id)).rowcount > 0

    # --- Freehand ink, per paper, side ("original"/"translated") and page ---

    def ink(self, paper_id: str, side: str, page: int) -> list[dict]:
        with self.connection() as db:
            row = db.execute("SELECT strokes FROM pdf_ink WHERE paper_id=? AND side=? AND page=?",
                             (paper_id, side, page)).fetchone()
        return json.loads(row["strokes"]) if row else []

    def save_ink(self, paper_id: str, side: str, page: int, strokes: list[dict]) -> None:
        with self.connection() as db:
            db.execute("INSERT INTO pdf_ink(paper_id,side,page,strokes) VALUES(?,?,?,?) "
                       "ON CONFLICT(paper_id,side,page) DO UPDATE SET strokes=excluded.strokes",
                       (paper_id, side, page, json.dumps(strokes, separators=(",", ":"))))

    def ink_by_page(self, paper_id: str, side: str) -> dict[int, list[dict]]:
        with self.connection() as db:
            return {row["page"]: json.loads(row["strokes"]) for row in db.execute(
                "SELECT page,strokes FROM pdf_ink WHERE paper_id=? AND side=?", (paper_id, side))}

    def ink_pages(self, paper_id: str) -> list[dict]:
        """Pages that have ink, with the number of strokes on each."""
        with self.connection() as db:
            rows = db.execute("SELECT side,page,strokes FROM pdf_ink WHERE paper_id=? ORDER BY page,side",
                              (paper_id,)).fetchall()
        return [{"side": row["side"], "page": row["page"], "count": len(value)}
                for row in rows if (value := json.loads(row["strokes"]))]
