"""Pages read by OCR during extraction (papeer.pdf.pdf_ocr, pdf_engine.extract_pdf with OcrOptions).

The PDFs are made here from the page images of tests/fixtures/ocr (a scan: one image filling the page).
Accuracy is the character error rate against truth.json, counted from difflib's differences (an upper
bound of the edit distance).
"""
from __future__ import annotations

from collections import Counter
import difflib
import io
import json
import math
from pathlib import Path
import re
import unicodedata

import pymupdf as fitz
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import pytest

from papeer.layout.ocr_engines import OcrLine, OcrOptions, OcrWord, WindowsOcrEngine
from papeer.layout.ocr_regions import PageLayout
from papeer.pdf import pdf_ocr
from papeer.pdf.pdf_engine import build_translated_pdf, extract_pdf, translation_units
from papeer.pdf.pdf_ocr import _item, _join, _rows, document_language, letter_share, prose_text

FIXTURES = Path(__file__).parent / "fixtures" / "ocr"
TRUTH = json.loads((FIXTURES / "truth.json").read_text("utf-8"))


def scan_pdf(tmp_path: Path, name: str, angle: float = 0.0) -> Path:
    """A one-page PDF holding the page image (turned, gray and blurred when angle is given)."""
    image = Image.open(FIXTURES / f"{name}.png").convert("L")
    if angle:
        image = image.point(lambda v: 40 + v * 175 // 255).filter(ImageFilter.GaussianBlur(1))
        image = image.rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=215)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    width, height = TRUTH[name]["size"]
    path = tmp_path / f"{name}.pdf"
    with fitz.open() as document:
        page = document.new_page(width=width, height=height)
        page.insert_image(page.rect, stream=buffer.getvalue())
        document.save(path)
    return path


def normalize(text: str, lang: str) -> str:
    text = unicodedata.normalize("NFKC", text.replace("\xad", "-"))
    for a, b in (("−", "-"), ("–", "-"), ("—", "-"), ("“", '"'), ("”", '"'), ("‘", "'"), ("’", "'")):
        text = text.replace(a, b)
    return re.sub(r"\s+", "", text) if lang == "ja" else re.sub(r"\s+", " ", text).strip()


def cer(hypothesis: str, reference: str) -> float:
    matcher = difflib.SequenceMatcher(None, reference, hypothesis, autojunk=False)
    edits = sum(max(i2 - i1, j2 - j1) for tag, i1, i2, j1, j2 in matcher.get_opcodes() if tag != "equal")
    return edits / max(1, len(reference))


def prose(name: str) -> list[str]:
    """The truth's lines outside the figure and the formula (those stay images)."""
    lines = TRUTH[name]["lines"]
    return [line[4] for line in lines
            if not re.fullmatch(r"[\d\s]+|N=\d+|Accuracy \(%\)|精度 \(%\)", line[4]) and "L(θ)" not in line[4]
            and "‖" not in line[4] and line[4] not in ("N", "i=1", "(1)")]


def text_of(document: dict) -> str:
    return "\n".join(b["text"] for b in document["blocks"] if b.get("kind", "text") == "text")


def options(tessdata: Path, **values) -> OcrOptions:
    return OcrOptions(enabled=True, tessdata=tessdata, **{"engine": "tesseract", **values})


# ---------------------------------------------------------------- helpers without an engine

def test_prose_text_tells_headings_from_formulas():
    for text in ("Abstract", "3. Model", "David Lee and Emma Wilson", "Adaptive Control for Automated Systems",
                 "We minimize the following objective:"):
        assert prose_text(text, "en"), text
    for text in ("L(@)=>) lly- fx) + All6ll, (1)", "(1)", "y = F(x, {Wi}) + x.", "N=8", "0 20 40 60", ""):
        assert not prose_text(text, "en"), text
    assert prose_text("目的関数を次のように定める。", "ja")
    assert not prose_text("L(6)=2ly-(G+AOは)", "ja")
    assert letter_share("ab 12") == .5 and letter_share("") == 0


def test_document_language_by_its_text():
    assert document_language(["The residual error is dominated by outliers near the boundary " * 3]) == "en"
    assert document_language(["雑音を含む観測から潜在構造を頑健に推定する簡潔な手法を提案する。" * 5]) == "ja"
    assert document_language(["", "p. 3"]) is None


def word(x0, y0, x1, y1, text):
    return OcrWord((x0, y0, x1, y1), text)


