import type { Camera, MapEdge, MapNode, Point } from "./mapGraph.ts";

export type CitationScope = "external" | "local";
export type MapGroup = { id: string; label: string; color: string; members: string[]; representative: string };
export const citationScope = (nodes: MapNode[]): CitationScope => nodes.some(n => n.external_citations !== null && Number.isFinite(n.external_citations) && n.external_citations >= 0) ? "external" : "local";
export const citationCount = (node: MapNode, scope: CitationScope): number | null => {
  const value = scope === "external" ? node.external_citations : node.local_citations;
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
};
/** Logarithmic area keeps highly cited papers legible without letting one circle fill the map. */
export const nodeRadius = (node: MapNode, scope: CitationScope) => Math.min(34, Math.sqrt(121 + 220 * Math.log10(1 + (citationCount(node, scope) ?? 0))));

/** Bibliographic updates can change community membership and circle sizes after coordinates were saved. */
export function reconcileMapLayout(nodes: MapNode[], origin: string, saved: Record<string, Point>, edges: MapEdge[], groups: MapGroup[], previousKey?: string) {
  const scope = citationScope(nodes);
  const key = JSON.stringify([2, nodes.map(n => [n.id, nodeRadius(n, scope).toFixed(2)]).sort(),
    groups.map(g => [...g.members].sort()).sort()]);
  const appended = mapPositions(nodes, origin, saved, edges, groups);
  let reflowed = false;
  if (key !== previousKey && Object.keys(saved).length) {
    const radii = new Map(nodes.map(n => [n.id, nodeRadius(n, scope) * 1.8]));
    const collisions = nodes.some((a, i) => nodes.slice(i + 1).some(b => Math.hypot(appended[a.id].x - appended[b.id].x,
      appended[a.id].y - appended[b.id].y) < radii.get(a.id)! + radii.get(b.id)! + 24));
    const grouped = new Set(groups.flatMap(g => g.members));
    const units = [...groups.map(g => g.members), ...nodes.filter(n => !grouped.has(n.id)).map(n => [n.id])];
    const boxes = units.map(ids => ({ left: Math.min(...ids.map(id => appended[id].x - radii.get(id)! - 28)),
      right: Math.max(...ids.map(id => appended[id].x + radii.get(id)! + 28)),
      top: Math.min(...ids.map(id => appended[id].y - radii.get(id)! - 58)),
      bottom: Math.max(...ids.map(id => appended[id].y + radii.get(id)! + 28)) }));
    const crossing = boxes.some((a, i) => boxes.slice(i + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
    reflowed = collisions || crossing;
  }
  return { key, reflowed, positions: reflowed ? mapPositions(nodes, origin, {}, edges, groups) : appended };
}

export function frameMap(nodes: MapNode[], positions: Record<string, Point>, width: number, height: number): Camera {
  const points = nodes.map(n => positions[n.id]).filter(Boolean);
  if (!points.length) return { x: 0, y: 0, zoom: 1, fitted: false };
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  const zoom = Math.max(.01, Math.min(1.4, Math.max(80, width - 140) / Math.max(1, maxX - minX), Math.max(80, height - 130) / Math.max(1, maxY - minY)));
  return { zoom, x: -(minX + maxX) / 2 * zoom, y: -(minY + maxY) / 2 * zoom + 8, fitted: true };
}

/** Communities use citation evidence, excluding the universal connection through the origin. */
export function mapGroups(nodes: MapNode[], edges: MapEdge[], origin: string): MapGroup[] {
  const peers = nodes.filter(n => n.id !== origin).sort((a, b) => a.id.localeCompare(b.id));
  const visible = new Set(peers.map(n => n.id));
  const outgoing = new Map(peers.map(n => [n.id, new Set<string>()]));
  const incoming = new Map(peers.map(n => [n.id, new Set<string>()]));
  for (const edge of edges) {
    if (edge.kind !== "citation" || edge.source === origin || edge.target === origin || edge.source === edge.target) continue;
    outgoing.get(edge.source)?.add(edge.target);
    incoming.get(edge.target)?.add(edge.source);
  }
  const weights = new Map<string, Map<string, number>>(peers.map(n => [n.id, new Map()]));
  const degree = new Map(peers.map(n => [n.id, 0]));
  let total = 0;
  const shared = (a: Set<string>, b: Set<string>) => [...a].filter(key => b.has(key)).length;
  for (let i = 0; i < peers.length; i++) for (let j = i + 1; j < peers.length; j++) {
    const a = peers[i].id, b = peers[j].id, outA = outgoing.get(a)!, outB = outgoing.get(b)!;
    const inA = incoming.get(a)!, inB = incoming.get(b)!;
    const references = shared(outA, outB), citers = shared(inA, inB);
    const weight = (outA.has(b) || outB.has(a) ? 1 : 0)
      + (references >= 2 ? 2 * references / Math.sqrt(outA.size * outB.size) : 0)
      + (citers >= 2 ? 2 * citers / Math.sqrt(inA.size * inB.size) : 0);
    if (!weight) continue;
    weights.get(a)!.set(b, weight); weights.get(b)!.set(a, weight);
    degree.set(a, degree.get(a)! + weight); degree.set(b, degree.get(b)! + weight); total += weight;
  }
  if (!total) return [];
  const communities = new Map(peers.filter(n => degree.get(n.id)! > 0).map(n => [n.id, [n.id]]));
  // Deterministic greedy modularity: weak bridges can join communities without collapsing them into one.
  while (communities.size > 1) {
    let best = 1e-9, pair: [string, string] | null = null;
    const ids = [...communities.keys()].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j], between = weights.get(a)?.get(b) ?? 0;
      if (!between) continue;
      const gain = between / total - 1.15 * degree.get(a)! * degree.get(b)! / (2 * total * total);
      if (gain > best) { best = gain; pair = [a, b]; }
    }
    if (!pair) break;
    const [a, b] = pair;
    communities.set(a, [...communities.get(a)!, ...communities.get(b)!]); communities.delete(b);
    degree.set(a, degree.get(a)! + degree.get(b)!);
    for (const key of communities.keys()) {
      if (key === a) continue;
      const value = (weights.get(a)?.get(key) ?? 0) + (weights.get(b)?.get(key) ?? 0);
      weights.get(a)!.set(key, value); weights.get(key)!.set(a, value); weights.get(key)!.delete(b);
    }
    weights.get(a)!.delete(b); weights.delete(b);
  }
  const metadata = new Map(peers.map(n => [n.id, n]));
  return [...communities.entries()].filter(([, members]) => members.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([id, members], i) => {
      members.sort();
      const representative = [...members].sort((a, b) => metadata.get(b)!.prior_count - metadata.get(a)!.prior_count
        || (metadata.get(b)!.external_citations ?? metadata.get(b)!.local_citations) - (metadata.get(a)!.external_citations ?? metadata.get(a)!.local_citations)
        || a.localeCompare(b))[0];
      return { id, members: members.filter(key => visible.has(key)), label: `グループ ${i + 1}`, color: `var(--map-group-${i % 8 + 1})`, representative: metadata.get(representative)!.title };
    });
}

