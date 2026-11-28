import { validatePage, type AnnotationChange, type InkObject, type Page, type PageAnnotation, type Point as LocalPoint } from '../../../runtime/edits/contracts.ts';
import { annotationPoints, transformInkPoint } from '../../../runtime/edits/annotationGeometry.ts';
import { assertPage, canonicalJson } from '../../../runtime/edits/editModel.ts';
import { inkObjectFromDraft, projectInkObject } from './canonicalInk.ts';
import { CanonicalEraseCursor } from './canonicalEraseCursor.ts';
import { reshapeShape, textUnits, type InkStroke, type Point, type ShapeHit } from '../../ink/inkGeometry.ts';

export type CanonicalInkOperation =
  | { type: 'create'; drafts: InkStroke[] }
  | { type: 'delete'; ids: string[] }
  | { type: 'transform'; ids: string[]; center: Point; scale: number; angle: number; delta: Point }
  | { type: 'style'; ids: string[]; color?: string; width?: number }
  | { type: 'paste'; annotations: InkObject[]; sourceWidthPt: number; ids: string[]; delta?: Point }
  | { type: 'reshape'; id: string; hit: ShapeHit; start: Point; end: Point; keepAspect: boolean }
  | { type: 'erase'; path: Point[]; radius: number; partial: boolean; highlightOnly: boolean; fragmentIdSeed: string }
  | { type: 'text'; id: string; text: string; at: Point; color: string; width: number };

function finite(...values: number[]) {
  if (values.some(value => !Number.isFinite(value))) throw new Error('non-finite-ink-operation');
}
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new Error('duplicate-ink-operation-id');
}

/** A world-space similarity composes with every canonical transform without flattening geometry. */
function similarity(annotation: InkObject, center: Point, scale: number, angle: number, delta: Point): InkObject {
  if (scale === 1 && angle === 0 && delta[0] === 0 && delta[1] === 0) return annotation;
  const t = annotation.transform, c = Math.cos(angle), s = Math.sin(angle);
  const x = (t.x - center[0]) * scale, y = (t.y - center[1]) * scale;
  return { ...annotation, transform: { x: center[0] + x * c - y * s + delta[0],
    y: center[1] + x * s + y * c + delta[1], rotationRad: t.rotationRad + angle,
    scaleX: t.scaleX * scale, scaleY: t.scaleY * scale } };
}

function bounds(annotations: InkObject[]) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const annotation of annotations) for (const p of annotationPoints(annotation)) {
    finite(p.x, p.y);
    left = Math.min(left, p.x); top = Math.min(top, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y);
  }
  return { left, top, right, bottom };
}

/** Fit the group, not its individual points. Exact ellipse extrema determine the boundary. */
function fit(annotations: InkObject[], page: Page): InkObject[] {
  if (!annotations.length) return annotations;
  const b = bounds(annotations), width = b.right - b.left, height = b.bottom - b.top;
  const scale = Math.min(1, width > page.widthPt ? .98 * page.widthPt / width : 1,
    height > page.heightPt ? .98 * page.heightPt / height : 1);
  const scaled = scale === 1 ? annotations : annotations.map(a => similarity(a, [b.left, b.top], scale, 0, [0, 0]));
  const next = bounds(scaled);
  const x = next.left < 0 ? -next.left : next.right > page.widthPt ? page.widthPt - next.right : 0;
  const y = next.top < 0 ? -next.top : next.bottom > page.heightPt ? page.heightPt - next.bottom : 0;
  return x === 0 && y === 0 ? scaled : scaled.map(a => similarity(a, [0, 0], 1, 0, [x, y]));
}

function localPoint(annotation: InkObject, point: Point, page: Page): LocalPoint {
  const t = annotation.transform, c = Math.cos(t.rotationRad), s = Math.sin(t.rotationRad);
  const x = point[0] * page.widthPt - t.x, y = point[1] * page.heightPt - t.y;
  return { x: (c * x + s * y) / t.scaleX, y: (-s * x + c * y) / t.scaleY };
}

