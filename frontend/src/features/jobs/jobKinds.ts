/** Kinds of sidecar background jobs; the names match the kind strings the sidecar sends. */
export type JobKind =
  | "translate" | "revision" | "revision-draft" | "glossary-draft"
  | "article" | "ask" | "check"
  | "import" | "export" | "interleaved"
  | "backup" | "restore" | "drive-sync";

/** Jobs that rewrite a paper's translation. */
export const TRANSLATION_JOBS: readonly JobKind[] = ["translate", "revision"];
/** Jobs that call the AI, so the plan's usage limits change (also when they fail on the limit). */
export const AI_PLAN_JOBS: readonly JobKind[] = ["translate", "revision", "revision-draft", "glossary-draft", "article", "ask", "check"];
/** Jobs that copy or replace the whole library; nothing else may run meanwhile. */
export const SNAPSHOT_JOBS: readonly JobKind[] = ["backup", "restore", "drive-sync"];

export function isJobKind(kind: string | undefined, kinds: readonly JobKind[]): boolean {
  return !!kind && (kinds as readonly string[]).includes(kind);
}
