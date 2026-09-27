from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
import re
import threading

import pymupdf as fitz

from papeer.layout.math_layout import LAYOUT_VERSION, MATH_TOKEN, annotate_math_fonts, formula_only_block, layout_blocks, merge_overlapping_prose, merge_continued_prose
from papeer.core.bibliography import extract_bibliography
from papeer.core.fileio import atomic_output
from papeer.layout.reference_layout import mark_references
from papeer.pdf.pdf_math_crops import formula_crop, page_glyph_bounds
from papeer.layout.table_layout import separate_tables, table_regions
from papeer.layout.figure_layout import figure_regions
from papeer.layout.algorithm_layout import separate_algorithms
from papeer.layout.reading_flow import order_page, continuation_groups, translation_blocks, materialize_flows
from papeer.pdf.pdf_typography import FONT_CSS, TextStyle, body_font_size, first_line_indented, font_archive, merge_wrapped_headings, reading_space, running_headers, text_html, text_style


# MuPDF must not be called concurrently from the UI and background jobs.
PDF_LOCK = threading.RLock()


def extract_pdf(path: Path) -> dict:
    with PDF_LOCK, fitz.open(path) as document:
        if document.needs_pass:
            raise ValueError("パスワード付きPDFです。解除したコピーを追加してください。")
        if not document.page_count:
            raise ValueError("PDFにページがありません。")
        blocks, pages, empty_pages = [], [], []
        for number, page in enumerate(document):
            page_blocks = []
            block_seq = 1
            items = page.get_text("rawdict", sort=True, flags=fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]
            annotate_math_fonts(items)
            items, algorithms, algorithm_regions = separate_algorithms(page, items)
            figures = figure_regions(page)
            tables = [r for r in table_regions(page) if not any(r.intersects(f) for f in figures + algorithm_regions)]
            items, tables = separate_tables(items, tables, number + 1)
            items, figures = separate_tables(items, figures, number + 1, kind="figure")
            for item in items:
                if item.get("type") != 0:
                    continue
                new_blocks = layout_blocks(item, number + 1, block_seq)
                block_seq += len(new_blocks)
                page_blocks.extend(new_blocks)
            page_blocks = merge_overlapping_prose(page_blocks)
            page_blocks = merge_continued_prose(page_blocks)
            for item in algorithms:
                new_blocks = layout_blocks(item, number + 1, block_seq)
                block_seq += len(new_blocks)
                page_blocks.extend(new_blocks)
            page_blocks.extend(tables + figures)
            page_blocks = merge_wrapped_headings(page_blocks, {number + 1: page.cropbox.height})
            if tables or figures or algorithms:
                page_blocks.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
            if not page_blocks:
                empty_pages.append(number + 1)
            blocks.extend(page_blocks)
            pages.append({"number": number + 1, "text": "\n\n".join(b["text"] for b in page_blocks),
                          "width": page.cropbox.width, "height": page.cropbox.height,
                          "rotation": page.rotation})
        title = (document.metadata or {}).get("title", "").strip()
        if not title or len(title) > 240:
            title = path.stem
        result = {**extract_bibliography(document), "layout_version": LAYOUT_VERSION, "title": title, "pages": pages, "blocks": blocks,
                "empty_pages": empty_pages, "page_count": len(pages)}
        ordered = []
        headers = running_headers(result)
        for info in pages:
            page_blocks, info['reading_order'] = order_page(
                [b for b in headers if b['page'] == info['number']], info['width'], info['height'])
            ordered.extend(page_blocks)
            info['text'] = '\n\n'.join(b['text'] for b in page_blocks)
        result['blocks'] = ordered
        mark_references(result)
        result['continuations'], result['continuation_decisions'] = continuation_groups(result)
        return result


