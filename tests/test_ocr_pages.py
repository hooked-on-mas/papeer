"""Pages needing OCR (garbled text layer or scanned image) are kept as the original,
and the garbled paragraphs of a partly garbled page.

The math cases guard against false positives: symbol fonts, private-use math glyphs
and dvips Type3 math fonts (which extract as control characters) must not make a
readable page "要OCR".
"""
import json
import threading
import time

import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

from papeer.core.storage import Library
from papeer.core.translation_review import required_translation_pages
from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService
from papeer.layout.math_layout import annotate_math_fonts
from papeer.layout.ocr_pages import GARBLED_RATIO, PARTIAL_RATIO, garbled_ratio
from papeer.pdf.pdf_engine import extract_pdf, translation_units
from sidecar.app import app
from test_workflow import FakeProvider

PROSE = ("We show that the proposed controller improves the tracking accuracy of the plant. "
         "The analysis holds for every admissible input and for bounded disturbances.")


# --- Synthetic rawdict pages (garbled_ratio only reads fonts, characters and boxes).

def _items(*lines):
    """lines: [(font, text, math_font), ...] per line, laid out left to right."""
    result = []
    for row, spans in enumerate(lines):
        x, y = 50.0, 60.0 + row * 14
        line = {"spans": []}
        for font, text, math in spans:
            chars = []
            for c in text:
                chars.append({"c": c, "bbox": (x, y, x + 5, y + 10)})
                x += 5
            line["spans"].append({"font": font, "math_font": math, "chars": chars})
        line["bbox"] = (50.0, y, x, y + 10)
        result.append({"type": 0, "lines": [line]})
    return result


def _prose_lines(count=4):
    return [[("Times-Roman", PROSE[i * 40:(i + 1) * 40 + 40], False)] for i in range(count)]


def _inferred(lines):
    """garbled_ratio of lines whose math fonts annotate_math_fonts infers, as extraction does."""
    items = _items(*[[(font, text, False) for font, text, _ in spans] for spans in lines])
    annotate_math_fonts(items)
    return garbled_ratio(items, [])


def _subset(text):
    """A renumbered subset font without ToUnicode: glyphs 1, 2, 3... in place of letters."""
    return "".join(chr(1 + (ord(c.lower()) - 97) % 26) if c.isalpha() else c for c in text)


def test_replacement_characters_and_glyph_ids_are_garbled():
    # MuPDF gives U+FFFD when nothing maps; a font without letters looks like math to
    # annotate_math_fonts, so this is measured over every character.
    assert garbled_ratio(_items(*[[("F3", "\ufffd" * 12 + " " + "\ufffd" * 20, True)]] * 4), []) == 1
    # Identity-H without ToUnicode: glyph IDs, the space glyph 3 becoming U+0003.
    shifted = "\x03".join(["VKRZ", "WKDW", "WKH", "SURSRVHG", "PHWKRG", "LPSURYHV", "DFFXUDF\\"])
    assert garbled_ratio(_items(*[[("ABCDEF+Arial", shifted, False)]] * 3), []) == 1
    # A renumbered subset (glyphs 1, 2, 3...) under a readable publisher footer.
    subset = "".join(chr(1 + "abcdefghijklmnopqrstuvwxyz".index(c)) if c.isalpha() else c for c in PROSE.lower())
    footer = [("Helvetica", "Downloaded from example.org on 1 January 2026", False)]
    lines = [[("F7", subset[i:i + 60], True)] for i in range(0, len(subset), 60)] + [footer]
    assert garbled_ratio(_items(*lines), []) >= GARBLED_RATIO


