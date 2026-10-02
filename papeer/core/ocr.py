"""OCR in the library: this PC's settings, what its engines and language data can read, the readings a
paper keeps, and reading a paper's pages again.

- Settings (ocr-settings.json in this PC's device folder, never synced or backed up): whether papers
  are read by OCR when added ("auto"), only after asking when one has pages that need it ("ask", the
  default), or never ("off"); the engine and the language. OCR results depend on the engines and
  language data a PC has, so these belong to the PC like its CLI paths.
- Readings (ocr-text.json beside the paper's document.json, synced with the library): what OCR read on
  each page (pdf_ocr.OcrPage.to_record). Extracting the paper again (a new LAYOUT_VERSION, here or on
  another PC) builds those pages from them, so nothing is read twice, the AI is never asked again inside
  a request, and the text, and with it the translation cache, stays the same on every PC.
- read_again: a job that reads a paper's pages that need OCR (all of them, or one page with the AI) and
  writes the paper's extraction again. Pages whose text changes lose their saved translation.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
from typing import Any

from papeer.core.fileio import atomic_write_json
from papeer.core.paths import PaperFiles, app_env, device_directory
from papeer.layout.ocr_engines import (ENGINE_CHOICES, LANGUAGES, TESSDATA, TESSDATA_URL, EngineSet, OcrOptions,
                                       VisionEngine, WindowsOcrEngine, engine_order, tessdata_directory, tessdata_ready)
from papeer.layout.reading_flow import unit_pages
from papeer.pdf.pdf_engine import PDF_LOCK, OcrRun, extract_pdf, translation_units

MODES = ("ask", "auto", "off")
LANG_CHOICES = ("auto", *LANGUAGES)
DEFAULT_SETTINGS = {"mode": "ask", "engine": "auto", "lang": "auto"}
LANGUAGE_NAMES = {"en": "英語", "ja": "日本語"}


# --- This PC's settings ---

def settings_path() -> Path:
    return device_directory() / "ocr-settings.json"


def ocr_settings() -> dict[str, str]:
    """{"mode", "engine", "lang"} of this PC; a missing or unknown value is the default."""
    try:
        stored = json.loads(settings_path().read_text("utf-8"))
    except (OSError, ValueError):
        stored = {}
    stored = stored if isinstance(stored, dict) else {}
    choices = {"mode": MODES, "engine": ENGINE_CHOICES, "lang": LANG_CHOICES}
    return {key: stored[key] if stored.get(key) in choices[key] else default for key, default in DEFAULT_SETTINGS.items()}


def save_ocr_settings(mode: str, engine: str, lang: str) -> dict[str, str]:
    if mode not in MODES:
        raise ValueError("OCR の使い方は、取り込み時に読む・聞く・使わないから選んでください。")
    if engine not in ENGINE_CHOICES:
        raise ValueError("OCR のエンジンは、自動・Tesseract・Windows・macOS から選んでください。")
    if lang not in LANG_CHOICES:
        raise ValueError("OCR の言語は、自動・英語・日本語から選んでください。")
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, {"version": 1, "mode": mode, "engine": engine, "lang": lang}, indent=None)
    return ocr_settings()


def ocr_options(enabled: bool = True, engine: str | None = None) -> OcrOptions:
    """The options OCR runs with on this PC: the settings, with the development variables over them
    (PAPEER_OCR_ENGINE, PAPEER_OCR_LANG, PAPEER_TESSDATA_DIR; see OcrOptions.from_env)."""
    settings, env = ocr_settings(), OcrOptions.from_env()
    return OcrOptions(enabled=enabled,
                      engine=engine or (env.engine if app_env("OCR_ENGINE", "") else settings["engine"]),
                      lang=env.lang if app_env("OCR_LANG", "") else settings["lang"],
                      tessdata=env.tessdata)


def import_reads() -> bool:
    """Whether a paper being added is read by OCR at once: the "auto" setting, or PAPEER_OCR=1."""
    return ocr_settings()["mode"] == "auto" or OcrOptions.from_env().enabled


# --- What this PC can read ---

def language_data() -> list[dict[str, Any]]:
    """Tesseract's language data: each language's file, size, source and whether it is here."""
    directory = tessdata_directory(ocr_options())
    return [{"lang": lang, "label": LANGUAGE_NAMES[lang], "file": f"{name}.traineddata", "size": size,
             "url": TESSDATA_URL.format(name=name), "installed": tessdata_ready(lang, directory)}
            for lang, (name, size, _sha) in TESSDATA.items()]


def status() -> dict[str, Any]:
    """The settings, the language data, what each engine can read, and the languages no engine reads yet.

    missing: the languages the settings may need (both for "auto") that no engine reads here; the
    frontend offers to download their language data before reading.
    """
    settings = ocr_settings()
    options = ocr_options()
    engines = EngineSet(options)
    readable = {lang: [engine.name for engine in engines.order(lang)] for lang in LANGUAGES}
    wanted = LANGUAGES if settings["lang"] == "auto" else (settings["lang"],)
    system: dict[str, Any] = {}
    if sys.platform == "win32":
        system = {"name": "windows", "label": "Windows の OCR", "languages": sorted(WindowsOcrEngine().languages())}
    elif sys.platform == "darwin":
        system = {"name": "vision", "label": "macOS の Vision", "languages": sorted(VisionEngine().languages())}
    return {"settings": settings, "directory": str(tessdata_directory(options)), "language_data": language_data(),
            "system": system or None, "readable": readable,
            "order": {lang: engine_order(lang, options.engine) for lang in LANGUAGES},
            "missing": [lang for lang in wanted if not readable[lang]]}


# --- The readings a paper keeps ---

def load_readings(folder: Path) -> dict[str, dict]:
    """The OCR readings kept with a paper (ocr-text.json), by page number; {} when there are none."""
    try:
        value = json.loads(PaperFiles(folder).ocr_text.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    pages = value.get("pages") if isinstance(value, dict) else None
    return {str(k): v for k, v in pages.items() if isinstance(v, dict)} if isinstance(pages, dict) else {}


def save_readings(folder: Path, readings: dict[str, dict]) -> None:
    """Keep the readings (none: the file is removed). Without indentation: only the app reads it."""
    path = PaperFiles(folder).ocr_text
    if readings:
        ordered = {key: readings[key] for key in sorted(readings, key=int)}
        atomic_write_json(path, {"version": 1, "pages": ordered}, indent=None)
    else:
        path.unlink(missing_ok=True)


# --- Reading a paper's pages again ---

def _page_units(document: dict) -> dict[int, list[tuple[str, str]]]:
    pages: dict[int, list[tuple[str, str]]] = {}
    for unit in translation_units(document):
        for page in unit_pages(unit):
            pages.setdefault(page, []).append((unit["id"], unit["text"]))
    return pages


def changed_pages(before: dict, after: dict) -> list[int]:
    """The pages whose translation units (the text sent for translation) differ between two extractions:
    their saved translations no longer apply, and the next translation makes them again."""
    old, new = _page_units(before), _page_units(after)
    return sorted(page for page in set(old) | set(new) if old.get(page) != new.get(page))


def read_again(lib, paper_id: str, run: OcrRun) -> dict[str, Any]:
    """Extract a paper again, reading the pages run asks for (run.engines, run.pages) by OCR, and keep it.

    A newly readable title is adopted, while a manually edited library title stays.
    Returns what was read and what changed:
    read_pages, failed_pages ({page: reason}), ocr_pages (still needing OCR), changed_pages and,
    among them, retranslate_pages (pages that had a saved translation).
    """
    folder = lib.folder(paper_id)
    files = PaperFiles(folder)
    previous = lib.document(paper_id)
    run.saved = load_readings(folder)
    document = extract_pdf(files.original_pdf, run=run)
    document["title"] = document["extracted_title"] or Path(lib.paper(paper_id)["original_name"]).stem
    changed = changed_pages(previous, document)
    cache = files.read_json(files.translation_cache, {})
    translated = {int(n) for n in (cache.get("completed_pages") or {}) if str(n).isdigit()} if isinstance(cache, dict) else set()
    lib.replace_extraction(paper_id, document, run.readings)
    return {"read_pages": sorted(run.read_now), "failed_pages": {str(k): v for k, v in sorted(run.errors.items())},
            "ocr_pages": [entry["page"] for entry in document["ocr_pages"] if entry.get("reason") != "partial"],
            "changed_pages": changed, "retranslate_pages": sorted(set(changed) & translated)}


def ocr_run(options: OcrOptions, cancel=None, pages: set[int] | None = None, progress=None,
            engines: dict | None = None, strict: bool = False) -> OcrRun:
    """An OcrRun reading with this PC's engines (or those given, the AI), stopped by cancel."""
    return OcrRun(EngineSet(options, PDF_LOCK, dict(engines or {}), cancel), pages=pages, progress=progress, strict=strict)
