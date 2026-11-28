/** Coordinates are fractions of the displayed PDF, independent of zoom and DPI. */
export type Point = [number, number];
export type InkKind = "pen" | "highlighter" | "line" | "arrow" | "rectangle" | "ellipse" | "text";
export type InkStroke = { id: string; color: string; width: number; points: Point[]; kind?: InkKind; text?: string; arrowHeadLength?: number | null };
export type Bounds = { x: number; y: number; width: number; height: number };
export type InkTool = "select" | "region" | "lasso" | "capture" | "eraser" | InkKind;
export const kindOf = (stroke: InkStroke) => stroke.kind ?? "pen";
export const SHAPE_KINDS: readonly InkTool[] = ["line", "arrow", "rectangle", "ellipse"];
export const isShape = (stroke: InkStroke) => SHAPE_KINDS.includes(kindOf(stroke));
const ELLIPSE_SEGMENTS = 64;
const ELLIPSE_QUARTER = ELLIPSE_SEGMENTS / 4;
const ELLIPSE_HALF = ELLIPSE_SEGMENTS / 2;
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

export function pointInPolygon([x, y]: Point, polygon: Point[]) {
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
    ...(kindOf(stroke) === "arrow" ? { arrowHeadLength: arrowHeadLength(stroke, ratio) * scale } : {}),
    points: stroke.points.map(([x, y]): Point => {
      const dx = (x - center[0]) * scale, dy = (y - center[1]) * ratio * scale;
      return [center[0] + dx * c - dy * s + delta[0], center[1] + (dx * s + dy * c) / ratio + delta[1]];
    }) }));
}