def test_math_heavy_readable_page_is_not_garbled():
    lines = _prose_lines(6)
    # Inline math: private-use glyphs of an opaque math font and of Symbol, Greek letters,
    # math italic, and TeX-style control codes in an inferred math font.
    lines[1] = lines[1] + [("NLKPQR+F12", "\uf8f1x\uf8f2", True), ("ABCDEF+SymbolMT", "\uf061\uf0b4\uf062", False),
                           ("Times-Roman", " with α, β and ", False), ("CMMI10", "\U0001d465\U0001d466", True)]
    lines[3] = lines[3] + [("Type3 (12 0 R)", "\x0b(t) \x00 \x0c", True)]
    # Display formulas: Word's equation fonts, and a prose-font formula with private-use
    # glyphs that layout detected as a formula.
    lines.append([("CambriaMath", "\U0001d465 = \uf020\U0001d6fc\uf021", False), ("MT Extra", "\uf038\uf039", False)])
    lines.append([("Times-Roman", "\uf0e5 \uf0f2 \uf0a5 \uf0b6", False)])
    formula = [{"kind": "formula", "bbox": [40, 60 + 7 * 14, 400, 60 + 7 * 14 + 12], "formulas": []}]
    ratio = garbled_ratio(_items(*lines), formula)
    assert ratio is not None and ratio < .05


def test_math_dominated_page_is_not_garbled():
    # A derivation page from dvips Type3 fonts: Greek (CMMI 0x0B-) and operators (CMSY 0x00-)
    # extract as control characters, and inferred math fonts leave little prose to judge.
    formula = [("Type3 (5 0 R)", "x(t)", True), ("Type3 (6 0 R)", " = ", False),
               ("Type3 (5 0 R)", "\x0by", True), ("Type3 (7 0 R)", "\x00", True),
               ("Type3 (5 0 R)", "\x0cz", True), ("Type3 (7 0 R)", "\x02", True), ("Type3 (5 0 R)", "u(t) + 1", True)]
    lines = [formula] * 10 + [[("Type3 (6 0 R)", "which proves the claim.", False)]]
    ratio = garbled_ratio(_items(*lines), [])
    assert ratio is None or ratio < PARTIAL_RATIO
    # A Greek run in one short math span is a formula, not a garbled word.
    lines = _prose_lines(4) + [[("Times-Roman", "bounded by ", False), ("Type3 (5 0 R)", "\x0b\x0c\x0d", True)]] * 8
    assert garbled_ratio(_items(*lines), []) == 0


def test_type3_ligatures_and_one_garbled_heading_do_not_flag_the_page():
    # OT1 ligatures without glyph names: fi = 0x0C, ffi = 0x0E.
    text = PROSE.replace("fi", "\x0c").replace("the", "the e\x0ecient")
    lines = [[("Type3 (8 0 R)", text[i:i + 70], False)] for i in range(0, len(text), 70)]
    assert garbled_ratio(_items(*lines), []) < .15
    lines = _prose_lines(6) + [[("ABCDEF+Bold", "\x03".join(["\x16\x0f\x11", "\x05\x0c"]), False)]]
    assert garbled_ratio(_items(*lines), []) < .15


def test_private_use_characters_in_japanese_lines_count_alone():
    # Japanese has no spaces between words: a line with one gaiji (外字, private use)
    # is not a garbled line.
    line = "本研究では提案する制御器が追従精度を改善することを示す\ue000解析は有界な外乱に対して成り立つ。"
    assert garbled_ratio(_items(*[[("MS-Mincho", line, False)]] * 4), []) < .05


def test_garbled_runs_count_even_in_a_font_taken_for_math():
    # A garbled font has no English words, so annotate_math_fonts takes it for math; its
    # runs of garbled characters still count, so half a page garbled is not hidden.
    text = (PROSE + " ") * 4
    readable = [[("Times-Roman", text[i:i + 45], False)] for i in range(0, 45 * 12, 45)]
    replaced = [[("ABCDEF+F9", "".join(c if c == " " else "�" for c in text[i:i + 45]), False)]
                for i in range(0, 45 * 12, 45)]
    subset = [[("ABCDEF+F9", _subset(text)[i:i + 45], False)] for i in range(0, 45 * 12, 45)]
    # Two columns on the same lines, one garbled.
    for garbled in (replaced, subset):
        assert _inferred([a + b for a, b in zip(readable, garbled)]) >= .45
    # A garbled paragraph below readable ones: partly garbled.
    assert PARTIAL_RATIO <= _inferred(readable[:7] + subset[:6]) < GARBLED_RATIO
    assert _inferred(readable[:4] + subset[:9]) >= GARBLED_RATIO


