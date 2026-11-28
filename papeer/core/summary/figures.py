"""Only expose figure assets with identifiable source evidence to text-only summarizers."""
from __future__ import annotations

import re
from copy import deepcopy
from typing import cast
import pymupdf as fitz

from papeer.layout.figure_layout import figure_caption_match, raster_figures


# Summary crops are caption-bound, so accept publishers that omit punctuation after the number.
SUMMARY_CAPTION = re.compile(
    r"(?:(?P<table>Table|표|表)|Fig(?:ure)?|그림|図|图)\.?\s*"
    r"(?>S?\d+(?:[.-]\d+)*|[A-Z](?:[.-]\d+)+|[A-Z]\d+|[IVX]+)(?:[.:：]|(?=\s|$))", re.I)

# Recorded with the source-bound image catalog; older reports must be rechecked.
SUMMARY_IMAGE_VERSION = 5


def render_summary_figure(page: fitz.Page, figure: dict, dpi: int = 150) -> bytes:
    """Render the original source crop upright, including landscape content on portrait pages."""
    matrix = fitz.Matrix(dpi / 72, dpi / 72).prerotate(figure.get("rotation", 0))
    pixmap = page.get_pixmap(clip=figure["rect"], matrix=matrix)
    pixmap.set_dpi(dpi, dpi)
    return pixmap.tobytes("png")


