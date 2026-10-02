import type { components } from "../../api/schema.d.ts";

export type CitationGraph = components["schemas"]["CitationGraph"];
export type CitationNode = components["schemas"]["CitationNode"];
export type Reference = components["schemas"]["Reference"];

/** Stable bounded graph: neighbours are prioritised, and omitted nodes are counted explicitly. */
export function graphView(graph: CitationGraph, center: string | null, scope: "nearby" | "library", external: boolean, limit = 60) {
  const neighbours = new Set([center]);
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    if (edge.source === center) neighbours.add(edge.target);
    if (edge.target === center) neighbours.add(edge.source);
  }
  const candidates = graph.nodes.filter((node) => (external || node.paper_id || node.id === center)
    && (scope === "library" || neighbours.has(node.id)));
  candidates.sort((a, b) => Number(b.id === center) - Number(a.id === center)
    || Number(neighbours.has(b.id)) - Number(neighbours.has(a.id))
    || (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  const nodes = candidates.slice(0, limit);
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes, edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)), total: candidates.length };
}

/** Concentric rings keep nodes apart without a simulation or continual animation. */
export function graphPositions(nodes: CitationNode[], center: string | null) {
  const positions = new Map<string, { x: number; y: number }>();
  const rest = nodes.filter((node) => node.id !== center);
  if (nodes.some((node) => node.id === center)) positions.set(center!, { x: 500, y: 420 });
  rest.forEach((node, index) => {
    const ring = index < 12 ? 0 : index < 32 ? 1 : 2;
    const start = [0, 12, 32][ring];
    const count = Math.min([12, 20, 28][ring], rest.length - start);
    const angle = (index - start) / count * Math.PI * 2 - Math.PI / 2;
    const radius = [175, 280, 380][ring];
    positions.set(node.id, { x: 500 + Math.cos(angle) * radius, y: 420 + Math.sin(angle) * radius });
  });
  return positions;
}
