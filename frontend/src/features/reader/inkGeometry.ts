/** Coordinates are fractions of the displayed PDF, independent of zoom and DPI. */
export type Point = [number, number];
export type InkKind = "pen" | "highlighter" | "line" | "arrow" | "rectangle" | "ellipse" | "text";
export type InkStroke = { id: string; color: string; width: number; points: Point[]; kind?: InkKind; text?: string };
export type Bounds = { x: number; y: number; width: number; height: number };
export type InkTool = "select" | "region" | "lasso" | "capture" | "eraser" | InkKind;
export const kindOf = (stroke: InkStroke) => stroke.kind ?? "pen";
export const textUnits = (text: string) => [...text].reduce((n, c) => n + (/^[\x00-\xff]$/.test(c) ? 0.6 : 1), 0);

export function boundsOf(strokes: InkStroke[]): Bounds | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const stroke of strokes) for (const [x, y] of stroke.points) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return Number.isFinite(left) ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}
export const rectBetween = (a: Point, b: Point): Bounds => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) });
export const inBounds = ([x, y]: Point, b: Bounds) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;

function pointInPolygon([x, y]: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

export function selectInk(strokes: InkStroke[], polygon: Point[], rectangle: boolean): string[] {
  if (polygon.length < 2) return [];
  const box = rectBetween(polygon[0], polygon[polygon.length - 1]);
  // Enclose the complete object; touching a neighbouring line does not select it.
  return strokes.filter(s => s.points.every(p => rectangle ? inBounds(p, box) : pointInPolygon(p, polygon))).map(s => s.id);
}

export function transformInk(strokes: InkStroke[], center: Point, scale: number, angle: number, delta: Point, ratio: number): InkStroke[] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return strokes.map(stroke => ({ ...stroke, width: Math.min(0.08, Math.max(0.0001, stroke.width * scale)),
    points: stroke.points.map(([x, y]): Point => {
      const dx = (x - center[0]) * scale, dy = (y - center[1]) * ratio * scale;
      return [center[0] + dx * c - dy * s + delta[0], center[1] + (dx * s + dy * c) / ratio + delta[1]];
    }) }));
}

/** Align the actual object orientation, even when an earlier gesture left it tilted. */
export function snapRotation(angle: number, strokes: InkStroke[], ratio: number): number {
  const reference = strokes.find(s => kindOf(s) === "text")
    ?? strokes.find(s => ["rectangle", "ellipse", "line", "arrow"].includes(kindOf(s)));
  let base = 0;
  if (reference && reference.points.length > 1) {
    const a = kindOf(reference) === "ellipse" ? reference.points[32] ?? reference.points[0] : reference.points[0];
    const b = kindOf(reference) === "ellipse" ? reference.points[0] : reference.points[1];
    base = Math.atan2((b[1] - a[1]) * ratio, b[0] - a[0]);
  }
  const absolute = base + angle;
  const target = Math.round(absolute / (Math.PI / 2)) * (Math.PI / 2);
  return Math.abs(target - absolute) <= Math.PI / 36 ? target - base : angle;
}

/** Translate the whole selection at the edge, never clamp individual points and distort it. */
export function fitInk(strokes: InkStroke[], ratio: number): InkStroke[] {
  let b = boundsOf(strokes);
  if (!b) return strokes;
  const factor = Math.min(1, b.width > 1 ? 0.98 / b.width : 1, b.height > 1 ? 0.98 / b.height : 1);
  let result = factor < 1 ? transformInk(strokes, [b.x, b.y], factor, 0, [0, 0], ratio) : strokes;
  b = boundsOf(result)!;
  const dx = b.x < 0 ? -b.x : b.x + b.width > 1 ? 1 - b.x - b.width : 0;
  const dy = b.y < 0 ? -b.y : b.y + b.height > 1 ? 1 - b.y - b.height : 0;
  result = transformInk(result, [0, 0], 1, 0, [dx, dy], ratio);
  return result.map(s => ({ ...s, points: s.points.map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]) }));
}