def test_stix_text_face_is_prose_but_its_math_faces_are_symbols():
    lines = _prose_lines(6)
    assert garbled_ratio(_items(*lines, [("STIXMathJax_Main", "x", False), ("STIXSizeOneSym", "", False)]), []) == 0
    garbled = garbled_ratio(_items(*lines, *[[("STIXGeneral", " " * 8, False)]] * 4), [])
    assert garbled > PARTIAL_RATIO


def test_formula_regions_are_found_per_line_quickly():
    # 3000 characters and 200 formulas: every character used to be compared with every formula.
    lines = [[("Times-Roman", (PROSE * 2)[:50], False)] for _ in range(60)]
    items = _items(*lines)
    formulas = [{"kind": "formula", "bbox": [300 + (i % 4) * 5, 60 + i * 4, 304 + (i % 4) * 5, 63 + i * 4], "formulas": []}
                for i in range(200)]
    start = time.perf_counter()
    for _ in range(3):
        garbled_ratio(items, formulas)
    assert (time.perf_counter() - start) / 3 < .1


def test_little_text_is_not_judged():
    assert garbled_ratio(_items([("F3", "\ufffd" * 20, True)]), []) is None


# --- Real PDFs.

def _prose_page(pdf, heading="Introduction"):
    page = pdf.new_page()
    page.insert_text((72, 72), heading, fontname="hebo", fontsize=14)
    page.insert_textbox(fitz.Rect(72, 90, 540, 400), PROSE + " " + PROSE, fontname="helv", fontsize=11)
    return page


def _garbled_page(pdf):
    """Text in an embedded Identity-H font whose ToUnicode map is removed afterwards."""
    page = pdf.new_page()
    writer = fitz.TextWriter(page.rect)
    font = fitz.Font("tiro")
    for row, start in enumerate(range(0, len(PROSE), 60)):
        writer.append((72, 140 + row * 16), PROSE[start:start + 60], font=font, fontsize=11)
    writer.write_text(page)
    return page


def _drop_to_unicode(path):
    with fitz.open(path) as pdf:
        for xref in range(1, pdf.xref_length()):
            if "/ToUnicode" in pdf.xref_object(xref):
                pdf.xref_set_key(xref, "ToUnicode", "null")
        pdf.saveIncr()


def _type3_font(pdf):
    """A Type3 font without glyph names or ToUnicode, as dvips wrote bitmap TeX fonts:
    MuPDF returns the raw character codes."""
    glyph = pdf.get_new_xref()
    pdf.update_object(glyph, "<<>>")
    pdf.update_stream(glyph, b"500 0 0 0 450 650 d1 0 0 450 650 re f")
    names = [f"/a{i}" for i in range(128)]
    font = pdf.get_new_xref()
    pdf.update_object(font, (
        "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 500 700] /FontMatrix [0.001 0 0 0.001 0 0]"
        f" /CharProcs << {' '.join(f'{n} {glyph} 0 R' for n in names)} >>"
        f" /Encoding << /Type /Encoding /Differences [0 {' '.join(names)}] >>"
        f" /FirstChar 0 /LastChar 127 /Widths [{' '.join(['500'] * 128)}] /Resources << >> >>"))
    return font


