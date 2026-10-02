import type { components } from "@/api/schema";
import { relatedPapers, citationIndex, type CitationGraph } from "./graph.ts";

export type MapResult = components["schemas"]["DiscoveryResult"];
export type MapNode = MapResult["nodes"][number];
export type MapEdge = MapResult["edges"][number];
export const externalCitationSource = (node: MapNode): string =>
  (node.external_id || node.id).includes("openalex.org/") ? "OpenAlex（保存済み）" : "Semantic Scholar";
export const externalCitationSources = (nodes: MapNode[]): string => [...new Set(nodes
  .filter(n => n.external_citations !== null).map(externalCitationSource))].join("・");
export type MapMode = "nearby" | "references" | "incoming" | "related" | "prior" | "following";
export type SavedMapView = {
  origin: string; selected: string | null; selectionKey?: string; mode: MapMode; filter: "all" | "registered" | "external";
  search: string; sort: "relevance" | "newest" | "cited"; listScroll: number;
  camera: Camera; positions: Record<string, Point>; layoutKey?: string; details: boolean; paneScroll?: number; diagramLimit?: "auto" | "20" | "40" | "60";
};
export type Point = { x: number; y: number };
export type Camera = { x: number; y: number; zoom: number; fitted?: boolean; manual?: boolean };
export const newView = (origin: string): SavedMapView => ({ origin, selected: null, mode: "nearby", filter: "all",
  search: "", sort: "relevance", listScroll: 0, camera: { x: 0, y: 0, zoom: 1 }, positions: {}, details: false, diagramLimit: "auto" });
export const mapViews = new Map<string, { view: SavedMapView; trail: SavedMapView[] }>();

/** A useful local graph appears before the richer backend result or while disconnected. */
export function localMap(graph: CitationGraph, origin: string): MapResult {
  const related = relatedPapers(graph, origin);
  const counts = citationIndex(graph);
  const direct = counts.outgoing.get(origin) ?? new Set<string>();
  const secondHop = new Map(graph.nodes.map(n => [n.id, [...(counts.incoming.get(n.id) ?? [])].filter(id => direct.has(id)).length]));
  const neighborhood = new Set([origin, ...direct, ...related.slice(0, 20).map(r => r.node.id),
    ...graph.nodes.filter(n => (secondHop.get(n.id) ?? 0) >= 2).map(n => n.id)]);
  return { origin, checked_at: "", stale: true, references: graph.references.filter(r => r.source === origin), warnings: graph.warnings.map(w => w.message), coverage: "ライブラリ内で確認できた関係",
    nodes: graph.nodes.map(n => {
      const ref = graph.references.find(r => r.target === n.id && r.source === origin);
      const relationship = related.find(r => r.node.id === n.id);
      const uncertain = ref?.citation_status === "unverified";
      const support = secondHop.get(n.id) ?? 0;
      const prior = [...(counts.incoming.get(n.id) ?? [])].filter(id => neighborhood.has(id)).length;
      const following = [...(counts.outgoing.get(n.id) ?? [])].filter(id => neighborhood.has(id)).length;
      const roles: MapNode["roles"] = [];
      if (counts.outgoing.get(origin)?.has(n.id)) roles.push("references");
      if (counts.incoming.get(origin)?.has(n.id)) roles.push("incoming");
      if (relationship || support >= 2 || uncertain) roles.push("related");
      if (prior >= 2 && n.id !== origin) roles.push("prior");
      if (following >= 2 && n.id !== origin) roles.push("following");
      return { ...n, roles, reasons: [direct.has(n.id) ? "直接引用" : "", relationship ? `共通の引用情報 ${relationship.sharedReferences + relationship.sharedCitations}件` : "",
        support >= 2 ? `直接の参考文献のうち${support}件が引用` : "", prior >= 2 ? `周辺の${prior}論文から引用` : "",
        uncertain ? "Semantic Scholarの参考文献候補（PDF・Crossrefで未確認）" : ""].filter(Boolean),
        score: support >= 2 ? 1 + support : relationship ? 1 + relationship.score : 0, doi: ref?.doi ?? "", arxiv_id: ref?.arxiv_id ?? "", first_author: "", abstract: "",
        external_id: "", external_citations: null, local_citations: counts.incoming.get(n.id)?.size ?? 0,
        prior_count: prior, following_count: following, reference_id: ref?.id ?? null, research_key: ref?.research_key ?? "", provenance: [], acquired_at: "" };
    }), edges: [...graph.edges.map(e => ({ ...e, kind: "citation" as const, provenance: "library" })),
      ...graph.references.filter(r => r.source === origin && r.citation_status === "unverified" && r.target !== origin)
        .map(r => ({ source: origin, target: r.target, kind: "candidate" as const, provenance: "Semantic Scholar（未照合）" }))] };
}