/** Limit a handle's deformation instead of translating its fixed opposite corner at the edge. */
function constrainShape(before: InkObject, requested: InkObject, page: Page): InkObject {
  const inside = (annotation: InkObject) => {
    const b = bounds([annotation]);
    return b.left >= -1e-9 && b.top >= -1e-9 && b.right <= page.widthPt + 1e-9 && b.bottom <= page.heightPt + 1e-9;
  };
  if (inside(requested)) return requested;
  // Previously imported out-of-page geometry has no valid fixed anchor to preserve.
  if (!inside(before)) return fit([requested], page)[0];
  const interpolate = (fraction: number): InkObject => {
    const number = (a: number, b: number) => a + (b - a) * fraction;
    const point = (a: LocalPoint, b: LocalPoint) => ({ x: number(a.x, b.x), y: number(a.y, b.y) });
    const a = before.geometry, b = requested.geometry;
    let geometry = b;
    if ((a.kind === 'rect' && b.kind === 'rect') || (a.kind === 'ellipse' && b.kind === 'ellipse'))
      geometry = { ...b, widthPt: number(a.widthPt, b.widthPt), heightPt: number(a.heightPt, b.heightPt) };
    else if (a.kind === 'line' && b.kind === 'line') geometry = { ...b, start: point(a.start, b.start), end: point(a.end, b.end) };
    else if (a.kind === 'arrow' && b.kind === 'arrow') geometry = { ...b, start: point(a.start, b.start), end: point(a.end, b.end), headLengthPt: number(a.headLengthPt, b.headLengthPt) };
    return { ...requested, geometry, transform: { ...requested.transform,
      x: number(before.transform.x, requested.transform.x), y: number(before.transform.y, requested.transform.y) } };
  };
  let low = 0, high = 1, result = before;
  for (let i = 0; i < 36; i++) {
    const fraction = (low + high) / 2, candidate = interpolate(fraction);
    if (inside(candidate)) { low = fraction; result = candidate; } else high = fraction;
  }
  return result;
}

function reshape(annotation: InkObject, operation: Extract<CanonicalInkOperation, { type: 'reshape' }>, page: Page): InkObject {
  finite(...operation.start, ...operation.end);
  const g = annotation.geometry, hit = operation.hit;
  if (!['line', 'arrow', 'rect', 'ellipse'].includes(g.kind)
    || (hit.part !== 'handle' && !(g.kind === 'ellipse' && hit.part === 'rim'))
    || (hit.part === 'handle' && (!Number.isInteger(hit.index) || hit.index < 0 || hit.index >= (g.kind === 'line' || g.kind === 'arrow' ? 2 : 4)))) throw new Error('invalid-ink-handle');
  if (operation.start.every((value, i) => value === operation.end[i])) return annotation;
  const projected = projectInkObject(annotation, page);
  if ((g.kind === 'line' || g.kind === 'arrow') && hit.part === 'handle') {
    const at = projected.points[hit.index];
    const moved: Point = [Math.max(0, Math.min(1, at[0] + operation.end[0] - operation.start[0])),
      Math.max(0, Math.min(1, at[1] + operation.end[1] - operation.start[1]))];
    const start = hit.index === 0 ? localPoint(annotation, moved, page) : g.start;
    const end = hit.index === 1 ? localPoint(annotation, moved, page) : g.end;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length < 1e-9) return annotation;
    const geometry = g.kind === 'line' ? { ...g, start, end }
      : { ...g, start, end, headLengthPt: Math.min(g.preferredHeadLengthPt ?? g.headLengthPt, length * .3) };
    return constrainShape(annotation, { ...annotation, geometry }, page);
  }
  if (g.kind !== 'rect' && g.kind !== 'ellipse') throw new Error('invalid-ink-handle');
  // Borrow the mature handle constraints, then apply only the changed local box to the original object.
  const shaped = reshapeShape(projected, hit, operation.start, operation.end, page.heightPt / page.widthPt, operation.keepAspect);
  const witnesses = g.kind === 'rect' ? shaped.points.slice(0, 4) : [0, 16, 32, 48].map(i => shaped.points[i]);
  const local = witnesses.map(point => localPoint(annotation, point, page));
  const x = Math.min(...local.map(point => point.x)), y = Math.min(...local.map(point => point.y));
  const widthPt = Math.max(...local.map(point => point.x)) - x, heightPt = Math.max(...local.map(point => point.y)) - y;
  if (widthPt < 1e-9 || heightPt < 1e-9) return annotation;
  const origin = transformInkPoint(annotation, { x, y });
  return constrainShape(annotation, { ...annotation, geometry: { ...g, widthPt, heightPt }, transform: { ...annotation.transform, ...origin } }, page);
}

