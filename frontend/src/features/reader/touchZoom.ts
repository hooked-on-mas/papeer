import { MIN_ZOOM, ZOOM_FIT_PAGE, ZOOM_PRESETS } from "./zoomLevels.ts";
import type { ZoomAnchor } from "./readingPlace.ts";

export interface TouchPoint { x: number; y: number }
export interface TouchPinch {
  distance: number;
  zoom: number;
  minZoom: number;
  fitZoom: number;
  x: number;
  y: number;
}

/** Capture the PDF point once; remeasuring it after every rounded scroll accumulates drift. */
export function beginTouchPinch(a: TouchPoint, b: TouchPoint, page: {
  left: number; top: number; width: number; height: number;
}, zoom: number, minZoom: number): TouchPinch {
  return {
    // The other pane can leave the shared zoom below this pane's fit-page size.
    // Start from that actual size without enlarging it to the local minimum.
    distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom,
    minZoom: zoom < minZoom ? Math.min(zoom, MIN_ZOOM) : minZoom, fitZoom: minZoom,
    x: ((a.x + b.x) / 2 - page.left) / page.width,
    y: ((a.y + b.y) / 2 - page.top) / page.height,
  };
}

/** Continuous scale, with the original PDF point following the moving finger midpoint. */
export function moveTouchPinch(pinch: TouchPinch, a: TouchPoint, b: TouchPoint): { zoom: number; anchor: ZoomAnchor } {
  const scale = Math.max(pinch.minZoom, Math.min(ZOOM_PRESETS[ZOOM_PRESETS.length - 1],
    pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance));
  return {
    zoom: scale <= pinch.minZoom && pinch.minZoom === pinch.fitZoom ? ZOOM_FIT_PAGE : scale,
    anchor: { x: pinch.x, y: pinch.y, atX: (a.x + b.x) / 2, atY: (a.y + b.y) / 2 },
  };
}