def test_parts_of_a_row_are_joined_in_the_engines_order():
    lines = [OcrLine((word(0, 0, 90, 20, "Our"),)),
             # The end of the next row, a little higher than its start, returned on its own.
             OcrLine((word(0, 30, 400, 50, "implementation"), word(410, 30, 500, 50, "is"))),
             OcrLine((word(510, 27, 600, 47, "written"),)),
             # A word box two rows tall does not pull the rows together.
             OcrLine((word(0, 55, 40, 100, "in"), word(50, 60, 150, 80, "Python"))),
             OcrLine((word(0, 90, 60, 110, "and"),))]
    rows = _rows(lines)
    assert [[w.text for w in row.words] for row in rows] == [
        ["Our"], ["implementation", "is", "written"], ["in", "Python"], ["and"]]


def test_spaces_between_latin_words_only():
    english = OcrLine((word(0, 0, 50, 20, "the"), word(52, 0, 90, 20, "noise")))
    assert "".join(t for t, _ in _join(english, 20)) == "the noise"
    # Windows' Japanese recognizer: a word per character, Latin letters too; the gaps decide.
    japanese = OcrLine((word(0, 0, 20, 20, "実"), word(20, 0, 40, 20, "装"), word(41, 0, 50, 20, "P"),
                        word(50, 0, 58, 20, "y"), word(70, 0, 80, 20, "3"), word(80, 0, 100, 20, "台")), spaced=False)
    assert "".join(t for t, _ in _join(japanese, 20)) == "実装Py 3台"


def test_lines_of_a_skewed_scan_are_moved_back_and_stay_level():
    layout = PageLayout(Image.new("L", (1000, 1000), 255), 2.0, 4, 40, 255, [], [])
    lines = [OcrLine((word(100, 100, 900, 140, "first"),)), OcrLine((word(100, 160, 900, 200, "second"),))]
    item = _item(lines, layout, .24, 0)
    assert item is not None
    first, second = item["lines"]
    # Each line is where its middle lies on the turned page, level, and the two do not overlap.
    mx, my = layout.unrotate(500, 120)
    assert (first["bbox"][0] + first["bbox"][2]) / 2 == pytest.approx(mx * .24, abs=.5)
    assert (first["bbox"][1] + first["bbox"][3]) / 2 == pytest.approx(my * .24, abs=.5)
    assert first["bbox"][3] <= second["bbox"][1]
    chars = first["spans"][0]["chars"]
    assert "".join(c["c"] for c in chars) == "first"
    assert all(a["bbox"][2] <= b["bbox"][0] + 1e-6 for a, b in zip(chars, chars[1:]))
    assert first["spans"][0]["font"] == "OCR" and first["spans"][0]["math_font"] is False


# ---------------------------------------------------------------- extraction

def test_ocr_is_off_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv("PAPEER_OCR", raising=False)
    document = extract_pdf(scan_pdf(tmp_path, "synth_en_2col"))
    assert document["ocr_pages"] == [{"page": 1, "reason": "image"}]
    assert "ocr_applied" not in document and document["blocks"] == [] and document["empty_pages"] == [1]


def test_without_language_data_the_page_stays_needing_ocr(tmp_path, monkeypatch):
    monkeypatch.setattr(WindowsOcrEngine, "languages", lambda self: set())
    empty = tmp_path / "tessdata"
    empty.mkdir()
    document = extract_pdf(scan_pdf(tmp_path, "synth_en_2col"), options(empty, lang="en"))
    assert document["ocr_pages"] == [{"page": 1, "reason": "image"}]
    assert "ocr_applied" not in document and document["blocks"] == []


@pytest.mark.parametrize("angle", [0.0, 1.5], ids=["clean", "skewed-scan"])
def test_english_two_columns(tessdata, tmp_path, angle):
    name = "synth_en_2col"
    document = extract_pdf(scan_pdf(tmp_path, name, angle), options(tessdata))
    assert document["ocr_pages"] == [] and document["empty_pages"] == []
    [applied] = document["ocr_applied"]
    assert applied["page"] == 1 and applied["reason"] == "image"
    assert applied["engine"] == "tesseract" and applied["lang"] == "en"
    assert applied["skew"] == pytest.approx(-angle, abs=.15)
    text = normalize(text_of(document), "en")
    reference = normalize("\n".join(prose(name)), "en")
    assert cer(text, reference) <= .02
    # Read column by column: the end of the left column comes before the start of the right one.
    left_end = normalize("boundary of the feasible region. Nevertheless, the method", "en")
    right_start = normalize("2. Method", "en")
    assert 0 <= text.find(left_end) < text.find(right_start)
    # Blocks look like those of any page: text of about the body size, flagged as OCR.
    body = [b for b in document["blocks"] if len(b["text"]) > 200]
    assert body and all(8 <= b["font_size"] <= 11 and b["ocr"] for b in body)
    # And they are translated like any other text.
    units = translation_units(document)
    assert len(units) >= 5 and any("latent structure" in unit["text"] for unit in units)