def summary_caption_labels(page: fitz.Page) -> list[str]:
    """Physical caption labels, excluding prose references and contents leaders."""
    blocks = _caption_blocks(cast(dict, page.get_text(
        "dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES))["blocks"])
    return [text for block in blocks for line in block.get("lines", [])
            if SUMMARY_CAPTION.match(text := " ".join("".join(s["text"] for s in line["spans"]).split()))]


def _caption_blocks(blocks: list[dict]) -> list[dict]:
    """Exclude running prose and lists of figures from the caption evidence."""
    sizes: dict[str, float] = {}
    for block in blocks:
        for line in block.get("lines", []):
            text = " ".join("".join(s["text"] for s in line["spans"]).split())
            if label := SUMMARY_CAPTION.match(text):
                key = re.sub(r"\s", "", label[0]).lower().rstrip(".:")
                sizes[key] = min(sizes.get(key, float("inf")), line["spans"][0]["size"])
    result = []
    for block in blocks:
        lines = []
        for line in block.get("lines", []):
            text = " ".join("".join(s["text"] for s in line["spans"]).split())
            label = SUMMARY_CAPTION.match(text)
            if label:
                key = re.sub(r"\s", "", label[0]).lower().rstrip(".:")
                if line["spans"][0]["size"] > sizes[key] + .5:
                    continue  # Same-page running reference in body type, not the smaller caption.
            if label and (re.match(r"(?:shows?|compares?|represents?|summari[sz]es?|illustrates?|"
                                        r"depicts?|presents?|lists?|reports?|evaluates?|fixes?)\b",
                                        text[label.end():].strip(), re.I)
                          or re.search(r"\.{3,}\s*\d+\s*$", text)):
                continue
            lines.append(line)
        result.append(dict(block, lines=lines))
    return result


def summary_figures(page: fitz.Page, blocks: list[dict], number: int, *, _include_rotated: bool = True,
                    following_page: fitz.Page | None = None) -> list[dict]:
    """Bind crops to captions and combine panels belonging to the same physical caption.

    A PDF image object is not necessarily a semantic figure. Without a caption we
    cannot describe it through the text-only provider contract, so it stays out
    of both the notes and the article catalog. The original PDF is unaffected.
    """
    found = [(b["id"], b["kind"], fitz.Rect(b["bbox"])) for b in blocks
             if b["page"] == number and b.get("kind") in {"figure", "table"}]
    found += [(f"p{number}i{index + 1}", "figure", rect) for index, rect
              in enumerate(raster_figures(page, [], include_strips=True))]
    text_blocks = _caption_blocks(cast(dict, page.get_text(
        "dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES))["blocks"])
    continued_label = None
    # A few publishers put the last figure's caption at the very top of the next
    # page. Recover only a bottom-of-page graphic with no intervening body text.
    # The rendered pixels still come exclusively from this original source page.
    if following_page is not None:
        following_blocks = _caption_blocks(cast(dict, following_page.get_text(
            "dict", flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES))["blocks"])
        for block in following_blocks:
            if not block.get("lines"):
                continue
            line = block["lines"][0]
            text = "".join(s["text"] for s in line["spans"]).strip()
            label = SUMMARY_CAPTION.match(text)
            if not label or label.group("table") or not 55 < line["bbox"][1] < 110:
                continue
            earlier = [b for b in following_blocks if b.get("lines") and 55 < b["bbox"][1] < line["bbox"][1] - 2]
            if earlier:
                continue
            candidates = [fitz.Rect(info["bbox"]) & page.rect for info in page.get_image_info()]
            candidates = [r for r in candidates if r.width > 100 and r.height > 40
                          and r.y1 > page.rect.height * .68 and r.get_area() < page.rect.get_area() * .8]
            if not candidates:
                continue
            bottom = max(candidates, key=lambda r: r.y1)
            if any(b.get("lines") and bottom.y1 < b["bbox"][1] < page.rect.height * .93
                   and len("".join(s["text"] for ln in b["lines"] for s in ln["spans"]).strip()) > 30
                   for b in text_blocks):
                continue
            transferred = deepcopy(block)
            dx, dy = bottom.x0 - block["bbox"][0], bottom.y1 + 6 - block["bbox"][1]
            def shifted(box, dx=dx, dy=dy):
                return (box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy)
            transferred["bbox"] = shifted(transferred["bbox"])
            for ln in transferred["lines"]:
                ln["bbox"] = shifted(ln["bbox"])
                for span in ln["spans"]:
                    span["bbox"] = shifted(span["bbox"])
                    span["origin"] = (span["origin"][0] + dx, span["origin"][1] + dy)
            text_blocks.append(transferred)
            continued_label = label[0]
            break
    rotations = set()
    for block in text_blocks:
        for line in block.get("lines", []):
            if SUMMARY_CAPTION.match("".join(s["text"] for s in line["spans"]).strip()):
                dx, dy = line.get("dir", (1, 0))
                if dy < -.9:
                    rotations.add(90)
                elif dy > .9:
                    rotations.add(270)
                elif dx < -.9:
                    rotations.add(180)
    # A vertical caption belongs to its rotated view, never to a neighboring
    # horizontal crop just because their unrotated rectangles happen to be near.
    text_blocks = [dict(block, lines=[line for line in block.get("lines", [])
        if not (SUMMARY_CAPTION.match("".join(s["text"] for s in line["spans"]).strip())
                and line.get("dir", (1, 0))[0] < .9)]) for block in text_blocks]
    lines = [line for block in text_blocks for line in block.get("lines", [])]
    def caption_match(rect):
        return figure_caption_match(page, rect, SUMMARY_CAPTION, prefer_placement=True,
                                    text_blocks=text_blocks, max_gap=90)
    # Some PDF image objects have invisible margins extending over their own caption.
    # Clip at that caption before judging the crop; translation's conservative image
    # detector correctly rejects such metadata boxes, but summaries can recover them.
    for index, info in enumerate(page.get_image_info()):
        rect = fitz.Rect(info["bbox"]) & page.rect
        if rect.width < 60 or rect.height < 40 or rect.get_area() > page.rect.get_area() * .8:
            continue
        embedded_captions = [fitz.Rect(line["bbox"]) for line in lines
            if SUMMARY_CAPTION.match("".join(s["text"] for s in line["spans"]).strip())
            and fitz.Rect(line["bbox"]).intersects(rect)]
        if any(abs(a.x0 - b.x0) > 50 and abs(a.y0 - b.y0) < 5
               for a in embedded_captions for b in embedded_captions):
            continue  # A watermark/backing image crossing distinct neighboring captions.
        for line in lines:
            text = "".join(s["text"] for s in line["spans"]).strip()
            label = SUMMARY_CAPTION.match(text)
            box = fitz.Rect(line["bbox"])
            if (label and not label.group("table") and rect.y0 + 35 < box.y0 < rect.y1
                    and box.x0 < rect.x1 and box.x1 > rect.x0):
                clipped = fitz.Rect(rect.x0, rect.y0, rect.x1, box.y0 - 3)
                if caption_match(clipped):
                    found.append((f"p{number}r{index + 1}", "figure", clipped))
        # A complete physical image with a caption is evidence even when its labels
        # resemble prose. Do not change translation's protected regions here.
        if caption_match(rect):
            found.append((f"p{number}r{index + 1}", "figure", rect))
    # Borderless tables and tables made from thin rules have no raster or drawing
    # cluster. PyMuPDF's line/text table detector supplies their actual cell region.
    table_labels = [line for line in lines if (label := SUMMARY_CAPTION.match(
        "".join(s["text"] for s in line["spans"]).strip())) and label.group("table")]
    if table_labels:
        split_found = []
        for identity, kind, rect in found:
            for ln in table_labels:
                if (kind == "table" and rect.y0 - 2 <= ln["bbox"][1] < rect.y0 + 15
                        and ln["bbox"][0] < rect.x1 and ln["bbox"][2] > rect.x0):
                    cap_end = next((b["bbox"][3] for b in text_blocks if ln in b.get("lines", [])), ln["bbox"][3])
                    rect = fitz.Rect(rect.x0, cap_end + 3, rect.x1, rect.y1)
            cuts = sorted((ln for ln in table_labels if kind == "table"
                           and rect.y0 + 15 < ln["bbox"][1] < rect.y1 - 20
                           and ln["bbox"][0] < rect.x1 and ln["bbox"][2] > rect.x0),
                          key=lambda ln: ln["bbox"][1])
            top = rect.y0
            for index, ln in enumerate(cuts):
                if ln["bbox"][1] - top < 35:
                    continue  # Adjacent bilingual labels describe one physical table.
                split_found.append((identity if top == rect.y0 else f"{identity}part{index + 1}",
                                    kind, fitz.Rect(rect.x0, top, rect.x1, ln["bbox"][1] - 3)))
                cap_end = next((b["bbox"][3] for b in text_blocks if ln in b.get("lines", [])), ln["bbox"][3])
                top = cap_end + 3
            if rect.y1 > top:
                split_found.append((identity if top == rect.y0 else f"{identity}part{len(cuts) + 1}",
                                    kind, fitz.Rect(rect.x0, top, rect.x1, rect.y1)))
        found = split_found
        def column_table(cap):
            middle = page.rect.width / 2
            return cap.x1 < middle and any(
                b["bbox"][0] > middle + 3 and b["bbox"][2] - b["bbox"][0] > page.rect.width * .25
                and len("".join(s["text"] for ln in b.get("lines", []) for s in ln["spans"])) > 60
                for b in text_blocks)
        tables = page.find_tables()
        for index, table in enumerate(tables.tables if tables else []):
            rect = fitz.Rect(table.bbox)
            match = caption_match(rect)
            if match and (label := SUMMARY_CAPTION.match(match[1])) and label.group("table"):
                found.append((f"p{number}d{index + 1}", "table", rect))
        def bound_table(cap):
            for _, _, candidate in found:
                match = caption_match(candidate)
                if (match and match[0].intersects(cap)
                        and (label := SUMMARY_CAPTION.match(match[1])) and label.group("table")):
                    return True
            return False
        # A borderless table can have no drawing primitives at all. Recover its
        # aligned cell rows immediately below a caption, stopping before prose.
        for index, caption_line in enumerate(table_labels):
            cap = fitz.Rect(caption_line["bbox"])
            if bound_table(cap):
                continue
            middle = page.rect.width / 2
            right = middle - 3 if column_table(cap) else page.rect.x1 - 20
            rows: list[list[fitz.Rect]] = []
            nearby = sorted((fitz.Rect(line["bbox"]) for line in lines
                             if line is not caption_line and line["bbox"][1] >= cap.y1 - 1
                             and line["bbox"][0] >= cap.x0 - 20 and line["bbox"][2] <= right),
                            key=lambda box: (box.y0, box.x0))
            for box in nearby:
                if rows and abs(box.y0 - rows[-1][0].y0) <= 3:
                    rows[-1].append(box)
                else:
                    rows.append([box])
            cells = []
            for row in rows:
                if not cells:
                    if row[0].y0 - cap.y1 > 65:
                        break
                    if len(row) < 3:
                        continue  # Wrapped caption description.
                elif row[0].y0 - max(box.y1 for box in cells) > 24 or len(row) < 2:
                    break
                cells.extend(row)
            if len(cells) >= 9:
                rect = fitz.Rect(cells[0])
                for box in cells[1:]:
                    rect |= box
                if ((match := caption_match(rect)) and (label := SUMMARY_CAPTION.match(match[1]))
                        and label.group("table")):
                    found.append((f"p{number}e{index + 1}", "table", rect))
        for index, caption_line in enumerate(table_labels):
            cap = fitz.Rect(caption_line["bbox"])
            if bound_table(cap):
                continue
            size = max(s["size"] for s in caption_line["spans"])
            # Use the caption's text column, rather than letting text-table detection
            # merge prose and tables from the whole page into one giant region.
            middle = page.rect.width / 2
            left, right = (middle + 3, page.rect.x1 - 20) if cap.x0 > middle else (20, page.rect.x1 - 20)
            if column_table(cap):
                right = middle - 3
            bottom = page.rect.y1 - 25
            for block in text_blocks:
                first = block.get("lines", [])[:1]
                if not first:
                    continue
                line = first[0]
                box = fitz.Rect(line["bbox"])
                text = "".join(s["text"] for s in line["spans"]).strip()
                prose = ((len(text) > 70 or len(text.split()) >= 8)
                         and max(s["size"] for s in line["spans"]) > size + .4)
                if (box.y0 > cap.y1 + 5 and box.x0 < right and box.x1 > left
                        and (SUMMARY_CAPTION.match(text) or prose)):
                    bottom = min(bottom, block["bbox"][1] - 3)
            clip = fitz.Rect(left, cap.y1 + 2, right, bottom)
            if clip.height < 25:
                continue
            detector = page.find_tables(clip=clip, strategy="text", min_words_vertical=2)
            for candidate_index, table in enumerate(detector.tables if detector else []):
                rect = fitz.Rect(table.bbox)
                if table.row_count < 2 or table.col_count < 2:
                    continue
                if ((match := caption_match(rect)) and (label := SUMMARY_CAPTION.match(match[1]))
                        and label.group("table")):
                    found.append((f"p{number}w{index + 1}x{candidate_index + 1}", "table", rect))
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
            if caption_match(clipped):
                found.append((f"p{number}c{index + 1}", "figure", clipped))
            # One drawing path may encode successive plots with captions between
            # them. Recover the later plots as well, without cropping across prose.
            ordered = sorted(separators, key=lambda box: box.y0)
            for separator_index, separator in enumerate(ordered):
                end = separator.y1
                for block in text_blocks:
                    if any(tuple(line["bbox"]) == (separator.x0, separator.y0, separator.x1, separator.y1)
                           for line in block.get("lines", [])):
                        end = max(end, block["bbox"][3])
                limit = ordered[separator_index + 1].y0 - 6 if separator_index + 1 < len(ordered) else rect.y1
                tail = fitz.Rect(rect.x0, end + 3, rect.x1, limit)
                if tail.height >= 35 and caption_match(tail):
                    found.append((f"p{number}c{index + 1}s{separator_index + 1}", "figure", tail))
    # Fresh drawing clusters recover full composite figures and legends missed by older extraction.
    # This does not change translation regions: only caption-bound summary assets use these crops.
    found += [(f"p{number}v{index + 1}", "figure", rect) for index, rect
              in enumerate(clusters)
              if rect.width >= 60 and rect.height >= 15 and rect.get_area() < page.rect.get_area() * .8]
    groups = {}
    unbound = []
    for block_id, kind, rect in found:
        match = caption_match(rect)
        if match is None:
            unbound.append(rect)
            continue
        location, caption = match
        label = SUMMARY_CAPTION.match(caption)
        if label is None or not caption[label.end():].strip(" .:;–—-"):
            continue
        neighboring_caption = any(
            abs(line["bbox"][1] - location.y0) < 5
            and abs(line["bbox"][0] - location.x0) > page.rect.width * .3
            and SUMMARY_CAPTION.match("".join(s["text"] for s in line["spans"]).strip())
            for line in lines)
        if neighboring_caption and rect.width > page.rect.width * .6 and location.width < page.rect.width * .48:
            middle = page.rect.width / 2
            if location.x1 < middle + 10:
                rect = rect & fitz.Rect(0, 0, middle - 3, page.rect.height)
            elif location.x0 > middle - 10:
                rect = rect & fitz.Rect(middle + 3, 0, page.rect.width, page.rect.height)
        key = tuple(location)  # pyright: ignore[reportArgumentType]
        preferred_table = bool(label.group("table")) and rect.y0 >= location.y1 - 2
        if key in groups:
            if label.group("table") and groups[key]["preferred_table"] != preferred_table:
                if preferred_table:
                    groups[key]["rect"] = rect
                    groups[key]["preferred_table"] = True
            else:
                groups[key]["rect"] |= rect
        else:
            groups[key] = {"id": block_id, "kind": "table" if label.group("table") else "figure",
                           "rect": rect, "caption": caption, "preferred_table": preferred_table}
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
        if item["kind"] == "table":
            for block in text_blocks:
                body = block.get("lines", [])
                first = "".join(s["text"] for s in body[0]["spans"]).strip() if body else ""
                if (re.match(r"Appendix\s+[A-Z](?:\.\d+)*\.", first)
                        and location[3] + 40 < block["bbox"][1] < rect.y1):
                    rect.y1 = block["bbox"][1] - 3
        nearby = rect + ((-18, -3, 18, 3) if item["kind"] == "table" else (-18, -12, 18, 16))
        for block in text_blocks:
            if (block["bbox"][0] < rect.x1 and block["bbox"][2] > rect.x0
                    and block["bbox"][3] <= rect.y0 + 2
                    and any(SUMMARY_CAPTION.match("".join(s["text"] for s in ln["spans"]).strip())
                            for ln in block.get("lines", []))):
                nearby.y0 = max(nearby.y0, block["bbox"][3] + 2)
        for line in lines:
            text = "".join(span["text"] for span in line["spans"]).strip()
            box = fitz.Rect(line["bbox"])
            # Include complete short labels even when they protrude past the plot/image boundary.
            if (text and len(text) < 80 and not SUMMARY_CAPTION.match(text)
                    and not box.intersects(fitz.Rect(location))
                    and (box in nearby or (box.intersects(rect) and box.y0 >= nearby.y0 and box.y1 <= nearby.y1))):
                rect |= box
        item["rect"] = rect & page.rect
        item.pop("preferred_table", None)
    items = sorted(groups.values(), key=lambda item: (item["rect"].y0, item["rect"].x0))
    if _include_rotated:
        for angle in sorted(rotations):
            matrix = fitz.Matrix(angle)
            bounds = page.rect * matrix
            matrix.e, matrix.f = -bounds.x0, -bounds.y0
            source_blocks = [dict(b, bbox=list(fitz.Rect(b["bbox"]) * matrix))  # pyright: ignore[reportArgumentType]
                             for b in blocks if b["page"] == number]
            with fitz.open() as normalized:
                target = normalized.new_page(width=bounds.width, height=bounds.height)
                source_index = page.number
                assert source_index is not None
                target.show_pdf_page(target.rect, page.parent, source_index, rotate=-angle)
                for item in summary_figures(target, source_blocks, number, _include_rotated=False):
                    items.append(dict(item, id=f"{item['id']}o{angle}", rect=item["rect"] * ~matrix,
                                      rotation=angle))
    used = set()
    for index, item in enumerate(items):
        if continued_label and item["caption"].startswith(continued_label):
            item["caption_page"] = number + 1
        if item["id"] in used:
            item["id"] += f"s{index + 1}"
        used.add(item["id"])
    return items