def _type3_page(pdf, lines):
    """lines: [[(font key, text), ...], ...] with keys R (prose), M (math italic), S (symbols)."""
    page = pdf.new_page()
    fonts = {key: _type3_font(pdf) for key in "RMS"}
    content = []
    for row, parts in enumerate(lines):
        x = 72.0
        for key, text in parts:
            content.append(f"BT /{key} 11 Tf {x:.1f} {720 - row * 16} Td <{text.encode('latin-1').hex()}> Tj ET")
            x += len(text) * 5.5
    stream = pdf.get_new_xref()
    pdf.update_object(stream, "<<>>")
    pdf.update_stream(stream, "\n".join(content).encode())
    pdf.xref_set_key(page.xref, "Contents", f"{stream} 0 R")
    pdf.xref_set_key(page.xref, "Resources",
                     "<< /Font << " + " ".join(f"/{k} {v} 0 R" for k, v in fonts.items()) + " >> >>")
    return page


def test_garbled_page_is_listed_and_kept_out_of_translation(tmp_path, monkeypatch):
    source = tmp_path / "garbled.pdf"
    with fitz.open() as pdf:
        _prose_page(pdf)
        _garbled_page(pdf)
        _prose_page(pdf, "Results")
        pdf.save(source)
    _drop_to_unicode(source)
    document = extract_pdf(source)
    assert [(e["page"], e["reason"]) for e in document["ocr_pages"]] == [(2, "garbled")]
    assert document["ocr_pages"][0]["garbled_ratio"] >= GARBLED_RATIO
    assert all(bool(b.get("needs_ocr")) == (b["page"] == 2) for b in document["blocks"])
    assert {u["page"] for u in translation_units(document)} == {1, 3}
    assert not any(2 in group["pages"] for group in document["continuations"])
    assert required_translation_pages(document) == [1, 3]

    root = tmp_path / "library"
    lib = Library(root)
    paper_id, _ = lib.import_pdf(source)
    monkeypatch.setenv("PAPEER_DATA_DIR", str(root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    with TestClient(app) as client:
        reading = client.get(f"/api/papers/{paper_id}/reading").json()
    assert reading["translation_required_pages"] == [1, 3]
    assert [(e["page"], e["reason"]) for e in reading["ocr_pages"]] == [(2, "garbled")]

    # Extraction caches from before the check have no list.
    cache = lib.folder(paper_id) / "document.json"
    saved = json.loads(cache.read_text("utf-8"))
    del saved["ocr_pages"]
    cache.write_text(json.dumps(saved), encoding="utf-8")
    assert lib.reading_info(paper_id)["ocr_pages"] == []


def test_renumbered_subset_font_under_a_readable_footer(tmp_path):
    source = tmp_path / "subset.pdf"
    letters = "abcdefghijklmnopqrstuvwxyz"
    subset = "".join(chr(1 + letters.index(c)) if c in letters else c for c in PROSE.lower())
    with fitz.open() as pdf:
        _prose_page(pdf)
        page = _type3_page(pdf, [[("R", subset[i:i + 70])] for i in range(0, len(subset), 70)])
        page.insert_text((72, 770), "Downloaded from example.org on 1 January 2026", fontname="helv", fontsize=8)
        pdf.save(source)
    document = extract_pdf(source)
    assert [(e["page"], e["reason"]) for e in document["ocr_pages"]] == [(2, "garbled")]


def test_math_heavy_type3_pages_are_not_flagged(tmp_path):
    source = tmp_path / "dvips.pdf"
    # OT1 prose font: letters keep their codes, ligatures fi/ffi/ff become control codes.
    prose = [[("R", "The e\x0ecient controller is de\x0cned for every admissible input o\x0bset."),
              ("M", " x"), ("R", " and "), ("M", "\x0b")],
             [("R", "We show that the tracking error of the plant is bounded by "), ("M", "\x0c"), ("R", ".")],
             [("R", "The analysis holds for every bounded disturbance of the system.")]]
    formula = [("M", "x(t)"), ("R", " = "), ("M", "\x0by"), ("S", "\x00"), ("M", "\x0cz"), ("S", "\x02"), ("M", "u(t)")]
    with fitz.open() as pdf:
        _type3_page(pdf, prose + [formula] * 3 + prose)
        # A derivation page: formulas with only a line of prose.
        _type3_page(pdf, [formula] * 12 + [[("R", "which completes the proof of the theorem.")]])
        # Symbol font glyphs next to Helvetica prose.
        page = _prose_page(pdf)
        page.insert_text((72, 450), "abgdDSQ", fontname="symb", fontsize=12)
        page.insert_text((72, 480), "a + b = g", fontname="symb", fontsize=12)
        pdf.save(source)
    document = extract_pdf(source)
    assert document["ocr_pages"] == []
    assert not any(b.get("needs_ocr") for b in document["blocks"])
    assert {1, 3} <= {u["page"] for u in translation_units(document)}


def test_scanned_image_page_needs_ocr_but_a_captioned_figure_does_not(tmp_path):
    source = tmp_path / "scan.pdf"
    scan = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 80), False)
    scan.clear_with(200)
    with fitz.open() as pdf:
        _prose_page(pdf)
        page = pdf.new_page()
        page.insert_image(page.rect, pixmap=scan)
        page.insert_text((300, 780), "2", fontname="helv", fontsize=9)
        page = pdf.new_page()
        page.insert_image(fitz.Rect(40, 40, 570, 600), pixmap=scan)
        page.insert_text((72, 630), "Figure 3. Tracking error of the proposed controller over time.",
                          fontname="helv", fontsize=10)
        pdf.save(source)
    document = extract_pdf(source)
    assert document["ocr_pages"] == [{"page": 2, "reason": "image"}]
    assert 2 not in required_translation_pages(document)