@pytest.mark.parametrize("angle", [0.0, -2.0], ids=["clean", "skewed-scan"])
def test_formula_and_figure_stay_images(tessdata, tmp_path, angle):
    name = "synth_en_2col_mathfig"
    document = extract_pdf(scan_pdf(tmp_path, name, angle), options(tessdata))
    kinds = Counter(b.get("kind", "text") for b in document["blocks"])
    assert kinds["formula"] == 1 and kinds["figure"] == 1
    formula = next(fitz.Rect(b["bbox"]) for b in document["blocks"] if b["kind"] == "formula")
    figure = next(fitz.Rect(b["bbox"]) for b in document["blocks"] if b["kind"] == "figure")
    lines = {line[4]: fitz.Rect(line[:4]) for line in TRUTH[name]["lines"]}
    assert formula.contains(next(r for t, r in lines.items() if t.startswith("L(θ)")) + (-1, -1, 1, 1))
    assert figure.contains(lines["N=256"] + (-1, -1, 1, 1)) and figure.contains(lines["Accuracy (%)"] + (-1, -1, 1, 1))
    text = text_of(document)
    assert "N=16" not in text and "Accuracy (%)" not in text
    assert cer(normalize(text, "en"), normalize("\n".join(prose(name)), "en")) <= .02
    assert units_skip_images(document)


def units_skip_images(document: dict) -> bool:
    kept = {b["id"] for b in document["blocks"] if b.get("kind") in {"formula", "figure"}}
    return not any(unit["block"] in kept for unit in translation_units(document))


def test_japanese_with_tesseract(tessdata, tmp_path, monkeypatch):
    name = "synth_ja_2col_mathfig"
    document = extract_pdf(scan_pdf(tmp_path, name), options(tessdata))
    [applied] = document["ocr_applied"]
    # The language is found from the page (there is no text layer to tell it).
    assert applied["lang"] == "ja" and "tesseract" in applied["engine"]
    text = text_of(document)
    assert cer(normalize(text, "ja"), normalize("\n".join(prose(name)), "ja")) <= .03
    assert not re.search(r"[぀-鿿] [぀-鿿]", text)


@pytest.mark.skipif("ja" not in WindowsOcrEngine().languages(), reason="Windows の OCR に日本語の認識器がない環境")
def test_japanese_with_windows_ocr(tessdata, tmp_path):
    name = "synth_ja_2col_mathfig"
    document = extract_pdf(scan_pdf(tmp_path, name, 1.5), options(tessdata, engine="auto"))
    [applied] = document["ocr_applied"]
    assert applied["lang"] == "ja" and applied["engine"] == "windows"
    text = text_of(document)
    assert cer(normalize(text, "ja"), normalize("\n".join(prose(name)), "ja")) <= .08
    # Windows puts a space between Japanese characters; none is left.
    assert not re.search(r"[぀-鿿] [぀-鿿]", text)


def test_translated_pdf_of_an_ocr_page(tessdata, tmp_path):
    source = scan_pdf(tmp_path, "synth_en_2col", 1.5)
    document = extract_pdf(source, options(tessdata))
    # Inline math the OCR text has (O(n^-1/2)) comes back as its markers, as from a real translation.
    translations = {b["id"]: " ".join(["訳文です。", *(f["token"] for f in b["formulas"])])
                    for b in document["blocks"] if b.get("kind", "text") == "text"}
    report = build_translated_pdf(source, document, translations, tmp_path / "translated.pdf")
    assert report["pages"] == 1
    with fitz.open(tmp_path / "translated.pdf") as translated:
        page = translated[0]
        assert "訳文です。" in page.get_text()
        # The scan stays under the translation (painted over where the text was, not removed).
        assert page.get_images()


