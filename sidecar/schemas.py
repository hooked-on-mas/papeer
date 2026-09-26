from __future__ import annotations

from typing import Any
from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str
    code_version: str


class SettingsModel(BaseModel):
    provider: str = "codex"
    model: str = "gpt-5.6-sol"
    reasoning_effort: str = "medium"
    api_base: str = "https://api.openai.com/v1"
    codex_path: str = "codex"
    claude_path: str = "claude"
    gemini_path: str = "agy"
    translation_concurrency: int = 0  # 0: automatic (1 for a local model, else 3)
    api_key: str | None = None


class ProviderActionRequest(BaseModel):
    """Optional unsaved settings from the dialog; omitted fields use the saved settings."""
    provider: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None
    api_base: str | None = None
    api_key: str | None = None
    codex_path: str | None = None
    claude_path: str | None = None
    gemini_path: str | None = None


class TranslateRequest(BaseModel):
    pages: str | None = None
    model: str | None = None
    effort: str | None = None


class ImportRequest(BaseModel):
    paths: list[str]
    collection: str | None = None


class AskAttachment(BaseModel):
    """A passage selected in the PDF and attached to a chat message."""
    page: int
    side: str = "original"
    text: str
    anchor_y: float = 0
    # Character offsets in the page's text layer, to select the passage again.
    start: int | None = None
    end: int | None = None
    raw: str = ""


class AskRequest(BaseModel):
    question: str
    attachments: list[AskAttachment] = Field(default_factory=list)
    search_all: bool = False
    scope: str = "paper"
    paper_ids: list[str] = Field(default_factory=list)
    collection: str = ""
    reference_pages: str = Field(default="", max_length=500)
    retrieval_query: str = Field(default="", max_length=2000)
    max_pages: int = Field(default=10, ge=1, le=30)


class BookmarkRequest(BaseModel):
    page: int
    side: str
    quote: str
    label: str = "重要"
    note: str = ""
    anchor_y: float = Field(default=0, ge=0, le=1)
    anchor_x: float = Field(default=0, ge=0, le=1)


class BookmarkEditRequest(BaseModel):
    label: str = Field(default="重要", max_length=40)
    note: str = Field(default="", max_length=1000)
    anchor_x: float | None = Field(default=None, ge=0, le=1)
    anchor_y: float | None = Field(default=None, ge=0, le=1)


class GlossaryRequest(BaseModel):
    terms: list[dict[str, str]]


class ExportRequest(BaseModel):
    kind: str = Field(description="translated | interleaved | bilingual | markdown")
    destination: str


class UpdatePaperRequest(BaseModel):
    title: str | None = None
    author: str | None = None
    year: str | None = None  # "" clears it; otherwise four digits
    collection: str | None = None
    note: str | None = None
    tags: list[str] | None = None
    read_status: str | None = None


class RenamePaperRequest(BaseModel):
    new_title: str


class CreateCollectionRequest(BaseModel):
    name: str


class RenameCollectionRequest(BaseModel):
    old_name: str
    new_name: str


class UIStateModel(BaseModel):
    reading_pages: dict[str, int] = Field(default_factory=dict)
    last_paper: str = ""
    sort: int = 0
    expanded_collections: list[str] = Field(default_factory=list)


class JobInfo(BaseModel):
    job_id: str
    paper_id: str | None = None
    kind: str
    message: str = ""
    done: int | None = None
    total: int | None = None
    status: str = "running"
    running: bool = True
    cancelled: bool = False
    result: Any | None = None
    error: str | None = None
