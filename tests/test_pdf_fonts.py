"""The bundled faces converted once per PC (pdf_fonts), subset per page, and the formulas' search text."""
from concurrent.futures import ThreadPoolExecutor
import io
import os
from pathlib import Path
import subprocess
import sys
import threading

from fontTools import fontBuilder
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont
import pymupdf as fitz
import pypdfium2 as pdfium
import pytest

from papeer.core.fileio import is_temporary
from papeer.pdf import pdf_engine, pdf_fonts
from papeer.pdf.pdf_engine import PDF_LOCK, build_translated_pdf, extract_pdf
from papeer.pdf.pdf_fonts import cached_truetype, font_cache_directory, subset_truetype, truetype_intact
from papeer.pdf.pdf_typography import FONT_DIRECTORY, FONT_FACES, searchable_text
from test_math_layout import make_math_pdf

ROOT = Path(__file__).resolve().parents[1]


def tiny_otf(path: Path, width: int = 600) -> Path:
    """A CFF (OTF) face with two squares, standing in for the 10 MB bundled faces."""
    builder = FontBuilder(1000, isTTF=False)
    builder.setupGlyphOrder([".notdef", "A", "B"])
    builder.setupCharacterMap({ord("A"): "A", ord("B"): "B"})
    charstrings = {}
    for name in (".notdef", "A", "B"):
        pen = T2CharStringPen(width, None)
        pen.moveTo((50, 0))
        pen.lineTo((50, 700))
        pen.curveTo((200, 750), (400, 750), (550, 700))
        pen.lineTo((550, 0))
        pen.closePath()
        charstrings[name] = pen.getCharString()
    builder.setupCFF("TinyTest-Regular", {"FullName": "Tiny Test"}, charstrings, {})
    builder.setupHorizontalMetrics({name: (width, 50) for name in charstrings})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Tiny Test", "styleName": "Regular"})
    builder.setupOS2(sTypoAscender=800, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.save(str(path))
    return path


@pytest.fixture
def conversions(monkeypatch, tmp_path):
    """Count the conversions; start with nothing read into memory and the cache in tmp_path/cache."""
    # A translation in an earlier test may still be loading the real faces (prepare_fonts_in_background).
    for thread in threading.enumerate():
        if thread.name == "papeer-fonts":
            thread.join(120)
    monkeypatch.setattr(pdf_fonts, "_LOADED", {})
    monkeypatch.setenv("PAPEER_FONT_CACHE_DIR", str(tmp_path / "cache"))
    calls = []
    convert = pdf_fonts.truetype_font

    def counting(font, family, style):
        calls.append((family, style))
        return convert(font, family, style)
    monkeypatch.setattr(pdf_fonts, "truetype_font", counting)
    return calls


def test_cache_lives_in_this_pcs_folder_not_in_the_library(monkeypatch, isolated_app_data):
    monkeypatch.delenv("PAPEER_FONT_CACHE_DIR", raising=False)
    monkeypatch.delenv("PAPERDESK_FONT_CACHE_DIR", raising=False)
    # Beside the folder-sync state (paths.device_directory): never backed up or synced, even
    # when PAPEER_DATA_DIR puts the library elsewhere.
    assert font_cache_directory() == isolated_app_data / "PapeerSync" / "font-cache"
    assert (isolated_app_data / "Papeer") not in font_cache_directory().parents


def test_face_is_converted_once_and_then_read_from_the_cache(conversions, monkeypatch, tmp_path):
    source = tiny_otf(tmp_path / "tiny.otf")
    data = cached_truetype(source, "TinyTest", "Regular")
    cache = tmp_path / "cache"
    files = list(cache.iterdir())
    assert len(files) == 1 and files[0].name.startswith("TinyTest-Regular-") and files[0].suffix == ".ttf"
    assert files[0].read_bytes() == data and truetype_intact(data)
    with TTFont(io.BytesIO(data)) as font:
        assert "glyf" in font and "CFF " not in font
        assert font["name"].getDebugName(6) == "TinyTest-Regular"
    # The same process keeps it; a new process (nothing in memory) reads the file.
    assert cached_truetype(source, "TinyTest", "Regular") is data
    monkeypatch.setattr(pdf_fonts, "_LOADED", {})
    assert cached_truetype(source, "TinyTest", "Regular") == data
    assert conversions == [("TinyTest", "Regular")]


def test_conversion_does_not_depend_on_the_time_it_runs(monkeypatch, tmp_path):
    # A face converted again (a damaged cache, another PC) must embed exactly as before.
    source = tiny_otf(tmp_path / "tiny.otf")
    converted = []
    for now in (1, 10**9):
        monkeypatch.setattr(fontBuilder, "timestampNow", lambda now=now: now)
        with TTFont(source) as font:
            converted.append(pdf_fonts.truetype_font(font, "TinyTest", "Regular"))
    assert converted[0] == converted[1]


@pytest.mark.parametrize("damage", ["truncate", "flip", "empty", "garbage"])
def test_damaged_cache_is_converted_again(conversions, monkeypatch, tmp_path, damage):
    source = tiny_otf(tmp_path / "tiny.otf")
    data = cached_truetype(source, "TinyTest", "Regular")
    [path] = (tmp_path / "cache").iterdir()
    broken = {"truncate": data[:len(data) // 2], "flip": data[:100] + bytes([data[100] ^ 1]) + data[101:],
              "empty": b"", "garbage": b"\0" * len(data)}[damage]
    path.write_bytes(broken)
    assert not truetype_intact(broken)
    monkeypatch.setattr(pdf_fonts, "_LOADED", {})
    assert cached_truetype(source, "TinyTest", "Regular") == data
    assert path.read_bytes() == data
    assert len(conversions) == 2


def test_changed_font_or_converter_gets_a_new_conversion_and_the_old_one_goes(conversions, monkeypatch, tmp_path):
    source = tiny_otf(tmp_path / "tiny.otf")
    first = cached_truetype(source, "TinyTest", "Regular")
    [old] = (tmp_path / "cache").iterdir()
    tiny_otf(source, width=700)
    os.utime(source, ns=(1, 1))  # a new size alone would do; the key never trusts the date
    second = cached_truetype(source, "TinyTest", "Regular")
    assert second != first
    monkeypatch.setattr(pdf_fonts, "CONVERSION_REVISION", pdf_fonts.CONVERSION_REVISION + 1)
    monkeypatch.setattr(pdf_fonts, "_SOURCE_KEYS", {})
    cached_truetype(source, "TinyTest", "Regular")
    [current] = (tmp_path / "cache").iterdir()
    assert current != old and len(conversions) == 3


def test_threads_asking_at_once_share_one_conversion(conversions, tmp_path):
    source = tiny_otf(tmp_path / "tiny.otf")
    start = threading.Barrier(8)

    def ask(_):
        start.wait()
        return cached_truetype(source, "TinyTest", "Regular")
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(ask, range(8)))
    assert len(conversions) == 1 and all(r is results[0] for r in results)
    assert [p.name for p in (tmp_path / "cache").iterdir() if is_temporary(p)] == []


def test_processes_converting_at_once_leave_one_whole_file(tmp_path):
    source = tiny_otf(tmp_path / "tiny.otf")
    cache = tmp_path / "cache"
    code = ("import sys; from pathlib import Path; from papeer.pdf.pdf_fonts import cached_truetype; "
            "sys.stdout.write(str(len(cached_truetype(Path(sys.argv[1]), 'TinyTest', 'Regular'))))")
    environment = dict(os.environ, PAPEER_FONT_CACHE_DIR=str(cache), PYTHONPATH=str(ROOT))
    processes = [subprocess.Popen([sys.executable, "-c", code, str(source)], cwd=ROOT, env=environment,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(4)]
    outputs = [process.communicate(timeout=120) for process in processes]
    assert all(process.returncode == 0 for process in processes), [error for _, error in outputs]
    [path] = cache.iterdir()
    assert truetype_intact(path.read_bytes())
    assert {int(out) for out, _ in outputs} == {path.stat().st_size}


def test_leftover_temporaries_of_an_interrupted_conversion_are_removed(conversions, tmp_path):
    cache = tmp_path / "cache"
    cache.mkdir()
    stale, fresh = cache / ".TinyTest-Regular-x.ttf.1.tmp", cache / ".TinyTest-Regular-x.ttf.2.tmp"
    stale.write_bytes(b"half")
    fresh.write_bytes(b"being written")
    os.utime(stale, (1, 1))
    cached_truetype(tiny_otf(tmp_path / "tiny.otf"), "TinyTest", "Regular")
    # Another process may still be writing the recent one.
    assert not stale.exists() and fresh.exists()


def test_leftovers_are_removed_when_a_new_process_first_reads_the_cache(conversions, monkeypatch, tmp_path):
    source = tiny_otf(tmp_path / "tiny.otf")
    data = cached_truetype(source, "TinyTest", "Regular")
    cache = tmp_path / "cache"
    stale, fresh = cache / ".TinyTest-Regular-x.ttf.1.tmp", cache / ".TinyTest-Regular-x.ttf.2.tmp"
    older, other_face = cache / "TinyTest-Regular-0123456789abcdef0123.ttf", cache / "TinyTest-Bold-0.ttf"
    for path in (stale, fresh, older, other_face):
        path.write_bytes(b"left over")
    os.utime(stale, (1, 1))
    # A new process (nothing in memory) that finds the conversion needs no conversion to tidy up.
    monkeypatch.setattr(pdf_fonts, "_LOADED", {})
    assert cached_truetype(source, "TinyTest", "Regular") == data
    assert not stale.exists() and not older.exists()
    assert fresh.exists() and other_face.exists()
    assert conversions == [("TinyTest", "Regular")]


@pytest.mark.parametrize("failure", ["write", "folder"])
def test_cache_that_cannot_be_saved_still_gives_the_face(conversions, monkeypatch, tmp_path, capsys, failure):
    # An OSError out of build_translated_pdf would stop the whole translation (translation_run.py, _publish_ready).
    monkeypatch.setattr(pdf_fonts, "_STORE_WARNED", False)
    if failure == "write":
        def refuse(path, data):
            raise PermissionError(13, "Access is denied", str(path))
        monkeypatch.setattr(pdf_fonts, "atomic_write_bytes", refuse)
    else:
        (tmp_path / "cache").write_bytes(b"a file where the folder should be")
    source = tiny_otf(tmp_path / "tiny.otf")
    data = cached_truetype(source, "TinyTest", "Regular")
    assert truetype_intact(data)
    # The rest of the process uses the face in memory; the other face adds no second warning.
    assert cached_truetype(source, "TinyTest", "Regular") is data
    assert truetype_intact(cached_truetype(source, "TinyTest", "Bold"))
    assert conversions == [("TinyTest", "Regular"), ("TinyTest", "Bold")]
    assert capsys.readouterr().err.count("警告: 日本語フォントの変換結果を保存できませんでした") == 1
    if failure == "write":
        assert list((tmp_path / "cache").iterdir()) == []


def test_subsets_are_the_same_when_made_in_parallel_threads():
    name, family, style = FONT_FACES[0]
    face = cached_truetype(FONT_DIRECTORY / name, family, style)
    with TTFont(io.BytesIO(face), lazy=True) as font:
        kanji = [chr(c) for c in sorted(font.getBestCmap()) if 0x4E00 <= c <= 0x9FFF]
    texts = ["制御器の設計と安定性の解析。αβ∑≤" + "".join(kanji[131 * i:131 * i + 60]) for i in range(6)]
    expected = [subset_truetype(face, text) for text in texts]
    start = threading.Barrier(len(texts))

    def make(text):
        start.wait()
        return subset_truetype(face, text)
    with ThreadPoolExecutor(len(texts)) as pool:
        assert list(pool.map(make, texts)) == expected
    with TTFont(io.BytesIO(expected[0])) as font:
        cmap = font.getBestCmap()
        assert all(ord(c) in cmap for c in texts[0])
        # License metadata of the derivative stays in the subset.
        assert "Open Font License" in (font["name"].getDebugName(13) or "")
        assert font["name"].getDebugName(1) == "PapeerSerif"


def test_formula_text_keeps_greek_and_math_and_folds_what_the_serif_lacks():
    assert searchable_text("α + β ≤ ∑ θ ∈ ∞ ∂ ∇ ∫") == "α + β ≤ ∑ θ ∈ ∞ ∂ ∇ ∫"
    # Mathematical italic, double-struck and subscript letters become the plain ones.
    assert searchable_text("𝑥ᵢ ∈ ℝ") == "xi ∈ R"
    # Nothing that would be copied as a missing glyph; whitespace runs become one space.
    assert searchable_text(" a\n\tb \U0001F600") == "a b"


def test_math_symbols_the_serif_lacks_become_their_nearest_character_in_it():
    name, family, style = FONT_FACES[0]
    with TTFont(io.BytesIO(cached_truetype(FONT_DIRECTORY / name, family, style)), lazy=True) as font:
        cmap = font.getBestCmap()
    stand_ins = {"⟨": "〈", "⟩": "〉", "∼": "〜", "∗": "*", "∘": "○", "⋆": "☆", "⋮": "︙",
                 "⋅": "·", "∙": "·", "∖": "\\", "⌈": "┌", "⌉": "┐", "⌊": "└", "⌋": "┘"}
    for symbol, stand_in in stand_ins.items():
        assert ord(symbol) not in cmap and ord(stand_in) in cmap, symbol
        assert searchable_text(symbol) == stand_in
    # Ceiling and floor stay apart.
    assert searchable_text("⟨x, y⟩ ∼ f∘g ⌈n/2⌉ + ⌊m⌋ a∗b") == "〈x, y〉 〜 f○g ┌n/2┐ + └m┘ a*b"


def formula_document(source: Path) -> tuple[dict, dict, str]:
    """The math test page with the inline formula's text as a paper with Greek math would give it."""
    document = extract_pdf(source)
    block = next(b for b in document["blocks"] if "The state" in b["text"] and b.get("formulas"))
    math = "α_k ≤ ∑ θ ∈ 𝑥ᵢ"
    blocks = [dict(b, formulas=[dict(f, text=math) for f in b["formulas"]]) if b is block else b
              for b in document["blocks"]]
    translation = "状態 " + " ".join(f["token"] for f in block["formulas"]) + " はフィードバック制御で変化する。"
    return dict(document, blocks=blocks), {block["id"]: translation}, math


def test_formula_under_its_image_can_be_found_and_copied(tmp_path):
    source, output = tmp_path / "math.pdf", tmp_path / "translated.pdf"
    make_math_pdf(source)
    document, translations, math = formula_document(source)
    build_translated_pdf(source, document, translations, output)
    with fitz.open(output) as pdf:
        page = pdf[0]
        assert searchable_text(math) == "α_k ≤ ∑ θ ∈ xi"
        assert "α_k ≤ ∑ θ ∈ xi" in page.get_text()
        [image] = [fitz.Rect(i["bbox"]) for i in page.get_image_info()]
        for needle in ("α", "≤", "∑", "θ", "xi"):
            found = page.search_for(needle)
            assert found and all(image.intersects(rect) for rect in found), needle
        # Invisible (render mode 3), in the bundled serif rather than a base-14 font without Greek.
        spans = [item for item in page.get_texttrace() if any(c[0] == ord("α") for c in item["chars"])]
        assert spans and all(item["type"] == 3 and "PapeerSerif" in item["font"] for item in spans)
    # PDFium (the reader's other engine) reads the same text.
    document = pdfium.PdfDocument(str(output))
    try:
        assert "α_k ≤ ∑ θ ∈ xi" in document[0].get_textpage().get_text_range()
    finally:
        document.close()


def multi_page_source(path: Path, pages: int) -> Path:
    single = path.with_name("single.pdf")
    make_math_pdf(single)
    with fitz.open(single) as page, fitz.open() as pdf:
        for _ in range(pages):
            pdf.insert_pdf(page)
        pdf.save(path)
    return path


def test_pages_built_at_once_match_pages_built_one_by_one(tmp_path, monkeypatch):
    source = multi_page_source(tmp_path / "paper.pdf", 4)
    document = extract_pdf(source)
    page_translations = {}
    for number in range(1, 5):
        # Different characters on every page, so that every page has its own font subset.
        words = "".join(chr(0x4E00 + 211 * number + j) for j in range(40))
        page_translations[number] = {
            b["id"]: f"第{number}頁の訳文{words}" + "".join(" " + f["token"] for f in b.get("formulas", []))
            for b in document["blocks"] if b["page"] == number and b["kind"] == "text"}

    def build(number: int, folder: Path) -> Path:
        output = folder / f"p{number}.pdf"
        build_translated_pdf(source, document, page_translations[number], output, page_numbers={number})
        return output

    def pages_of(paths):
        result = []
        for path in paths:
            with fitz.open(path) as pdf:
                page = pdf[0]
                result.append((page.get_text(), sorted(f[3].split("+")[-1] for f in page.get_fonts()),
                               page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5)).samples))
        return result

    (tmp_path / "one").mkdir()
    expected = pages_of([build(n, tmp_path / "one") for n in range(1, 5)])

    # fontTools runs outside PDF_LOCK; MuPDF (the fonts put into the page included) inside it.
    held = {"subsets": [], "mupdf": []}
    subsets, write_text, insert_htmlbox = pdf_engine.font_subsets, fitz.TextWriter.write_text, fitz.Page.insert_htmlbox

    def watched_subsets(text):
        held["subsets"].append(PDF_LOCK._is_owned())
        return subsets(text)

    def watched_write(self, *args, **kwargs):
        held["mupdf"].append(PDF_LOCK._is_owned())
        return write_text(self, *args, **kwargs)

    def watched_htmlbox(self, *args, **kwargs):
        held["mupdf"].append(PDF_LOCK._is_owned())
        return insert_htmlbox(self, *args, **kwargs)
    monkeypatch.setattr(pdf_engine, "font_subsets", watched_subsets)
    monkeypatch.setattr(fitz.TextWriter, "write_text", watched_write)
    monkeypatch.setattr(fitz.Page, "insert_htmlbox", watched_htmlbox)

    (tmp_path / "parallel").mkdir()
    start = threading.Barrier(4)

    def build_at_once(number):
        start.wait()
        return build(number, tmp_path / "parallel")
    with ThreadPoolExecutor(4) as pool:
        paths = list(pool.map(build_at_once, range(1, 5)))
    assert pages_of(paths) == expected
    assert held["subsets"] == [False] * 4
    assert held["mupdf"] and all(held["mupdf"])
    for number, (text, _, _) in enumerate(expected, 1):
        assert f"第{number}頁の訳文" in text and "α" not in text


