"""Models of the background work on one paper (sidecar/routes/ai_jobs.py)."""
from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

from pydantic import BaseModel, Field

from sidecar.job_types import Usage
from sidecar.schemas.common import Stored
from sidecar.schemas.research import ChatResearch


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
    web_search: bool = False
    research_keys: list[str] = Field(default_factory=list, max_length=10)


class ExportRequest(BaseModel):
    kind: str = Field(description="translated | interleaved | bilingual | markdown")
    destination: str


class ChatPassage(TypedDict):
    """A passage as a question stored it (an AskAttachment, its text shortened: PaperService.ask). Messages
    saved before the offsets into the text layer were sent lack start, end and raw."""
    page: int
    side: Literal["original", "translated"]
    text: str
    anchor_y: float
    start: NotRequired[int | None]
    end: NotRequired[int | None]
    raw: NotRequired[str]


class ChatMessage(BaseModel):
    """A message of the paper's chat (Library.messages). Answered with response_model_exclude_unset: a question
    without attached passages has no attachments key. The usage and passages are JSON in the database."""
    role: Literal["user", "assistant"]
    content: str
    usage: Stored[Usage | None]  # An answer's; None for a question, or when the connection did not tell.
    attachments: Stored[list[ChatPassage]] = None  # Never answered: a message without passages has no key.
    research: Stored[ChatResearch] = None