export function mapRows(data: MapResult, view: SavedMapView) {
  const query = view.search.toLocaleLowerCase();
  return data.nodes.filter(n => n.id !== data.origin && (view.mode === "nearby" ?
    n.roles.some(r => ["references", "incoming", "related"].includes(r)) : n.roles.includes(view.mode)))
    .filter(n => view.filter === "all" || (view.filter === "registered" ? !!n.paper_id : !n.paper_id))
    .filter(n => `${n.title} ${n.first_author} ${n.doi} ${n.arxiv_id}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => {
      if (view.sort === "newest") return Number(b.year || 0) - Number(a.year || 0) || a.id.localeCompare(b.id);
      // Use one scope consistently; global counts are displayed separately rather than mixed into sorting.
      if (view.sort === "cited") return b.local_citations - a.local_citations || a.id.localeCompare(b.id);
      if (view.mode === "prior") return b.prior_count - a.prior_count || a.id.localeCompare(b.id);
      if (view.mode === "following") return b.following_count - a.following_count || Number(b.year || 0) - Number(a.year || 0) || a.id.localeCompare(b.id);
      return (view.mode === "nearby" ? Number(b.roles.includes("references")) - Number(a.roles.includes("references")) : 0)
        || b.score - a.score || a.id.localeCompare(b.id);
    });
}

/** Reserve room for related work while keeping the origin and selected paper visible. */
export function mapWindow(data: MapResult, rows: MapNode[], view: SavedMapView, limit = 60) {
  const pinned = data.nodes.filter(n => n.id === data.origin || n.id === view.selected);
  const room = Math.max(0, limit - pinned.length);
  const candidates = rows.filter(n => !pinned.some(p => p.id === n.id));
  let chosen = candidates;
  if (view.mode === "nearby") {
    const similar = candidates.filter(n => n.roles.includes("related") && !n.roles.includes("references"))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, Math.min(15, Math.ceil(room / 3)));
    const anchors = new Set([...similar.map(n => n.id), ...pinned.filter(n => n.id !== data.origin).map(n => n.id)]);
    const connections = new Map<string, number>();
    const selectionLinks = new Set(data.edges.filter(e => e.kind === "citation" &&
      (e.source === view.selected || e.target === view.selected)).flatMap(e => [e.source, e.target]));
    for (const e of data.edges) {
      if (e.kind !== "citation") continue;
      if (anchors.has(e.target)) connections.set(e.source, (connections.get(e.source) ?? 0) + 1);
      if (anchors.has(e.source)) connections.set(e.target, (connections.get(e.target) ?? 0) + 1);
    }
    const rest = candidates.filter(n => !similar.includes(n)).sort((a, b) =>
      Number(b.roles.includes("references")) - Number(a.roles.includes("references"))
      || Number(selectionLinks.has(b.id)) - Number(selectionLinks.has(a.id))
      || b.score - a.score || a.id.localeCompare(b.id));
    // Keep topic-relevant direct references as well as the real connectors to peers.
    // Generic foundations with many connections no longer consume every direct slot.
    const directRoom = room - similar.length;
    const connected = rest.filter(n => (connections.get(n.id) ?? 0) > 0).sort((a, b) =>
      Number(selectionLinks.has(b.id)) - Number(selectionLinks.has(a.id))
      || (connections.get(b.id) ?? 0) - (connections.get(a.id) ?? 0) || b.score - a.score);
    const bridges = connected.slice(0, Math.min(directRoom, Math.max(2, Math.floor(directRoom / 3))));
    const directPapers = rest.filter(n => !bridges.includes(n)).slice(0, directRoom - bridges.length);
    chosen = [...bridges, ...directPapers, ...similar, ...rest.filter(n => !bridges.includes(n) && !directPapers.includes(n))];
  }
  // Other modes still show the bibliography nodes that connect the chosen work
  // to the origin. These context nodes are not extra rows in the filtered list.
  const targets = new Set([...pinned, ...chosen.slice(0, room)].map(n => n.id));
  const direct = new Set(data.edges.filter(e => e.kind === "citation" && e.source === data.origin).map(e => e.target));
  const connectorEdges = data.edges.filter(e => e.kind === "citation" && e.source !== data.origin && e.target !== data.origin &&
    (direct.has(e.source) && targets.has(e.target) || direct.has(e.target) && targets.has(e.source)));
  const connectors = new Set(connectorEdges.flatMap(e => [e.source, e.target]).filter(id => direct.has(id) && !targets.has(id)));
  const targetOrder = new Map([...(view.selected ? [view.selected] : []), ...chosen.map(n => n.id)].map((id, i) => [id, i]));
  const priority = (id: string) => Math.min(...connectorEdges.filter(e => e.source === id || e.target === id)
    .map(e => targetOrder.get(e.source === id ? e.target : e.source) ?? Number.MAX_SAFE_INTEGER));
  const contextRoom = Math.max(0, room - Math.min(chosen.length, Math.ceil(room / 3)));
  const context = view.mode === "nearby" || view.mode === "references" ? [] : data.nodes.filter(n => connectors.has(n.id)
    && (view.filter === "all" || (view.filter === "registered" ? !!n.paper_id : !n.paper_id)))
    .sort((a, b) => priority(a.id) - priority(b.id) || a.id.localeCompare(b.id)).slice(0, contextRoom);
  const nodes = [...pinned, ...chosen.slice(0, room - context.length), ...context];
  const ids = new Set(nodes.map(n => n.id));
  return { nodes, edges: data.edges.filter(e => ids.has(e.source) && ids.has(e.target)),
    omitted: rows.filter(n => !ids.has(n.id)).length, context: context.length };
}

export { mapPositions } from "./mapLayout.ts";
