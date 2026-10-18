import type { Camera, MapNode, Point } from "./mapGraph.ts";
import { citationScope, frameMap, nodeRadius, type MapGroup } from "./mapLayout.ts";

type Block = { ids: string[]; points: Record<string, Point>; width: number; height: number };
/** Pack actual screen footprints, including headings, when a saved or very dense layout cannot fit. */
export function viewportLayout(nodes: MapNode[], groups: MapGroup[], positions: Record<string, Point>, origin: string,
  width: number, height: number, names: Record<string, string>): { positions: Record<string, Point>; camera: Camera } {
  const scope = citationScope(nodes), metadata = new Map(nodes.map(n => [n.id, n]));
  const grouped = new Set(groups.flatMap(g => g.members));
  const units = [...groups.map(g => ({ ids: g.members, name: names[g.id] || g.label })),
    ...nodes.filter(n => !grouped.has(n.id)).map(n => ({ ids: [n.id], name: "" }))];
  const availableWidth = Math.max(80, width - 40), availableHeight = Math.max(80, height - 40);
  const initialZoom = frameMap(nodes, positions, width, height).zoom;
  let best: { blocks: Block[]; places: Point[]; zoom: number; width: number; height: number; score: number } | undefined;
  for (let attempt = 0; attempt < 24; attempt++) {
    const zoom = initialZoom * .85 ** attempt;
    const radius = (id: string) => Math.max(id === origin ? 14 : 8, nodeRadius(metadata.get(id)!, scope) * (zoom >= 1 ? zoom : Math.sqrt(zoom)));
    const blocks: Block[] = units.map(unit => {
      const center = { x: unit.ids.reduce((s, id) => s + positions[id].x, 0) / unit.ids.length,
        y: unit.ids.reduce((s, id) => s + positions[id].y, 0) / unit.ids.length };
      const points = Object.fromEntries(unit.ids.map(id => [id, { x: (positions[id].x - center.x) * zoom, y: (positions[id].y - center.y) * zoom }]));
      // Screen-size minima must participate in collision resolution, especially in 60-node diagrams.
      for (let pass = 0; pass < 90; pass++) {
        let changed = false;
        for (let i = 0; i < unit.ids.length; i++) for (let j = i + 1; j < unit.ids.length; j++) {
          const a = points[unit.ids[i]], b = points[unit.ids[j]], dx = b.x - a.x || .01, dy = b.y - a.y || .01, distance = Math.hypot(dx, dy);
          const overlap = radius(unit.ids[i]) + radius(unit.ids[j]) + 8 - distance;
          if (overlap <= .01) continue;
          a.x -= dx / distance * overlap / 2; a.y -= dy / distance * overlap / 2;
          b.x += dx / distance * overlap / 2; b.y += dy / distance * overlap / 2; changed = true;
        }
        if (!changed) break;
      }
      const spanX = Math.max(...unit.ids.map(id => points[id].x)) - Math.min(...unit.ids.map(id => points[id].x));
      const spanY = Math.max(...unit.ids.map(id => points[id].y)) - Math.min(...unit.ids.map(id => points[id].y));
      // Degenerate or elongated saved shapes need compact circle packing rather than endless zooming out.
      const maxRadius = Math.max(...unit.ids.map(radius));
      const density = unit.ids.reduce((sum, id) => sum + Math.PI * radius(id) ** 2, 0) / ((spanX + 2 * maxRadius) * (spanY + 2 * maxRadius));
      if (unit.ids.length > 1 && (spanX > availableWidth * .85 || spanY > availableHeight * .65 || density < .18
        || Math.max(spanX, spanY) > Math.max(1, Math.min(spanX, spanY)) * 3)) {
        const cell = Math.max(...unit.ids.map(radius)) * 2 + 8;
        const columns = Math.max(1, Math.min(unit.ids.length, Math.ceil(Math.sqrt(unit.ids.length * availableWidth / availableHeight) * .7)));
        unit.ids.forEach((id, i) => { const row = Math.floor(i / columns); points[id] = {
          x: (i % columns + row % 2 * .5) * cell, y: row * cell * Math.sqrt(3) / 2,
        }; });
      }
      const left = Math.min(...unit.ids.map(id => points[id].x - radius(id))) - 12;
      const right = Math.max(...unit.ids.map(id => points[id].x + radius(id))) + 12;
      const top = Math.min(...unit.ids.map(id => points[id].y - radius(id))) - 12;
      const bottom = Math.max(...unit.ids.map(id => points[id].y + radius(id))) + 12;
      const textWidth = [...unit.name].reduce((s, c) => s + (c.charCodeAt(0) < 256 ? 6.5 : 12), 0) + 20;
      // Reserve the name before packing communities; no topic-specific label placement rules.
      const headerHeight = unit.name ? Math.ceil(textWidth / 100) * 15 + 24 : 0;
      const blockWidth = Math.max(right - left, unit.name ? Math.min(124, textWidth + 24) : 0);
      for (const id of unit.ids) points[id] = { x: points[id].x - (left + right) / 2 + blockWidth / 2,
        y: points[id].y - top + headerHeight };
      return { ids: unit.ids, points, width: blockWidth, height: bottom - top + headerHeight };
    });
    const root = blocks.find(b => b.ids.includes(origin))!;
    const rest = blocks.filter(b => b !== root).sort((a, b) => b.height - a.height || b.width - a.width || a.ids[0].localeCompare(b.ids[0]));
    let fitted = false;
    for (const fraction of [1, .9, .8, .7]) for (let rootIndex = 0; rootIndex <= rest.length; rootIndex++) {
      const ordered = [...rest.slice(0, rootIndex), root, ...rest.slice(rootIndex)], places: Point[] = [];
      const target = availableWidth * fraction;
      let x = 0, y = 0, rowHeight = 0, usedWidth = 0;
      for (const block of ordered) {
        if (x && x + block.width > target) { x = 0; y += rowHeight + 18; rowHeight = 0; }
        places.push({ x, y }); x += block.width + 18; rowHeight = Math.max(rowHeight, block.height); usedWidth = Math.max(usedWidth, x - 18);
      }
      const usedHeight = y + rowHeight, ratio = Math.max(usedWidth / availableWidth, usedHeight / availableHeight);
      const rootPoint = root.points[origin], rootPlace = places[rootIndex];
      const centrality = Math.hypot((rootPlace.x + rootPoint.x - usedWidth / 2) / availableWidth,
        (rootPlace.y + rootPoint.y - usedHeight / 2) / availableHeight);
      const score = ratio > 1 ? ratio * 1000 + centrality : usedWidth * usedHeight / (availableWidth * availableHeight) + centrality;
      if (!best || score < best.score) best = { blocks: ordered, places, zoom, width: usedWidth, height: usedHeight, score };
      if (ratio <= 1) fitted = true;
    }
    if (fitted) break;
  }
  const packed = best!;
  const pixels = Object.fromEntries(packed.blocks.flatMap((block, i) => block.ids.map(id => [id, {
    x: block.points[id].x + packed.places[i].x + (width - packed.width) / 2,
    y: block.points[id].y + packed.places[i].y + (height - packed.height) / 2,
  }])));
  const root = pixels[origin];
  return { positions: { ...positions, ...Object.fromEntries(nodes.map(n => [n.id, { x: (pixels[n.id].x - root.x) / packed.zoom,
    y: (pixels[n.id].y - root.y) / packed.zoom }])) }, camera: { x: root.x - width / 2, y: root.y - height / 2, zoom: packed.zoom, fitted: true } };
}
