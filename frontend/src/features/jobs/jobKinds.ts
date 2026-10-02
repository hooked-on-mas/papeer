/**
 * Kinds of sidecar background jobs, named as the sidecar names them (JobKind in sidecar/job_types.py;
 * tests/test_job_types.py checks that the two lists agree).
 */
export const JOB_KINDS = [
  "translate", "revision", "revision-draft", "glossary-draft", "glossary-select", "glossary-split",
  "article", "ask", "check",
  "import", "export", "interleaved",
  "backup", "restore", "drive-sync",
  "ocr", "ocr-data",
  "reference-research", "reference-import",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

/** Jobs that rewrite a paper's translation. */
export const TRANSLATION_JOBS: readonly JobKind[] = ["translate", "revision"];
/** Jobs that call the AI, so the plan's usage limits change (also when they fail on the limit). */
export const AI_PLAN_JOBS: readonly JobKind[] = ["translate", "revision", "revision-draft", "glossary-draft", "glossary-select", "glossary-split", "article", "ask", "check", "reference-research", "reference-import"];
/** Jobs that copy or replace the whole library; nothing else may run meanwhile (SNAPSHOT_KINDS in sidecar/job_types.py). */
export const SNAPSHOT_JOBS: readonly JobKind[] = ["backup", "restore", "drive-sync"];

export function isJobKind(kind: string | undefined, kinds: readonly JobKind[]): boolean {
  return !!kind && (kinds as readonly string[]).includes(kind);
}