def _column_page(pdf, left, right_rows):
    """Helvetica prose in the left column and Type3 subset rows in the right one."""
    page = _type3_page(pdf, [])
    font = pdf.xref_get_key(page.xref, "Resources/Font/R")[1]
    content = [f"BT /R 9 Tf 320 {740 - row * 12} Td <{text.encode('latin-1').hex()}> Tj ET"
               for row, text in enumerate(right_rows)]
    stream = pdf.get_new_xref()
    pdf.update_object(stream, "<<>>")
    pdf.update_stream(stream, "\n".join(content).encode())
    pdf.xref_set_key(page.xref, "Contents", f"{stream} 0 R")
    pdf.xref_set_key(page.xref, "Resources", f"<< /Font << /R {font} >> >>")
    page.insert_textbox(fitz.Rect(50, 40, 300, 780), left, fontname="helv", fontsize=9)
    return page


def test_page_with_one_garbled_column_is_listed(tmp_path):
    source = tmp_path / "columns.pdf"
    text = (PROSE + " ") * 3
    with fitz.open() as pdf:
        _column_page(pdf, text, [_subset(text[i:i + 42]) for i in range(0, len(text), 42)])
        pdf.save(source)
    document = extract_pdf(source)
    [entry] = document["ocr_pages"]
    assert entry["reason"] in {"garbled", "partial"} and entry["garbled_ratio"] >= PARTIAL_RATIO
    if entry["reason"] == "partial":
        # The readable column is still translated, the garbled one never.
        assert all("\x01" not in u["text"] and "\x05" not in u["text"] for u in translation_units(document))
        assert translation_units(document)


def test_partly_garbled_page_translates_its_readable_paragraphs(tmp_path):
    source = tmp_path / "partial.pdf"
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_textbox(fitz.Rect(72, 60, 540, 330), " ".join([PROSE] * 5), fontname="helv", fontsize=11)
        writer = fitz.TextWriter(page.rect)
        for row, start in enumerate(range(0, 2 * len(PROSE), 60)):
            writer.append((72, 420 + row * 16), (PROSE * 2)[start:start + 60], font=fitz.Font("tiro"), fontsize=11)
        writer.write_text(page)
        pdf.save(source)
    _drop_to_unicode(source)
    document = extract_pdf(source)
    [entry] = document["ocr_pages"]
    assert entry["reason"] == "partial" and PARTIAL_RATIO <= entry["garbled_ratio"] < GARBLED_RATIO
    garbled = [b for b in document["blocks"] if b.get("needs_ocr")]
    assert garbled and all("\x01" in b["text"] for b in garbled)
    units = translation_units(document)
    assert units and all("\x01" not in u["text"] for u in units)
    assert required_translation_pages(document) == [1]


