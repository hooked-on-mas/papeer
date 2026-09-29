"""OCR in the library (papeer.core.ocr, sidecar/routes/ocr.py): this PC's settings, the language data and its
download, the readings a paper keeps, reading a paper's pages again as a job (with its cancel), and the AI
engine with a stand-in connection. No real AI, network or language data is used: the engines are stand-ins."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
from unittest.mock import patch

from fastapi.testclient import TestClient
import pymupdf as fitz
from PIL import Image, ImageDraw
import pytest

from papeer.core import ocr
from papeer.core import ai_ocr
from papeer.core.ai_ocr import AiOcrEngine, batches, ink_rows, lines_for
from papeer.core.config import Settings
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from papeer.layout import ocr_engines
from papeer.layout.math_layout import LAYOUT_VERSION
from papeer.layout.ocr_engines import (OcrError, OcrLine, OcrOptions, OcrWord, VisionEngine, WindowsOcrEngine,
                                       download_tessdata)
from papeer.core.search_index import SearchIndex
from papeer.pdf import pdf_ocr
from papeer.pdf.pdf_engine import PDF_LOCK, OcrRun, extract_pdf
from papeer.pdf.pdf_ocr import OcrPage
from papeer.providers import Cancelled, ProviderBackend, ProviderSpec, create_provider
from sidecar import deps
from sidecar.app import app
from sidecar.deps import job_manager

FIXTURES = Path(__file__).parent / "fixtures" / "ocr"


class StandIn:
    """An OCR engine that reads every region as a line of fixed words, spanning the region."""
    name = "tesseract"

    def __init__(self, text: str = "Scanned words read by the stand-in engine"):
        self.text = text
        self.calls = 0
        self.entered = threading.Event()
        self.release: threading.Event | None = None

    def languages(self) -> set[str]:
        return {"en", "ja"}

    def recognize(self, image: Image.Image, lang: str) -> list[OcrLine]:
        self.calls += 1
        self.entered.set()
        if self.release is not None:
            self.release.wait(10)
        return [OcrLine((OcrWord((0, 0, image.width, min(image.height, 40)), self.text),))]


@pytest.fixture
def engine(monkeypatch):
    """The stand-in in place of Tesseract, and no system OCR."""
    stand_in = StandIn()
    monkeypatch.setattr(ocr_engines, "TesseractEngine", lambda directory, dpi, lock: stand_in)
    monkeypatch.setattr(WindowsOcrEngine, "languages", lambda self: set())
    monkeypatch.setattr(VisionEngine, "languages", lambda self: set())
    return stand_in


def scan_pdf(folder: Path, pages: int = 1) -> Path:
    """A PDF whose pages are the image of a scanned two-column English page (and, after it, a page of text)."""
    image = Image.open(FIXTURES / "synth_en_2col.png").convert("L")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    path = folder / "scan.pdf"
    width, height = image.width * 72 / 300, image.height * 72 / 300  # Scanned at 300 dpi.
    with fitz.open() as document:
        page = document.new_page(width=width, height=height)
        page.insert_image(page.rect, stream=buffer.getvalue())
        for _ in range(pages - 1):
            page = document.new_page(width=width, height=height)
            page.insert_text((72, 100), "An ordinary page with a text layer, which needs no OCR at all. " * 3, fontsize=9)
        document.save(path)
    return path


# ---------------------------------------------------------------- settings

def test_settings_are_this_pcs_with_defaults_for_anything_missing_or_unknown():
    assert ocr.ocr_settings() == {"mode": "ask", "engine": "auto", "lang": "auto"}
    assert ocr.save_ocr_settings("auto", "tesseract", "ja") == {"mode": "auto", "engine": "tesseract", "lang": "ja"}
    assert ocr.settings_path().parent == ocr.device_directory()
    assert ocr.import_reads()
    for bad in (("sometimes", "auto", "auto"), ("ask", "abbyy", "auto"), ("ask", "auto", "fr")):
        with pytest.raises(ValueError):
            ocr.save_ocr_settings(*bad)
    ocr.settings_path().write_text(json.dumps({"mode": "never", "engine": "windows", "lang": 3}), "utf-8")
    assert ocr.ocr_settings() == {"mode": "ask", "engine": "windows", "lang": "auto"}
    ocr.settings_path().write_text("{broken", "utf-8")
    assert ocr.ocr_settings() == ocr.DEFAULT_SETTINGS and not ocr.import_reads()


def test_the_development_variables_still_win(monkeypatch):
    ocr.save_ocr_settings("off", "tesseract", "en")
    monkeypatch.setenv("PAPEER_OCR", "1")
    monkeypatch.setenv("PAPEER_OCR_ENGINE", "windows")
    assert ocr.import_reads()
    options = ocr.ocr_options()
    assert (options.enabled, options.engine, options.lang) == (True, "windows", "en")
    assert ocr.ocr_options(engine="ai").engine == "ai"


def test_status_tells_the_language_data_what_reads_each_language_and_what_is_missing(engine, tmp_path, monkeypatch):
    monkeypatch.setenv("PAPEER_TESSDATA_DIR", str(tmp_path))
    status = ocr.status()
    assert [entry["lang"] for entry in status["language_data"]] == ["en", "ja"]
    assert not any(entry["installed"] for entry in status["language_data"])
    assert status["language_data"][0]["url"].startswith("https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/")
    assert status["directory"] == str(tmp_path)
    assert status["readable"] == {"en": ["tesseract"], "ja": ["tesseract"]} and status["missing"] == []
    monkeypatch.setattr(StandIn, "languages", lambda self: {"ja"})
    ocr.save_ocr_settings("ask", "auto", "en")
    assert ocr.status()["missing"] == ["en"]


# ---------------------------------------------------------------- language data

def _fake_data(monkeypatch, content: bytes) -> None:
    monkeypatch.setitem(ocr_engines.TESSDATA, "en", ("eng", len(content), hashlib.sha256(content).hexdigest()))


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_a_cancelled_download_leaves_nothing_behind(tmp_path, monkeypatch):
    content = b"x" * 300_000
    _fake_data(monkeypatch, content)

    def stop(received, size):
        raise Cancelled("中止")

    with pytest.raises(Cancelled):
        download_tessdata("en", lambda url, size: True, tmp_path, opener=lambda url, timeout: _Response(content), progress=stop)
    assert list(tmp_path.iterdir()) == []


@pytest.fixture
def client(monkeypatch):
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        with patch.dict("os.environ", {"PAPEER_DATA_DIR": str(root / "library"), "PAPEER_TOKEN": "", "PAPEER_DEV_NO_AUTH": "1",
                                       "PAPEER_TESSDATA_DIR": str(root / "tessdata")}):
            yield TestClient(app), root


def _wait(job_id: str):
    deadline = time.time() + 60
    while time.time() < deadline:
        job = job_manager.get_job(job_id)
        if job and not job.running:
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_the_download_job_reports_its_progress_and_why_it_failed(client, monkeypatch):
    client, root = client
    content = b"language data " * 20_000
    _fake_data(monkeypatch, content)
    answers = {"body": content}
    monkeypatch.setattr(ocr_engines.urllib.request, "urlopen", lambda url, timeout: _Response(answers["body"]))
    messages = []
    original = job_manager.broadcast
    monkeypatch.setattr(job_manager, "broadcast", lambda event: messages.append(getattr(event, "message", "")) or original(event))

    job = _wait(client.post("/api/ocr/language-data", json={"langs": ["en"]}).json()["job_id"])
    assert job.status == "succeeded" and job.result.installed == ["en"]
    assert (root / "tessdata" / "eng.traineddata").read_bytes() == content
    assert any(message.startswith("英語の言語データをダウンロードしています") and "KB" in message for message in messages)
    assert client.get("/api/ocr").json()["language_data"][0]["installed"]

    (root / "tessdata" / "eng.traineddata").unlink()
    answers["body"] = b"something else" * 20_000
    job = _wait(client.post("/api/ocr/language-data", json={"langs": ["en"]}).json()["job_id"])
    assert job.status == "failed" and "SHA-256" in job.error
    assert not (root / "tessdata" / "eng.traineddata").exists()
    assert client.post("/api/ocr/language-data", json={"langs": []}).status_code == 422


def test_settings_route_saves_and_status_tells_whether_the_ai_can_read_images(client, engine):
    client, _ = client
    assert client.put("/api/ocr/settings", json={"mode": "off", "engine": "tesseract", "lang": "en"}).json() == {
        "mode": "off", "engine": "tesseract", "lang": "en"}
    assert client.put("/api/ocr/settings", json={"mode": "never", "engine": "auto", "lang": "auto"}).status_code == 422
    Settings(provider="antigravity").save(deps.get_data_dir())
    ai = client.get("/api/ocr").json()["ai"]
    assert not ai["available"] and "agy" in ai["reason"] and ai["provider"] == "antigravity"
    for provider in ("claude", "codex", "api"):
        Settings(provider=provider).save(deps.get_data_dir())
        assert client.get("/api/ocr").json()["ai"]["available"], provider


# ---------------------------------------------------------------- readings and extraction

def test_a_page_read_once_is_built_again_from_its_reading_without_any_engine(engine, tmp_path):
    source = scan_pdf(tmp_path, pages=2)
    run = ocr.ocr_run(OcrOptions(enabled=True, engine="tesseract", lang="en"))
    first = extract_pdf(source, run=run)
    assert first["ocr_applied"] == [{"page": 1, "reason": "image", "engine": "tesseract", "lang": "en", "skew": 0.0}]
    assert run.read_now == [1] and set(run.readings) == {"1"} and engine.calls
    assert "Scanned words read by the stand-in engine" in first["pages"][0]["text"]

    calls = engine.calls
    again = OcrRun(saved=json.loads(json.dumps(run.readings)))  # As kept on disk.
    second = extract_pdf(source, run=again)
    assert engine.calls == calls
    # The first extraction is built from the reading as kept, so building it again gives the very same document.
    assert second == first
    assert again.readings == run.readings
    record = run.readings["1"]
    assert OcrPage.from_record(record).to_record() == record
    # Without its reading, the page stays 要OCR.
    assert extract_pdf(source, run=OcrRun())["ocr_pages"] == [{"page": 1, "reason": "image"}]
    # A reading of another format is not used.
    assert "ocr_applied" not in extract_pdf(source, run=OcrRun(saved={"1": {"version": 99}}))


def test_a_cancelled_reading_stops_between_regions(engine, tmp_path):
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        extract_pdf(scan_pdf(tmp_path), run=ocr.ocr_run(OcrOptions(enabled=True, engine="tesseract", lang="en"), cancel))
    assert engine.calls == 0


def test_a_scanned_pdf_is_added_and_read_by_the_job_and_kept_through_a_new_layout_version(client, engine):
    client, root = client
    source = scan_pdf(root, pages=2)
    job = _wait(client.post("/api/papers/import", json={"paths": [str(source)]}).json()["job_id"])
    assert job.status == "succeeded"
    paper_id = job.result.paper_ids[0]
    # "ask" (the default): nothing read while adding; the frontend offers it.
    assert job.result.needs_ocr == [paper_id] and engine.calls == 0
    reading = client.get(f"/api/papers/{paper_id}/reading").json()
    assert reading["ocr_pages"] == [{"page": 1, "reason": "image"}] and reading["ocr_applied"] == []

    assert client.post(f"/api/papers/{paper_id}/ocr", json={"engine": "local", "pages": [9]}).status_code == 400
    job = _wait(client.post(f"/api/papers/{paper_id}/ocr", json={"engine": "local", "pages": None}).json()["job_id"])
    assert job.status == "succeeded", job.error
    assert job.result.read_pages == [1] and job.result.ocr_pages == [] and 1 in job.result.changed_pages
    assert job.result.retranslate_pages == [] and job.result.usage is None
    reading = client.get(f"/api/papers/{paper_id}/reading").json()
    assert reading["ocr_pages"] == [] and reading["ocr_applied"][0]["engine"] == "tesseract"
    assert 1 in reading["translation_required_pages"]
    lib = Library(root / "library")
    files = PaperFiles(lib.folder(paper_id))
    assert set(json.loads(files.ocr_text.read_text("utf-8"))["pages"]) == {"1"}
    assert "stand-in engine" in lib.page_text(paper_id, 1)

    # A new LAYOUT_VERSION extracts the paper again inside a request: no engine runs, the reading is used.
    calls = engine.calls
    document = json.loads(files.document_json.read_text("utf-8"))
    files.document_json.write_text(json.dumps({**document, "layout_version": LAYOUT_VERSION - 1}), "utf-8")
    refreshed = lib.document(paper_id)
    assert engine.calls == calls
    assert refreshed["layout_version"] == LAYOUT_VERSION and refreshed["ocr_applied"] == document["ocr_applied"]
    assert refreshed["pages"][0]["text"] == document["pages"][0]["text"]


def test_the_pages_whose_translation_is_made_again_are_told(client, engine):
    client, root = client
    job = _wait(client.post("/api/papers/import", json={"paths": [str(scan_pdf(root, pages=2))]}).json()["job_id"])
    paper_id = job.result.paper_ids[0]
    _wait(client.post(f"/api/papers/{paper_id}/ocr", json={}).json()["job_id"])
    lib = Library(root / "library")
    files = PaperFiles(lib.folder(paper_id))
    files.translation_cache.write_text(json.dumps({"completed_pages": {"1": {}, "2": {}}}), "utf-8")
    engine.text = "Other words the engine reads now"
    job = _wait(client.post(f"/api/papers/{paper_id}/ocr", json={"pages": [1]}).json()["job_id"])
    assert job.result.read_pages == [1] and job.result.changed_pages == [1] and job.result.retranslate_pages == [1]


def test_reading_a_paper_can_be_cancelled_and_leaves_it_as_it_was(client, engine):
    client, root = client
    job = _wait(client.post("/api/papers/import", json={"paths": [str(scan_pdf(root))]}).json()["job_id"])
    paper_id = job.result.paper_ids[0]
    engine.release = threading.Event()
    job_id = client.post(f"/api/papers/{paper_id}/ocr", json={}).json()["job_id"]
    assert engine.entered.wait(30)
    assert client.post(f"/api/jobs/{job_id}/cancel").status_code == 200
    engine.release.set()
    job = _wait(job_id)
    assert job.status == "cancelled"
    reading = client.get(f"/api/papers/{paper_id}/reading").json()
    assert reading["ocr_pages"] == [{"page": 1, "reason": "image"}] and reading["ocr_applied"] == []


def test_added_papers_are_read_at_once_with_the_auto_setting(client, engine):
    client, root = client
    ocr.save_ocr_settings("auto", "auto", "en")
    job = _wait(client.post("/api/papers/import", json={"paths": [str(scan_pdf(root))]}).json()["job_id"])
    assert job.status == "succeeded" and job.result.needs_ocr == []
    lib = Library(root / "library")
    assert lib.document(job.result.paper_ids[0])["ocr_applied"][0]["page"] == 1
    assert PaperFiles(lib.folder(job.result.paper_ids[0])).ocr_text.is_file()


# ---------------------------------------------------------------- the AI

class ImageReader(ProviderBackend):
    """A stand-in connection that answers the text of each image: "line one\\nline two"."""
    spec = ProviderSpec(id="api", label="Stand-in", description="", kind="http")

    def __init__(self, settings=None, cancel=None, api_key=None):
        super().__init__(settings or Settings(provider="api"), cancel)
        self.images: list[list[bytes]] = []

    def _generate(self, instruction, data, schema):
        raise AssertionError("no text request is expected")

    def image_support(self):
        return None

    def _generate_images(self, instruction, images, schema):
        self.images.append(images)
        self.usage.add(input_tokens=100, output_tokens=10)
        return json.dumps({"texts": ["Read by the model\nsecond line"] * len(images)})


def test_ai_lines_are_put_on_the_rows_of_ink():
    image = Image.new("L", (400, 120), 255)
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, 380, 30), fill=0)
    draw.rectangle((10, 70, 200, 90), fill=0)
    assert ink_rows(image) == [(10, 10, 381, 31), (10, 70, 201, 91)]
    lines = lines_for(image, "First line\n\nSecond line\n")
    assert [line.words[0].text for line in lines] == ["First line", "Second line"]
    assert [line.box for line in lines] == [(10, 10, 381, 31), (10, 70, 201, 91)]
    # Counts that differ: spread evenly over the ink.
    spread = lines_for(image, "a\nb\nc\nd")
    assert len(spread) == 4 and spread[0].box[1] == 10 and spread[-1].box[3] == 91
    assert lines_for(image, "  \n") == []


def test_the_ai_engine_reads_every_region_of_a_page_in_one_request():
    provider = ImageReader()
    engine = AiOcrEngine(provider)
    images = [Image.new("L", (300, 60), 255), Image.new("L", (300, 60), 255)]
    found = engine.recognize_many(images, "en")
    assert len(found) == 2 and len(provider.images) == 1 and len(provider.images[0]) == 2
    assert provider.images[0][0].startswith(b"\x89PNG")
    provider._generate_images = lambda instruction, images, schema: json.dumps({"texts": ["only one"]})
    with pytest.raises(OcrError, match="数"):
        engine.recognize_many(images, "en")


def test_a_page_is_read_again_by_the_ai_and_its_usage_reported(client, engine, monkeypatch):
    client, root = client
    job = _wait(client.post("/api/papers/import", json={"paths": [str(scan_pdf(root, pages=2))]}).json()["job_id"])
    paper_id = job.result.paper_ids[0]
    provider = ImageReader()
    monkeypatch.setattr(deps, "provider_for", lambda settings=None, cancel=None, api_key=None: provider)
    assert client.post(f"/api/papers/{paper_id}/ocr", json={"engine": "ai", "pages": None}).status_code == 400
    assert client.post(f"/api/papers/{paper_id}/ocr", json={"engine": "ai", "pages": [1, 2]}).status_code == 400
    calls = engine.calls
    job = _wait(client.post(f"/api/papers/{paper_id}/ocr", json={"engine": "ai", "pages": [1]}).json()["job_id"])
    assert job.status == "succeeded", job.error
    assert engine.calls == calls and len(provider.images) == 1  # One request for the page, no local engine.
    assert job.result.read_pages == [1] and job.result.usage.calls == 1 and job.result.usage.input_tokens == 100
    lib = Library(root / "library")
    assert lib.document(paper_id)["ocr_applied"][0]["engine"] == "ai"
    assert "Read by the model" in lib.page_text(paper_id, 1)


def test_a_connection_that_cannot_take_images_is_refused_before_anything_is_sent(client, engine):
    client, root = client
    job = _wait(client.post("/api/papers/import", json={"paths": [str(scan_pdf(root))]}).json()["job_id"])
    Settings(provider="antigravity").save(deps.get_data_dir())
    answer = client.post(f"/api/papers/{job.result.paper_ids[0]}/ocr", json={"engine": "ai", "pages": [1]})
    assert answer.status_code == 400 and "agy" in answer.json()["detail"]


def test_the_cli_connections_get_the_images_and_keep_their_tools_off(tmp_path):
    seen = {}

    def popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
        seen["command"] = command
        stdin.seek(0)
        seen["stdin"] = stdin.read()
        seen["files"] = {path.name: path.read_bytes() for path in Path(cwd).glob("*.png")}
        answer = json.dumps({"type": "result", "result": '{"texts": ["x"]}', "usage": {}}) + "\n"
        stdout.write(answer.encode())
        (Path(cwd) / "answer.txt").write_text('{"texts": ["x"]}', "utf-8")

        class Done:
            returncode = 0
            pid = 1

            def poll(self):
                return 0

            def wait(self, timeout=None):
                return 0
        return Done()

    png = b"\x89PNG fake"
    with patch("subprocess.Popen", popen), patch("shutil.which", lambda name: f"/bin/{name}"):
        create_provider(Settings(provider="claude"), threading.Event()).read_images("Read", [png], None)
        command = seen["command"]
        assert command[command.index("--input-format") + 1] == "stream-json" and command[command.index("--tools") + 1] == ""
        message = json.loads(seen["stdin"])
        blocks = message["message"]["content"]
        assert message["type"] == "user" and blocks[0]["type"] == "text" and blocks[1]["type"] == "image"
        assert blocks[1]["source"]["media_type"] == "image/png"

        create_provider(Settings(provider="codex"), threading.Event()).read_images("Read", [png, png], None)
        command = seen["command"]
        images = [command[i + 1] for i, part in enumerate(command) if part == "--image"]
        assert images == ["image-1.png", "image-2.png"]  # Named relative to the run's folder, its working folder.
        assert seen["files"]["image-1.png"] == png
        # --image takes the files up to the next option: one follows them.
        assert command[command.index(images[-1]) + 1].startswith("--")
        assert command[-1] == "-" and b"Read" in seen["stdin"]

    with pytest.raises(RuntimeError, match="agy"):
        create_provider(Settings(provider="antigravity"), threading.Event()).read_images("Read", [png])


# ---------------------------------------------------------------- macOS Vision

def test_vision_reads_nothing_off_macos_and_tesseract_takes_over():
    if sys.platform == "darwin":
        pytest.skip("on macOS Vision may be there")
    assert VisionEngine().languages() == set()
    with pytest.raises(OcrError):
        VisionEngine().recognize(Image.new("L", (10, 10), 255), "en")


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS Vision only on a Mac")
def test_vision_reads_an_english_page_on_macos():  # pragma: no cover - run on a Mac only
    engine = VisionEngine()
    if "en" not in engine.languages():
        pytest.skip("Vision (pyobjc) is not available")
    image = Image.open(FIXTURES / "synth_en_2col.png").convert("L")
    lines = engine.recognize(image.crop((0, 0, image.width, image.height // 4)), "en")
    assert lines and any(len(word.text) > 3 for line in lines for word in line.words)


# ---------------------------------------------------------------- review fixes

class Reader:
    """An engine that reads every image as the given text, one line per region, and counts its calls."""

    def __init__(self, name: str, texts: dict[str, str]):
        self.name, self.texts, self.calls = name, texts, []

    def languages(self) -> set[str]:
        return set(self.texts)

    def recognize(self, image: Image.Image, lang: str) -> list[OcrLine]:
        self.calls.append(lang)
        words = self.texts[lang].split()
        return [OcrLine(tuple(OcrWord((i * 10, 0, i * 10 + 9, 30), word) for i, word in enumerate(words)),
                        spaced=lang != "ja")]


# How Windows' Japanese recognizer read the first lines of an English scan (ResNet's page 2): 36% kana and kanji.
NOISE = ("D に 〃 夜 ・ れ に ″ ra 〃 et ル 0 お た 、 ゞ 尾 川 0 尾 ( 〃 加 ( Ⅲ ″ な ⅲ . We 〃 尾 、 に 〃 ー 4 尾 ⅵ イ ″ "
         "ar 〃 ⅲ g 第 れ 〃 肥 Ⅳ 0 欣 に 仏 ゞ e 〃 に 作 ⅲ ⅲ g 可 netW01 ・ ks ⅲ 襯 4 尾 Ⅷ 伝 ta 〃 行")
ENGLISH = "way networks have not demonstrated accuracy gains with extremely increased depth of over one hundred layers"
JAPANESE = "本研究では 観測 データ から 潜在 構造 を 推定 する 手法 を 提案 し その 有効性 を 実験 により 確かめる"


def _layout():
    from papeer.layout.ocr_regions import segment_page
    return segment_page(Image.open(FIXTURES / "synth_en_2col.png").convert("L"), 300)


def _engines(ja: str, en: str):
    return ocr_engines.EngineSet(OcrOptions(enabled=True), engines={
        "windows": Reader("windows", {"ja": ja}), "tesseract": Reader("tesseract", {"en": en})})


def test_an_english_scan_read_as_kana_by_the_japanese_recognizer_stays_english():
    layout = _layout()
    with patch.object(sys, "platform", "win32"):
        for document_lang in ("en", None):
            assert pdf_ocr._probe_language(layout, _engines(NOISE, ENGLISH), document_lang) == "en", document_lang
        # Without an English engine to compare with, the share alone decides: still English.
        engines = ocr_engines.EngineSet(OcrOptions(enabled=True), engines={"windows": Reader("windows", {"ja": NOISE}),
                                                                            "tesseract": Reader("tesseract", {"ja": NOISE})})
        assert pdf_ocr._probe_language(layout, engines, "en") == "en"
        # Japanese read as Japanese stays Japanese, also in a document whose other pages are English.
        assert pdf_ocr._probe_language(layout, _engines(JAPANESE, "iii Ar rn ii ftv Ji oo"), "en") == "ja"
        # In between (a Japanese line full of English terms), an English reading decides.
        mixed = "深層学習の手法 ResNet と VGG を比べる"  # 57% kana and kanji
        assert pdf_ocr._probe_language(layout, _engines(mixed, ENGLISH)) == "en"
        assert pdf_ocr._probe_language(layout, _engines(mixed, "iii Ar rn ii")) == "ja"


def test_reading_a_page_holds_no_pdf_lock(engine, tmp_path):
    held = []

    def recognize(image, lang):
        # Another thread (the UI rendering a page) can take the lock while the page is being read.
        free = []

        def take():
            if PDF_LOCK.acquire(timeout=1):
                PDF_LOCK.release()
                free.append(True)

        thread = threading.Thread(target=take)
        thread.start()
        thread.join()
        held.append(not free)
        return [OcrLine((OcrWord((0, 0, image.width, 30), "Words of the page read without the lock"),))]

    engine.recognize = recognize
    document = extract_pdf(scan_pdf(tmp_path), run=ocr.ocr_run(OcrOptions(enabled=True, engine="tesseract", lang="en")))
    assert document["ocr_applied"] and held and not any(held)


def test_a_new_layout_version_keeps_every_saved_reading(client, engine):
    client, root = client
    job = _wait(client.post("/api/papers/import", json={"paths": [str(scan_pdf(root))]}).json()["job_id"])
    paper_id = job.result.paper_ids[0]
    _wait(client.post(f"/api/papers/{paper_id}/ocr", json={}).json()["job_id"])
    lib = Library(root / "library")
    folder = lib.folder(paper_id)
    readings = {**ocr.load_readings(folder), "9": {"version": 1, "note": "a page the new code no longer flags"}}
    ocr.save_readings(folder, readings)
    files = PaperFiles(folder)
    document = json.loads(files.document_json.read_text("utf-8"))
    files.document_json.write_text(json.dumps({**document, "layout_version": LAYOUT_VERSION - 1}), "utf-8")
    lib.document(paper_id)
    assert ocr.load_readings(folder) == readings
    ocr.save_readings(folder, {})
    assert not files.ocr_text.exists()


def test_the_search_index_takes_in_pages_read_on_another_pc(client, engine):
    client, root = client
    job = _wait(client.post("/api/papers/import", json={"paths": [str(scan_pdf(root, pages=2))]}).json()["job_id"])
    paper_id = job.result.paper_ids[0]
    lib = Library(root / "library")
    index = SearchIndex(lib.root)
    index.refresh(lib)
    with index.reader() as reader:
        assert not reader.counts("stand-in").get(paper_id)
    # Another PC read the page: the synced library brings the page texts and ocr-text.json, and this PC's
    # index is not told (no forget_pages here).
    run = ocr.ocr_run(OcrOptions(enabled=True, engine="tesseract", lang="en"))
    document = extract_pdf(PaperFiles(lib.folder(paper_id)).original_pdf, run=run)
    lib.replace_extraction(paper_id, document, run.readings)
    index.refresh(lib)
    with index.reader() as reader:
        assert reader.counts("stand-in").get(paper_id)


def test_images_go_in_batches_small_enough_to_send():
    assert batches([]) == []
    assert batches([1] * 45) == [(0, 20), (20, 40), (40, 45)]
    big = ai_ocr.BATCH_BYTES // 2 + 1
    assert batches([big, big, 10]) == [(0, 1), (1, 3)]
    with pytest.raises(OcrError, match="大きすぎて AI に送れません"):
        batches([ai_ocr.BATCH_BYTES + 1])
    provider = ImageReader()
    found = AiOcrEngine(provider).recognize_many([Image.new("L", (40, 20), 255)] * 25, "en")
    assert len(found) == 25 and [len(images) for images in provider.images] == [20, 5]
    image = Image.new("L", (5000, 100), 255)
    assert max(Image.open(io.BytesIO(ai_ocr._png(image))).size) == ai_ocr.MAX_SIDE


def test_a_failure_of_the_ai_connection_ends_the_job_as_it_is_and_leaves_the_paper(client, engine, monkeypatch):
    client, root = client
    job = _wait(client.post("/api/papers/import", json={"paths": [str(scan_pdf(root))]}).json()["job_id"])
    paper_id = job.result.paper_ids[0]
    provider = ImageReader()

    def out_of_plan(instruction, images, schema):
        raise RuntimeError("Claude Code接続に失敗しました。ログイン状態・利用枠を確認してください。\nYou have hit your usage limit")

    provider._generate_images = out_of_plan
    monkeypatch.setattr(deps, "provider_for", lambda settings=None, cancel=None, api_key=None: provider)
    job = _wait(client.post(f"/api/papers/{paper_id}/ocr", json={"engine": "ai", "pages": [1]}).json()["job_id"])
    assert job.status == "failed" and job.error.startswith("Claude Code接続に失敗しました") and "usage limit" in job.error
    assert client.get(f"/api/papers/{paper_id}/reading").json()["ocr_pages"] == [{"page": 1, "reason": "image"}]
