"""Models of the library routes (sidecar/routes/papers.py): papers, what the reader shows, sticky notes and folders."""
from __future__ import annotations

from typing import Annotated, Literal, NotRequired, TypedDict

from pydantic import BaseModel, ConfigDict, Field, with_config

from papeer.core.translation_status import TranslationStatus
from sidecar.job_types import GlossaryTerm, Usage
from sidecar.schemas.common import Stored


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


# --- Papers ---


class PaperRow(BaseModel):
    """A paper as GET /api/papers lists it: its papers row (Library._paper) and what library_list.paper_row adds.

    Answered with response_model_exclude_unset, so a row keeps exactly the keys it was given: the fields
    with defaults are the ones a row may lack. What paper_row adds is missing from the row of a paper whose
    ID is not a folder's name (a hand-edited database), except last_opened_at: library_rows gives every row
    that one, None when the paper was never opened on this PC (papeer/core/opened_papers.py).
    The row's columns have no default, so a column added to the papers table fails the tests until named here.
    """
    id: str
    sha256: str
    title: str
    original_name: str
    pages: int
    status: TranslationStatus  # Always a code: Library._paper reads the labels stored before as codes.
    collection_name: str
    created_at: str
    tags: list[str]
    read_status: str
    first_author: str
    publication_year: str
    bibliography_version: int
    doi: str  # For citing it (BibTeX); "" when unknown, as arxiv_id and venue.
    arxiv_id: str
    venue: str
    # When it was last opened on this PC, UTC ISO text; None if never.
    last_opened_at: str | None = None
    folder_path: str = ""
    has_article: bool = False
    # Translation progress (library_list.translation_state).
    translated_count: int = 0
    translation_required_count: int = 0
    translation_completed_required_count: int = 0
    translation_ocr_count: int = 0  # Pages kept as the original because they need OCR.
    translation_has_issues: bool | None = None  # None without a readable report.
    has_translated: bool = False
    translation_in_progress: bool = False


class Paper(PaperRow):
    """GET /api/papers/{paper_id}: the paper's row with its memo, which the list leaves out."""
    note: str


class PaperOpened(BaseModel):
    """POST /api/papers/{paper_id}/opened (opened_papers.mark_opened): the time recorded on this PC, whether
    an unread paper became 読書中, and the fields that changed as paper.changed names them."""
    last_opened_at: str
    started_reading: bool
    fields: list[str]


# --- What the reader shows (GET /api/papers/{paper_id}/reading) ---
# The files these come from may have been written by an earlier Papeer, so ReadingState passes them on
# as Stored: described for the frontend's types, never refused. Keys a file may lack are NotRequired.


class ReadabilityWarning(TypedDict):
    """A paragraph typeset below the readable size because it overflowed its box (pdf_engine.build_translated_pdf).
    Reports written before the length estimate have only page, block, font_size and scale."""
    page: int
    block: NotRequired[str]
    font_size: NotRequired[float]
    scale: NotRequired[float]
    role: NotRequired[str]
    # Characters of the typeset translation (math and spaces not counted), and about how many fit at the
    # readable size: None when the box is too small for any translation at that size.
    chars: NotRequired[int]
    char_budget: NotRequired[int | None]
    # Translation blocks the typeset text came from; a paragraph's block is its id before the last "_".
    source_blocks: NotRequired[list[str]]


class GlossaryWarning(TypedDict):
    """A paragraph whose translation lacks the rendering of a glossary term found in the source."""
    page: int
    unit: str
    excerpt: str
    terms: list[GlossaryTerm]


@with_config(ConfigDict(extra="allow"))
class TranslationReport(TypedDict, total=False):
    """translation-report.json of the last translation (PaperService.translate). Only what the frontend
    reads is named; a report has more (the code versions, counts of preserved blocks, ...), and those of
    earlier versions may lack any of it."""
    pages: int
    requested_pages: list[int]
    selected_pages: list[int]
    translated_pages: list[int]
    skipped_pages: list[int]  # Pages whose PDF could not be made: they stay in the original.
    scaled_blocks: int
    readability_warnings: list[ReadabilityWarning]
    skipped_blocks: list[str]
    skipped_block_pages: list[int]
    page_errors: dict[str, str]
    glossary_warnings: list[GlossaryWarning]
    model: str
    usage: Usage | None


@with_config(ConfigDict(extra="allow"))
class TranslationPreview(TypedDict):
    """translation-preview.json: the pages of the translation in progress (or the last one) made so far."""
    run_id: str
    complete: bool
    pages: list[int]
    target_pages: NotRequired[list[int]]
    skipped_pages: NotRequired[list[int]]
    total_pages: NotRequired[int]
    page_errors: NotRequired[dict[str, str]]


class OcrPage(TypedDict):
    """A page needing OCR (papeer.layout.ocr_pages): kept as the original when its text layer is garbled or it
    is a scanned image, or translated except for its garbled paragraphs ("partial")."""
    page: int
    reason: Literal["garbled", "image", "partial"]
    garbled_ratio: NotRequired[float]
    # "partial" only: paragraphs kept as the original (0 when the garbled text is in formulas or tables).
    garbled_paragraphs: NotRequired[int]


class TranslatedPageRef(BaseModel):
    """Where the right pane finds a page: the file (relative to the paper's folder), the page in it, its time."""
    file: str
    index: int
    mtime: int


class PageVersion(BaseModel):
    """The translation key's short hash (or "不明") and the model that translated a page."""
    sha: str
    model: str


class ReadingState(BaseModel):
    """Everything the reader needs to show the original and the translation page by page (reading_state.reading_state)."""
    page_count: int
    source_page_count: int
    empty_pages: list[int]
    translation_required_pages: list[int]
    ocr_pages: Stored[list[OcrPage]]  # Listed in the translation review; not translated unless "partial".
    completed_pages: list[int]
    preview: Stored[TranslationPreview | None]
    in_progress: bool
    report: Stored[TranslationReport | None]
    translated_pages: dict[str, TranslatedPageRef | None]  # By page number; None while the page waits.
    page_versions: dict[str, PageVersion]
    last_page: int
    has_translated: bool
    has_article: bool
    has_interleaved: bool
    original_mtime: int


class Article(BaseModel):
    """GET /api/papers/{paper_id}/article: the summary article, and what generating it used (None if unknown)."""
    content: str
    usage: Stored[Usage | None]


# --- Sticky notes and highlights ---


class StickyNote(BaseModel):
    """A sticky note or highlight (a bookmarks row, Library._bookmark).

    kind and color are plain text: a newer Papeer on another PC may store values this one does not know
    (the database is synced).
    """
    id: int
    paper_id: str
    page: int
    side: Literal["original", "translated"]
    quote: str
    label: str
    note: str
    anchor_y: float
    anchor_x: float
    created_at: str
    kind: str  # "note" or "highlight".
    color: str  # A highlight's (HighlightColor); "" for a sticky note.
    # A highlight's rectangles, [x, y, width, height] as fractions of the page: JSON in the database, which
    # a newer Papeer might write differently.
    rects: Stored[list[tuple[float, float, float, float]]]


class LibraryStickyNote(StickyNote):
    """GET /api/sticky-notes: with the paper's title and file name, for the list across the library."""
    paper_title: str
    paper_name: str