def test_ocr_page_reports_what_it_used(tessdata, tmp_path):
    with fitz.open(scan_pdf(tmp_path, "synth_en_2col_mathfig", -2.0)) as document:
        result = pdf_ocr.ocr_page(document[0], pdf_ocr.EngineSet(options(tessdata)), "en")
    assert result.summary()["engine"] == "tesseract" and result.summary()["lang"] == "en"
    assert result.angle == pytest.approx(2.0, abs=.15) and len(result.formulas) == 1 and len(result.figures) == 1
    # The figure's page area is the turned box: wider than the straight one by the skew.
    assert all(not math.isnan(v) for v in result.figures[0])


# ---------------------------------------------------------------- failures, ids, limits

def test_a_mupdf_error_in_tesseract_leaves_the_page_needing_ocr(tessdata, tmp_path, monkeypatch):
    # MuPDF raises its own FzError classes, not RuntimeError: they must not stop the paper from being added.
    def broken(self, *args, **kwargs):
        raise fitz.mupdf.FzErrorLibrary("code=3: Tesseract language initialisation failed")
    monkeypatch.setattr(fitz.Page, "get_textpage_ocr", broken)
    monkeypatch.setattr(WindowsOcrEngine, "languages", lambda self: set())
    document = extract_pdf(scan_pdf(tmp_path, "synth_en_2col"), options(tessdata, lang="en"))
    assert document["ocr_pages"] == [{"page": 1, "reason": "image"}] and "ocr_applied" not in document


def test_any_fault_in_ocr_leaves_the_page_needing_ocr(tessdata, tmp_path, monkeypatch):
    def broken(*args, **kwargs):
        raise ValueError("a bug in the layout of OCR text")
    monkeypatch.setattr(pdf_ocr, "segment_page", broken)
    document = extract_pdf(scan_pdf(tmp_path, "synth_en_2col"), options(tessdata, lang="en"))
    assert document["ocr_pages"] == [{"page": 1, "reason": "image"}] and "ocr_applied" not in document


def test_block_ids_stay_unique_after_the_prose_merges():
    layout = PageLayout(Image.new("L", (2480, 3508), 255), 0.0, 4, 40, 255, [], [])

    def paragraph(y):
        return [OcrLine((word(200, y + i * 50, 1200, y + i * 50 + 40, "words of a paragraph that goes on"),))
                for i in range(3)]
    # The first two overlap (one paragraph read as two regions): merged, they leave a number unused.
    items = [_item(paragraph(y), layout, .24, i) for i, y in enumerate((400, 520, 900))]
    result = pdf_ocr.OcrPage([i for i in items if i], [fitz.Rect(50, 300, 250, 320), fitz.Rect(50, 600, 250, 620)],
                             [fitz.Rect(50, 400, 250, 500)], "tesseract", "en", 0.0, 0.0, {"tesseract"})
    blocks = pdf_ocr.ocr_page_blocks(result, 1, 842)
    ids = [b["id"] for b in blocks]
    assert len(ids) == len(set(ids)) and Counter(b.get("kind") for b in blocks) == {"text": 2, "formula": 2, "figure": 1}


def test_the_language_comes_from_pages_that_need_no_ocr(tessdata, tmp_path, monkeypatch):
    # Japanese text in the top margin of a scanned English page: the page needs OCR, so its text layer
    # does not decide the language; a first look at the page does.
    path = scan_pdf(tmp_path, "synth_en_2col")
    with fitz.open(path) as document:
        document[0].insert_text((20, 12), "雑音を含む観測から潜在構造を頑健に推定する簡潔な手法を提案する" * 4,
                                fontname="japan", fontsize=4)
        document.saveIncr()
    seen = []
    original = pdf_ocr.ocr_image
    monkeypatch.setattr("papeer.pdf.pdf_engine.ocr_image", lambda image, dpi, engines, lang, *rest: seen.append(lang) or
                        original(image, dpi, engines, lang, *rest))
    document = extract_pdf(path, options(tessdata))
    assert seen == [None] and document["ocr_applied"][0]["lang"] == "en"


