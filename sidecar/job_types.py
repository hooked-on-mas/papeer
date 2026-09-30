"""What the sidecar's jobs are and what they tell the frontend: kinds, results and the event stream.

Every background job has a kind (JobKind) and, once it has succeeded, a result of that kind's model
(RESULT_TYPES): JobManager checks the result against it, so a route that returns another shape fails
its job (a bug, logged) instead of handing the frontend something it does not expect. The models
appear in the API's schema (JobInfo in GET /api/jobs and /api/jobs/{job_id}, and the events of
/ws/events through event_schemas), which the frontend's types follow (frontend/src/api/jobTypes.ts).
"""
from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class JobKind(StrEnum):
    """The kinds of background jobs; the names are what the frontend receives (jobKinds.ts)."""
    TRANSLATE = "translate"
    REVISION = "revision"  # A paragraph's corrected translation adopted: the pages it is on are made again.
    REVISION_DRAFT = "revision-draft"
    GLOSSARY_DRAFT = "glossary-draft"
    GLOSSARY_SELECT = "glossary-select"  # The AI chooses the domain dictionaries a paper uses.
    GLOSSARY_SPLIT = "glossary-split"  # The AI splits a dictionary into domain dictionaries by subject.
    ARTICLE = "article"
    ASK = "ask"
    CHECK = "check"
    IMPORT = "import"
    EXPORT = "export"
    INTERLEAVED = "interleaved"
    BACKUP = "backup"
    RESTORE = "restore"
    DRIVE_SYNC = "drive-sync"
    OCR = "ocr"  # A paper's pages read by OCR (or one page by the AI) and its extraction written again.
    OCR_DATA = "ocr-data"  # Tesseract's language data downloaded to this PC.


# The jobs that copy or replace the whole library: nothing else runs beside them (JobManager), and the
# requests that would touch the library wait or are refused meanwhile (deps.snapshot_running).
SNAPSHOT_KINDS = frozenset({JobKind.BACKUP, JobKind.RESTORE, JobKind.DRIVE_SYNC})

JobStatus = Literal["running", "succeeded", "failed", "cancelled"]


# --- Results, by kind ---

class Usage(BaseModel):
    """The tokens a job used, when the AI connection tells (providers.common.UsageMeter.report)."""
    provider: str
    model: str
    calls: int
    measured_calls: int
    input_tokens: int
    cached_tokens: int
    output_tokens: int
    reasoning_tokens: int
    cost_usd: float | None = None


class TranslateResult(BaseModel):
    """translate and revision: the run's translation-report.json (PaperService.translate).

    Only what the frontend reads is named; the rest of the report (warnings, counts of preserved
    blocks, ...) is kept as it is.
    """
    model_config = ConfigDict(extra="allow")
    pages: int
    requested_pages: list[int]
    selected_pages: list[int]
    already_translated_pages: list[int]
    preserved_pages: list[int]
    translated_pages: list[int]
    untranslated_pages: list[int]
    skipped_pages: list[int]
    skipped_blocks: list[str]
    skipped_block_pages: list[int]
    page_errors: dict[str, str]
    model: str
    usage: Usage | None = None


class RevisionDraftResult(BaseModel):
    text: str
    unit_id: str


class GlossaryTerm(BaseModel):
    source: str
    target: str


class GlossaryDraftResult(BaseModel):
    terms: list[GlossaryTerm]


class GlossaryDomainsResult(BaseModel):
    domains: list[str]
    new_domain: str | None = None


class GlossaryDomainCount(BaseModel):
    name: str
    count: int


class GlossarySplitResult(BaseModel):
    moved: int  # Terms given a domain.
    domains: list[GlossaryDomainCount]  # Every domain dictionary afterwards (not 共通), with its terms.


class ArticleResult(BaseModel):
    content: str
    usage: Usage | None = None


class AskResult(BaseModel):
    answer: str
    usage: Usage | None = None


class ImportResult(BaseModel):
    paper_ids: list[str]  # In the order the paths were sent; a PDF already in the library gives its paper.
    added: int  # How many were new.
    # The new papers with pages still needing OCR (scans not read when added): the frontend offers to read them.
    needs_ocr: list[str] = Field(default_factory=list)


class OcrResult(BaseModel):
    """ocr: what papeer.core.ocr.read_again read and changed (pages are page numbers)."""
    read_pages: list[int]
    failed_pages: dict[str, str]  # By page: why it could not be read.
    ocr_pages: list[int]  # Pages still needing OCR afterwards.
    changed_pages: list[int]  # Pages whose text for translation changed.
    retranslate_pages: list[int]  # Among them, those that had a saved translation.
    usage: Usage | None = None


class OcrDataResult(BaseModel):
    installed: list[str]  # The languages whose data is now on this PC.


class ExportResult(BaseModel):
    kind: Literal["interleaved", "bilingual"]
    destination: str


class InterleavedResult(BaseModel):
    kind: Literal["interleaved"]
    path: str  # interleaved.pdf beside the paper, for an external viewer.


class BackupResult(BaseModel):
    path: str


class RestoreResult(BaseModel):
    # Where the library as it was stays, when it had to stay beside the library; None when this PC's
    # history holds it (history_restore).
    previous_path: str | None = None


