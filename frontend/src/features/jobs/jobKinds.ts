/**
 * Kinds of sidecar background jobs, named as the sidecar names them (JobKind in sidecar/job_types.py;
 * tests/test_job_types.py checks that the two lists agree).
 */
export const JOB_KINDS = [
  "translate", "revision", "revision-draft", "glossary-draft", "glossary-select", "glossary-split",
  "term-replace", "term-research",
  "article", "ask", "check",
  "import", "export", "interleaved",
  "backup", "restore", "drive-sync",
  "ocr", "ocr-data",
  "reference-research", "paper-discovery", "paper-map-groups", "reference-import",
  "library-organize",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

/** Jobs that rewrite a paper's translation. */
export const TRANSLATION_JOBS: readonly JobKind[] = ["translate", "revision", "term-replace"];
/** Jobs that call the AI, so the plan's usage limits change (also when they fail on the limit). */
export const AI_PLAN_JOBS: readonly JobKind[] = ["translate", "revision", "revision-draft", "glossary-draft", "glossary-select", "glossary-split", "term-research", "article", "ask", "check", "reference-research", "paper-map-groups", "reference-import", "library-organize"];
/** Jobs that copy or replace the whole library; nothing else may run meanwhile (SNAPSHOT_KINDS in sidecar/job_types.py). */
export const SNAPSHOT_JOBS: readonly JobKind[] = ["backup", "restore", "drive-sync"];

/** Independent of reference lookup; agrees with REFERENCE_RESEARCH_COMPATIBLE_KINDS in the sidecar. */
export const REFERENCE_RESEARCH_COMPATIBLE_JOBS: readonly JobKind[] = [
  "translate", "revision", "revision-draft", "glossary-draft", "glossary-select", "glossary-split",
  "term-replace", "term-research",
  "article", "ask", "export", "interleaved",
];

export function isJobKind(kind: string | undefined, kinds: readonly JobKind[]): boolean {
  return !!kind && (kinds as readonly string[]).includes(kind);
}
