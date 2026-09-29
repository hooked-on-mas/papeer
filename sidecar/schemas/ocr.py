"""Models of OCR: this PC's settings and engines, language data, and reading a paper's pages (sidecar/routes/ocr.py)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

OcrMode = Literal["ask", "auto", "off"]
OcrEngineChoice = Literal["auto", "tesseract", "windows", "vision"]
OcrLangChoice = Literal["auto", "en", "ja"]
OcrLang = Literal["en", "ja"]


class OcrSettings(BaseModel):
    """This PC's OCR settings (papeer.core.ocr: not synced). mode: read papers by OCR when they are added
    ("auto"), ask when one has pages that need it ("ask"), or never ("off")."""
    mode: OcrMode
    engine: OcrEngineChoice
    lang: OcrLangChoice


class LanguageData(BaseModel):
    """One language's data for Tesseract (tessdata_fast), and whether this PC has it."""
    lang: OcrLang
    label: str
    file: str
    size: int  # bytes
    url: str
    installed: bool


class SystemEngine(BaseModel):
    """The system's own OCR (Windows, or macOS Vision) and the languages it reads on this PC."""
    name: Literal["windows", "vision"]
    label: str
    languages: list[OcrLang]


class AiReading(BaseModel):
    """Whether the AI connection now chosen can read a page from its image, and if not, why."""
    available: bool
    reason: str | None = None
    provider: str
    label: str


class OcrStatus(BaseModel):
    """GET /api/ocr: the settings, the language data, what each language is read with and what cannot be read yet."""
    settings: OcrSettings
    directory: str  # Where the language data is kept.
    language_data: list[LanguageData]
    system: SystemEngine | None
    readable: dict[str, list[str]]  # By language: the engines that read it now, first choice first.
    order: dict[str, list[str]]  # By language: the engines the settings try, whether they can read it or not.
    missing: list[OcrLang]  # Languages the settings may need that nothing reads yet.
    ai: AiReading


class LanguageDataRequest(BaseModel):
    langs: list[OcrLang] = Field(min_length=1)


class OcrReadRequest(BaseModel):
    """POST /api/papers/{paper_id}/ocr. engine "local": this PC's engines, "ai": the AI connection (one page).
    pages: the pages to read (again, when they were read before); None reads the pages that need OCR and
    have not been read yet."""
    engine: Literal["local", "ai"] = "local"
    pages: list[int] | None = None
