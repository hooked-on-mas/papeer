import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { QK } from "@/lib/queryKeys";
import { isRunning, useStore } from "@/store";
import { startJob, requestCancel } from "@/features/jobs/jobEvents";
import { useWebSearchCapability } from "./researchHooks";
import type { MapResult } from "./mapGraph";
import type { MapGroup } from "./mapLayout";
import type { components } from "@/api/schema";

export type GroupDescription = components["schemas"]["MapGroupDescription"];
const membershipKey = (members: string[]) => JSON.stringify([...members].sort());

export function useGroupDescriptions(source: string | null, data: MapResult, groups: MapGroup[], ready: boolean) {
  const client = useQueryClient();
  const capability = useWebSearchCapability();
  const enabled = capability.data?.reference_research_enabled === true;
  const membershipSignature = JSON.stringify(groups.map(g => [...g.members].sort()).sort((a, b) => membershipKey(a).localeCompare(membershipKey(b))));
  const memberships = useMemo(() => JSON.parse(membershipSignature) as string[][], [membershipSignature]);
  const ids = new Set(memberships.flat());
  const evidenceEdges = data.edges.filter(e => e.kind === "citation" && (ids.has(e.source) || ids.has(e.target)));
  const evidenceIds = new Set([...ids, ...evidenceEdges.flatMap(e => [e.source, e.target])]);
  const signature = JSON.stringify([memberships, data.nodes.filter(n => evidenceIds.has(n.id)).map(n => [n.id, n.title, ids.has(n.id) ? n.abstract : ""]).sort(),
    evidenceEdges.map(e => [e.source, e.target]).sort()]);
  const scope = `${source}:${data.origin}:${signature}`;
  const [status, setStatus] = useState({ scope: "", running: false, error: "" });
  const [retry, setRetry] = useState({ scope: "", revision: 0 });
  const revision = retry.scope === scope ? retry.revision : 0;
  const attempted = useRef(new Set<string>());
  const active = useRef<{ alive: boolean; id?: string; key: string } | null>(null);
  const busy = useStore(s => s.activeJobs.some(j => j.paper_id === source && j.kind === "paper-map-groups" && isRunning(j)));
  const queryKey = useMemo(() => [QK.mapGroups, source, data.origin, signature], [source, data.origin, signature]);
  const query = useQuery({ queryKey, enabled: !!source && ready && groups.length > 0,
    queryFn: ({ signal }) => unwrap(api.GET("/api/papers/{paper_id}/discovery/groups", {
      params: { path: { paper_id: source! }, query: { origin: data.origin } }, signal })), staleTime: 30_000 });
  const descriptions = Object.fromEntries(groups.flatMap(g => {
    const found = query.data?.groups.find(item => membershipKey(item.members) === membershipKey(g.members));
    return found ? [[g.id, found]] : [];
  })) as Record<string, GroupDescription>;
  const missing = groups.some(g => !descriptions[g.id] || descriptions[g.id].stale);
  useEffect(() => () => {
    const request = active.current;
    if (request?.alive) { attempted.current.delete(request.key); request.alive = false; if (request.id) void requestCancel(request.id).catch(() => {}); }
    active.current = null;
  }, [source, scope, enabled, ready]);
  useEffect(() => {
    const key = `${scope}:${query.data?.connection}:${revision}`;
    if (!source || !ready || !enabled || !query.isSuccess || !groups.length || (!missing && !revision)
      || busy || active.current?.alive || attempted.current.has(key)) return;
    // Debounce changing filters/counts. External discovery settles before any model request starts.
    const timer = setTimeout(() => {
      attempted.current.add(key);
      const request: { alive: boolean; id?: string; key: string } = { alive: true, key }; active.current = request;
      setStatus({ scope, running: true, error: "" });
      void startJob(`/api/papers/${source}/discovery/groups`, { origin: data.origin, groups: memberships, force: revision > 0 },
        { kind: "paper-map-groups", paperId: source }, event => {
          if (event.status === "succeeded") client.setQueryData(queryKey, event.result);
          if (!request.alive) return;
          request.alive = false;
          setStatus({ scope, running: false, error: event.status === "failed" ? event.error || "グループを説明できませんでした。" : "" });
        }).then(id => { request.id = id; if (!request.alive) void requestCancel(id).catch(() => {}); })
        .catch(e => { if (request.alive) { request.alive = false; setStatus({ scope, running: false, error: String(e) }); } });
    }, 800);
    return () => clearTimeout(timer);
  }, [source, ready, enabled, query.isSuccess, query.data?.connection, groups.length, missing, busy, scope, revision, client, data.origin, memberships, queryKey]);
  return { descriptions, enabled, running: status.scope === scope && status.running,
    error: status.scope === scope ? status.error : query.isError ? query.error.message : "",
    retry: () => { void query.refetch(); setRetry({ scope, revision: revision + 1 }); } };
}