function editText(previous: InkObject | undefined, operation: Extract<CanonicalInkOperation, { type: 'text' }>, page: Page): InkObject {
  finite(...operation.at, operation.width);
  if (!operation.text.trim()) throw new Error('empty-ink-text');
  if (previous && previous.geometry.kind !== 'text') throw new Error('text-required');
  if (previous?.geometry.kind === 'text' && operation.text === previous.geometry.text) return previous;
  const fontSizePt = previous?.geometry.kind === 'text' ? previous.geometry.fontSizePt : .025 * page.widthPt;
  const lines = operation.text.split('\n');
  const geometry = { kind: 'text' as const, text: operation.text, fontSizePt,
    fontFamily: previous?.geometry.kind === 'text' ? previous.geometry.fontFamily : 'sans-serif',
    widthPt: Math.max(1, ...lines.map(textUnits)) * fontSizePt, heightPt: lines.length * 1.3 * fontSizePt };
  const annotation: InkObject = previous ? { ...previous, geometry }
    : { kind: 'ink', id: operation.id, geometry, transform: { x: operation.at[0] * page.widthPt, y: operation.at[1] * page.heightPt, rotationRad: 0, scaleX: 1, scaleY: 1 },
      style: { color: operation.color, widthPt: operation.width * page.widthPt, highlighter: false, opacity: 1 } };
  return fit([annotation], page)[0];
}

