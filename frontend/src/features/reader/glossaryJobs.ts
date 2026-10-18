import { startJob } from "@/features/jobs/jobEvents";
import type { JobFinished } from "@/features/jobs/jobHandlers";
import { create } from "zustand";

type SplitPreview = { moved: number; terms: Record<string, string>[]; original: Record<string, string>[] };
export const useGlossarySplitPreviews = create<{ previews: Record<string, SplitPreview> }>(() => ({ previews: {} }));

export function rememberSplitPreview(event: JobFinished<"glossary-split">): void {
  if (event.status !== "succeeded" || !event.paper_id || !event.result.terms || !event.result.original || !event.result.moved) return;
  const paperId = event.paper_id;
  const preview = { moved: event.result.moved, terms: event.result.terms, original: event.result.original };
  useGlossarySplitPreviews.setState((s) => ({ previews: { ...s.previews, [paperId]: preview } }));
}

export function takeSplitPreview(paperId: string): SplitPreview | null {
  const preview = useGlossarySplitPreviews.getState().previews[paperId];
  if (!preview) return null;
  useGlossarySplitPreviews.setState((s) => {
    const previews = { ...s.previews }; delete previews[paperId]; return { previews };
  });
  return preview;
}

/**
 * Ask the AI to choose the domain dictionaries this paper uses. The sidecar saves the choice
 * (translationJobs refreshes what shows it), so nothing is kept here; resolves with the job's id.
 * `watcher` hears how the job ended (the failure is not raised anywhere else: translationJobs keeps it quiet).
 */
export function startDomainSelect(paperId: string, body: { model?: string; effort?: string } = {},
  watcher?: (event: JobFinished<"glossary-select">) => void): Promise<string> {
  return startJob(`/api/papers/${paperId}/glossary-domains/select`, body, { kind: "glossary-select", paperId }, watcher);
}

/**
 * Ask the AI to split a dictionary (a domain's name, or 共通) into domain dictionaries by subject. The
 * sidecar saves the result like the choice above; resolves with the job's id. `watcher` as above.
 */
export function startGlossarySplit(paperId: string, body: { domain: string; model?: string; effort?: string; preview?: boolean },
  watcher?: (event: JobFinished<"glossary-split">) => void): Promise<string> {
  return startJob(`/api/papers/${paperId}/glossary/split`, body, { kind: "glossary-split", paperId }, watcher);
}