# Longest source text sent as one translation unit; longer blocks are split (tests lower it).
UNIT_LIMIT = 6500
# ". " followed by a capital: a sentence end unless the word before the period is an
# abbreviation. A decimal ("3.5") has no space after the point. Group 1 is the word before
# the mark, matched from its start so that checking it stays linear in the block length.
_SENTENCE_MARK = r"""(\S*?)[.!?]["'”’)\]]*(\s+)(?=["“‘(\[]?[A-Z])"""
_SENTENCE_END = re.compile(r"(?<!\S)" + _SENTENCE_MARK)
# A unit that starts inside a word (after a cut at a math marker): the rest of that word.
_SENTENCE_END_AT = re.compile(_SENTENCE_MARK)
_ABBREVIATIONS = {
    "al", "app", "approx", "art", "ca", "cf", "ch", "chap", "co", "col", "cor", "corp", "def", "dept",
    "dr", "ed", "eds", "eq", "eqs", "est", "etc", "ex", "fig", "figs", "inc", "jr", "lem", "ltd",
    "mr", "mrs", "ms", "no", "nos", "p", "pp", "prof", "prop", "ref", "refs", "resp", "sec", "secs",
    "sect", "sr", "st", "sup", "suppl", "tab", "thm", "viz", "vol", "vols", "vs"}


def _sentence_end(text: str, match: re.Match) -> bool:
    if text[match.end(1)] != ".":
        return True
    word = match[1]
    if match.start(1) and not text[match.start(1) - 1].isspace():
        word = re.search(r"\S*$", text[:match.end(1)])[0]
    word = word.lstrip("([{\"'“‘")
    # "e.g.", "i.e.", "U.S." and initials ("J. Smith") are not sentence ends.
    if "." in word or re.fullmatch(r"[A-Z]", word):
        return False
    return word.casefold() not in _ABBREVIATIONS


def _unit_end(text: str, start: int, limit: int) -> int:
    """End of the unit starting at start: the last sentence end within the limit, else the
    last space, else the limit itself (never inside a math marker)."""
    end = start + limit
    if end >= len(text):
        return len(text)
    matches = list(_SENTENCE_END.finditer(text, start, end + 1))
    if start and not text[start - 1].isspace() and (first := _SENTENCE_END_AT.match(text, start, end + 1)):
        matches.insert(0, first)
    sentences = [m.end() for m in matches if start < m.end() <= end and _sentence_end(text, m)]
    if sentences:
        return sentences[-1]
    spaces = [m.end() for m in re.finditer(r"\s+", text[start:end])]
    if spaces:
        return start + spaces[-1]
    for token in MATH_TOKEN.finditer(text, start):
        if token.start() >= end:
            break
        if token.start() < end < token.end():
            return token.start() if token.start() > start else token.end()
    return end


def translation_units(document: dict, limit: int | None = None) -> list[dict]:
    limit = UNIT_LIMIT if limit is None else limit
    if limit <= 0:
        raise ValueError("翻訳単位の文字数上限は正の数にしてください。")
    units = []
    for block in translation_blocks(document):
        if block.get("kind") in {"formula", "table", "reference", "figure", "algorithm"} or formula_only_block(block):
            continue
        text = block.get("translation_text", block["text"])
        # Pure page numbers and symbol-only blocks are retained verbatim.
        if not re.search(r"[A-Za-z\u3040-\u30ff\u3400-\u9fff]", text):
            continue
        start, index = 0, 0
        while start < len(text):
            end = _unit_end(text, start, limit)
            units.append({"id": f"{block['id']}_{index}", "block": block["id"],
                          "page": block["page"], "text": text[start:end],
                          **({k: block[k] for k in ("flow_pages", "flow_blocks")} if "flow_pages" in block else {})})
            start, index = end, index + 1
    return units


def batches(units: list[dict], limit: int = 9000):
    batch, length = [], 0
    for unit in units:
        size = len(unit["text"]) + 100 + (len(json.dumps(unit["context"], ensure_ascii=False)) if unit.get("context") else 0)
        if batch and length + size > limit:
            yield batch
            batch, length = [], 0
        batch.append(unit)
        length += size
    if batch:
        yield batch


def _reading_order(images: list[dict]) -> list[dict]:
    """Images placed by insert_htmlbox, line by line and left to right."""
    lines: list[list[dict]] = []
    for image in sorted(images, key=lambda img: (img['bbox'][1] + img['bbox'][3]) / 2):
        middle = (image['bbox'][1] + image['bbox'][3]) / 2
        # Same line when its middle falls within the line's first image.
        if lines and lines[-1][0]['bbox'][1] <= middle <= lines[-1][0]['bbox'][3]:
            lines[-1].append(image)
        else:
            lines.append([image])
    return [image for line in lines for image in sorted(line, key=lambda img: img['bbox'][0])]