def test_scanned_page_with_a_download_stamp_needs_ocr(tmp_path):
    source = tmp_path / "stamped.pdf"
    scan = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 60, 80), False)
    scan.clear_with(200)
    with fitz.open() as pdf:
        _prose_page(pdf)
        page = pdf.new_page()
        page.insert_image(page.rect, pixmap=scan)
        page.insert_text((40, 20), "Journal of Examples, Vol. 12, No. 3 (1987), pp. 101-120", fontname="helv", fontsize=8)
        page.insert_text((40, 770), "This content downloaded from 192.0.2.1 on Mon, 01 Jan 2026 00:00:00 UTC",
                         fontname="helv", fontsize=7)
        pdf.save(source)
    assert extract_pdf(source)["ocr_pages"] == [{"page": 2, "reason": "image"}]


@pytest.fixture
def library(tmp_path):
    return Library(tmp_path / "library")


def test_translation_names_ocr_pages_and_explains_papers_without_text(tmp_path, library):
    source = tmp_path / "garbled.pdf"
    with fitz.open() as pdf:
        _prose_page(pdf)
        _garbled_page(pdf)
        pdf.save(source)
    _drop_to_unicode(source)
    paper_id, _ = library.import_pdf(source)
    PaperService(library, FakeProvider(), threading.Event()).translate(paper_id)
    markdown = PaperFiles(library.folder(paper_id)).translation_md.read_text("utf-8")
    assert "要OCRのため未翻訳のページ（文字化け・画像だけ）: p.2" in markdown.split("## ")[0]

    only = tmp_path / "only-garbled.pdf"
    with fitz.open() as pdf:
        _garbled_page(pdf)
        pdf.save(only)
    _drop_to_unicode(only)
    paper_id, _ = library.import_pdf(only)
    with pytest.raises(ValueError, match="要OCR"):
        PaperService(library, FakeProvider(), threading.Event()).translate(paper_id)
    from papeer.core.library_list import translation_state
    state = translation_state(library.folder(paper_id), 1)
    assert state["translation_required_count"] == 0 and state["translation_ocr_count"] == 1


def test_garbled_stamp_in_the_margin_is_kept_without_listing_the_page(tmp_path):
    # A publisher's download stamp in a font without ToUnicode, on an otherwise readable page.
    source = tmp_path / "stamp.pdf"
    with fitz.open() as pdf:
        page = _prose_page(pdf)
        writer = fitz.TextWriter(page.rect)
        writer.append((20, 785), "Downloaded From: http://example.org/ on 06/18/2018 Terms of Use: http://example.org/terms",
                      font=fitz.Font("tiro"), fontsize=7)
        writer.write_text(page)
        pdf.save(source)
    _drop_to_unicode(source)
    document = extract_pdf(source)
    assert document["ocr_pages"] == []
    [stamp] = [b for b in document["blocks"] if b.get("needs_ocr")]
    assert stamp["bbox"][1] > 770
    assert all("\x03" not in u["text"] for u in translation_units(document))


def test_greek_and_operator_derivation_page_is_not_flagged(tmp_path):
    # dvips Type3: CMMI Greek (0x0B-) and CMSY operators (0x00-) as control characters, in
    # separate spans; runs of garbled characters never cross spans. Two lines of prose.
    source = tmp_path / "derivation.pdf"
    prose = [[("R", "We show that the tracking error of the plant is bounded for every input "), ("M", "x"), ("R", ".")]]
    greek = [("M", "\x15\x16"), ("S", "\x00"), ("M", "\x17\x18"), ("R", " = "), ("M", "\x19\x1a"),
             ("S", "\x02"), ("M", "\x1b\x0e")]
    inline = [("R", "The gain "), ("M", "K\x0b\x0c\x0d"), ("R", " and the rate satisfy the bound for all time.")]
    with fitz.open() as pdf:
        _type3_page(pdf, prose * 2 + [greek] * 14)
        _type3_page(pdf, prose + [inline] * 6 + [greek] * 8)
        pdf.save(source)
    document = extract_pdf(source)
    assert document["ocr_pages"] == []
    assert not any(b.get("needs_ocr") for b in document["blocks"])
    assert {u["page"] for u in translation_units(document)} == {1, 2}


