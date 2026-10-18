import { create } from "zustand";
import { startJob } from "@/features/jobs/jobEvents";
import type { JobFinished } from "@/features/jobs/jobHandlers";
import type { Term, GlossaryCandidate } from "./translationStart";

/** The AI's check for unregistered terms of one paper, kept while the translation dialog is closed. */
export type GlossaryDraft =
  | { status: "running"; jobId: string | null }
  | { status: "done"; jobId: string; terms: GlossaryCandidate[] };

type GlossaryDraftState = {
  drafts: Record<string, GlossaryDraft>;
  /** The paper whose translation dialog is open, so a finished check is shown there instead of announced. */
  openPaperId: string | null;
};

export const useGlossaryDrafts = create<GlossaryDraftState>(() => ({ drafts: {}, openPaperId: null }));

function setDraft(paperId: string, draft: GlossaryDraft | null): void {
  useGlossaryDrafts.setState((state) => {
    const drafts = { ...state.drafts };
    if (draft) drafts[paperId] = draft;
    else delete drafts[paperId];
    return { drafts };
  });
}

export function setGlossaryDialogPaper(paperId: string | null): void {
  useGlossaryDrafts.setState({ openPaperId: paperId });
}

export function isGlossaryDialogOpen(paperId: string | null): boolean {
  return !!paperId && useGlossaryDrafts.getState().openPaperId === paperId;
}

/**
 * Record how the check ended (from its watcher, or from translationJobs, which runs first) and
 * tell whether its candidates now wait for the dialog. A job other than the paper's current check changes nothing.
 */
export function finishGlossaryDraft(event: JobFinished<"glossary-draft">): boolean {
  const paperId = event.paper_id;
  if (!paperId) return false;
  const current = useGlossaryDrafts.getState().drafts[paperId];
  // A null jobId: the job ended before its start request returned.
  if (current?.status === "running" && (current.jobId === null || current.jobId === event.job_id)) {
    setDraft(paperId, event.status === "succeeded"
      ? { status: "done", jobId: event.job_id, terms: event.result.terms } : null);
  }
  const draft = useGlossaryDrafts.getState().drafts[paperId];
  return draft?.status === "done" && draft.jobId === event.job_id;
}

/**
 * Ask the AI for this paper's unregistered terms. The job goes on when the dialog closes; its
 * candidates wait here until the dialog shows them (translationJobs announces a finished check).
 */
export async function startGlossaryDraft(paperId: string, body: { terms: Term[]; model?: string; effort?: string }): Promise<void> {
  setDraft(paperId, { status: "running", jobId: null });
  try {
    const jobId = await startJob(`/api/papers/${paperId}/glossary-draft`, body, { kind: "glossary-draft", paperId },
      (event) => { finishGlossaryDraft(event); });
    // A fast job may have finished (and run the watcher) already.
    const current = useGlossaryDrafts.getState().drafts[paperId];
    if (current?.status === "running") setDraft(paperId, { status: "running", jobId });
  } catch (error) {
    setDraft(paperId, null);
    throw error;
  }
}

/** The finished check's candidates, handed over once. */
export function takeGlossaryDraft(paperId: string): GlossaryCandidate[] | null {
  const draft = useGlossaryDrafts.getState().drafts[paperId];
  if (draft?.status !== "done") return null;
  setDraft(paperId, null);
  return draft.terms;
}
