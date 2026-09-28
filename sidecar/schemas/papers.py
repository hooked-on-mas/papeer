"""Request models of the library routes (sidecar/routes/papers.py): papers, sticky notes and folders."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field


class ImportRequest(BaseModel):
    paths: list[str]
    collection: str | None = None


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


class UpdatePaperRequest(BaseModel):
    title: str | None = None
    author: str | None = None
    year: str | None = None  # "" clears it; otherwise four digits
    collection: str | None = None
    note: str | None = None
    tags: list[str] | None = None
    read_status: str | None = None
    doi: str | None = Field(default=None, max_length=500)  # "" clears it; a doi.org link is kept bare
    arxiv_id: str | None = Field(default=None, max_length=200)
    venue: str | None = Field(default=None, max_length=1000)


class BibtexRequest(BaseModel):
    paper_ids: list[str] = Field(min_length=1, max_length=10000)


class BibtexExportRequest(BaseModel):
    collection: str  # The folder, with its subfolders.
    destination: str  # A .bib file outside the library.


class RenamePaperRequest(BaseModel):
    new_title: str


class CreateCollectionRequest(BaseModel):
    name: str


class RenameCollectionRequest(BaseModel):
    old_name: str
    new_name: str