def test_what_is_recorded_is_the_same_on_every_extraction(tessdata, tmp_path):
    path = scan_pdf(tmp_path, "synth_en_2col_mathfig")
    first, second = extract_pdf(path, options(tessdata)), extract_pdf(path, options(tessdata))
    assert first["ocr_applied"] == second["ocr_applied"] == [
        {"page": 1, "reason": "image", "engine": "tesseract", "lang": "en", "skew": 0.0}]
    assert first["blocks"] == second["blocks"]
    ids = [b["id"] for b in first["blocks"]]
    assert len(ids) == len(set(ids))


def test_large_pages_are_rendered_at_a_lower_resolution():
    with fitz.open() as document:
        document.new_page(width=595, height=842)
        document.new_page(width=2384, height=3370)  # A0
        document.new_page(width=4000, height=200)
        a4, poster, strip = document[0], document[1], document[2]
        assert pdf_ocr.render_dpi(a4, 300) == 300
        for page in (poster, strip):
            dpi = pdf_ocr.render_dpi(page, 300)
            assert dpi < 300
            image, used = pdf_ocr.render_page(page, 300)
            assert used == dpi
            assert image.width * image.height <= pdf_ocr.MAX_PIXELS and max(image.size) <= pdf_ocr.MAX_SIDE


@pytest.mark.parametrize("engine", ["tesseract", "auto"])
def test_a_japanese_scan_in_an_english_paper_is_read_as_japanese(tessdata, tmp_path, engine):
    # The paper's text layer is English, but a Japanese engine can look at each page first.
    scan = scan_pdf(tmp_path, "synth_ja_2col_mathfig")
    path = tmp_path / "mixed.pdf"
    with fitz.open() as document, fitz.open(scan) as scanned:
        document.new_page().insert_textbox(fitz.Rect(50, 50, 550, 800),
                                           "The residual error is dominated by outliers near the boundary. " * 30)
        document.insert_pdf(scanned)
        document.save(path)
    document = extract_pdf(path, options(tessdata, engine=engine))
    assert [(a["page"], a["lang"]) for a in document["ocr_applied"]] == [(2, "ja")]
    text = normalize(document["pages"][1]["text"], "ja")
    assert cer(text, normalize("\n".join(prose("synth_ja_2col_mathfig")), "ja")) <= .08
    # Asked for English, it stays English.
    assert extract_pdf(path, options(tessdata, engine="tesseract", lang="en"))["ocr_applied"][0]["lang"] == "en"


# ---------------------------------------------------------------- the language of a page with little text

FONT = Path(__file__).parent.parent / "papeer" / "core" / "assets" / "fonts" / "SourceHanSerifJP-Regular.otf"


def _first_lines(name: str, lines: float) -> Image.Image:
    """A letter-size page at 300 dpi holding only the first `lines` lines of a fixture's largest text block."""
    image = Image.open(FIXTURES / f"{name}.png").convert("L")
    layout = pdf_ocr.segment_page(image, 300)
    box = max((b.box for b in layout.blocks), key=pdf_ocr._area)
    page = Image.new("L", (2550, 3300), 255)
    page.paste(image.crop((box[0], box[1], box[2], min(box[3], box[1] + int(lines * layout.line_height)))), (box[0], 400))
    return page


def _title(*lines: str) -> Image.Image:
    page = Image.new("L", (2550, 3300), 255)
    draw = ImageDraw.Draw(page)
    font = ImageFont.truetype(str(FONT), 60)
    for index, line in enumerate(lines):
        draw.text((300, 400 + 120 * index), line, fill=0, font=font)
    return page


@pytest.mark.parametrize("case, image, lang", [
    ("Japanese, two lines", lambda: _first_lines("synth_ja_2col_mathfig", 2.2), "ja"),
    ("Japanese, one line", lambda: _first_lines("synth_ja_2col_mathfig", 1.1), "ja"),
    ("English, two lines", lambda: _first_lines("synth_en_2col", 2.2), "en"),
    ("English, a title only", lambda: _title("Appendix B", "Proof of Theorem 2"), "en"),
    ("Japanese, a title only", lambda: _title("付録 B　定理 2 の証明"), "ja"),
])
def test_a_page_of_a_line_or_two_gets_its_language_from_its_largest_region(tessdata, case, image, lang):
    # Such a page may have no text block; its language is still looked at, also in an English document.
    layout = pdf_ocr.segment_page(image(), 300)
    engines = pdf_ocr.EngineSet(OcrOptions(enabled=True, tessdata=tessdata))
    for document_lang in (None, "en"):
        assert pdf_ocr._probe_language(layout, engines, document_lang) == lang, (case, document_lang)
