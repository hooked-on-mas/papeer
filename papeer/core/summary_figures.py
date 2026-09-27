"""Only expose figure assets with identifiable source evidence to text-only summarizers."""
from __future__ import annotations

import pymupdf as fitz

from papeer.layout.figure_layout import CAPTION, figure_caption_match, raster_figures


def summary_figures(page: fitz.Page, blocks: list[dict], number: int) -> list[dict]:
    """Bind crops to captions and combine panels belonging to the same physical caption.

    A PDF image object is not necessarily a semantic figure. Without a caption we
    cannot describe it through the text-only provider contract, so it stays out
    of both the notes and the article catalog. The original PDF is unaffected.
    """
    found = [(b["id"], b["kind"], fitz.Rect(b["bbox"])) for b in blocks
             if b["page"] == number and b.get("kind") in {"figure", "table"}]
    found += [(f"p{number}i{index + 1}", "figure", rect) for index, rect
              in enumerate(raster_figures(page, [rect for *_, rect in found]))]
    groups = {}
    for block_id, kind, rect in found:
        match = figure_caption_match(page, rect)
        if match is None:
            continue
        location, caption = match
        label = CAPTION.match(caption)
        if label is None or not caption[label.end():].strip(" .:;–—-"):
            continue
        key = tuple(location)
        if key in groups:
            groups[key]["rect"] |= rect
        else:
            groups[key] = {"id": block_id, "kind": kind, "rect": rect, "caption": caption}
    return sorted(groups.values(), key=lambda item: (item["rect"].y0, item["rect"].x0))
