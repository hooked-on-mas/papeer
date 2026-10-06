import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QK } from "@/lib/queryKeys";
import { isRunning, useStore } from "@/store";
import { api, unwrap } from "@/api/client";
import { startJob, requestCancel } from "@/features/jobs/jobEvents";
import { useWebSearchCapability } from "./researchHooks";
import type { MapResult } from "./mapGraph";

export function useDiscovery(source: string | null, origin: string) {
  const client = useQueryClient();
  const capability = useWebSearchCapability();
  const enabled = capability.data?.paper_discovery_enabled === true;
  const [status, setStatus] = useState({ scope: "", running: false, error: "" });
  const [retry, setRetry] = useState({ scope: "", revision: 0 });
  const attempted = useRef(new Set<string>());
  const active = useRef<{ alive: boolean; id?: string; key: string; automaticKey: string } | null>(null);
  const scope = `${source}:${origin}`;
  const revision = retry.scope === scope ? retry.revision : 0;
  const running = status.scope === scope && status.running;
  const busy = useStore(s => s.activeJobs.some(j => j.paper_id === source && j.kind === "paper-discovery" && isRunning(j)));
  const query = useQuery({
    queryKey: [QK.discovery, source, origin], enabled: !!source,
    queryFn: ({ signal }) => unwrap(api.GET("/api/papers/{paper_id}/discovery", {
      params: { path: { paper_id: source! }, query: { origin } }, signal })),
    refetchInterval: running ? 1500 : false,
  });
  useEffect(() => () => {
    const request = active.current;
    if (request?.alive) {
      attempted.current.delete(request.key); attempted.current.delete(request.automaticKey);
      request.alive = false; if (request.id) void requestCancel(request.id).catch(() => {});
    }
    active.current = null;
  }, [source, origin, enabled]);
  const stale = query.data?.stale === true;
  const originNode = query.data?.nodes.find(n => n.id === query.data?.origin);
  const identity = originNode?.doi || originNode?.arxiv_id || originNode?.title || "";
  const manualKey = `${scope}:retry:${revision}`, automaticKey = `${scope}:auto:${identity}`;
  const manual = revision > 0 && !attempted.current.has(manualKey);
  const pending = enabled && (manual || stale && !attempted.current.has(automaticKey));
  // Include queued and restored jobs so partial citation evidence cannot briefly form groups.
  const settled = (query.isSuccess || query.isError) && (capability.isSuccess || capability.isError)
    && !query.isFetching && !running && !busy && !pending;
  useEffect(() => {
    if (!source || !enabled || (!stale && !manual) || active.current?.alive || busy) return;
    const key = manual ? manualKey : automaticKey;
    if (attempted.current.has(key)) return;
    const timer = setTimeout(() => {
      attempted.current.add(key);
      attempted.current.add(automaticKey);
      const request: { alive: boolean; id?: string; key: string; automaticKey: string } = { alive: true, key, automaticKey }; active.current = request;
      setStatus({ scope, running: true, error: "" });
      void startJob(`/api/papers/${source}/discovery`, { origin, force: manual }, { kind: "paper-discovery", paperId: source }, event => {
        if (event.status === "succeeded") client.setQueryData<MapResult>([QK.discovery, source, origin], event.result);
        if (!request.alive) return;
        request.alive = false;
        setStatus({ scope, running: false, error: event.status === "failed" ? event.error || "外部情報を取得できませんでした。" : "" });
        void client.invalidateQueries({ queryKey: [QK.discovery, source, origin] });
        void client.invalidateQueries({ queryKey: [QK.citations] });
      }).then(id => {
        request.id = id;
        if (!request.alive) void requestCancel(id).catch(() => {});
      }).catch(e => {
        if (request.alive) { request.alive = false; setStatus({ scope, running: false, error: String(e) }); }
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [source, origin, enabled, stale, revision, client, scope, busy, identity, manualKey, automaticKey, manual]);
  return { ...query, running, settled, error: status.scope === scope ? status.error : "", enabled, refresh: () => {
    void query.refetch(); if (!running) setRetry({ scope, revision: revision + 1 });
  } };
}
