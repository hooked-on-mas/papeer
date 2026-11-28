import type { Page, PageAnnotation, Point } from './contracts.ts';
import { assertSnapshot, EditRejected } from './editModel.ts';
import { annotationPoints } from './annotationGeometry.ts';
export { annotationPoints } from './annotationGeometry.ts';

/** PDF affine convention: x'=a*x+c*y+e, y'=b*x+d*y+f. CSS pixels and DPR never enter saved geometry. */
export type Matrix = readonly [number, number, number, number, number, number];
export function transformPoint(matrix: Matrix, point: Point): Point {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}
export function inverseMatrix(matrix: Matrix): Matrix {
  const [a, b, c, d, e, f] = matrix, determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) throw new EditRejected('singular-transform');
  return [d / determinant, -b / determinant, -c / determinant, a / determinant,
    (c * f - d * e) / determinant, (b * e - a * f) / determinant];
}
export function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  const [a, b, c, d, e, f] = left, [g, h, i, j, k, l] = right;
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
}
export function pdfPageCoordinates(crop: readonly [number, number, number, number], userUnit = 1, rotate = 0) {
  const [x0, y0, x1, y1] = crop;
  if (crop.some(value => !Number.isFinite(value)) || !(x1 > x0 && y1 > y0 && userUnit > 0 && Number.isFinite(userUnit))
    || !Number.isFinite(rotate) || rotate % 90 !== 0) throw new EditRejected('pdf-page-dimensions');
  const angle = ((rotate % 360) + 360) % 360;
  const width = (x1 - x0) * userUnit, height = (y1 - y0) * userUnit;
  const u = userUnit;
  const matrix: Matrix = angle === 0 ? [u, 0, 0, -u, -x0 * u, y1 * u]
    : angle === 90 ? [0, u, u, 0, -y0 * u, -x0 * u]
    : angle === 180 ? [-u, 0, 0, u, x1 * u, -y0 * u]
    : [0, -u, -u, 0, y1 * u, x1 * u];
  return { widthPt: angle % 180 ? height : width, heightPt: angle % 180 ? width : height,
    fromPdf: matrix, toPdf: inverseMatrix(matrix) };
}

/** Explicit paper resize. Default preserves physical positions and rejects overflow; fit is uniform only. */
export function paperResizeLayout(oldWidth: number, oldHeight: number, width: number, height: number, fit = false) {
  if (![oldWidth, oldHeight, width, height].every(value => value > 0 && Number.isFinite(value))) throw new EditRejected('paper-dimensions');
  const scale = fit ? Math.min(width / oldWidth, height / oldHeight, 1) : 1;
  return { scale, dx: fit ? (width - oldWidth * scale) / 2 : 0, dy: fit ? (height - oldHeight * scale) / 2 : 0 };
}
export function resizePaper(page: Page, widthPt: number, heightPt: number, backgroundRevision: string, fit = false): Page {
  if (page.background.kind !== 'paper' || !(widthPt > 0 && heightPt > 0) || !Number.isFinite(widthPt + heightPt)) throw new EditRejected('paper-dimensions');
  const { scale, dx, dy } = paperResizeLayout(page.widthPt, page.heightPt, widthPt, heightPt, fit);
  const point = (p: Point) => ({ x: p.x * scale + dx, y: p.y * scale + dy });
  const annotations = page.annotations.map((annotation): PageAnnotation => {
    if (annotation.kind === 'sticky') return { ...annotation, anchor: point(annotation.anchor) };
    if (annotation.kind === 'highlight') return { ...annotation, backgroundRevision, anchor: point(annotation.anchor), quads: annotation.quads.map(quad => quad.map(point)) };
    return { ...annotation, transform: { ...annotation.transform, x: annotation.transform.x * scale + dx,
      y: annotation.transform.y * scale + dy, scaleX: annotation.transform.scaleX * scale, scaleY: annotation.transform.scaleY * scale } };
  });
  const next = { ...page, widthPt, heightPt, backgroundRevision, annotations };
  const overflow = annotations.some(annotation => annotationPoints(annotation).some(p => p.x < -1e-8 || p.y < -1e-8 || p.x > widthPt + 1e-8 || p.y > heightPt + 1e-8));
  if (overflow) throw new EditRejected('paper-content-overflow');
  assertSnapshot({ kind: 'document', id: page.id, version: backgroundRevision, pages: [next], deletedPages: [] });
  return next;
}
