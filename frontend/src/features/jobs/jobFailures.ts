import { create } from "zustand";
import { useErrorDialog } from "@/components/errorDialog";
import type { ErrorReport } from "@/lib/errorReports";

/**
 * Failures of jobs whose paper was not on screen, by paper: the library marks the paper's row until
 * the user looks at the error (or the same kind of job succeeds for it), instead of a dialog
 * interrupting whatever the user was reading.
 */
export const useJobFailures = create<{ failures: Record<string, ErrorReport> }>(() => ({ failures: {} }));

export function addJobFailure(report: ErrorReport): void {
  const paperId = report.paperId;
  if (!paperId) return;
  useJobFailures.setState((state) => ({ failures: { ...state.failures, [paperId]: report } }));
}

/** Forget the paper's failure; with `kind`, only a failure of that kind of job. */
export function clearJobFailure(paperId: string, kind?: string): void {
  const failure = useJobFailures.getState().failures[paperId];
  if (!failure || (kind && failure.kind !== kind)) return;
  useJobFailures.setState((state) => {
    const failures = { ...state.failures };
    delete failures[paperId];
    return { failures };
  });
}

/** Show the paper's failure in the error dialog; it counts as seen. */
export function showJobFailure(paperId: string): void {
  const failure = useJobFailures.getState().failures[paperId];
  if (!failure) return;
  clearJobFailure(paperId);
  useErrorDialog.getState().report(failure);
}