def _space_without_formulas(rect: fitz.Rect, formulas: list[fitz.Rect]) -> fitz.Rect:
    """Find space for prose when a publisher's text box overlaps display math."""
    candidates = [rect]
    for formula in formulas:
        available = []
        for candidate in candidates:
            cut = candidate & formula
            if cut.is_empty:
                available.append(candidate)
                continue
            pieces = [fitz.Rect(candidate.x0, candidate.y0, cut.x0, candidate.y1),
                      fitz.Rect(cut.x1, candidate.y0, candidate.x1, candidate.y1),
                      fitz.Rect(candidate.x0, candidate.y0, candidate.x1, cut.y0),
                      fitz.Rect(candidate.x0, cut.y1, candidate.x1, candidate.y1)]
            available.extend(piece for piece in pieces if piece.width > 4 and piece.height > 4)
        candidates = available
    if not candidates:
        raise ValueError("本文と数式・表の領域を分離できませんでした。未完成のPDFは保存していません。")
    return max(candidates, key=lambda candidate: candidate.get_area())


def build_translated_pdf(source: Path, document: dict, translations: dict[str, str], output: Path,
                         page_numbers: set[int] | None = None,
                         translate_page_numbers: set[int] | None = None) -> dict:
    """Preserve tables and display math; reinsert inline math in the translation."""
    output.parent.mkdir(parents=True, exist_ok=True)
    scaled_blocks = 0
    inline_formulas = 0
    readability_warnings = []
    preserved_margin_blocks = []
    compact_blocks = []
    preserved_label_blocks = []
    document, translations = materialize_flows(document, translations)
    document = dict(document, blocks=running_headers(document))
    document = dict(document, blocks=[dict(b, kind="formula", formulas=[]) if formula_only_block(b) else b
                                     for b in document["blocks"]])
    # Legacy extraction can split the beginning of a line (with tall inline
    # math) from its continuation. Lay out overlapping translated fragments
    # together, without changing persisted IDs or invalidating the cache.
    translations = dict(translations)
    heading_blocks = merge_wrapped_headings(document["blocks"], {p["number"]: p["height"] for p in document["pages"]})
    original_blocks = {b["id"]: b for b in document["blocks"]}
    restored = []
    for block in heading_blocks:
        parts = block.get("heading_parts", [])
        # Fresh extraction already translated the complete heading under one ID.
        # Legacy caches may still have a separate translation for every line.
        if len(parts) > 1 and all(part in original_blocks for part in parts):
            if all(part in translations for part in parts):
                translations[block["id"]] = " ".join(translations[part] for part in parts)
            else:
                restored.extend(original_blocks[part] for part in parts)
                continue
        restored.append(block)
    document = dict(document, blocks=restored)
    merged = []
    for block in document["blocks"]:
        box = fitz.Rect(block["bbox"])
        target = next((b for b in reversed(merged)
                       if b["page"] == block["page"]
                       and b.get("kind") == block.get("kind") == "text"
                       and b["id"] in translations and block["id"] in translations
                       and abs(b["bbox"][0] - box.x0) < 8
                       and min(b["bbox"][3], box.y1) > max(b["bbox"][1], box.y0)), None)
        if target is None:
            merged.append(dict(block))
        else:
            target["bbox"] = list(fitz.Rect(target["bbox"]) | box)
            if target.get("regions") and block.get("regions"):
                target["regions"] = target["regions"] + block["regions"]
            else:
                target.pop("regions", None)
            target["text"] += " " + block["text"]
            target["formulas"] = target.get("formulas", []) + block.get("formulas", [])
            translations[target["id"]] += " " + translations[block["id"]]
    document = dict(document, blocks=merged)
    selected = set(range(1, document["page_count"] + 1)) if page_numbers is None else set(page_numbers)
    if not selected or not selected <= set(range(1, document["page_count"] + 1)):
        raise ValueError("生成するページ番号が不正です。")
    # Older caches have only the union box, which can include prose between
    # equation lines. Enrich geometry without changing IDs or translation tokens.
    if any(b.get("kind") == "formula" and "regions" not in b for b in document["blocks"]):
        # Geometry/text are stable even if newer extraction adds table blocks
        # and renumbers the other blocks. Never associate crops by ID alone.
        fresh = {}
        with PDF_LOCK, fitz.open(source) as geometry_source:
            for number, page in enumerate(geometry_source, 1):
                items = page.get_text("rawdict", sort=True,
                    flags=fitz.TEXTFLAGS_RAWDICT & ~fitz.TEXT_PRESERVE_IMAGES)["blocks"]
                annotate_math_fonts(items)
                # Recreate pre-table grouping for legacy caches. Table extraction
                # can split an old formula group even when the PDF is identical.
                for item in items:
                    if item.get("type") == 0:
                        for b in layout_blocks(item, number, 1):
                            fresh[(number, b["text"], tuple(b["bbox"]))] = b
        enriched = []
        for block in document["blocks"]:
            match = fresh.get((block["page"], block["text"], tuple(block["bbox"])), {})
            if (block.get("kind") == "formula" and "regions" not in block
                    and match.get("text") == block["text"] and match.get("bbox") == block["bbox"]):
                block = dict(block, regions=match["regions"])
            enriched.append(block)
        document = dict(document, blocks=enriched)
    with PDF_LOCK, fitz.open(source) as pdf, fitz.open(source) as original:
        fonts = font_archive("".join(translations.values())) if translations else fitz.Archive()
        by_page: dict[int, list] = {}
        for block in document["blocks"]:
            if block["id"] in translations and block.get("kind") not in {"formula", "table", "reference", "figure", "algorithm"}:
                by_page.setdefault(block["page"], []).append(block)
        for number in range(document["page_count"]):
            if number + 1 not in selected or (translate_page_numbers is not None and number + 1 not in translate_page_numbers):
                continue
            page = pdf[number]
            rotation = page.rotation
            page.set_rotation(0)
            original[number].set_rotation(0)
            glyph_bounds = page_glyph_bounds(original[number])
            planned = []
            # Text extraction coordinates are unrotated; the media box uses the same coordinates.
            bounds = fitz.Rect(0, 0, page.cropbox.width, page.cropbox.height)
            page_blocks = [b for b in document["blocks"] if b["page"] == number + 1]
            # Old caches may contain only block boxes. Recover line geometry
            # from the source without re-extracting IDs or invalidating translations.
            source_lines = None
            obstacles = [fitz.Rect(item["bbox"]) for item in page.get_image_info()]
            obstacles.extend(fitz.Rect(item["rect"]) for item in page.get_drawings())
            body_size = body_font_size(page_blocks)
            # Preserve the full box for isolated math (including fraction bars).
            # Where it encloses prose, protect the actual equation lines instead.
            prose_rects = [fitz.Rect(b["bbox"]) for b in page_blocks if b.get("kind") not in {"formula", "table", "reference", "figure", "algorithm"}]
            full_boxes = [fitz.Rect(b["bbox"]) & bounds for b in page_blocks if b.get("kind") == "formula"]
            enclosed_prose = []
            for rect in prose_rects:
                try:
                    _space_without_formulas(rect & bounds, full_boxes)
                except ValueError:
                    enclosed_prose.append(rect)
            display_rects = []
            for block in page_blocks:
                if block.get("kind") not in {"formula", "table", "reference", "figure", "algorithm"}:
                    continue
                box = fitz.Rect(block["bbox"])
                regions = (block.get("regions", [block["bbox"]])
                           if any(box.intersects(rect) for rect in enclosed_prose) else [block["bbox"]])
                display_rects.extend(fitz.Rect(region) & bounds for region in regions)
            restore_rects = []
            for block in by_page.get(number + 1, []):
                rect = fitz.Rect(block["bbox"]) & bounds
                if (re.fullmatch(r"[A-Za-z]{1,4}", block["text"].strip())
                        and rect.width < block["font_size"] * 2
                        and rect.height < block["font_size"] * 3):
                    preserved_label_blocks.append(block["id"])
                    continue
                if rect.width < 45 and rect.height > rect.width * 4 and len(block["text"]) > 25:
                    preserved_margin_blocks.append(block["id"])
                    continue
                style = text_style(block, body_size, bounds.height)
                overlapping = [formula for formula in display_rects if rect.intersects(formula)]
                placement = _space_without_formulas(reading_space(block, style, page_blocks, bounds, obstacles), display_rects)
                restore_rects.extend(overlapping)
                text = translations[block["id"]]
                formulas = block.get("formulas", [])
                if Counter(MATH_TOKEN.findall(text)) != Counter(f["token"] for f in formulas):
                    raise ValueError("訳文中の数式の目印が欠落・重複しています。再翻訳してください。")
                archive = fitz.Archive()
                archive.add(fonts)
                images = {}
                for index, formula in enumerate(formulas):
                    source_number = formula.get('source_page', number + 1) - 1
                    source_page = original[source_number]
                    source_page.set_rotation(0)
                    source_glyphs = glyph_bounds if source_number == number else page_glyph_bounds(source_page)
                    crop = formula_crop(formula, source_glyphs) & source_page.rect
                    name = f"{block['id']}-{index}.png"
                    pixels = source_page.get_pixmap(matrix=fitz.Matrix(4, 4), clip=crop, alpha=False)
                    archive.add((pixels.tobytes("png"), name))
                    em = max(1, block["font_size"])
                    descent = (crop.y1 - formula["baseline"]) / em
                    images[formula["token"]] = (
                        f'<img src="{name}" style="width:{crop.width / em:.4f}em;'
                        f'height:{crop.height / em:.4f}em;vertical-align:{-descent:.4f}em">')
                if not block.get("regions"):
                    if source_lines is None:
                        source_lines = [fitz.Rect(line["bbox"])
                            for item in original[number].get_text("dict")["blocks"]
                            if item.get("type") == 0 for line in item["lines"]]
                    regions = [list(line & rect) for line in source_lines
                               if rect.contains((line.tl + line.br) / 2)]
                    block = dict(block, regions=regions)
                markup = text_html(text, style, images, first_indent=first_line_indented(block))
                with fitz.open() as probe:
                    candidate = probe.new_page(width=bounds.width, height=bounds.height)
                    remaining, scale = candidate.insert_htmlbox(placement, markup, archive=archive, css=FONT_CSS, scale_low=0)
                # Tight, short lead-ins around equations should keep readable
                # glyphs before sacrificing font size. Never compact paragraphs.
                if (scale < .85 and style.role == "body" and placement.height < style.size * 3
                        and len(MATH_TOKEN.sub("x", text)) < 160):
                    compact = text_html(text, TextStyle("compact", style.size, 1.15), images)
                    with fitz.open() as probe:
                        candidate = probe.new_page(width=bounds.width, height=bounds.height)
                        compact_remaining, compact_scale = candidate.insert_htmlbox(
                            placement, compact, archive=archive, css=FONT_CSS, scale_low=0)
                    if compact_remaining >= 0 and compact_scale > scale:
                        markup, remaining, scale = compact, compact_remaining, compact_scale
                        compact_blocks.append(block["id"])
                if remaining < 0:
                    raise RuntimeError("訳文を元のページ内に配置できませんでした。未完成のPDFは保存していません。")
                scaled_blocks += int(scale < 0.60)
                if style.size * scale < (6 if style.role == "footer" else 8):
                    readability_warnings.append({"page": number + 1, "block": block["id"],
                        "font_size": round(style.size * scale, 2), "scale": round(scale, 3)})
                inline_formulas += len(formulas)
                page.add_redact_annot(rect, fill=(1, 1, 1), cross_out=False)
                # In the translation's order, which the laid-out images follow; word order may differ from the source.
                by_token = {}
                for formula in formulas:
                    by_token.setdefault(formula["token"], []).append(formula)
                planned.append((placement, markup, archive, [by_token[token].pop(0) for token in MATH_TOKEN.findall(text)]))
            if planned:
                page.apply_redactions(images=0, graphics=0, text=0)
                # Redaction removes any glyph touching a text box. Restore math
                # from a separate source document, retaining vector quality.
                for rect in restore_rects:
                    page.draw_rect(rect, color=None, fill=(1, 1, 1), overlay=True)
                    page.show_pdf_page(rect, original, number, clip=rect)
                for rect, markup, archive, formulas in planned:
                    images_before = {tuple(img['bbox']) for img in page.get_image_info()}
                    remaining, _ = page.insert_htmlbox(rect, markup, archive=archive, css=FONT_CSS, scale_low=0)
                    if remaining < 0:
                        raise RuntimeError("訳文の描画に失敗しました。未完成のPDFは保存していません。")
                    if formulas:
                        images_after = page.get_image_info()
                        new_images = [img for img in images_after if tuple(img['bbox']) not in images_before]
                        for img, formula in zip(_reading_order(new_images), formulas):
                            img_rect = fitz.Rect(img['bbox'])
                            fontsize = img_rect.height
                            while fontsize >= 0.1:
                                if page.insert_textbox(img_rect, formula["text"], fontsize=fontsize, render_mode=3) >= 0:
                                    break
                                fontsize *= 0.9
            page.set_rotation(rotation)
        if page_numbers is not None:
            pdf.select([number - 1 for number in sorted(selected)])
        pdf.set_metadata({"title": document["title"] + " - 日本語訳", "creator": "Papeer"})
        with atomic_output(output) as temporary:
            pdf.save(temporary, garbage=4, deflate=True)
        return {"overflow_blocks": 0, "pages": pdf.page_count, "supplements": [],
                "scaled_blocks": scaled_blocks, "inline_formulas": inline_formulas,
                "readability_warnings": readability_warnings, "preserved_margin_blocks": preserved_margin_blocks,
                "compact_blocks": compact_blocks,
                "preserved_label_blocks": preserved_label_blocks,
                "preserved_reference_blocks": [b["id"] for b in document["blocks"]
                                               if b.get("kind") == "reference" and b["page"] in selected],
                "preserved_algorithm_blocks": sum(b.get("kind") == "algorithm" and b["page"] in selected for b in document["blocks"]),
                "preserved_figure_blocks": sum(b.get("kind") == "figure" and b["page"] in selected for b in document["blocks"]),
                "preserved_table_blocks": sum(b.get("kind") == "table" and b["page"] in selected for b in document["blocks"]),
                "preserved_formula_blocks": sum(b.get("kind") == "formula" and b["page"] in selected for b in document["blocks"])}