def test_ligature_codes_and_icon_glyphs_do_not_list_the_page(tmp_path):
    source = tmp_path / "ligatures.pdf"
    body = [[("R", "The analysis holds for every bounded disturbance of the system and every input.")]] * 8
    # OT1 ffi = 0x0E: "Efficient and sufficient office layout."
    caption = [("R", "Figure 3: E\x0ecient and su\x0ecient o\x0ece layout.")]
    with fitz.open() as pdf:
        page = _type3_page(pdf, body + [[], caption])
        # Icon glyphs without ToUnicode (TextWriter writes private-use characters as code 0).
        writer = fitz.TextWriter(page.rect)
        writer.append((72, 600), "\ue715 \ue717 \ue774", font=fitz.Font("tiro"), fontsize=12)
        writer.write_text(page)
        pdf.save(source)
    document = extract_pdf(source)
    assert document["ocr_pages"] == []
    [icons] = [b for b in document["blocks"] if b.get("needs_ocr")]
    assert set(icons["text"].split()) == {"\x00"}
    assert any("su\x0ecient" in u["text"] for u in translation_units(document))


def test_partial_page_without_garbled_paragraphs_says_so(tmp_path):
    # The garbled column is a formula to the layout (its font has no English words), so no
    # paragraph is kept back: the page is listed with no garbled paragraph.
    source = tmp_path / "third.pdf"
    text = (PROSE + " ") * 3
    with fitz.open() as pdf:
        _column_page(pdf, text, [_subset(text[i:i + 42]) for i in range(0, len(text) // 2, 42)])
        pdf.save(source)
    document = extract_pdf(source)
    [entry] = document["ocr_pages"]
    assert entry["reason"] == "partial" and entry["garbled_paragraphs"] == 0
    from papeer.layout.ocr_pages import ocr_markdown_note
    assert ocr_markdown_note(document) == []


def test_garbled_page_drawn_one_glyph_at_a_time(tmp_path):
    # Each glyph in its own BT..ET: MuPDF gives spans of a character or two, which join
    # into one span of the font, so the garbled runs still count.
    source = tmp_path / "glyphs.pdf"
    text = _subset((PROSE + " ") * 2)
    with fitz.open() as pdf:
        page = _type3_page(pdf, [])
        font = pdf.xref_get_key(page.xref, "Resources/Font/R")[1]
        content = []
        for row, start in enumerate(range(0, len(text), 60)):
            for column, c in enumerate(text[start:start + 60]):
                content.append(f"BT /R 11 Tf {72 + column * 5.5:.1f} {700 - row * 16} Td <{c.encode('latin-1').hex()}> Tj ET")
        stream = pdf.get_new_xref()
        pdf.update_object(stream, "<<>>")
        pdf.update_stream(stream, "\n".join(content).encode())
        pdf.xref_set_key(page.xref, "Contents", f"{stream} 0 R")
        pdf.xref_set_key(page.xref, "Resources", f"<< /Font << /R {font} >> >>")
        pdf.save(source)
    with fitz.open(source) as pdf:
        spans = [s for b in pdf[0].get_text("rawdict")["blocks"] for line in b["lines"] for s in line["spans"]]
    assert max(len(s["chars"]) for s in spans) < 10
    document = extract_pdf(source)
    assert [(e["page"], e["reason"]) for e in document["ocr_pages"]] == [(1, "garbled")]