/** Produce one atomic page edit. Existing annotations are never reconstructed from their surface projection. */
export function applyCanonicalInkOperation(page: Page, operation: CanonicalInkOperation): {
  annotations: PageAnnotation[]; changes: AnnotationChange[]; createdIds: string[];
} {
  validatePage(page); assertPage(page);
  const originals = new Map(page.annotations.map(annotation => [annotation.id, annotation]));
  let annotations = page.annotations, createdIds: string[] = [];
  if (operation.type === 'reshape' || operation.type === 'text') {
    const before = originals.get(operation.id);
    if (before && before.kind !== 'ink') throw new Error('ink-required');
    if (operation.type === 'reshape' && !before) throw new Error('missing-ink-operation-target');
    const updated = operation.type === 'reshape' ? reshape(before as InkObject, operation, page) : editText(before, operation, page);
    annotations = before ? page.annotations.map(annotation => annotation.id === operation.id ? updated : annotation) : [...page.annotations, updated];
    if (!before) createdIds = [updated.id];
  } else if (operation.type === 'erase') {
    const cursor = new CanonicalEraseCursor(page, operation);
    cursor.append(operation.path); annotations = cursor.getAnnotations();
  } else if (operation.type === 'create' || operation.type === 'paste') {
    let created: InkObject[];
    if (operation.type === 'create') created = operation.drafts.map(draft => inkObjectFromDraft(draft, page));
    else {
      finite(operation.sourceWidthPt);
      if (operation.sourceWidthPt <= 0 || operation.ids.length !== operation.annotations.length) throw new Error('invalid-ink-paste');
      const delta = operation.delta ?? [.025, .025 * page.widthPt / page.heightPt];
      finite(...delta);
      const scale = page.widthPt / operation.sourceWidthPt;
      created = fit(operation.annotations.map((annotation, i) => {
        if (annotation.kind !== 'ink') throw new Error('ink-required');
        return similarity({ ...structuredClone(annotation), id: operation.ids[i] }, [0, 0], scale, 0,
          [delta[0] * page.widthPt, delta[1] * page.heightPt]);
      }), page);
    }
    createdIds = created.map(annotation => annotation.id); unique(createdIds);
    if (createdIds.some(id => originals.has(id))) throw new Error('existing-ink-operation-id');
    annotations = [...page.annotations, ...created];
  } else {
    unique(operation.ids);
    const selected = operation.ids.map(id => {
      const annotation = originals.get(id);
      if (!annotation || annotation.kind !== 'ink') throw new Error('missing-ink-operation-target');
      return annotation;
    });
    const ids = new Set(operation.ids);
    if (operation.type === 'delete') annotations = page.annotations.filter(annotation => !ids.has(annotation.id));
    else {
      let updated: InkObject[];
      if (operation.type === 'transform') {
        finite(...operation.center, operation.scale, operation.angle, ...operation.delta);
        if (operation.scale <= 0) throw new Error('invalid-ink-scale');
        updated = fit(selected.map(annotation => similarity(annotation,
          [operation.center[0] * page.widthPt, operation.center[1] * page.heightPt], operation.scale, operation.angle,
          [operation.delta[0] * page.widthPt, operation.delta[1] * page.heightPt])), page);
      } else {
        if (operation.width !== undefined) { finite(operation.width); if (operation.width <= 0) throw new Error('invalid-ink-width'); }
        updated = selected.map(annotation => ({ ...annotation, style: { ...annotation.style,
          ...(operation.color === undefined ? {} : { color: operation.color }),
          ...(operation.width === undefined ? {} : { widthPt: operation.width * page.widthPt / Math.max(annotation.transform.scaleX, annotation.transform.scaleY) }) } }));
      }
      const replacements = new Map(updated.map(annotation => [annotation.id, annotation]));
      annotations = page.annotations.map(annotation => replacements.get(annotation.id) ?? annotation);
    }
  }
  return canonicalInkResult(page, annotations);
}

/** Validate and describe a completed canonical preview using the same atomic page diff. */
export function canonicalInkResult(page: Page, annotations: PageAnnotation[]): {
  annotations: PageAnnotation[]; changes: AnnotationChange[]; createdIds: string[];
} {
  const originals = new Map(page.annotations.map(annotation => [annotation.id, annotation]));
  const createdIds = annotations.filter(annotation => !originals.has(annotation.id)).map(annotation => annotation.id);
  const result = { ...page, annotations };
  validatePage(result); assertPage(result);
  const remaining = new Set(annotations.map(annotation => annotation.id));
  const changes: AnnotationChange[] = page.annotations.filter(annotation => !remaining.has(annotation.id)).map(annotation => ({ type: 'delete', id: annotation.id }));
  for (const annotation of annotations) {
    const before = originals.get(annotation.id);
    if (!before) changes.push({ type: 'create', annotation });
    else if (before !== annotation && canonicalJson(before) !== canonicalJson(annotation)) changes.push({ type: 'update', annotation });
  }
  const appliedOrder = [...page.annotations.filter(annotation => remaining.has(annotation.id)).map(annotation => annotation.id), ...createdIds];
  const desiredOrder = annotations.map(annotation => annotation.id);
  if (canonicalJson(appliedOrder) !== canonicalJson(desiredOrder)) changes.push({ type: 'order', ids: desiredOrder });
  return { annotations, changes, createdIds };
}
