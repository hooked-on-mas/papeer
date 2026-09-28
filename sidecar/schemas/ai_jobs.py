"""Request models of the background work on one paper (sidecar/routes/ai_jobs.py)."""
from __future__ import annotations

from pydantic import BaseModel, Field


class TranslateRequest(BaseModel):
    pages: str | None = None
    model: str | None = None
    effort: str | None = None


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


class ExportRequest(BaseModel):
    kind: str = Field(description="translated | interleaved | bilingual | markdown")
    destination: str