/** Align the actual object orientation, even when an earlier gesture left it tilted. */
export function snapRotation(angle: number, strokes: InkStroke[], ratio: number): number {
  const reference = strokes.find(s => kindOf(s) === "text")
    ?? strokes.find(isShape);
  let base = 0;
  if (reference && reference.points.length > 1) {
    const a = kindOf(reference) === "ellipse" ? reference.points[ELLIPSE_HALF] ?? reference.points[0] : reference.points[0];
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
  if (kind === "ellipse") return Array.from({ length: ELLIPSE_SEGMENTS + 1 }, (_, i): Point =>
    [box.x + box.width * (1 + Math.cos(i / ELLIPSE_SEGMENTS * Math.PI * 2)) / 2,
      box.y + box.height * (1 + Math.sin(i / ELLIPSE_SEGMENTS * Math.PI * 2)) / 2]);
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

export type ShapeHit = { part: "handle"; index: number } | { part: "rim" } | { part: "body" };
const distance = (a: Point, b: Point, ratio: number) => Math.hypot(a[0] - b[0], (a[1] - b[1]) * ratio);
// Older saved arrows have only points. Preserve enlarged heads and recover the default
// size for heads that were capped by a short shaft.
const arrowHeadLength = (stroke: InkStroke, ratio: number) => stroke.arrowHeadLength
  ?? Math.max(0.025, stroke.points[2] ? distance(stroke.points[1], stroke.points[2], ratio) : 0);

function reshapeArrow(stroke: InkStroke, a: Point, b: Point, ratio: number): InkStroke {
  const nominal = arrowHeadLength(stroke, ratio);
  const angle = Math.atan2((b[1] - a[1]) * ratio, b[0] - a[0]);
  const wings: Point[] = [-0.5, 0.5].map(offset => [-Math.cos(angle + offset), -Math.sin(angle + offset) / ratio]);
  let length = Math.min(nominal, distance(a, b, ratio) * 0.3);
  // Fit both wings along their directions, rather than interpolating their points
  // independently of the shaft. The chosen endpoints stay where the user put them.
  for (const wing of wings) for (const i of [0, 1]) {
    if (wing[i] > 0) length = Math.min(length, (1 - b[i]) / wing[i]);
    if (wing[i] < 0) length = Math.min(length, -b[i] / wing[i]);
  }
  const tips = wings.map(([x, y]): Point => [Math.max(0, Math.min(1, b[0] + x * length)), Math.max(0, Math.min(1, b[1] + y * length))]);
  return { ...stroke, arrowHeadLength: nominal, points: [a, b, tips[0], b, tips[1]] };
}
export const ellipseCenter = ({ points }: InkStroke): Point => {
  const b = points[ELLIPSE_HALF] ?? points[0];
  return [(points[0][0] + b[0]) / 2, (points[0][1] + b[1]) / 2];
};

/** Direction of a shape handle in displayed page coordinates. */
export function shapeHandleCursor(stroke: InkStroke, index: number, ratio: number): string {
  const kind = kindOf(stroke);
  if (kind === "line" || kind === "arrow") return "pointer";
  let dx = 0, dy = 0;
  if (kind === "ellipse") {
    const c = ellipseCenter(stroke), h = shapeHandles(stroke)[index];
    if (!h) return "crosshair";
    dx = h[0] - c[0]; dy = (h[1] - c[1]) * ratio;
  } else {
    const h = stroke.points[index], opposite = stroke.points[(index + 2) % 4];
    if (!h || !opposite) return "crosshair";
    dx = h[0] - opposite[0]; dy = (h[1] - opposite[1]) * ratio;
  }
  const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][(sector + 8) % 4];
}

/** Shift constrains new lines to 45-degree steps and boxes to physical squares/circles. */
export function constrainedShapeEnd(kind: InkKind, start: Point, end: Point, ratio: number): Point {
  const dx = end[0] - start[0], dy = (end[1] - start[1]) * ratio;
  let target: Point;
  if (kind === "line" || kind === "arrow") {
    const length = Math.hypot(dx, dy), angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    target = [start[0] + length * Math.cos(angle), start[1] + length * Math.sin(angle) / ratio];
  } else if (kind === "rectangle" || kind === "ellipse") {
    const length = Math.max(Math.abs(dx), Math.abs(dy));
    target = [start[0] + Math.sign(dx || 1) * length, start[1] + Math.sign(dy || 1) * length / ratio];
  } else return end;
  let fraction = 1;
  target.forEach((value, i) => {
    const from = start[i], change = value - from;
    if (value > 1 && change) fraction = Math.min(fraction, (1 - from) / change);
    if (value < 0 && change) fraction = Math.min(fraction, -from / change);
  });
  return [start[0] + (target[0] - start[0]) * fraction, start[1] + (target[1] - start[1]) * fraction];
}

/** Line and arrow ends (the tip is points[1]), rectangle corners, and four marks on an ellipse rim. */
export function shapeHandles(stroke: InkStroke): Point[] {
  const kind = kindOf(stroke);
  if (kind === "rectangle") return stroke.points.slice(0, 4);
  if (kind === "ellipse") return [0, ELLIPSE_QUARTER, ELLIPSE_HALF, ELLIPSE_QUARTER * 3].flatMap(i => stroke.points[i] ? [stroke.points[i]] : []);
  return kind === "line" || kind === "arrow" ? stroke.points.slice(0, 2) : [];
}

/** Handles first, then the outline or a closed shape's interior. Scaling uses a visible frame handle. */
export function hitShape(stroke: InkStroke, p: Point, tolerance: number, ratio: number): ShapeHit | null {
  const kind = kindOf(stroke), points = stroke.points, reach = tolerance + stroke.width / 2;
  if (!isShape(stroke) || !points.length) return null;
  const outline = points.some((b, i) => pointSegmentDistance(p, points[Math.max(0, i - 1)], b, ratio) <= reach);
  let index = -1, best = reach;
  shapeHandles(stroke).forEach((h, i) => { const d = distance(h, p, ratio); if (d <= best) { best = d; index = i; } });
  if (index >= 0) return { part: "handle", index };
  if (kind === "ellipse") return outline || pointInPolygon(p, points) ? { part: "body" } : null;
  return outline || (kind === "rectangle" && pointInPolygon(p, points)) ? { part: "body" } : null;
}

/**
 * Stretch an ellipse along the axis of the handle at right (0), bottom (1), left (2) or top (3), in the
 * ellipse's own tilt, keeping the opposite end where it is. The other axis stays as it was.
 */
function stretchEllipse(stroke: InkStroke, index: number, start: Point, p: Point, ratio: number, keepAspect: boolean): InkStroke {
  const points = stroke.points, c = ellipseCenter(stroke);
  const from = (q: Point): Point => [q[0] - c[0], (q[1] - c[1]) * ratio];
  const unit = (v: Point, fallback: Point): Point => { const l = Math.hypot(v[0], v[1]); return l > 1e-9 ? [v[0] / l, v[1] / l] : fallback; };
  const rightArm = from(points[0]), bottomArm = from(points[ELLIPSE_QUARTER] ?? points[0]);
  const u = unit(rightArm, [1, 0]), v = unit(bottomArm, [-u[1], u[0]]);
  const horizontal = index % 2 === 0, sign = index < 2 ? 1 : -1;
  const axis = horizontal ? u : v, half = horizontal ? Math.hypot(...rightArm) : Math.hypot(...bottomArm);
  const fixed: Point = [-sign * axis[0] * half, -sign * axis[1] * half];
  const moved: Point = [-fixed[0] + p[0] - start[0], -fixed[1] + (p[1] - start[1]) * ratio];
  const length = Math.max(0.0001, sign * ((moved[0] - fixed[0]) * axis[0] + (moved[1] - fixed[1]) * axis[1]));
  const centre: Point = [c[0] + fixed[0] + sign * axis[0] * length / 2, c[1] + (fixed[1] + sign * axis[1] * length / 2) / ratio];
  const proportion = keepAspect && half ? length / (2 * half) : 1;
  const a = horizontal ? length / 2 : Math.hypot(...rightArm) * proportion;
  const b = horizontal ? Math.hypot(...bottomArm) * proportion : length / 2;
  return { ...stroke, points: Array.from({ length: ELLIPSE_SEGMENTS + 1 }, (_, i): Point => {
    const x = a * Math.cos(i / ELLIPSE_SEGMENTS * Math.PI * 2), y = b * Math.sin(i / ELLIPSE_SEGMENTS * Math.PI * 2);
    return [centre[0] + x * u[0] + y * v[0], centre[1] + (x * u[1] + y * v[1]) / ratio];
  }) };
}

/**
 * Drag a handle by the pointer's travel since `start`. A rectangle keeps its opposite corner and tilt;
 * an ellipse handle stretches that one axis, and its rim scales it about the centre. Width, colour and id stay.
 */
export function reshapeShape(stroke: InkStroke, hit: ShapeHit, start: Point, p: Point, ratio: number, keepAspect = false): InkStroke {
  const kind = kindOf(stroke), points = stroke.points;
  if (p[0] === start[0] && p[1] === start[1]) return stroke;
  let result = stroke;
  if (kind === "ellipse" && hit.part === "handle") {
    result = stretchEllipse(stroke, hit.index, start, p, ratio, keepAspect);
  } else if (kind === "ellipse" && hit.part === "rim") {
    const c = ellipseCenter(stroke);
    const factor = Math.max(0.05, Math.min(20, distance(p, c, ratio) / (distance(start, c, ratio) || 1)));
    result = { ...transformInk([stroke], c, factor, 0, [0, 0], ratio)[0], width: stroke.width };
  } else if (hit.part === "handle" && points[hit.index]) {
    const h = points[hit.index];
    const t: Point = [Math.max(0, Math.min(1, h[0] + p[0] - start[0])), Math.max(0, Math.min(1, h[1] + p[1] - start[1]))];
    if (kind === "rectangle") {
      // Project onto the original edge directions (in page proportions), so a rotated box stays rotated.
      const i = hit.index, o = points[(i + 2) % 4];
      const axis = (q: Point): Point => { const x = q[0] - o[0], y = (q[1] - o[1]) * ratio, l = Math.hypot(x, y); return l ? [x / l, y / l] : [0, 0]; };
      let u = axis(points[(i + 1) % 4]), v = axis(points[(i + 3) % 4]);
      if (!u[0] && !u[1]) u = v[0] || v[1] ? [-v[1], v[0]] : [1, 0];
      if (!v[0] && !v[1]) v = [-u[1], u[0]];
      const dx = t[0] - o[0], dy = (t[1] - o[1]) * ratio;
      const originalU = distance(o, points[(i + 1) % 4], ratio);
      const originalV = distance(o, points[(i + 3) % 4], ratio);
      let amountU = dx * u[0] + dy * u[1], amountV = dx * v[0] + dy * v[1];
      if (keepAspect && originalU > 1e-9 && originalV > 1e-9) {
        const scaleU = amountU / originalU, scaleV = amountV / originalV;
        const scale = Math.max(0.0001, Math.abs(scaleU - 1) > Math.abs(scaleV - 1) ? scaleU : scaleV);
        amountU = originalU * scale; amountV = originalV * scale;
      }
      const along = (w: Point, amount: number): Point => [o[0] + amount * w[0], o[1] + amount * w[1] / ratio];
      const a = along(u, amountU), b = along(v, amountV), next = [...points];
      next[i] = [a[0] + b[0] - o[0], a[1] + b[1] - o[1]];
      next[(i + 1) % 4] = a; next[(i + 3) % 4] = b; next[4] = next[0];
      result = { ...stroke, points: next };
    } else {
      const ends = points.slice(0, 2);
      ends[hit.index] = t;
      if (kind === "arrow") {
        const [a, b] = ends;
        return reshapeArrow(stroke, a, b, ratio);
      } else result = { ...stroke, points: ends };
    }
  }
  // Limit the requested deformation along its path. Translating the completed shape would
  // move a rectangle's opposite corner or an ellipse's centre, and scale its stroke width.
  let fraction = 1;
  result.points.forEach(([x, y], i) => {
    const before = points[i];
    if (!before) return;
    for (const [a, b] of [[before[0], x], [before[1], y]]) {
      if (b > 1 && b !== a) fraction = Math.min(fraction, (1 - a) / (b - a));
      if (b < 0 && b !== a) fraction = Math.min(fraction, -a / (b - a));
    }
  });
  if (fraction <= 0) return stroke;
  if (fraction === 1) return result;
  return { ...result, points: result.points.map(([x, y], i): Point =>
    [points[i][0] + (x - points[i][0]) * fraction, points[i][1] + (y - points[i][1]) * fraction]) };
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