def interleaved_pdf(source: Path, translated: Path, output: Path) -> None:
    """Alternate original / translated pages, retaining each page's geometry."""
    if output.resolve() in {source.resolve(), translated.resolve()}:
        raise ValueError("原文・日本語訳とは別の保存先を選んでください。")
    output.parent.mkdir(parents=True, exist_ok=True)
    with PDF_LOCK, fitz.open(source) as original, fitz.open(translated) as japanese, fitz.open() as result:
        if original.page_count != japanese.page_count:
            raise ValueError("原文と日本語訳のページ数が一致しません。再翻訳してから交互PDFを作成してください。")
        for index in range(original.page_count):
            result.insert_pdf(original, from_page=index, to_page=index)
            result.insert_pdf(japanese, from_page=index, to_page=index)
        result.set_metadata({"title": (original.metadata.get("title") or source.stem) + " - 原文・日本語訳（交互）",
                             "creator": "Papeer"})
        with atomic_output(output) as temporary:
            result.save(temporary, garbage=4, deflate=True)


def bilingual_pdf(source: Path, translated: Path, output: Path) -> None:
    with PDF_LOCK, fitz.open(source) as original, fitz.open(translated) as japanese, fitz.open() as result:
        for index in range(japanese.page_count):
            right = japanese[index]
            if index < original.page_count:
                left = original[index]
                height = max(left.rect.height, right.rect.height)
                page = result.new_page(width=left.rect.width + right.rect.width + 16, height=height)
                page.show_pdf_page(fitz.Rect(0, 0, left.rect.width, left.rect.height), original, index)
                page.show_pdf_page(fitz.Rect(left.rect.width + 16, 0, page.rect.width, right.rect.height), japanese, index)
            else:
                result.insert_pdf(japanese, from_page=index, to_page=index)
        with atomic_output(output) as temporary:
            result.save(temporary, garbage=4, deflate=True)


def page_png(path: Path, index: int, width: int = 650) -> bytes | None:
    from papeer.pdf.pdf_viewer import page_png as render_png
    return render_png(path, index, width)