class DriveSyncResult(BaseModel):
    """folder_sync.sync_connected (drive_sync.sync, drive_sync_v2.sync) and folder_sync.migrate: "synced", or
    why it did not (yet): "deferred", "conflict", "review", "waiting" (the new format: another PC's data is
    still arriving)."""
    model_config = ConfigDict(extra="allow")
    status: Literal["synced", "deferred", "conflict", "review", "waiting"]
    reloaded: bool = False  # Another PC's library was taken in: the page reloads.
    previous_path: str | None = None
    set_aside: list[str] = Field(default_factory=list)
    not_set_aside: list[dict[str, Any]] = Field(default_factory=list)
    conflicts: list[dict[str, Any]] | None = None  # "conflict"
    review: dict[str, Any] | None = None  # "review"
    waiting: dict[str, Any] | None = None  # "waiting": what is waited for (drive_sync_v2.waiting_status)
    heads: list[str] | None = None  # "waiting": the heads, as expected_heads for going on without waiting
    migrated: bool | None = None  # folder_sync.migrate: whether the sync folder is in the new format now


# check: the connection's answer as one line of text.
CheckResult = str

RESULT_TYPES: dict[JobKind, Any] = {
    JobKind.TRANSLATE: TranslateResult,
    JobKind.REVISION: TranslateResult,
    JobKind.REVISION_DRAFT: RevisionDraftResult,
    JobKind.GLOSSARY_DRAFT: GlossaryDraftResult,
    JobKind.GLOSSARY_SELECT: GlossaryDomainsResult,
    JobKind.GLOSSARY_SPLIT: GlossarySplitResult,
    JobKind.ARTICLE: ArticleResult,
    JobKind.ASK: AskResult,
    JobKind.CHECK: CheckResult,
    JobKind.IMPORT: ImportResult,
    JobKind.EXPORT: ExportResult,
    JobKind.INTERLEAVED: InterleavedResult,
    JobKind.BACKUP: BackupResult,
    JobKind.RESTORE: RestoreResult,
    JobKind.DRIVE_SYNC: DriveSyncResult,
    JobKind.OCR: OcrResult,
    JobKind.OCR_DATA: OcrDataResult,
}

# Which one belongs to which kind is RESULT_TYPES (and the frontend's JobResults); the union is only
# the schema's answer to "what can a result be".
JobResult = Union[
    TranslateResult, RevisionDraftResult, GlossaryDraftResult, GlossaryDomainsResult, GlossarySplitResult, ArticleResult, AskResult, ImportResult,
    ExportResult, InterleavedResult, BackupResult, RestoreResult, DriveSyncResult, OcrResult, OcrDataResult,
    CheckResult,
]

_RESULT_ADAPTERS = {kind: TypeAdapter(result_type) for kind, result_type in RESULT_TYPES.items()}


def job_result(kind: JobKind, value: Any) -> Any:
    """`value`, a job's return value, as its kind's result model; pydantic's ValidationError if it is not one."""
    return _RESULT_ADAPTERS[kind].validate_python(value)


class Sent(BaseModel):
    """A model whose every field is in what the sidecar sends, defaults included: the schema requires them
    all, so the frontend's types say `paper_id: string | null` (and an event's `type`) rather than an
    optional key."""
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class JobStarted(BaseModel):
    """The answer of a route that starts a job: follow it with GET /api/jobs/{job_id} or the events."""
    job_id: str


class JobInfo(Sent):
    """A job as GET /api/jobs/{job_id} tells it, running or finished (JobManager keeps the last ones)."""
    job_id: str
    paper_id: str | None = None
    kind: JobKind
    message: str = ""
    done: int | None = None
    total: int | None = None
    status: JobStatus = "running"
    running: bool = True
    cancelled: bool = False
    result: JobResult | None = None  # Once succeeded: RESULT_TYPES[kind].
    error: str | None = None  # Once failed or cancelled.


# --- Events of /ws/events ---

class JobStartedEvent(Sent):
    type: Literal["job.started"] = "job.started"
    job_id: str
    paper_id: str | None
    kind: JobKind
    message: str


class JobProgressEvent(Sent):
    type: Literal["job.progress"] = "job.progress"
    job_id: str
    paper_id: str | None
    kind: JobKind
    message: str
    done: int | None  # From a "3/10" in the message.
    total: int | None


class JobPageReadyEvent(Sent):
    """A page of a translation in progress is ready to show."""
    type: Literal["job.page_ready"] = "job.page_ready"
    paper_id: str | None
    page: int


class JobFinishedEvent(JobInfo):
    """The job as it ended; the same as GET /api/jobs/{job_id} answers afterwards."""
    type: Literal["job.finished"] = "job.finished"


class LibraryChangedEvent(Sent):
    type: Literal["library.changed"] = "library.changed"


class PaperChangedEvent(Sent):
    """One paper changed; `fields`: the columns written, None when anything about it may have."""
    type: Literal["paper.changed"] = "paper.changed"
    paper_id: str
    fields: list[str] | None = None


class ImportPagesEvent(Sent):
    """The page counts of the PDFs being added, keyed by the path as sent (None: not readable)."""
    type: Literal["import.pages"] = "import.pages"
    pages: dict[str, int | None]


class ImportItemEvent(Sent):
    """One PDF has been added (or was in the library already)."""
    type: Literal["import.item"] = "import.item"
    path: str
    paper_id: str


# What JobManager.broadcast sends (it still takes a plain dict too, sent as it is).
EventModel = Union[JobStartedEvent, JobProgressEvent, JobPageReadyEvent, JobFinishedEvent, LibraryChangedEvent,
                   PaperChangedEvent, ImportPagesEvent, ImportItemEvent]
ServerEvent = Annotated[EventModel, Field(discriminator="type")]


def event_schemas(ref_template: str = "#/components/schemas/{model}") -> dict[str, Any]:
    """The events' JSON schemas by name, ServerEvent (any of them) included, for the API's components."""
    schema = TypeAdapter(ServerEvent).json_schema(mode="serialization", ref_template=ref_template)
    return {**schema.pop("$defs", {}), "ServerEvent": schema}
