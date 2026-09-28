"""OCR engines (papeer.layout.ocr_engines): which engine reads a language, the fallback, the options from
the environment and the download of the Tesseract language data (the network is replaced)."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
from pathlib import Path
import sys
import threading

from PIL import Image
import pytest

from papeer.layout import ocr_engines
from papeer.layout.ocr_engines import (EngineSet, OcrDeclined, OcrError, OcrLine, OcrOptions, OcrWord,
                                       WindowsOcrEngine, download_tessdata, engine_order, recognize,
                                       tessdata_directory, tessdata_ready)

FIXTURES = Path(__file__).parent / "fixtures" / "ocr"


# ---------------------------------------------------------------- choice

def test_japanese_goes_to_windows_first_on_windows_and_tesseract_elsewhere():
    assert engine_order("ja", platform="win32") == ["windows", "tesseract"]
    assert engine_order("en", platform="win32") == ["tesseract", "windows"]
    # macOS and Linux: Tesseract only, until Vision is added.
    assert engine_order("ja", platform="darwin") == ["tesseract"]
    assert engine_order("en", platform="linux") == ["tesseract"]


def test_a_chosen_engine_goes_first_and_the_other_stays_as_fallback():
    assert engine_order("en", "windows", platform="win32") == ["windows", "tesseract"]
    assert engine_order("ja", "tesseract", platform="win32") == ["tesseract", "windows"]
    assert engine_order("ja", "windows", platform="darwin") == ["tesseract"]


class FakeEngine:
    def __init__(self, name, langs, fail=False):
        self.name, self.langs, self.fail, self.calls = name, set(langs), fail, 0

    def languages(self):
        return self.langs

    def recognize(self, image, lang):
        self.calls += 1
        if self.fail:
            raise OcrError("broken")
        return [OcrLine((OcrWord((0, 0, 10, 10), self.name),))]


def test_recognize_falls_back_to_the_next_engine():
    first, second = FakeEngine("windows", {"ja"}, fail=True), FakeEngine("tesseract", {"ja"})
    lines, name = recognize(Image.new("L", (20, 20), 255), "ja", [first, second])
    assert name == "tesseract" and first.calls == 1 and lines[0].words[0].text == "tesseract"
    with pytest.raises(OcrError, match="OCR できるエンジンがありません"):
        recognize(Image.new("L", (20, 20), 255), "ja", [first])
    with pytest.raises(OcrError):
        recognize(Image.new("L", (20, 20), 255), "ja", [])


def test_engine_set_leaves_out_engines_without_the_language(monkeypatch):
    engines = EngineSet(OcrOptions(enabled=True, engine="auto"))
    engines.engines = {"windows": FakeEngine("windows", {"ja"}), "tesseract": FakeEngine("tesseract", {"en"})}
    monkeypatch.setattr(sys, "platform", "win32")
    assert [e.name for e in engines.order("ja")] == ["windows"]
    assert [e.name for e in engines.order("en")] == ["tesseract"]
    engines.engines["windows"].langs = set()
    assert engines.order("ja") == []


def test_options_come_from_the_environment(monkeypatch, tmp_path):
    for name in ("PAPEER_OCR", "PAPEER_OCR_ENGINE", "PAPEER_OCR_LANG", "PAPEER_TESSDATA_DIR"):
        monkeypatch.delenv(name, raising=False)
    assert OcrOptions.from_env() == OcrOptions()
    assert not OcrOptions.from_env().enabled
    monkeypatch.setenv("PAPEER_OCR", "1")
    monkeypatch.setenv("PAPEER_OCR_ENGINE", "Windows")
    monkeypatch.setenv("PAPEER_OCR_LANG", "ja")
    monkeypatch.setenv("PAPEER_TESSDATA_DIR", str(tmp_path))
    options = OcrOptions.from_env()
    assert (options.enabled, options.engine, options.lang, options.tessdata) == (True, "windows", "ja", tmp_path)
    assert tessdata_directory(options) == tmp_path
    monkeypatch.setenv("PAPEER_OCR_ENGINE", "abbyy")
    monkeypatch.setenv("PAPEER_OCR_LANG", "fr")
    assert (OcrOptions.from_env().engine, OcrOptions.from_env().lang) == ("auto", "auto")


def test_language_data_lives_in_the_device_folder(monkeypatch, tmp_path):
    monkeypatch.delenv("PAPEER_TESSDATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert tessdata_directory() == tmp_path / "PapeerSync" / "tessdata" / "fast"


# ---------------------------------------------------------------- download

CONTENT = b"traineddata " * 5000


@pytest.fixture
def fake_data(monkeypatch):
    """A made-up language "en" whose data is CONTENT, served by a fake opener."""
    monkeypatch.setitem(ocr_engines.TESSDATA, "en", ("eng", len(CONTENT), hashlib.sha256(CONTENT).hexdigest()))
    requests = []

    class Response(io.BytesIO):
        def __exit__(self, *args):
            self.close()

    def opener(body=CONTENT):
        def open_(url, timeout):
            requests.append(url)
            return Response(body)
        return open_
    return requests, opener


def test_download_asks_first_and_checks_the_hash(fake_data, tmp_path):
    requests, opener = fake_data
    asked, progress = [], []
    path = download_tessdata("en", lambda url, size: asked.append((url, size)) or True, tmp_path, opener(),
                             lambda done, total: progress.append(done))
    assert path == tmp_path / "eng.traineddata" and path.read_bytes() == CONTENT
    assert asked == [("https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata",
                      len(CONTENT))]
    assert requests == [asked[0][0]] and progress[-1] == len(CONTENT)
    assert not list(tmp_path.glob("*.part"))
    assert tessdata_ready("en", tmp_path)
    # Present and intact: nothing is asked or fetched again.
    assert download_tessdata("en", lambda url, size: pytest.fail("asked again"), tmp_path, opener()) == path
    assert len(requests) == 1


def test_declined_download_fetches_nothing(fake_data, tmp_path):
    requests, opener = fake_data
    with pytest.raises(OcrDeclined):
        download_tessdata("en", lambda url, size: False, tmp_path / "data", opener())
    assert requests == [] and not (tmp_path / "data").exists()


@pytest.mark.parametrize("body", [CONTENT[:-1] + b"X", CONTENT[:100], CONTENT + b"more"], ids=["changed", "short", "long"])
def test_a_wrong_download_never_takes_the_name(fake_data, tmp_path, body):
    _, opener = fake_data
    with pytest.raises(OcrError):
        download_tessdata("en", lambda url, size: True, tmp_path, opener(body))
    assert list(tmp_path.iterdir()) == []


def test_a_network_error_leaves_nothing_behind(fake_data, tmp_path):
    def broken(url, timeout):
        raise OSError("no network")
    with pytest.raises(OcrError, match="ダウンロードできませんでした"):
        download_tessdata("en", lambda url, size: True, tmp_path, broken)
    assert list(tmp_path.iterdir()) == []


def test_a_changed_file_is_not_ready(fake_data, tmp_path):
    (tmp_path / "eng.traineddata").write_bytes(CONTENT[:-1] + b"Y")
    assert not tessdata_ready("en", tmp_path)
    assert not tessdata_ready("ja", tmp_path)


def test_the_listed_hashes_match_the_published_files(tessdata):
    # The session fixture fetched (or found) them through download_tessdata, which checks the hashes.
    for lang in ocr_engines.TESSDATA:
        assert tessdata_ready(lang, tessdata)


def test_unknown_language():
    with pytest.raises(OcrError):
        download_tessdata("fr", lambda url, size: True)


# ---------------------------------------------------------------- Tesseract through PyMuPDF

def test_tesseract_reads_words_with_boxes(tessdata):
    image = Image.open(FIXTURES / "synth_en_2col.png").convert("L")
    truth = json.loads((FIXTURES / "truth.json").read_text("utf-8"))["synth_en_2col"]
    line = next(line for line in truth["lines"] if line[4].startswith("David Lee"))
    k = 300 / 72
    box = (int(line[0] * k) - 20, int(line[1] * k) - 20, int(line[2] * k) + 20, int(line[3] * k) + 20)
    lines = ocr_engines.TesseractEngine(tessdata).recognize(image.crop(box), "en")
    assert [" ".join(w.text for w in line.words) for line in lines] == ["David Lee and Emma Wilson"]
    x0, y0, x1, y1 = lines[0].box
    assert abs(x0 - 20) < 8 and abs(y0 - 20) < 12 and abs(x1 - (box[2] - box[0] - 20)) < 8


def test_tesseract_without_data_fails_so_that_the_next_engine_is_tried(tmp_path):
    engine = ocr_engines.TesseractEngine(tmp_path)
    assert engine.languages() == set()
    with pytest.raises(OcrError):
        engine.recognize(Image.new("L", (50, 50), 255), "en")


# ---------------------------------------------------------------- Windows.Media.Ocr

windows_ja = pytest.mark.skipif("ja" not in WindowsOcrEngine().languages(),
                                reason="Windows の OCR に日本語の認識器がない環境")


@windows_ja
def test_windows_ocr_reads_japanese_without_spaces_between_characters():
    from papeer.pdf.pdf_ocr import _join, _rows

    image = Image.open(FIXTURES / "synth_ja_2col_mathfig.png").convert("L")
    truth = json.loads((FIXTURES / "truth.json").read_text("utf-8"))["synth_ja_2col_mathfig"]
    line = next(line for line in truth["lines"] if line[4].startswith("目的関数"))
    k = 300 / 72
    crop = image.crop((int(line[0] * k) - 10, int(line[1] * k) - 10, int(line[2] * k) + 10, int(line[3] * k) + 10))
    lines = WindowsOcrEngine().recognize(crop, "ja")
    assert lines and not lines[0].spaced
    row = _rows(lines)[0]
    text = "".join(piece for piece, _ in _join(row, row.box[3] - row.box[1]))
    assert text == line[4]


@windows_ja
def test_windows_ocr_shrinks_images_over_its_limit_and_runs_beside_an_event_loop():
    image = Image.open(FIXTURES / "synth_ja_2col_mathfig.png").convert("L").crop((150, 150, 1250, 350))
    wide = Image.new("L", (10400, 200), 255)
    wide.paste(image, (9200, 0))
    result = []

    async def inside_a_loop():
        result.extend(WindowsOcrEngine().recognize(wide, "ja"))

    thread = threading.Thread(target=asyncio.run, args=(inside_a_loop(),))
    thread.start()
    thread.join()
    assert result, "nothing read"
    # Boxes are in pixels of the image given, not of the shrunk copy.
    assert min(line.box[0] for line in result) > 9000


# ---------------------------------------------------------------- the tests' own language data

def test_tests_never_download_unless_asked(tmp_path):
    from _tessdata import prepare_tessdata

    def download(*args):
        pytest.fail("downloaded without being asked")
    with pytest.raises(pytest.skip.Exception, match="PAPEER_TEST_DOWNLOAD_TESSDATA=1"):
        prepare_tessdata(tmp_path, {}, download)


def test_tests_fail_when_the_asked_download_fails(tmp_path):
    from _tessdata import prepare_tessdata

    def download(lang, confirm, directory):
        raise OcrError("no network")
    with pytest.raises(pytest.fail.Exception, match="no network"):
        prepare_tessdata(tmp_path, {"PAPEER_TEST_DOWNLOAD_TESSDATA": "1"}, download)


def test_tests_take_the_language_data_from_the_given_folder(tessdata, tmp_path):
    from _tessdata import prepare_tessdata

    assert prepare_tessdata(tmp_path, {"PAPEER_TEST_TESSDATA": str(tessdata)},
                            lambda *args: pytest.fail("downloaded")) == tessdata


# ---------------------------------------------------------------- failures become OcrError

def test_a_mupdf_error_in_tesseract_becomes_an_ocr_error(tessdata, monkeypatch):
    import pymupdf

    def broken(self, *args, **kwargs):
        raise pymupdf.mupdf.FzErrorLibrary("code=3: Tesseract language initialisation failed")
    monkeypatch.setattr(pymupdf.Page, "get_textpage_ocr", broken)
    with pytest.raises(OcrError, match="FzErrorLibrary"):
        ocr_engines.TesseractEngine(tessdata).recognize(Image.new("L", (100, 50), 255), "en")


@pytest.mark.parametrize("error", [OSError("no recognizer"), MemoryError(), ValueError("odd")])
def test_any_windows_ocr_failure_falls_back_to_the_next_engine(monkeypatch, error):
    engine = WindowsOcrEngine()
    monkeypatch.setattr(WindowsOcrEngine, "_winrt", staticmethod(lambda: ("modules",)))
    monkeypatch.setattr(WindowsOcrEngine, "_tag", lambda self, lang: "ja")

    def broken(*args):
        raise error
    monkeypatch.setattr(WindowsOcrEngine, "_recognize", broken)
    with pytest.raises(OcrError):
        engine.recognize(Image.new("L", (50, 50), 255), "ja")
    lines, name = recognize(Image.new("L", (20, 20), 255), "ja", [engine, FakeEngine("tesseract", {"ja"})])
    assert name == "tesseract"


def test_an_engine_raising_anything_is_skipped():
    class Odd(FakeEngine):
        def recognize(self, image, lang):
            raise KeyError("an engine added later")
    lines, name = recognize(Image.new("L", (20, 20), 255), "en", [Odd("vision", {"en"}), FakeEngine("tesseract", {"en"})])
    assert name == "tesseract"


def test_a_broken_http_response_leaves_nothing_behind(fake_data, tmp_path):
    import http.client

    class Broken(io.BytesIO):
        def __exit__(self, *args):
            self.close()

        def read(self, *args):
            raise http.client.IncompleteRead(b"partial")

    with pytest.raises(OcrError, match="ダウンロードできませんでした"):
        download_tessdata("en", lambda url, size: True, tmp_path, lambda url, timeout: Broken())
    assert list(tmp_path.iterdir()) == []