/** Only new nodes move. Full redistribution is an explicit user action. */
export function mapPositions(nodes: MapNode[], origin: string, saved: Record<string, Point>, edges: MapEdge[] = [], groups = mapGroups(nodes, edges, origin)): Record<string, Point> {
  const positions = { ...saved };
  positions[origin] ??= { x: 0, y: 0 };
  const movable = new Set(nodes.filter(n => !positions[n.id]).map(n => n.id));
  if (!movable.size) return positions;
  const scope = citationScope(nodes), radius = new Map(nodes.map(n => [n.id, nodeRadius(n, scope) * 1.8]));
  const membership = new Map(groups.flatMap(group => group.members.map(id => [id, group.id] as const)));
  const centers = new Map<string, Point>();
  const extent = new Map(groups.map(g => [g.id, 80 + Math.sqrt(g.members.length) * 60]));
  groups.forEach((group, i) => {
    const pinned = group.members.filter(id => saved[id]);
    const angle = -Math.PI / 2 + i * 2.3999632297, distance = extent.get(group.id)! + 160;
    centers.set(group.id, pinned.length ? { x: pinned.reduce((sum, id) => sum + saved[id].x, 0) / pinned.length,
      y: pinned.reduce((sum, id) => sum + saved[id].y, 0) / pinned.length } : { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance });
  });
  if (!Object.keys(saved).length) for (let pass = 0; pass < 70; pass++) {
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = centers.get(groups[i].id)!, b = centers.get(groups[j].id)!;
      const dx = b.x - a.x || .01, dy = b.y - a.y || .01, distance = Math.hypot(dx, dy);
      const overlap = extent.get(groups[i].id)! + extent.get(groups[j].id)! + 95 - distance;
      if (overlap <= 0) continue;
      a.x -= dx / distance * overlap / 2; a.y -= dy / distance * overlap / 2;
      b.x += dx / distance * overlap / 2; b.y += dy / distance * overlap / 2;
    }
  }
  const visible = new Set(nodes.map(n => n.id)), links = edges.filter(e => visible.has(e.source) && visible.has(e.target));
  const anchors = new Map<string, Point>();
  let loose = 0;
  for (const node of nodes) {
    if (!movable.has(node.id)) continue;
    const group = membership.get(node.id), center = group ? centers.get(group)! : undefined;
    const siblings = group ? groups.find(g => g.id === group)!.members : [];
    const index = group ? siblings.filter(id => id !== origin).indexOf(node.id) : loose++;
    const angle = index * 2.3999632297, distance = group ? 65 + Math.sqrt(index) * 57 : 360 + Math.sqrt(index) * 75;
    const neighbors = links.filter(e => e.source === node.id || e.target === node.id)
      .map(e => e.source === node.id ? e.target : e.source).filter(id => id !== origin && saved[id]);
    const anchor = neighbors.length ? { x: neighbors.reduce((sum, id) => sum + saved[id].x, 0) / neighbors.length,
      y: neighbors.reduce((sum, id) => sum + saved[id].y, 0) / neighbors.length } : center ?? { x: 0, y: 0 };
    anchors.set(node.id, anchor);
    const spread = neighbors.length ? 55 : distance;
    positions[node.id] = { x: anchor.x + Math.cos(angle) * spread, y: anchor.y + Math.sin(angle) * spread };
  }
  for (let step = 0; step < 230; step++) {
    const forces = Object.fromEntries(nodes.map(n => [n.id, { x: 0, y: 0 }]));
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].id, b = nodes[j].id, pa = positions[a], pb = positions[b];
      const dx = pb.x - pa.x || .01, dy = pb.y - pa.y || .01, distance = Math.max(1, Math.hypot(dx, dy));
      const same = membership.has(a) && membership.get(a) === membership.get(b);
      const minimum = radius.get(a)! + radius.get(b)! + (same ? 52 : 90);
      const force = 14000 / (distance * distance) + Math.max(0, minimum - distance) * .45;
      forces[a].x -= dx / distance * force; forces[a].y -= dy / distance * force;
      forces[b].x += dx / distance * force; forces[b].y += dy / distance * force;
    }
    for (const edge of links) {
      const a = positions[edge.source], b = positions[edge.target], dx = b.x - a.x, dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const root = edge.source === origin || edge.target === origin;
      const same = membership.has(edge.source) && membership.get(edge.source) === membership.get(edge.target);
      const force = (distance - (root ? 350 : same ? 160 : 400)) * (root ? .0015 : edge.kind !== "citation" ? .002 : same ? .018 : .003);
      forces[edge.source].x += dx / distance * force; forces[edge.source].y += dy / distance * force;
      forces[edge.target].x -= dx / distance * force; forces[edge.target].y -= dy / distance * force;
    }
    for (const id of movable) {
      const p = positions[id], f = forces[id], anchor = anchors.get(id)!;
      const attraction = membership.has(id) || Object.keys(saved).length ? .025 : .001;
      positions[id] = { x: p.x + Math.max(-8, Math.min(8, f.x + (anchor.x - p.x) * attraction)),
        y: p.y + Math.max(-8, Math.min(8, f.y + (anchor.y - p.y) * attraction)) };
    }
  }
  // Resolve remaining collisions without changing a dragged or restored position.
  for (let pass = 0; pass < 24; pass++) for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i].id, b = nodes[j].id, pa = positions[a], pb = positions[b];
    if (!movable.has(a) && !movable.has(b)) continue;
    const dx = pb.x - pa.x || .01, dy = pb.y - pa.y || .01, distance = Math.hypot(dx, dy);
    const overlap = radius.get(a)! + radius.get(b)! + 42 - distance;
    if (overlap <= 0) continue;
    const shift = overlap / (movable.has(a) && movable.has(b) ? 2 : 1);
    if (movable.has(a)) { pa.x -= dx / distance * shift; pa.y -= dy / distance * shift; }
    if (movable.has(b)) { pb.x += dx / distance * shift; pb.y += dy / distance * shift; }
  }
  if (!Object.keys(saved).length) {
    // Desktop graph panes are wider than tall. Put the dominant spread along the width before packing.
    const points = nodes.map(n => positions[n.id]);
    const mean = { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
    const xx = points.reduce((sum, p) => sum + (p.x - mean.x) ** 2, 0), yy = points.reduce((sum, p) => sum + (p.y - mean.y) ** 2, 0);
    const xy = points.reduce((sum, p) => sum + (p.x - mean.x) * (p.y - mean.y), 0);
    const angle = -.5 * Math.atan2(2 * xy, xx - yy), c = Math.cos(angle), s = Math.sin(angle);
    for (const n of nodes) { const p = positions[n.id]; positions[n.id] = { x: p.x * c - p.y * s, y: p.x * s + p.y * c }; }
    separateGroups(nodes, groups, positions, origin, scope);
  }
  return positions;
}

