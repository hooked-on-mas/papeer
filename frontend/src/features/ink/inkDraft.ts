import { boundsOf, constrainedShapeEnd, fitInk, kindOf, SHAPE_KINDS, shapePoints, type InkKind, type InkStroke, type Point } from './inkGeometry.ts';
import { traceFeature } from '../../runtime/featureTrace.ts';

export type DrawingKind = Exclude<InkKind, 'text'>;
export const DRAWING_KINDS = [
  ['pen', 'ペン'], ['highlighter', '蛍光ペン'], ['line', '直線'],
  ['arrow', '矢印'], ['rectangle', '四角'], ['ellipse', '丸'],
] as const satisfies readonly (readonly [DrawingKind, string])[];

/** Input adapters supply page coordinates; drawing rules never depend on the host. */
export function beginInkDraft(id: string, kind: DrawingKind, at: Point, color: string, width: number): InkStroke {
  traceFeature('reader.ink-draft', id, `begin:${kind}`);
  return { id, kind, color, width, points: [at], ...(kind === 'arrow' ? { arrowHeadLength: .025 } : {}) };
}

export function advanceInkDraft(stroke: InkStroke, start: Point, samples: readonly Point[], ratio: number,
  { straightHighlighter = false, shift = false }: { straightHighlighter?: boolean; shift?: boolean } = {}): InkStroke {
  const kind = kindOf(stroke), end = samples[samples.length - 1];
  if (!end) return stroke;
  if (kind === 'pen' || (kind === 'highlighter' && !straightHighlighter && !shift)) {
    const points = [...stroke.points];
    for (const next of samples) {
      const previous = points[points.length - 1];
      if (points.length < 20000 && Math.hypot(next[0] - previous[0], (next[1] - previous[1]) * ratio) > .0004) points.push(next);
    }
    return { ...stroke, points };
  }
  const constrained = kind === 'highlighter' && shift ? [end[0], start[1]] as Point
    : shift ? constrainedShapeEnd(kind, start, end, ratio) : end;
  return { ...stroke, points: shapePoints(kind, start, constrained, ratio) };
}

/** A tap may produce a pen dot, but must never persist a zero-sized shape. */
export function inkDraftHasSize(stroke: InkStroke, ratio: number): boolean {
  const kind = kindOf(stroke);
  if (!SHAPE_KINDS.includes(kind)) return true;
  const box = boundsOf([stroke]);
  if (!box || Math.hypot(box.width, box.height * ratio) <= .003) return false;
  return kind !== 'rectangle' && kind !== 'ellipse' || box.width > .0004 && box.height * ratio > .0004;
}

export function finishInkDraft(stroke: InkStroke, ratio: number): InkStroke | null {
  return inkDraftHasSize(stroke, ratio) ? fitInk([stroke], ratio)[0] : null;
}
