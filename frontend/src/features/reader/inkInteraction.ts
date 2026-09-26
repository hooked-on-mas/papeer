import type { InkKind, Point } from "./inkGeometry";

export const SHAPE_LIFT_GRACE_MS = 300;
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
