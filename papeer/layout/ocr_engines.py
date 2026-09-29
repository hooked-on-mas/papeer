"""OCR engines behind one interface, which engine reads a page, and the Tesseract language data.

Every engine takes a grayscale image (a text region of a page, papeer.layout.ocr_regions) and gives
its lines, each with the boxes of its words in pixels of that image (OcrLine). Spacing is not the
engine's business: the words are joined by papeer.pdf.pdf_ocr, which puts a space between two Latin
words and none next to a Japanese character.

- "tesseract": the Tesseract built into PyMuPDF (Page.get_textpage_ocr). No Tesseract program is
  needed, only its language data (tessdata_fast, downloaded once after the user agrees:
  download_tessdata). Runs on every OS.
- "windows": Windows.Media.Ocr through pywinrt. Uses the recognizers Windows has installed (Japanese
  on a Japanese Windows; English only when its language pack is added). Some 3-5 times faster than
  Tesseract on Japanese at the same accuracy.
- "vision": macOS Vision (VNRecognizeTextRequest) through pyobjc, macOS only. Not tried on a real Mac
  yet: when pyobjc or the framework is missing or fails, the engine reads nothing and the next engine
  (Tesseract) is used.
- "ai": re-reading a page with the AI connection (papeer.core.ai_ocr.AiOcrEngine), only when the user
  asks for it on one page; EngineSet takes it ready-made.

engine_order() picks the engines for a language in the order they are tried; recognize() falls back
to the next one when an engine fails.

Failures are caught broadly (`except Exception`) here, in _fetch and _as_ocr_error, and in
pdf_engine._read_by_ocr, so that no fault of OCR stops a paper from being added. A cancelled job
(papeer.providers.Cancelled) passes through each of them: `except Cancelled: raise` comes first, or it
would be taken for a failed engine and the next one tried.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
import functools
import hashlib
import io
import logging
from pathlib import Path
import sys
import threading
from typing import Protocol, cast
import urllib.request

from PIL import Image

from papeer.core.fileio import replace_file
from papeer.core.paths import app_env, device_directory
from papeer.providers.common import Cancelled

logger = logging.getLogger(__name__)

LANGUAGES = ("en", "ja")

# Tesseract language data: tessdata_fast at the 4.1.0 tag (the LSTM models Tesseract 4 and 5 read,
# the "fast" integer versions: several times faster than tessdata_best at nearly the same accuracy).
TESSDATA_VERSION = "4.1.0"
TESSDATA_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/" + TESSDATA_VERSION + "/{name}.traineddata"
TESSDATA = {
    # language: (file name without .traineddata, size in bytes, SHA-256)
    "en": ("eng", 4113088, "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"),
    "ja": ("jpn", 2471260, "1f5de9236d2e85f5fdf4b3c500f2d4926f8d9449f28f5394472d9e8d83b91b4d"),
}
# Pages are rendered for OCR at this resolution: 300 dpi reads 7 pt footnotes, 150 dpi does not.
OCR_DPI = 300


class OcrError(RuntimeError):
    """An engine could not read an image, or no engine can read the language."""


class OcrDeclined(OcrError):
    """The user did not agree to download the language data."""


@dataclass(frozen=True)
class OcrWord:
    box: tuple[float, float, float, float]  # pixels of the image given to the engine
    text: str


@dataclass(frozen=True)
class OcrLine:
    words: tuple[OcrWord, ...]
    # The words are words: Latin words next to each other take a space. False when the engine cuts
    # Latin text anywhere (the Japanese recognizers of Windows and Tesseract); the gaps decide then.
    spaced: bool = True

    @property
    def box(self) -> tuple[float, float, float, float]:
        return (min(w.box[0] for w in self.words), min(w.box[1] for w in self.words),
                max(w.box[2] for w in self.words), max(w.box[3] for w in self.words))


class OcrEngine(Protocol):
    name: str

    def languages(self) -> set[str]:
        """The languages (LANGUAGES) this engine can read now, without downloading anything."""
        ...

    def recognize(self, image: Image.Image, lang: str) -> list[OcrLine]:
        """The lines of a grayscale image, top to bottom; raises OcrError when it cannot read it."""
        ...


# ---------------------------------------------------------------- options

# The engines the settings offer ("ai" is chosen per page, never as a setting).
ENGINE_CHOICES = ("auto", "tesseract", "windows", "vision")

@dataclass(frozen=True)
class OcrOptions:
    """Whether and how extraction reads pages that need OCR (scans, garbled text layers).

    Off by default. The app takes them from this PC's settings (papeer.core.ocr_settings); the
    environment still turns OCR on for development (PAPEER_OCR=1, from_env). PAPEER_OCR_ENGINE is
    auto, tesseract, windows or vision; PAPEER_OCR_LANG auto, en or ja (auto: the language of the
    document's text, else a first look at the page); PAPEER_TESSDATA_DIR puts the language data
    elsewhere than tessdata_directory().
    """
    enabled: bool = False
    engine: str = "auto"
    lang: str = "auto"
    dpi: int = OCR_DPI
    tessdata: Path | None = None

    @classmethod
    def from_env(cls) -> OcrOptions:
        enabled = (app_env("OCR", "") or "").strip().lower() in {"1", "true", "on", "yes"}
        engine = (app_env("OCR_ENGINE", "") or "auto").strip().lower()
        lang = (app_env("OCR_LANG", "") or "auto").strip().lower()
        if engine not in ENGINE_CHOICES:
            logger.warning("PAPEER_OCR_ENGINE=%s is not auto, tesseract, windows or vision; using auto", engine)
            engine = "auto"
        if lang not in {"auto", *LANGUAGES}:
            logger.warning("PAPEER_OCR_LANG=%s is not auto, en or ja; using auto", lang)
            lang = "auto"
        directory = app_env("TESSDATA_DIR", "")
        return cls(enabled=enabled, engine=engine, lang=lang, tessdata=Path(directory) if directory else None)


# ---------------------------------------------------------------- language data

def tessdata_directory(options: OcrOptions | None = None) -> Path:
    """Where this PC keeps the Tesseract language data (never synced: it belongs to the PC)."""
    if options is not None and options.tessdata is not None:
        return options.tessdata
    override = app_env("TESSDATA_DIR", "")
    return Path(override) if override else device_directory() / "tessdata" / "fast"


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


_verified: dict[tuple[str, int, int], bool] = {}
_verified_lock = threading.Lock()
# One download at a time: two would write the same .part file.
_download_lock = threading.Lock()


def tessdata_ready(lang: str, directory: Path) -> bool:
    """The language's data is in directory and is exactly the file TESSDATA names (checked once per
    file state: Tesseract parses it in native code)."""
    name, size, sha = TESSDATA[lang]
    path = directory / f"{name}.traineddata"
    try:
        stat = path.stat()
    except OSError:
        return False
    if stat.st_size != size:
        return False
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    with _verified_lock:
        if key not in _verified:
            _verified[key] = _digest(path) == sha
        return _verified[key]


def download_tessdata(lang: str, confirm: Callable[[str, int], bool], directory: Path | None = None,
                      opener: Callable[..., object] | None = None,
                      progress: Callable[[int, int], None] | None = None) -> Path:
    """Download a language's data after the user agrees, and return its path.

    confirm(url, size) asks the user (the file comes from GitHub); False raises OcrDeclined. The
    file is written to <name>.traineddata.part, checked against its SHA-256 and only then renamed,
    so a broken or interrupted download never takes the name Tesseract reads. progress(received,
    size) may raise Cancelled to stop it: the .part file is removed and Cancelled passes on.
    """
    if lang not in TESSDATA:
        raise OcrError(f"OCR の言語データがない言語です: {lang}")
    directory = directory or tessdata_directory()
    name, size, sha = TESSDATA[lang]
    target = directory / f"{name}.traineddata"
    if tessdata_ready(lang, directory):
        return target
    url = TESSDATA_URL.format(name=name)
    if not confirm(url, size):
        raise OcrDeclined("OCR の言語データのダウンロードが取り消されました。")
    with _download_lock:
        if tessdata_ready(lang, directory):
            return target
        directory.mkdir(parents=True, exist_ok=True)
        _fetch(url, target, size, sha, opener, progress)
    return target


def _fetch(url: str, target: Path, size: int, sha: str, opener, progress) -> None:
    part = target.with_name(target.name + ".part")
    digest, received = hashlib.sha256(), 0
    try:
        with (opener or urllib.request.urlopen)(url, timeout=60) as response, part.open("wb") as out:  # type: ignore[attr-defined]
            while chunk := response.read(1 << 16):
                received += len(chunk)
                if received > size:
                    raise OcrError("OCR の言語データの大きさが想定と違います。")
                digest.update(chunk)
                out.write(chunk)
                if progress:
                    progress(received, size)
        if received != size or digest.hexdigest() != sha:
            raise OcrError("OCR の言語データの内容を確認できませんでした（SHA-256 が一致しません）。")
        replace_file(part, target)
    except (OcrError, Cancelled):
        part.unlink(missing_ok=True)
        raise
    except Exception as error:  # noqa: BLE001 - OSError, http.client.HTTPException, ... all mean "not downloaded"
        part.unlink(missing_ok=True)
        raise OcrError(f"OCR の言語データをダウンロードできませんでした: {error}") from error
    except BaseException:
        part.unlink(missing_ok=True)
        raise


def _as_ocr_error(engine: str, read: Callable[[], list[OcrLine]]) -> list[OcrLine]:
    """read(), with any failure an OcrError, so that the next engine is tried: MuPDF raises its own
    FzError classes (not RuntimeError), WinRT OSError, a large image MemoryError."""
    try:
        return read()
    except (OcrError, Cancelled):
        raise
    except Exception as error:  # noqa: BLE001 - see the docstring
        raise OcrError(f"{engine} で読めませんでした: {type(error).__name__}: {error}") from error


# ---------------------------------------------------------------- Tesseract (PyMuPDF)

def _split_words(chars: list[dict], scale: float) -> list[OcrWord]:
    """Words of one MuPDF OCR line: runs of characters without a space or a gap between them.

    MuPDF spreads each Tesseract word evenly over its box, so the characters of a word touch; it
    does not always put a space between words, but the gap between their boxes is still there.
    """
    words: list[OcrWord] = []
    text, box = "", None
    for char in chars:
        c, b = char["c"], char["bbox"]
        if c.isspace() or (box is not None and b[0] - box[2] > .3):
            if text and box is not None:
                words.append(OcrWord(tuple(v * scale for v in box), text))  # type: ignore[arg-type]
            text, box = "", None
            if c.isspace():
                continue
        text += c
        box = list(b) if box is None else [min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3])]
    if text and box is not None:
        words.append(OcrWord(tuple(v * scale for v in box), text))  # type: ignore[arg-type]
    return words


class TesseractEngine:
    """Tesseract as built into PyMuPDF, with the tessdata_fast language data."""
    name = "tesseract"

    def __init__(self, directory: Path, dpi: int = OCR_DPI, lock: threading.RLock | None = None):
        self.directory = directory
        self.dpi = dpi
        # MuPDF must not run in two threads at once (papeer.pdf.pdf_engine.PDF_LOCK).
        self.lock = lock or threading.RLock()

    def languages(self) -> set[str]:
        return {lang for lang in TESSDATA if tessdata_ready(lang, self.directory)}

    def recognize(self, image: Image.Image, lang: str) -> list[OcrLine]:
        if lang not in self.languages():
            raise OcrError(f"Tesseract の言語データがありません: {TESSDATA.get(lang, (lang,))[0]}")
        return _as_ocr_error("Tesseract", lambda: self._recognize(image, lang))

    def _recognize(self, image: Image.Image, lang: str) -> list[OcrLine]:
        import pymupdf

        buffer = io.BytesIO()
        image.convert("L").save(buffer, format="PNG")
        scale = self.dpi / 72
        with self.lock, pymupdf.open() as document:
            page = document.new_page(width=image.width / scale, height=image.height / scale)
            page.insert_image(page.rect, stream=buffer.getvalue())
            textpage = page.get_textpage_ocr(language=TESSDATA[lang][0], dpi=self.dpi, full=True,
                                              tessdata=str(self.directory))
            content = cast(dict, page.get_text("rawdict", textpage=textpage))
        lines = []
        for block in content["blocks"]:
            for line in block.get("lines", []):
                chars = [char for span in line["spans"] for char in span["chars"]]
                words = _split_words(chars, scale)
                if words:
                    # The Japanese model cuts text into words at random: the gaps decide the spaces.
                    lines.append(OcrLine(tuple(words), spaced=lang != "ja"))
        return lines


# ---------------------------------------------------------------- Windows.Media.Ocr (pywinrt)

_WINDOWS_TAGS = {"en": ("en-US", "en-GB", "en"), "ja": ("ja", "ja-JP")}


def _run_async(operation):
    """The result of a WinRT async operation, also from a thread that runs an event loop."""
    import asyncio
    import concurrent.futures

    async def wait():
        return await operation

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(wait())
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        return pool.submit(asyncio.run, wait()).result()


class WindowsOcrEngine:
    """Windows.Media.Ocr: the recognizers of the languages Windows has installed."""
    name = "windows"
    # Recognizers by language tag, shared by every instance of the process: making one takes about a
    # second, and each extraction makes a new EngineSet.
    _engines: dict[str, object] = {}
    _lock = threading.Lock()

    @staticmethod
    @functools.cache
    def _winrt():
        if sys.platform != "win32":
            return None
        try:
            from winrt.windows.globalization import Language  # pyright: ignore[reportMissingImports]
            from winrt.windows.graphics.imaging import BitmapPixelFormat, SoftwareBitmap  # pyright: ignore[reportMissingImports]
            from winrt.windows.media.ocr import OcrEngine as WinOcrEngine  # pyright: ignore[reportMissingImports]
            from winrt.windows.storage.streams import DataWriter  # pyright: ignore[reportMissingImports]
        except Exception:  # noqa: BLE001 - not installed, or its DLLs fail to load: no Windows OCR
            return None
        return Language, BitmapPixelFormat, SoftwareBitmap, WinOcrEngine, DataWriter

    def _tag(self, lang: str) -> str | None:
        modules = self._winrt()
        if modules is None:
            return None
        Language, _, _, WinOcrEngine, _ = modules
        for tag in _WINDOWS_TAGS.get(lang, ()):
            try:
                if WinOcrEngine.is_language_supported(Language(tag)):
                    return tag
            except Exception:  # noqa: BLE001 - WinRT unavailable here: the language is not readable
                return None
        return None

    def languages(self) -> set[str]:
        return {lang for lang in LANGUAGES if self._tag(lang)}

    def recognize(self, image: Image.Image, lang: str) -> list[OcrLine]:
        modules = self._winrt()
        tag = self._tag(lang)
        if modules is None or tag is None:
            raise OcrError(f"Windows の OCR に {lang} の認識器がありません。")
        return _as_ocr_error("Windows の OCR", lambda: self._recognize(image, lang, tag, modules))

    def _recognize(self, image: Image.Image, lang: str, tag: str, modules) -> list[OcrLine]:
        Language, BitmapPixelFormat, SoftwareBitmap, WinOcrEngine, DataWriter = modules
        with self._lock:
            engine = self._engines.get(tag)
            if engine is None:
                engine = WinOcrEngine.try_create_from_language(Language(tag))
                if engine is None:
                    raise OcrError(f"Windows の OCR を {tag} で始められませんでした。")
                self._engines[tag] = engine
        image = image.convert("L")
        # The engine refuses images larger than MaxImageDimension on either side: shrink them.
        limit = int(WinOcrEngine.max_image_dimension)
        factor = 1.0
        if max(image.size) > limit:
            factor = limit / max(image.size)
            image = image.resize((max(1, int(image.width * factor)), max(1, int(image.height * factor))),
                                 Image.Resampling.BOX)
        buffer_writer = DataWriter()  # an in-memory buffer, not a file
        buffer_writer.write_bytes(image.tobytes())
        bitmap = SoftwareBitmap.create_copy_from_buffer(buffer_writer.detach_buffer(), BitmapPixelFormat.GRAY8,
                                                        image.width, image.height)
        result = _run_async(engine.recognize_async(bitmap))  # pyright: ignore[reportAttributeAccessIssue]
        lines = []
        for line in result.lines:
            words = []
            for word in line.words:
                r = word.bounding_rect
                words.append(OcrWord((r.x / factor, r.y / factor, (r.x + r.width) / factor, (r.y + r.height) / factor),
                                     word.text))
            if words:
                lines.append(OcrLine(tuple(words), spaced=lang != "ja"))
        lines.sort(key=lambda line: (line.box[1], line.box[0]))
        return lines


# ---------------------------------------------------------------- macOS Vision (pyobjc)

_VISION_TAGS = {"en": ["en-US"], "ja": ["ja-JP", "en-US"]}


class VisionEngine:
    """macOS Vision's text recognizer (VNRecognizeTextRequest, accurate level) through pyobjc.

    Written from Apple's documentation and not yet tried on a Mac: any failure (pyobjc missing, an
    older macOS without Japanese, an error from the framework) makes it read nothing, and the next
    engine (Tesseract) is tried. Vision gives each line with its box but no word boxes, so a line is
    one OcrWord.
    """
    name = "vision"

    @staticmethod
    @functools.cache
    def _vision():
        if sys.platform != "darwin":
            return None
        try:
            import Vision  # pyright: ignore[reportMissingImports]
            from Foundation import NSData  # pyright: ignore[reportMissingImports]
        except Exception:  # noqa: BLE001 - not installed, or the framework fails to load: no Vision
            return None
        return Vision, NSData

    @functools.cached_property
    def _languages(self) -> set[str]:
        modules = self._vision()
        if modules is None:
            return set()
        Vision, _ = modules  # pyright: ignore[reportGeneralTypeIssues] - checked for win32, where it is None
        try:
            request = Vision.VNRecognizeTextRequest.alloc().init()
            request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
            supported, _error = request.supportedRecognitionLanguagesAndReturnError_(None)  # pyright: ignore
            tags = {str(tag) for tag in (supported or [])}
        except Exception:  # noqa: BLE001 - an older macOS without the call: English only
            tags = {"en-US"}
        return {lang for lang, wanted in _VISION_TAGS.items() if wanted[0] in tags}

    def languages(self) -> set[str]:
        return set(self._languages)

    def recognize(self, image: Image.Image, lang: str) -> list[OcrLine]:
        modules = self._vision()
        if modules is None or lang not in self._languages:
            raise OcrError(f"macOS の Vision で {lang} を読めません。")
        return _as_ocr_error("macOS の Vision", lambda: self._recognize(image, lang, modules))

    def _recognize(self, image: Image.Image, lang: str, modules) -> list[OcrLine]:
        Vision, NSData = modules
        buffer = io.BytesIO()
        image.convert("L").save(buffer, format="PNG")
        data = NSData.dataWithBytes_length_(buffer.getvalue(), len(buffer.getvalue()))
        handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        request.setRecognitionLanguages_(_VISION_TAGS[lang])
        request.setUsesLanguageCorrection_(True)
        ok, error = handler.performRequests_error_([request], None)
        if not ok:
            raise OcrError(f"macOS の Vision で読めませんでした: {error}")
        width, height = image.size
        lines = []
        for observation in request.results() or []:
            candidates = observation.topCandidates_(1)
            if not candidates:
                continue
            text = str(candidates[0].string()).strip()
            if not text:
                continue
            # Normalized coordinates with the origin at the bottom left.
            box = observation.boundingBox()
            x0, y1 = box.origin.x * width, (1 - box.origin.y) * height
            x1, y0 = x0 + box.size.width * width, y1 - box.size.height * height
            lines.append(OcrLine((OcrWord((x0, y0, x1, y1), text),), spaced=True))
        lines.sort(key=lambda line: (line.box[1], line.box[0]))
        return lines


# ---------------------------------------------------------------- choice and fallback

_ENGINE_TYPES: dict[str, Callable[..., OcrEngine]] = {"tesseract": TesseractEngine, "windows": WindowsOcrEngine,
                                                      "vision": VisionEngine}


@dataclass
class EngineSet:
    """The engines a document is read with, made once (a Windows OCR engine per language is kept).

    engines may hold engines made beforehand (the AI one: OcrOptions.engine "ai"). cancel, when set,
    stops the reading between regions (Cancelled).
    """
    options: OcrOptions
    lock: threading.RLock | None = None
    engines: dict[str, OcrEngine] = field(default_factory=dict)
    cancel: threading.Event | None = None

    def get(self, name: str) -> OcrEngine | None:
        if name not in self.engines:
            if name == "tesseract":
                self.engines[name] = TesseractEngine(tessdata_directory(self.options), self.options.dpi, self.lock)
            elif name in _ENGINE_TYPES:
                self.engines[name] = _ENGINE_TYPES[name]()
            else:
                return None
        return self.engines[name]

    def order(self, lang: str) -> list[OcrEngine]:
        return [engine for name in engine_order(lang, self.options.engine)
                if (engine := self.get(name)) is not None and lang in engine.languages()]

    def check(self) -> None:
        """Raise Cancelled once the job reading the document has been cancelled."""
        if self.cancel is not None and self.cancel.is_set():
            raise Cancelled("OCR を中止しました。")


def engine_order(lang: str, preference: str = "auto", platform: str | None = None) -> list[str]:
    """The engines tried for a language, first choice first.

    auto: the system's own OCR for Japanese on Windows and macOS (Tesseract when it has no Japanese
    recognizer), Tesseract otherwise (Windows' English recognizer is less accurate on papers). A
    named engine goes first and the others stay as the fallback. "ai" (a page re-read by the AI
    connection) has no fallback: the user asked for that engine on that page.
    """
    if preference == "ai":
        return ["ai"]
    platform = platform or sys.platform
    names = ["tesseract"]
    system = {"win32": "windows", "darwin": "vision"}.get(platform)
    if system:
        names = [system, "tesseract"] if lang == "ja" else ["tesseract", system]
    if preference in names:
        names = [preference] + [n for n in names if n != preference]
    return names


def recognize(image: Image.Image, lang: str, engines: list[OcrEngine]) -> tuple[list[OcrLine], str]:
    """(lines, engine name) from the first engine that reads the image."""
    errors = []
    for engine in engines:
        try:
            return engine.recognize(image, lang), engine.name
        except Cancelled:
            raise
        except Exception as error:  # noqa: BLE001 - an engine added later may raise anything
            logger.warning("OCR engine %s failed (%s); trying the next one", engine.name, error)
            errors.append(f"{engine.name}: {error}")
    raise OcrError("OCR できるエンジンがありません。" + (" " + " / ".join(errors) if errors else ""))


def main(argv: list[str]) -> int:
    """`python -m papeer.layout.ocr_engines download en ja`: fetch language data after asking."""
    if len(argv) < 2 or argv[0] != "download" or not set(argv[1:]) <= set(TESSDATA):
        print("usage: python -m papeer.layout.ocr_engines download en|ja ...", file=sys.stderr)
        return 2

    def ask(url: str, size: int) -> bool:
        answer = input(f"{url} ({size / 1e6:.1f} MB) を {tessdata_directory()} にダウンロードしますか？ [y/N] ")
        return answer.strip().lower() in {"y", "yes"}

    for lang in argv[1:]:
        try:
            print(download_tessdata(lang, ask))
        except OcrError as error:
            print(error, file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
