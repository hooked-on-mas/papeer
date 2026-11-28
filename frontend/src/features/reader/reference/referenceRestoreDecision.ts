import { readingPlace, type PaneView, type ReadingPlace, type ZoomAnchor } from '../navigation/readingPlace.ts';

/** A native scroll can move before its notification, while resize invalidates the old draw.
 * Read those latest offsets against the last settled geometry, never the resized page. */
export function placeBeforeReferenceResize(held: ReadingPlace | null, prior: PaneView | null,
  live: { top: number; left: number; maxTop: number; maxLeft: number }): ReadingPlace | null {
  if (!held || !prior || !Object.values(live).every(Number.isFinite)) return held;
  const movedY = live.top !== prior.scrollTop, movedX = live.left !== prior.scrollLeft;
  if (!movedY && !movedX) return held;
  const latest = readingPlace({ ...prior, scrollTop: live.top, scrollLeft: live.left });
  if (!latest) return held;
  // A smaller layout can clamp an already observed offset. Keep that axis's intent.
  const clampedY = prior.scrollTop > live.maxTop && live.top === live.maxTop;
  const clampedX = prior.scrollLeft > live.maxLeft && live.left === live.maxLeft;
  return { x: movedX && !clampedX ? latest.x : held.x, y: movedY && !clampedY ? latest.y : held.y };
}

/** Stateless decisions; the hook retains the only pending intent and position. */
export type ReferenceRestoreIntent = { kind: 'place'; place: ReadingPlace | null } | { kind: 'zoom'; anchor: ZoomAnchor | null };
export function referenceReportCurrent(targetCurrent: boolean, paneCurrent: boolean, producerCurrent: boolean, zoomCurrent: boolean, generation: number, minimumGeneration: number): boolean {
  return targetCurrent && paneCurrent && producerCurrent && zoomCurrent && Number.isSafeInteger(generation) && generation >= minimumGeneration;
}
export function referenceRestoreDecision(intent: ReferenceRestoreIntent | null, settled: boolean): { apply: 'none' | 'place' | 'anchor'; consume: boolean } {
  if (!intent) return { apply: 'none', consume: false };
  return { apply: intent.kind === 'zoom' && intent.anchor ? 'anchor' : intent.kind === 'place' && settled ? 'place' : 'none', consume: settled };
}
export function referenceInputReady(active: boolean, allowed: boolean, current: boolean, settled: boolean): boolean {
  return active && allowed && current && settled;
}
export function referenceGestureContinues(active: boolean, samePane: boolean, admitted: boolean, allowed: boolean): boolean {
  return active && samePane && admitted && allowed;
}
/** Binding validity can change before React publishes a new binding. */
export function referenceDrawSettled<T extends { isCurrent(): boolean }>(captured: T | null, current: T | null, sameDraw: boolean, rasterReady: boolean): boolean {
  return !!captured && current === captured && sameDraw && rasterReady && captured.isCurrent();
}

/** Only an admitted same-pane continuation may bypass the fresh-input gate. */
export function referenceTouchAdmission(fresh: boolean, sameGesture: boolean, preservation: boolean): boolean {
  return fresh || (sameGesture && preservation);
}
