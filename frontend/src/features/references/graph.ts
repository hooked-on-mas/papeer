import type { components } from "../../api/schema.d.ts";

export type CitationGraph = components["schemas"]["CitationGraph"];
export type CitationNode = components["schemas"]["CitationNode"];
export type Reference = components["schemas"]["Reference"];

export type RelatedPaper = { node: CitationNode; sharedReferences: number; sharedCitations: number; score: number };

/** Counts distinct citing papers, never bibliography rows or repeated mentions. */
export function citationIndex(graph: CitationGraph) {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const { source, target } of graph.edges) {
    if (source === target) continue;
    if (!outgoing.has(source)) outgoing.set(source, new Set());
    if (!incoming.has(target)) incoming.set(target, new Set());
    outgoing.get(source)!.add(target);
    incoming.get(target)!.add(source);
  }
  return { outgoing, incoming };
}

function overlap(a?: Set<string>, b?: Set<string>) {
  if (!a || !b) return 0;
  return [...a].filter(id => b.has(id)).length;
}

/** Bibliographic coupling and co-citation within the available library, not a global similarity claim. */
export function relatedPapers(graph: CitationGraph, center: string | null): RelatedPaper[] {
  if (!center) return [];
  const { outgoing, incoming } = citationIndex(graph);
  return graph.nodes.filter(node => node.id !== center).map(node => {
    const sharedReferences = overlap(outgoing.get(center), outgoing.get(node.id));
    const sharedCitations = overlap(incoming.get(center), incoming.get(node.id));
    const normalized = (map: Map<string, Set<string>>, shared: number) => shared
      / Math.sqrt((map.get(center)?.size ?? 1) * (map.get(node.id)?.size ?? 1));
    return { node, sharedReferences, sharedCitations,
      score: Math.max(normalized(outgoing, sharedReferences), normalized(incoming, sharedCitations)) };
  }).filter(item => item.sharedReferences + item.sharedCitations > 0)
    .sort((a, b) => b.score - a.score || b.sharedReferences + b.sharedCitations - a.sharedReferences - a.sharedCitations
      || a.node.id.localeCompare(b.node.id));
}

export function similarityView(graph: CitationGraph, center: string | null, external: boolean, limit = 60) {
  const related = relatedPapers(graph, center).filter(item => external || item.node.paper_id);
  const origin = graph.nodes.find(node => node.id === center);
  const nodes = [...(origin ? [origin] : []), ...related.map(item => item.node)].slice(0, limit);
  const ids = new Set(nodes.map(node => node.id));
  const edges: { source: string; target: string; weight: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (const item of relatedPapers(graph, nodes[i].id)) {
      if (ids.has(item.node.id) && nodes.findIndex(node => node.id === item.node.id) > i)
        edges.push({ source: nodes[i].id, target: item.node.id, weight: item.score });
    }
  }
  return { nodes, edges, total: related.length + Number(!!origin) };
}

/** A deterministic, bounded force layout; computes once rather than animating while reading. */
export function similarityPositions(nodes: CitationNode[], center: string | null, edges: { source: string; target: string; weight: number }[]) {
  const positions = graphPositions(nodes, center);
  for (let step = 0; step < 160; step++) {
    const forces = new Map(nodes.map(node => [node.id, { x: 0, y: 0 }]));
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = positions.get(nodes[i].id)!, b = positions.get(nodes[j].id)!;
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
      const force = 5000 / (distance * distance);
      const fa = forces.get(nodes[i].id)!, fb = forces.get(nodes[j].id)!;
      fa.x -= dx / distance * force; fa.y -= dy / distance * force;
      fb.x += dx / distance * force; fb.y += dy / distance * force;
    }
    for (const edge of edges) {
      const a = positions.get(edge.source)!, b = positions.get(edge.target)!;
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - (220 - 100 * edge.weight)) * 0.015 * edge.weight;
      const fa = forces.get(edge.source)!, fb = forces.get(edge.target)!;
      fa.x += dx / distance * force; fa.y += dy / distance * force;
      fb.x -= dx / distance * force; fb.y -= dy / distance * force;
    }
    for (const node of nodes) {
      if (node.id === center) continue;
      const point = positions.get(node.id)!, force = forces.get(node.id)!;
      point.x += Math.max(-5, Math.min(5, force.x + (500 - point.x) * 0.001));
      point.y += Math.max(-5, Math.min(5, force.y + (420 - point.y) * 0.001));
    }
  }
  return positions;
}

export function publicationYear(value: string): number | null {
  return /^\d{4}$/.test(value) ? Number(value) : null;
}

export function yearColor(year: string, nodes: CitationNode[]) {
  const years = nodes.map(node => publicationYear(node.year)).filter((value): value is number => value !== null);
  const value = publicationYear(year);
  if (value === null || !years.length) return "var(--muted)";
  const min = Math.min(...years), max = Math.max(...years);
  const ratio = max === min ? 0.5 : (value - min) / (max - min);
  return `oklch(${0.87 - ratio * 0.25} ${0.04 + ratio * 0.10} 245)`;
}

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
