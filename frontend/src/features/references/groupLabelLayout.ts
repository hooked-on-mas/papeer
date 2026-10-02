import type { Point } from "./mapGraph.ts";

export type LabelBox = { left: number; right: number; top: number; bottom: number };
export type GroupLabel = LabelBox & { id: string; lines: string[]; x: number; y: number };
const textWidth = (text: string) => [...text].reduce((sum, c) => sum + (c.charCodeAt(0) < 256 ? 6.5 : 12), 0);
const overlap = (a: LabelBox, b: LabelBox) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** Reserve a header beside the members; the colored outline will include this space. */
export function groupLabelLayout(groups: { id: string; name: string; hull: Point[] }[], circles: { x: number; y: number; radius: number }[], viewport: { width: number; height: number }): GroupLabel[] {
  const labels: GroupLabel[] = [];
  for (const group of groups) {
    const left = Math.min(...group.hull.map(p => p.x)), right = Math.max(...group.hull.map(p => p.x));
    const top = Math.min(...group.hull.map(p => p.y)), bottom = Math.max(...group.hull.map(p => p.y));
    const limit = Math.max(100, Math.min(120, right - left)), lines: string[] = [];
    const remaining = [...group.name];
    const lineCount = Math.ceil(textWidth(group.name) / limit);
    for (let i = 0; i < lineCount; i++) {
      const target = textWidth(remaining.join("")) / (lineCount - i);
      let line = "";
      while (remaining.length) {
        const next = remaining[0], width = textWidth(line);
        if (line && (width + textWidth(next) > limit || (lineCount - i > 1 && Math.abs(width - target) <= Math.abs(width + textWidth(next) - target)))) break;
        line += remaining.shift();
      }
      lines.push(line.trim());
    }
    if (remaining.length) lines[lines.length - 1] += remaining.join("");
    const width = Math.max(...lines.map(textWidth)) + 10, height = lines.length * 15 + 6;
    let best: GroupLabel | undefined, bestScore = Infinity;
    const candidates: (Point & { preference: number })[] = [];
    for (let offset = -2; offset <= 2; offset++) {
      candidates.push({ x: (left + right) / 2 + offset * 10, y: top - height / 2 - 5, preference: Math.abs(offset) * .1 },
        { x: (left + right) / 2 + offset * 10, y: bottom + height / 2 + 5, preference: 1 + Math.abs(offset) * .1 },
        { x: left - width / 2 - 5, y: (top + bottom) / 2 + offset * 10, preference: 2 + Math.abs(offset) * .1 },
        { x: right + width / 2 + 5, y: (top + bottom) / 2 + offset * 10, preference: 2 + Math.abs(offset) * .1 });
    }
    for (const { x, y, preference } of candidates) {
      const box = { left: x - width / 2, right: x + width / 2, top: y - height / 2, bottom: y + height / 2 };
      const score = (Math.max(0, -box.left) + Math.max(0, box.right - viewport.width) + Math.max(0, -box.top) + Math.max(0, box.bottom - viewport.height)) * 1000
        + labels.reduce((sum, b) => sum + overlap(box, b) * 1000, 0)
        + circles.reduce((sum, c) => sum + overlap(box, { left: c.x - c.radius, right: c.x + c.radius, top: c.y - c.radius, bottom: c.y + c.radius }) * 100, 0)
        + groups.filter(g => g.id !== group.id).reduce((sum, g) => sum + overlap(box, {
          left: Math.min(...g.hull.map(p => p.x)), right: Math.max(...g.hull.map(p => p.x)),
          top: Math.min(...g.hull.map(p => p.y)), bottom: Math.max(...g.hull.map(p => p.y)) }) * 50, 0)
        + preference;
      if (score < bestScore) { bestScore = score; best = { ...box, id: group.id, lines, x, y }; }
    }
    if (best) labels.push(best);
  }
  return labels;
}