export function shapePoints(kind: InkKind, a: Point, b: Point, ratio: number): Point[] {
  const box = rectBetween(a, b);
  if (kind === "rectangle") return [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height], [box.x, box.y]];
  if (kind === "ellipse") return Array.from({ length: 65 }, (_, i): Point => [box.x + box.width * (1 + Math.cos(i / 64 * Math.PI * 2)) / 2, box.y + box.height * (1 + Math.sin(i / 64 * Math.PI * 2)) / 2]);
  if (kind === "arrow") {
    const angle = Math.atan2((b[1] - a[1]) * ratio, b[0] - a[0]);
    const length = Math.min(0.025, Math.hypot(b[0] - a[0], (b[1] - a[1]) * ratio) * 0.3);
    return [a, b, [b[0] - Math.cos(angle - 0.5) * length, b[1] - Math.sin(angle - 0.5) * length / ratio], b,
      [b[0] - Math.cos(angle + 0.5) * length, b[1] - Math.sin(angle + 0.5) * length / ratio]];
  }
  return [a, b];
}

export function textPoints(text: string, at: Point, fontSize: number, ratio: number): Point[] {
  const lines = text.split("\n"), width = Math.max(1, ...lines.map(textUnits)) * fontSize;
  const height = lines.length * fontSize * 1.3 / ratio;
  return [at, [at[0] + width, at[1]], [at[0] + width, at[1] + height], [at[0], at[1] + height]];
}

export function pointSegmentDistance(p: Point, a: Point, b: Point, ratio: number) {
  const x = a[0] - p[0], y = (a[1] - p[1]) * ratio;
  const dx = b[0] - a[0], dy = (b[1] - a[1]) * ratio;
  const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x + t * dx, y + t * dy);
}

export function hitInk(stroke: InkStroke, p: Point, radius: number, ratio: number) {
  if (kindOf(stroke) === "text") return pointInPolygon(p, stroke.points)
    || stroke.points.some((a, i) => pointSegmentDistance(p, a, stroke.points[(i + 1) % stroke.points.length], ratio) <= radius);
  return stroke.points.some((b, i) => pointSegmentDistance(p, stroke.points[Math.max(0, i - 1)], b, ratio) <= radius + stroke.width / 2);
}

/** Split at circle intersections so even a two-point line can be partially erased. */
export function eraseInk(strokes: InkStroke[], p: Point, radius: number, ratio: number, partial: boolean, highlightOnly: boolean): InkStroke[] {
  return strokes.flatMap(stroke => {
    const kind = kindOf(stroke);
    if ((highlightOnly && kind !== "highlighter") || !hitInk(stroke, p, radius, ratio)) return [stroke];
    if (!partial || !["pen", "highlighter"].includes(kind)) return [];
    const r = radius + stroke.width / 2;
    const pieces: Point[][] = [];
    let current: Point[] = [];
    const flush = () => { if (current.length) pieces.push(current); current = []; };
    for (let i = 1; i < stroke.points.length; i++) {
      const a = stroke.points[i - 1], b = stroke.points[i];
      const dx = b[0] - a[0], dy = (b[1] - a[1]) * ratio;
      const ax = a[0] - p[0], ay = (a[1] - p[1]) * ratio;
      const aa = dx * dx + dy * dy, bb = 2 * (ax * dx + ay * dy), cc = ax * ax + ay * ay - r * r;
      const cuts = [0, 1], discriminant = bb * bb - 4 * aa * cc;
      if (aa > 0 && discriminant > 0) for (const t of [(-bb - Math.sqrt(discriminant)) / (2 * aa), (-bb + Math.sqrt(discriminant)) / (2 * aa)]) if (t > 0 && t < 1) cuts.push(t);
      cuts.sort((x, y) => x - y);
      const interpolate = (t: number): Point => [a[0] + dx * t, a[1] + dy * t / ratio];
      for (let j = 1; j < cuts.length; j++) {
        const mid = interpolate((cuts[j - 1] + cuts[j]) / 2);
        if (Math.hypot(mid[0] - p[0], (mid[1] - p[1]) * ratio) > r) {
          if (!current.length) current.push(interpolate(cuts[j - 1]));
          current.push(interpolate(cuts[j]));
        } else flush();
      }
    }
    flush();
    return pieces.map((points, i) => ({ ...stroke, id: i ? crypto.randomUUID() : stroke.id, points }));
  });
}
