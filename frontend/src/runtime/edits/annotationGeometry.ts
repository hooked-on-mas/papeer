import type { Geometry, InkObject, PageAnnotation, Point } from './contracts.ts';

export function geometryPoints(geometry: Geometry): Point[] {
  const g = geometry;
  if (g.kind === 'path') return g.points;
  if (g.kind === 'line') return [g.start, g.end];
  if (g.kind === 'arrow') {
    const angle = Math.atan2(g.end.y - g.start.y, g.end.x - g.start.x);
    const head = (at: Point, direction: number) => [-.5, .5].map(offset => ({
      x: at.x - Math.cos(direction + offset) * g.headLengthPt, y: at.y - Math.sin(direction + offset) * g.headLengthPt,
    }));
    const end = head(g.end, angle);
    const start = head(g.start, angle + Math.PI);
    return g.head === 'end' ? [g.start, g.end, end[0], g.end, end[1]] : [start[0], g.start, start[1], g.start, g.end, end[0], g.end, end[1]];
  }
  if (g.kind === 'ellipse') return Array.from({ length: 65 }, (_, i) => ({
    x: g.widthPt * (1 + Math.cos(i * Math.PI / 32)) / 2, y: g.heightPt * (1 + Math.sin(i * Math.PI / 32)) / 2,
  }));
  return [{ x: 0, y: 0 }, { x: g.widthPt, y: 0 }, { x: g.widthPt, y: g.heightPt }, { x: 0, y: g.heightPt }];
}
export function transformInkPoint(annotation: InkObject, point: Point): Point {
  const t = annotation.transform, c = Math.cos(t.rotationRad), s = Math.sin(t.rotationRad);
  return { x: t.x + c * point.x * t.scaleX - s * point.y * t.scaleY, y: t.y + s * point.x * t.scaleX + c * point.y * t.scaleY };
}
/** Extent witnesses for validation/resize. Ellipses use their actual extrema, not empty frame corners. */
export function annotationPoints(annotation: PageAnnotation): Point[] {
  if (annotation.kind === 'sticky') return [annotation.anchor];
  if (annotation.kind === 'highlight') return [annotation.anchor, ...annotation.quads.flat()];
  const g = annotation.geometry, t = annotation.transform;
  if (g.kind === 'ellipse') {
    const c = Math.cos(t.rotationRad), s = Math.sin(t.rotationRad), rx = g.widthPt / 2, ry = g.heightPt / 2;
    const x = Math.atan2(-s * t.scaleY * ry, c * t.scaleX * rx), y = Math.atan2(c * t.scaleY * ry, s * t.scaleX * rx);
    return [x, x + Math.PI, y, y + Math.PI].map(angle => transformInkPoint(annotation, { x: rx * (1 + Math.cos(angle)), y: ry * (1 + Math.sin(angle)) }));
  }
  return geometryPoints(g).map(point => transformInkPoint(annotation, point));
}
