import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isRunning, useStore } from "@/store";
import { QK } from "@/lib/queryKeys";
import { startJob, requestCancel } from "@/features/jobs/jobEvents";
import { useConnection } from "@/features/jobs/connection";
import type { Reference } from "./graph";
import { useResearch, useWebSearchCapability, type ResearchRecord } from "./researchHooks";

export const AUTO_RESEARCH_CONCURRENCY = 5;
type Active = { token: symbol; attempt: string; source: string; key: string; title: string; jobId?: string; stopping?: boolean };
type State = { enabled: boolean; active: Active[]; attempted: Set<string>; error: string; failedAttempts: Set<string> };

/** Persist only the explicit opt-in. A single queue is shared across pane remounts. */
export const useAutoResearch = create<State>()(persist((): State => ({
  enabled: false, active: [], attempted: new Set<string>(), error: "", failedAttempts: new Set<string>(),
}), { name: "papeer-auto-reference-research", partialize: state => ({ enabled: state.enabled }) }));

export function researchComplete(record: ResearchRecord) {
  return !!record.summary || record.sources.length > 0 || record.basis === "unresolved";
}

async function stopActive(active: Active) {
  if (!active.jobId) return; // The POST can still be in flight; its response will cancel it.
  try { await requestCancel(active.jobId); }
  catch (error) {
    useAutoResearch.setState({ error: `新しい収集は停止しました。実行中の収集を中止できませんでした：${error instanceof Error ? error.message : String(error)}` });
  }
}

export function setAutoResearch(enabled: boolean) {
  const state = useAutoResearch.getState();
  const attempted = new Set(state.attempted);
  if (enabled) state.failedAttempts.forEach(attempt => attempted.delete(attempt));
  const active = !enabled ? state.active.map(item => ({ ...item, stopping: true })) : state.active;
  useAutoResearch.setState({ enabled, active, attempted, error: "", failedAttempts: new Set<string>() });
  if (!enabled) active.forEach(item => { void stopActive(item); });
}

export function useAutomaticResearch(source: string | null, references: Reference[], selectedKey?: string) {
  const queryClient = useQueryClient();
  const state = useAutoResearch();
  const research = useResearch(source);
  const capability = useWebSearchCapability();
  const connected = useConnection(s => s.connected);
  const busy = useStore(s => s.activeJobs.some(job => isRunning(job) && job.paper_id === source
    && !state.active.some(item => item.jobId === job.job_id)));
  const records = research.data ?? [];
  const unique = [...new Map(references.map(ref => [ref.research_key, ref])).values()];
  const completed = new Set(records.filter(researchComplete).map(record => record.key));
  const candidates = unique.filter(ref => ref.research_key && !completed.has(ref.research_key));
  const ready = !!source && /^[0-9a-f]{32}$/.test(source) && connected && !busy && research.isSuccess
    && !research.isFetching && capability.data?.web_search === true;

  useEffect(() => {
    // Recheck shared state at dispatch time so StrictMode and two mounted panes cannot duplicate work.
    const current = useAutoResearch.getState();
    if (!ready || !source || !current.enabled || current.error) return;
    const next = candidates.filter(ref => !current.attempted.has(`${source}:${ref.research_key}`))
      .sort((a, b) => Number(b.research_key === selectedKey) - Number(a.research_key === selectedKey))
      .slice(0, Math.max(0, AUTO_RESEARCH_CONCURRENCY - current.active.length));
    if (!next.length) return;
    const reserved = next.map(ref => ({ token: Symbol(), attempt: `${source}:${ref.research_key}`, source,
      key: ref.research_key, title: ref.title || ref.raw }));
    // Reserve every slot before sending requests, including requests waiting for their job IDs.
    useAutoResearch.setState({ active: [...current.active, ...reserved],
      attempted: new Set([...current.attempted, ...reserved.map(item => item.attempt)]) });
    next.forEach((ref, index) => {
      const { token, attempt } = reserved[index];
      const fail = (error: string) => useAutoResearch.setState(latest => ({
        active: latest.active.filter(item => item.token !== token), error,
        failedAttempts: new Set([...latest.failedAttempts, attempt]),
      }));
      void startJob(`/api/papers/${source}/reference-research`, { reference_id: ref.id },
      { kind: "reference-research", paperId: source }, event => {
        const latest = useAutoResearch.getState();
        const running = latest.active.find(item => item.token === token);
        if (!running) return;
        const remaining = latest.active.filter(item => item.token !== token);
        if (event.status === "succeeded") {
          // Update the cache before releasing the queue, including after a pane was closed.
          queryClient.setQueryData<ResearchRecord[]>([QK.research, source], old =>
            [...(old ?? []).filter(record => record.key !== event.result.key), event.result]);
          useAutoResearch.setState({ active: remaining });
        } else if (event.status === "cancelled") {
          const attempted = new Set(latest.attempted); attempted.delete(attempt);
          useAutoResearch.setState({ active: remaining, attempted });
          if (!running.stopping) setAutoResearch(false);
        } else {
          fail(event.error || "情報を取得できませんでした。");
        }
      }).then(jobId => {
        const latest = useAutoResearch.getState();
        const running = latest.active.find(item => item.token === token);
        if (!running) return;
        const active = { ...running, jobId };
        useAutoResearch.setState({ active: latest.active.map(item => item.token === token ? active : item) });
        if (!latest.enabled || active.stopping) void stopActive(active);
      }).catch(error => {
        if (useAutoResearch.getState().active.some(item => item.token === token))
          fail(error instanceof Error ? error.message : String(error));
      });
    });
  }, [ready, source, candidates, selectedKey, state.enabled, state.active, state.error, state.attempted, queryClient]);

  return { ...state, available: capability.data?.web_search === true, capabilityError: capability.isError,
    loadError: research.error, connected, completed: unique.filter(ref => completed.has(ref.research_key)).length,
    total: unique.length, busy };
}
