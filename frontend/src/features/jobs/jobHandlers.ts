import type { QueryKey } from "@tanstack/react-query";
import type { JobFinished, JobSucceeded } from "@/api/jobTypes";
import type { JobKind } from "./jobKinds";

export type { JobFinished, JobSucceeded } from "@/api/jobTypes";

export type JobContext = {
  /** The job's paper is on screen, or the job is library-wide. */
  visible: boolean;
  /** Show a message in the status bar (only when visible), with the AI usage appended. */
  status: (message: string) => void;
  /**
   * Tell of an outcome that must not be missed (a translation, an export) in a toast instead of the
   * status bar, whichever paper is on screen: titled with the paper's name when it is not the one on
   * screen, with the AI usage appended to `message`.
   */
  done: (message: string, options?: {
    title?: string;
    /** "info" for an outcome with something to look at (pages left in the original), shown longer. */
    tone?: "success" | "info";
    /** Left out for a paper removed meanwhile. */
    action?: { label: string; run: () => void };
  }) => void;
};

/**
 * What a feature does when one of its jobs ends. The job event stream stays generic;
 * each feature registers its own messages and the queries its jobs make stale.
 */
export type JobHandler<K extends JobKind = JobKind> = {
  succeeded?: (event: JobSucceeded<K>, context: JobContext) => void;
  /** Queries to refresh when the job ends, whatever the outcome. */
  refresh?: (event: JobFinished<K>) => QueryKey[];
  /** How the error dialog's 再開 starts a failed job's work again (none: the dialog offers no 再開). */
  resume?: { label: string; run: (event: JobFinished<K>) => void };
};

export type JobHandlers = { [K in JobKind]?: JobHandler<K> };

const handlers = new Map<JobKind, JobHandler>();

export function registerJobHandlers(entries: JobHandlers): void {
  for (const kind of Object.keys(entries) as JobKind[]) {
    // Called only with events of the kind it was registered for (jobHandler).
    const handler = entries[kind] as JobHandler | undefined;
    if (handler) handlers.set(kind, handler);
  }
}

/** The handler of the event's kind, to be called with events of that kind only. */
export function jobHandler(kind: JobKind): JobHandler | undefined {
  return handlers.get(kind);
}