def test_translation_start_converts_the_faces_on_a_background_thread(conversions, monkeypatch, tmp_path):
    from papeer.pdf import pdf_typography
    fonts = tmp_path / "fonts"
    fonts.mkdir()
    for name, _, _ in FONT_FACES:
        tiny_otf(fonts / name)
    monkeypatch.setattr(pdf_typography, "FONT_DIRECTORY", fonts)
    escaped = []
    monkeypatch.setattr(threading, "excepthook", escaped.append)
    assert pdf_typography.fonts_need_conversion()
    for _ in range(2):  # the second finds nothing to do
        pdf_typography.prepare_fonts_in_background()
        for thread in threading.enumerate():
            if thread.name == "papeer-fonts":
                thread.join(60)
    assert sorted(conversions) == sorted((family, style) for _, family, style in FONT_FACES)
    assert len(list((tmp_path / "cache").glob("*.ttf"))) == 2
    # Nothing left to convert, in this process or (files only) in a new one.
    assert not pdf_typography.fonts_need_conversion()
    monkeypatch.setattr(pdf_fonts, "_LOADED", {})
    assert not pdf_typography.fonts_need_conversion()
    # A failure stays on the thread; the page that needs the faces reports it.
    monkeypatch.setattr(pdf_typography, "FONT_DIRECTORY", tmp_path / "missing")
    pdf_typography.prepare_fonts_in_background()
    for thread in threading.enumerate():
        if thread.name == "papeer-fonts":
            thread.join(60)
    assert escaped == []