/** Move whole communities until their padded regions are disjoint, preserving internal geometry. */
function separateGroups(nodes: MapNode[], groups: MapGroup[], positions: Record<string, Point>, origin: string, scope: CitationScope) {
  const assigned = new Set(groups.flatMap(g => g.members));
  const units = [...groups.map(g => g.members), ...nodes.filter(n => !assigned.has(n.id)).map(n => [n.id])];
  const metadata = new Map(nodes.map(n => [n.id, n]));
  const bounds = (ids: string[]) => {
    const padding = (id: string) => nodeRadius(metadata.get(id)!, scope) * 1.8 + 28;
    return { left: Math.min(...ids.map(id => positions[id].x - padding(id))), right: Math.max(...ids.map(id => positions[id].x + padding(id))),
      top: Math.min(...ids.map(id => positions[id].y - padding(id))) - 30, bottom: Math.max(...ids.map(id => positions[id].y + padding(id))) };
  };
  const move = (ids: string[], x: number, y: number) => ids.forEach(id => { positions[id] = { x: positions[id].x + x, y: positions[id].y + y }; });
  for (let pass = 0; pass < 160; pass++) {
    let changed = false;
    for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
      const a = bounds(units[i]), b = bounds(units[j]);
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left) + 85;
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + 85;
      if (overlapX <= 0 || overlapY <= 0) continue;
      const fixedA = units[i].includes(origin), fixedB = units[j].includes(origin);
      const fraction = fixedA || fixedB ? 1 : .5;
      const x = overlapX < overlapY ? Math.sign((b.left + b.right) - (a.left + a.right) || 1) * (overlapX + 1) * fraction : 0;
      const y = overlapX < overlapY ? 0 : Math.sign((b.top + b.bottom) - (a.top + a.bottom) || 1) * (overlapY + 1) * fraction;
      if (!fixedA) move(units[i], -x, -y);
      if (!fixedB) move(units[j], x, y);
      changed = true;
    }
    if (!changed) break;
  }
}

