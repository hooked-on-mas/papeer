import type { QueryKey } from "@tanstack/react-query";
import type { JobKind } from "./jobKinds";

export type JobFinished = {
  job_id: string;
  paper_id: string | null;
  kind: string;
  status: "succeeded" | "failed" | "cancelled";
  result?: any;
  error?: string;
  cancelled?: boolean;
};

export type JobContext = {
  /** The job's paper is on screen, or the job is library-wide. */
  visible: boolean;
  /** Show a message in the status bar (only when visible), with the AI usage appended. */
  status: (message: string) => void;
};

/**
 * What a feature does when one of its jobs ends. The job event stream stays generic;
 * each feature registers its own messages and the queries its jobs make stale.
 */
export type JobHandler = {
  succeeded?: (event: JobFinished, context: JobContext) => void;
  /** Queries to refresh when the job ends, whatever the outcome. */
  refresh?: (event: JobFinished) => QueryKey[];
  /** How the error dialog's 再開 starts a failed job's work again (none: the dialog offers no 再開). */
  resume?: { label: string; run: (event: JobFinished) => void };
};

export type JobHandlers = Partial<Record<JobKind, JobHandler>>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandlers(entries: JobHandlers): void {
  for (const [kind, handler] of Object.entries(entries)) {
    if (handler) handlers.set(kind, handler);
  }
}

export function jobHandler(kind: string): JobHandler | undefined {
  return handlers.get(kind);
}
