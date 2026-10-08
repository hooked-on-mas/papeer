/**
 * The sidecar's job contract (sidecar/job_types.py): what each kind of job returns, how GET /api/jobs
 * and /api/jobs/{job_id} tell a job, and the events of /ws/events.
 *
 * The types are the generated ones (schema.d.ts, components["schemas"][<same name>]); only what the
 * schema cannot say is written here: JobResults (which result belongs to which kind), and the narrowing
 * of JobInfo and JobFinished by kind and status.
 */
import type { components } from "./schema";
import type { JobKind } from "@/features/jobs/jobKinds";

export type { JobKind };

type Schemas = components["schemas"];

// --- Results, by kind ---

/**
 * translate and revision: the run's translation-report.json. Only what the frontend reads is named;
 * the report has more (warnings, counts of preserved blocks: TranslationReport in hooks.ts).
 */
export type TranslateResult = Schemas["TranslateResult"];
export type RevisionDraftResult = Schemas["RevisionDraftResult"];
export type GlossaryTerm = Schemas["GlossaryTerm"];
export type GlossaryDraftResult = Schemas["GlossaryDraftResult"];
/** glossary-select: the domain dictionaries chosen for the paper (recorded by the sidecar), and a new domain for its terms. */
export type GlossaryDomainsResult = Schemas["GlossaryDomainsResult"];
/** glossary-split: how many terms were given a domain, and every domain dictionary afterwards with its terms. */
export type GlossarySplitResult = Schemas["GlossarySplitResult"];
export type TermReplacementResult = Schemas["TermReplacementResult"];
export type TermResearchResult = Schemas["TermResearchResult"];
export type ArticleResult = Schemas["ArticleResult"];
export type AskResult = Schemas["AskResult"];
/** paper_ids in the order the paths were sent; a PDF already in the library gives its paper. */
export type ImportResult = Schemas["ImportResult"];
export type ExportResult = Schemas["ExportResult"];
export type InterleavedResult = Schemas["InterleavedResult"];
export type BackupResult = Schemas["BackupResult"];
export type RestoreResult = Schemas["RestoreResult"];
/** "synced", or why the sync did not (yet) take place; reloaded: another PC's library was taken in. */
export type DriveSyncResult = Schemas["DriveSyncResult"];
/** ocr: the pages read by OCR (or one page by the AI), those that failed and those whose translation is made again. */
export type OcrResult = Schemas["OcrResult"];
/** ocr-data: the languages whose Tesseract data is now on this PC. */
export type OcrDataResult = Schemas["OcrDataResult"];
export type ResearchRecord = Schemas["ResearchRecord"];
export type DiscoveryResult = Schemas["DiscoveryResult"];
export type MapGroupResult = Schemas["MapGroupResult"];
export type ReferenceImportResult = Schemas["ReferenceImportResult"];
/** check: the connection's answer as one line of text. */
export type CheckResult = string;

/** What a job of each kind returns once it has succeeded (RESULT_TYPES in sidecar/job_types.py). */
export type JobResults = {
  "term-replace": TermReplacementResult;
  "term-research": TermResearchResult;
  translate: TranslateResult;
  revision: TranslateResult;
  "revision-draft": RevisionDraftResult;
  "glossary-draft": GlossaryDraftResult;
  "glossary-select": GlossaryDomainsResult;
  "glossary-split": GlossarySplitResult;
  article: ArticleResult;
  ask: AskResult;
  check: CheckResult;
  import: ImportResult;
  export: ExportResult;
  interleaved: InterleavedResult;
  backup: BackupResult;
  restore: RestoreResult;
  "drive-sync": DriveSyncResult;
  ocr: OcrResult;
  "ocr-data": OcrDataResult;
  "paper-discovery": DiscoveryResult;
  "paper-map-groups": MapGroupResult;
  "reference-research": ResearchRecord;
  "reference-import": ReferenceImportResult;
};

// --- Jobs ---

export type JobStatus = Schemas["JobInfo"]["status"];

/** A route that starts a job answers its id. */
export type JobStarted = Schemas["JobStarted"];

type JobBase<K extends JobKind> = Omit<Schemas["JobInfo"], "kind" | "status" | "running" | "result" | "error"> & { kind: K };

/** A job that has ended, told by kind and outcome: a succeeded one has its kind's result, the others an error. */
export type JobFinished<K extends JobKind = JobKind> = K extends JobKind
  ? | (JobBase<K> & { status: "succeeded"; running: false; result: JobResults[K]; error: null })
    | (JobBase<K> & { status: "failed" | "cancelled"; running: false; result: null; error: string | null })
  : never;

export type JobSucceeded<K extends JobKind = JobKind> = Extract<JobFinished<K>, { status: "succeeded" }>;

/** A job as GET /api/jobs (running ones) and /api/jobs/{job_id} (also the last finished ones) tell it. */
export type JobInfo<K extends JobKind = JobKind> = K extends JobKind
  ? (JobBase<K> & { status: "running"; running: true; result: null; error: null }) | JobFinished<K>
  : never;

// --- Events of /ws/events ---

export type JobStartedEvent = Schemas["JobStartedEvent"];
/** done and total: from a "3/10" in the message. */
export type JobProgressEvent = Schemas["JobProgressEvent"];
/** A page of a translation in progress is ready to show. */
export type JobPageReadyEvent = Schemas["JobPageReadyEvent"];
/** The job as it ended: the same as GET /api/jobs/{job_id} answers afterwards (narrowed as JobFinished). */
export type JobFinishedEvent = JobFinished & { type: "job.finished" };
export type LibraryChangedEvent = Schemas["LibraryChangedEvent"];
/** One paper changed; `fields`: the columns written, null when anything about it may have. */
export type PaperChangedEvent = Schemas["PaperChangedEvent"];
/** The page counts of the PDFs being added, keyed by the path as sent (null: not readable). */
export type ImportPagesEvent = Schemas["ImportPagesEvent"];
/** One PDF has been added (or was in the library already). */
export type ImportItemEvent = Schemas["ImportItemEvent"];

export type ServerEvent =
  | JobStartedEvent | JobProgressEvent | JobPageReadyEvent | JobFinishedEvent
  | LibraryChangedEvent | PaperChangedEvent | ImportPagesEvent | ImportItemEvent;
