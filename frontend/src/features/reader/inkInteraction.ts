import { boundsOf, hitInk, hitShape, inBounds, kindOf, type InkKind, type InkStroke, type Point, type ShapeHit } from "./inkGeometry.ts";

export const SHAPE_LIFT_GRACE_MS = 300;

/** A shape tool edits only the explicitly selected shape; a click may select another of its kind. */
export function shapeToolTarget(strokes: InkStroke[], selectedId: string | undefined, kind: InkKind, p: Point, tolerance: number, ratio: number):
  { selected?: InkStroke; hit: ShapeHit | null; clickTarget?: InkStroke } {
  const selected = strokes.find(s => s.id === selectedId && kindOf(s) === kind);
  const hit = selected ? hitShape(selected, p, tolerance, ratio) : null;
  const clickTarget = [...strokes].reverse().find(s => kindOf(s) === kind && hitShape(s, p, tolerance, ratio));
  return { selected, hit, clickTarget };
}

/** Visible handles take precedence; another shape in front can be selected with a click. */
export function mayEditSelectedShape(target: ReturnType<typeof shapeToolTarget>, forceDraw: boolean, explicitHandle: boolean): boolean {
  return !!target.selected && !forceDraw && (explicitHandle || !target.clickTarget || target.clickTarget.id === target.selected.id);
}

/** Ignore no-op transforms so a click does not create an Undo step or clear Redo. */
export const inkChanged = (before: InkStroke[], after: InkStroke[]) => before.length !== after.length || before.some((s, i) => {
  const next = after[i];
  return s !== next && (s.id !== next.id || s.kind !== next.kind || s.text !== next.text || s.width !== next.width || s.color !== next.color || s.points.length !== next.points.length
    || s.points.some(([x, y], j) => Math.abs(x - next.points[j][0]) > 1e-10 || Math.abs(y - next.points[j][1]) > 1e-10));
});
const RESUME_RADIUS_PX = 24;

/** Only reconnect a brief Pencil lift near the dragged end of a shape.
 * CSS pixels keep the tolerance consistent across zoom levels and page sizes.
 * Freehand strokes stay separate so letters never gain accidental joins.
 */
export function canResumeShape({ kind, pointerType, elapsed, previous, next, width, height }: {
  kind: InkKind; pointerType: string; elapsed: number; previous: Point; next: Point; width: number; height: number;
}): boolean {
  return pointerType === "pen" && ["line", "arrow", "rectangle", "ellipse"].includes(kind)
    && elapsed >= 0 && elapsed <= SHAPE_LIFT_GRACE_MS
    && Math.hypot((next[0] - previous[0]) * width, (next[1] - previous[1]) * height) <= RESUME_RADIUS_PX;
}

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 8;
const PRESS_MARGIN = 0.01;

/**
 * What a right-click or long press on the page acts on: the current selection when the press lands in
 * its frame, else the writing under the press (which becomes the selection), else nothing.
 */
export function pressTarget(strokes: InkStroke[], selectedIds: string[], p: Point, ratio: number): string[] | null {
  const box = boundsOf(strokes.filter(s => selectedIds.includes(s.id)));
  if (box && inBounds(p, { x: box.x - PRESS_MARGIN, y: box.y - PRESS_MARGIN, width: box.width + 2 * PRESS_MARGIN, height: box.height + 2 * PRESS_MARGIN })) return selectedIds;
  const hit = [...strokes].reverse().find(s => hitInk(s, p, PRESS_MARGIN, ratio));
  return hit ? [hit.id] : null;
}
