import { touchSwipePage, type PaneEdges } from "../navigation/pageTurn.ts";
/** One shared recognition lifecycle for PointerEvent and TouchEvent adapters. */
export function createTouchSwipe() {
  let gesture: { x: number; y: number; maxY: number; edges: PaneEdges } | undefined;
  return {
    start(x: number, y: number, edges: PaneEdges) { gesture = { x, y, maxY: 0, edges }; },
    move(y: number) { if (gesture) gesture.maxY = Math.max(gesture.maxY, Math.abs(y - gesture.y)); },
    cancel() { gesture = undefined; },
    finish(x: number, y: number) {
      const start = gesture; gesture = undefined;
      return start ? touchSwipePage(x - start.x, Math.max(start.maxY, Math.abs(y - start.y)), start.edges) : 0;
    },
  };
}
