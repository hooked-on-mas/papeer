import { startJob } from "@/features/jobs/jobEvents";
import type { JobFinished } from "@/features/jobs/jobHandlers";

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
export function startGlossarySplit(paperId: string, body: { domain: string; model?: string; effort?: string },
  watcher?: (event: JobFinished<"glossary-split">) => void): Promise<string> {
  return startJob(`/api/papers/${paperId}/glossary/split`, body, { kind: "glossary-split", paperId }, watcher);
}