/** Rounded convex outlines follow group members instead of surrounding unrelated papers. */
export function groupOutline(group: MapGroup, positions: Record<string, Point>, padding: number | ((id: string) => number), extra: Point[] = []) {
  const points = group.members.filter(id => positions[id]).flatMap(id => Array.from({ length: 8 }, (_, i) => ({
    x: positions[id].x + Math.cos(i * Math.PI / 4) * (typeof padding === "number" ? padding : padding(id)),
    y: positions[id].y + Math.sin(i * Math.PI / 4) * (typeof padding === "number" ? padding : padding(id)) })));
  if (!points.length) return null;
  points.push(...extra);
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (items: Point[]) => {
    const hull: Point[] = [];
    for (const p of items) { while (hull.length >= 2 && turn(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop(); hull.push(p); }
    return hull.slice(0, -1);
  };
  const hull = [...half(points), ...half([...points].reverse())];
  const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const first = middle(hull[hull.length - 1], hull[0]);
  const path = `M ${first.x} ${first.y} ` + hull.map((p, i) => {
    const next = middle(p, hull[(i + 1) % hull.length]); return `Q ${p.x} ${p.y} ${next.x} ${next.y}`;
  }).join(" ") + " Z";
  return { path, hull, label: { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: Math.min(...points.map(p => p.y)) - 10 } };
}
