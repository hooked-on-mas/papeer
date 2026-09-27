/**
 * The sidecar's job contract (sidecar/job_types.py): what each kind of job returns, how GET /api/jobs
 * and /api/jobs/{job_id} tell a job, and the events of /ws/events.
 *
 * Written by hand after the Python models, with their names, until the API types are generated
 * (schema.d.ts): each type here then becomes an alias of components["schemas"][<same name>], and only
 * what the schema cannot say stays (JobResults, which result belongs to which kind, and the narrowing
 * of JobInfo and JobFinished by kind and status).
 */
import type { JobKind } from "@/features/jobs/jobKinds";
import type { Usage } from "@/lib/usage";

export type { JobKind };

// --- Results, by kind ---

/**
 * translate and revision: the run's translation-report.json. Only what the frontend reads is named;
 * the report has more (warnings, counts of preserved blocks: TranslationReport in hooks.ts).
 */
export type TranslateResult = {
  pages: number;
  requested_pages: number[];
  selected_pages: number[];
  already_translated_pages: number[];
  preserved_pages: number[];
  translated_pages: number[];
  untranslated_pages: number[];
  /** Pages whose PDF could not be made: they stay in the original. */
  skipped_pages: number[];
  skipped_blocks: string[];
  skipped_block_pages: number[];
  page_errors: Record<string, string>;
  model: string;
  usage?: Usage | null;
};
export type RevisionDraftResult = { text: string; unit_id: string };
export type GlossaryTerm = { source: string; target: string };
export type GlossaryDraftResult = { terms: GlossaryTerm[] };
export type ArticleResult = { content: string; usage?: Usage | null };
export type AskResult = { answer: string; usage?: Usage | null };
/** paper_ids in the order the paths were sent; a PDF already in the library gives its paper. */
export type ImportResult = { paper_ids: string[]; added: number };
export type ExportResult = { kind: "interleaved" | "bilingual"; destination: string };
export type InterleavedResult = { kind: "interleaved"; path: string };
export type BackupResult = { path: string };
export type RestoreResult = { previous_path: string };
/** "synced", or why the sync did not (yet) take place. */
export type DriveSyncResult = {
  status: "synced" | "deferred" | "conflict" | "review";
  /** Another PC's library was taken in: the page reloads. */
  reloaded?: boolean;
  previous_path?: string | null;
  set_aside?: string[];
  not_set_aside?: Record<string, unknown>[];
  conflicts?: Record<string, unknown>[] | null;
  review?: Record<string, unknown> | null;
};
/** check: the connection's answer as one line of text. */
export type CheckResult = string;

/** What a job of each kind returns once it has succeeded (RESULT_TYPES in sidecar/job_types.py). */
export type JobResults = {
  translate: TranslateResult;
  revision: TranslateResult;
  "revision-draft": RevisionDraftResult;
  "glossary-draft": GlossaryDraftResult;
  article: ArticleResult;
  ask: AskResult;
  check: CheckResult;
  import: ImportResult;
  export: ExportResult;
  interleaved: InterleavedResult;
  backup: BackupResult;
  restore: RestoreResult;
  "drive-sync": DriveSyncResult;
};

// --- Jobs ---

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

type JobBase<K extends JobKind> = {
  job_id: string;
  paper_id: string | null;
  kind: K;
  message: string;
  done: number | null;
  total: number | null;
  cancelled: boolean;
};

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

export type JobStartedEvent = { type: "job.started"; job_id: string; paper_id: string | null; kind: JobKind; message: string };
export type JobProgressEvent = {
  type: "job.progress"; job_id: string; paper_id: string | null; kind: JobKind; message: string;
  /** From a "3/10" in the message. */
  done: number | null;
  total: number | null;
};
/** A page of a translation in progress is ready to show. */
export type JobPageReadyEvent = { type: "job.page_ready"; paper_id: string | null; page: number };
/** The job as it ended: the same as GET /api/jobs/{job_id} answers afterwards. */
export type JobFinishedEvent = JobFinished & { type: "job.finished" };
export type LibraryChangedEvent = { type: "library.changed" };
/** One paper changed; `fields`: the columns written, none when anything about it may have. */
export type PaperChangedEvent = { type: "paper.changed"; paper_id: string; fields?: string[] | null };
/** The page counts of the PDFs being added, keyed by the path as sent (null: not readable). */
export type ImportPagesEvent = { type: "import.pages"; pages: Record<string, number | null> };
/** One PDF has been added (or was in the library already). */
export type ImportItemEvent = { type: "import.item"; path: string; paper_id: string };

export type ServerEvent =
  | JobStartedEvent | JobProgressEvent | JobPageReadyEvent | JobFinishedEvent
  | LibraryChangedEvent | PaperChangedEvent | ImportPagesEvent | ImportItemEvent;
