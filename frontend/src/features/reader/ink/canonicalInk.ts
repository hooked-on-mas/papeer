import type { Geometry, InkObject, Page, Point as InkPoint, Transform } from '../../../runtime/edits/contracts.ts';
import { geometryPoints, transformInkPoint } from '../../../runtime/edits/annotationGeometry.ts';
import { kindOf, textUnits, type InkStroke, type Point } from '../../ink/inkGeometry.ts';

export type InkPageSize = Pick<Page, 'widthPt' | 'heightPt'>;
const identity = (): Transform => ({ x: 0, y: 0, rotationRad: 0, scaleX: 1, scaleY: 1 });
const distance = (a: InkPoint, b: InkPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const same = (a: InkPoint, b: InkPoint) => distance(a, b) < 1e-6;
const reject = (): never => { throw new Error('invalid-ink-draft'); };
function checkPage(page: InkPageSize) {
  if (![page.widthPt, page.heightPt].every(value => Number.isFinite(value) && value > 0)) reject();
}

/** Disposable display/hit-test projection. Never use this to rewrite an existing annotation. */
export function projectInkObject(annotation: InkObject, page: InkPageSize): InkStroke {
  checkPage(page);
  const g = annotation.geometry;
  let points = geometryPoints(g);
  if (g.kind === 'rect') points = [...points, points[0]];
  // Existing shape handles expect the shaft at indices 0 and 1, including double-headed arrows.
  if (g.kind === 'arrow' && g.head === 'both') points = [g.start, ...points.slice(4), g.start, points[0], g.start, points[2]];
  return {
    id: annotation.id, color: annotation.style.color,
    width: annotation.style.widthPt * Math.max(annotation.transform.scaleX, annotation.transform.scaleY) / page.widthPt,
    kind: g.kind === 'path' ? annotation.style.highlighter ? 'highlighter' : 'pen' : g.kind === 'rect' ? 'rectangle' : g.kind,
    points: points.map(point => { const p = transformInkPoint(annotation, point); return [p.x / page.widthPt, p.y / page.heightPt] as Point; }),
    ...(g.kind === 'text' ? { text: g.text } : {}),
    ...(g.kind === 'arrow' ? { arrowHeadLength: (g.preferredHeadLengthPt ?? g.headLengthPt) / page.widthPt } : {}),
  };
}

function frame(points: InkPoint[], closed: boolean) {
  if (points.length !== (closed ? 5 : 4) || (closed && !same(points[0], points[4]))) reject();
  const [a, b, c, d] = points;
  const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - a.x, vy = d.y - a.y;
  const widthPt = Math.hypot(ux, uy), heightPt = Math.hypot(vx, vy);
  if (!(widthPt > 0 && heightPt > 0) || ux * vy - uy * vx <= 0
    || Math.abs(ux * vx + uy * vy) / (widthPt * heightPt) > 1e-8
    || !same(c, { x: b.x + vx, y: b.y + vy })) reject();
  return { widthPt, heightPt, transform: { ...identity(), x: a.x, y: a.y, rotationRad: Math.atan2(uy, ux) } };
}

/** Constructor for a newly completed gesture only; canonical updates retain their original geometry/style. */
export function inkObjectFromDraft(stroke: InkStroke, page: InkPageSize): InkObject {
  checkPage(page);
  const kind = kindOf(stroke);
  if (!stroke.id || [...stroke.id].length > 80 || !/^#[0-9a-f]{6}$/i.test(stroke.color)
    || !Number.isFinite(stroke.width) || stroke.width <= 0 || stroke.width > .08
    || !['pen', 'highlighter', 'line', 'arrow', 'rectangle', 'ellipse', 'text'].includes(kind)
    || !stroke.points.length || stroke.points.length > 20000
    || stroke.points.some(p => p.length !== 2 || p.some(n => !Number.isFinite(n) || n < 0 || n > 1))) reject();
  if (kind === 'text' && (typeof stroke.text !== 'string' || !stroke.text.trim() || [...stroke.text].length > 2000)) reject();
  const points = stroke.points.map(([x, y]) => ({ x: x * page.widthPt, y: y * page.heightPt }));
  let geometry: Geometry, transform = identity();
  if (kind === 'pen' || kind === 'highlighter') geometry = { kind: 'path', points };
  else if (kind === 'line' || kind === 'arrow') {
    if (points.length !== (kind === 'line' ? 2 : 5) || distance(points[0], points[1]) === 0) reject();
    if (kind === 'line') geometry = { kind: 'line', start: points[0], end: points[1] };
    else {
      if (!same(points[1], points[3])) reject();
      const headLengthPt = distance(points[1], points[2]);
      const preferredHeadLengthPt = (stroke.arrowHeadLength ?? .025) * page.widthPt;
      if (!(headLengthPt > 0) || !Number.isFinite(preferredHeadLengthPt) || preferredHeadLengthPt + 1e-6 < headLengthPt) reject();
      geometry = { kind: 'arrow', start: points[0], end: points[1], head: 'end', headLengthPt, preferredHeadLengthPt: Math.max(headLengthPt, preferredHeadLengthPt) };
    }
  } else if (kind === 'rectangle' || kind === 'text') {
    const box = frame(points, kind === 'rectangle'); transform = box.transform;
    if (kind === 'rectangle') geometry = { kind: 'rect', widthPt: box.widthPt, heightPt: box.heightPt };
    else {
      const text = stroke.text!, lines = text.split('\n'), fontSizePt = box.heightPt / (lines.length * 1.3);
      const widthPt = Math.max(1, ...lines.map(textUnits)) * fontSizePt;
      geometry = { kind: 'text', text, fontSizePt, fontFamily: 'sans-serif', widthPt, heightPt: box.heightPt };
      transform.scaleX = box.widthPt / widthPt;
    }
  } else {
    if (points.length !== 65 || !same(points[0], points[64])) reject();
    const center = { x: (points[0].x + points[32].x) / 2, y: (points[0].y + points[32].y) / 2 };
    const u = { x: points[0].x - center.x, y: points[0].y - center.y }, v = { x: points[16].x - center.x, y: points[16].y - center.y };
    const rx = Math.hypot(u.x, u.y), ry = Math.hypot(v.x, v.y);
    if (!(rx > 0 && ry > 0) || u.x * v.y - u.y * v.x <= 0 || Math.abs(u.x * v.x + u.y * v.y) / (rx * ry) > 1e-8) reject();
    geometry = { kind: 'ellipse', widthPt: rx * 2, heightPt: ry * 2 };
    transform = { ...identity(), x: center.x - u.x - v.x, y: center.y - u.y - v.y, rotationRad: Math.atan2(u.y, u.x) };
  }
  const annotation: InkObject = { kind: 'ink', id: stroke.id, geometry, transform,
    style: { color: stroke.color, widthPt: stroke.width * page.widthPt, opacity: kind === 'highlighter' ? .3 : 1, highlighter: kind === 'highlighter' } };
  const expected = kind === 'rectangle' ? points.slice(0, 4) : points;
  const actual = geometryPoints(geometry).map(point => transformInkPoint(annotation, point));
  if (actual.length !== expected.length || actual.some((point, i) => !same(point, expected[i]))) reject();
  return annotation;
}
