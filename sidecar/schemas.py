from __future__ import annotations

from typing import Annotated, Any, Literal
from pydantic import BaseModel, ConfigDict, Field

from papeer.core.config import Settings


class HealthResponse(BaseModel):
    status: str = "ok"
    version: str  # App release, MAJOR.MINOR.PATCH (papeer.__version__).
    code_version: str  # Extraction and PDF drawing code identity, "code-sha256-<hex>" (papeer.core.code_version).


_DEFAULTS = Settings()


class SettingsModel(BaseModel):
    # Older clients send codex_path/api_base etc.; Settings.from_values migrates them.
    model_config = ConfigDict(extra="allow")

    provider: str = _DEFAULTS.provider
    model: str = _DEFAULTS.model
    reasoning_effort: str = _DEFAULTS.reasoning_effort
    timeout_seconds: int = _DEFAULTS.timeout_seconds
    translation_concurrency: int = _DEFAULTS.translation_concurrency  # 0: automatic (1 for a local model, else 3)
    # By provider id: that connection's own settings (cli_path, base_url, model, reasoning_effort).
    provider_options: dict[str, dict[str, str]] = Field(default_factory=dict)
    api_key: str | None = None


class ProviderActionRequest(BaseModel):
    """Optional unsaved settings from the dialog; omitted fields use the saved settings."""
    provider: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None
    provider_options: dict[str, dict[str, str]] | None = None
    api_key: str | None = None


class ProviderSpecModel(BaseModel):
    id: str
    label: str
    description: str
    kind: str
    needs_login: bool
    needs_api_key: bool
    login_service: str
    fields: list[dict[str, str]]


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


# The keys of storage.HIGHLIGHT_COLORS.
HighlightColor = Literal["yellow", "green", "blue", "pink", "purple"]
PageFraction = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class BookmarkRequest(BaseModel):
    page: int
    side: str
    quote: str
    label: str = "重要"
    note: str = ""
    anchor_y: float = Field(default=0, ge=0, le=1)
    anchor_x: float = Field(default=0, ge=0, le=1)
    # A highlight: its colour and the rectangles it covers, [x, y, width, height] as fractions of the page.
    kind: Literal["note", "highlight"] = "note"
    color: HighlightColor | Literal[""] = ""
    rects: list[tuple[PageFraction, PageFraction, PageFraction, PageFraction]] = Field(default_factory=list, max_length=400)


class BookmarkEditRequest(BaseModel):
    # Left out (None), the label or memo stays as it is: a PATCH of the colour or position alone keeps them.
    label: str | None = Field(default=None, max_length=40)
    note: str | None = Field(default=None, max_length=1000)
    anchor_x: float | None = Field(default=None, ge=0, le=1)
    anchor_y: float | None = Field(default=None, ge=0, le=1)
    color: HighlightColor | None = None  # Highlights only.


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
    # Where the view was within each paper's page in reading_pages, as a fraction of the page's height.
    reading_anchors: dict[str, float] = Field(default_factory=dict)
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
