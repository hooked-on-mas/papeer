"""Only expose figure assets with identifiable source evidence to text-only summarizers."""
from __future__ import annotations

import re
from typing import cast
import pymupdf as fitz

from papeer.layout.figure_layout import figure_caption_match, raster_figures


# Summary crops are caption-bound, so accept publishers that omit punctuation after the number.
SUMMARY_CAPTION = re.compile(r"(?:Fig(?:ure)?|Table)\.?\s*(?:\d+|[IVX]+)(?:[.:]|(?=\s|$))", re.I)


def summary_figures(page: fitz.Page, blocks: list[dict], number: int) -> list[dict]:
    """Bind crops to captions and combine panels belonging to the same physical caption.

    A PDF image object is not necessarily a semantic figure. Without a caption we
    cannot describe it through the text-only provider contract, so it stays out
    of both the notes and the article catalog. The original PDF is unaffected.
    """
    found = [(b["id"], b["kind"], fitz.Rect(b["bbox"])) for b in blocks
             if b["page"] == number and b.get("kind") in {"figure", "table"}]
    found += [(f"p{number}i{index + 1}", "figure", rect) for index, rect
              in enumerate(raster_figures(page, [], include_strips=True))]
    lines = [line for block in cast(dict, page.get_text("dict"))["blocks"] for line in block.get("lines", [])]
    clusters = page.cluster_drawings(x_tolerance=6, y_tolerance=6)
    # Some PDFs put a plot and later graphics in one drawing path. A caption inside that path
    # separates the top figure from the later content; never crop through the caption itself.
    for index, rect in enumerate(clusters):
        separators = [fitz.Rect(line["bbox"]) for line in lines
                      if SUMMARY_CAPTION.match("".join(s["text"] for s in line["spans"]).strip())
                      and rect.y0 + 35 < line["bbox"][1] < rect.y1
                      and line["bbox"][0] < rect.x1 and line["bbox"][2] + 40 > rect.x0]
        if separators:
            top = min(separators, key=lambda box: box.y0)
            # The caption number itself may sit far left of the chart. Check its full description.
            clipped = fitz.Rect(rect.x0, rect.y0, rect.x1, top.y0 - 6)
            if figure_caption_match(page, clipped, SUMMARY_CAPTION, prefer_placement=True):
                found.append((f"p{number}c{index + 1}", "figure", clipped))
    # Fresh drawing clusters recover full composite figures and legends missed by older extraction.
    # This does not change translation regions: only caption-bound summary assets use these crops.
    found += [(f"p{number}v{index + 1}", "figure", rect) for index, rect
              in enumerate(clusters)
              if rect.width >= 60 and rect.height >= 35 and rect.get_area() < page.rect.get_area() * .8]
    groups = {}
    unbound = []
    for block_id, kind, rect in found:
        match = figure_caption_match(page, rect, SUMMARY_CAPTION, prefer_placement=True)
        if match is None:
            unbound.append(rect)
            continue
        location, caption = match
        label = SUMMARY_CAPTION.match(caption)
        if label is None or not caption[label.end():].strip(" .:;–—-"):
            continue
        key = tuple(location)  # pyright: ignore[reportArgumentType]
        if key in groups:
            groups[key]["rect"] |= rect
        else:
            groups[key] = {"id": block_id, "kind": kind, "rect": rect, "caption": caption}
    # Stacked panels can be farther than 40pt from their shared caption. Grow from the bound
    # bottom panel through neighboring graphic regions, stopping at captions or intervening prose.
    while unbound:
        attached = False
        for rect in list(unbound):
            owners = []
            for location, item in groups.items():
                combined = item["rect"] | rect
                gap = max(rect.y0 - item["rect"].y1, item["rect"].y0 - rect.y1, 0)
                if (gap > 40 or rect.x1 < item["rect"].x0 or rect.x0 > item["rect"].x1
                        or combined.y1 > location[1] + 2):
                    continue
                blocked = False
                for line in lines:
                    box = fitz.Rect(line["bbox"])
                    text = "".join(span["text"] for span in line["spans"]).strip()
                    if box.intersects(combined) and not box.intersects(rect) and not box.intersects(item["rect"]):
                        if SUMMARY_CAPTION.match(text) or len(text) > 100:
                            blocked = True
                            break
                if not blocked:
                    owners.append(item)
            if len(owners) == 1:
                owners[0]["rect"] |= rect
                unbound.remove(rect)
                attached = True
        if not attached:
            break
    for location, item in groups.items():
        rect = item["rect"]
        nearby = rect + (-18, -12, 18, 16)
        for line in lines:
            text = "".join(span["text"] for span in line["spans"]).strip()
            box = fitz.Rect(line["bbox"])
            # Include complete short labels even when they protrude past the plot/image boundary.
            if (text and len(text) < 80 and not SUMMARY_CAPTION.match(text)
                    and not box.intersects(fitz.Rect(location))
                    and (box in nearby or (box.intersects(rect) and box.y0 >= nearby.y0 and box.y1 <= nearby.y1))):
                rect |= box
        item["rect"] = rect & page.rect
    return sorted(groups.values(), key=lambda item: (item["rect"].y0, item["rect"].x0))
