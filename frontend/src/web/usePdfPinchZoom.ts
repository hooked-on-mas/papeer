import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const MIN_PDF_ZOOM = .5;
export const MAX_PDF_ZOOM = 4;

/** Pinch only the PDF surface: browser zoom would also enlarge and hide its controls. */
export function usePdfPinchZoom(container: RefObject<HTMLDivElement | null>, zoom: number, onZoom?: (zoom: number) => void, pageKey?: string) {
  const currentZoom = useRef(zoom);
  const pendingScroll = useRef<{ pane: HTMLElement; left: number; top: number } | undefined>(undefined);
  useLayoutEffect(() => {
    currentZoom.current = zoom;
    const pending = pendingScroll.current;
    if (pending) {
      pending.pane.scrollTo(pending.left, pending.top);
      pendingScroll.current = undefined;
    }
  }, [zoom]);
  useEffect(() => {
    const root = container.current;
    const pane = root?.closest<HTMLElement>(".web-pdf-pane");
    if (!root || !pane || !onZoom) return;
    type Pinch = { surface: HTMLElement; ids: number[]; distance: number; x: number; y: number; anchorX: number; anchorY: number;
      left: number; top: number; zoom: number; nextZoom: number; dx: number; dy: number };
    let pinch: Pinch | undefined;
    let suppressTouch = false;
    const pens = new Set<number>();
    const sample = (touches: TouchList, ids?: number[]) => {
      const pair = Array.from(touches).filter(touch => !ids || ids.includes(touch.identifier));
      if (pair.length !== 2) return;
      const [a, b] = pair;
      return { ids: [a.identifier, b.identifier], x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2,
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
    };
    const clearPreview = () => {
      if (!pinch) return;
      pinch.surface.style.removeProperty("transform");
      pinch.surface.style.removeProperty("transform-origin");
      pinch.surface.style.removeProperty("will-change");
    };
    const start = (event: TouchEvent) => {
      if (pinch || pens.size || event.touches.length !== 2) return;
      const surface = (event.target as Element).closest<HTMLElement>(".web-pdf-surface");
      if (!surface || !root.contains(surface)) return;
      const at = sample(event.touches);
      if (!at || at.distance < 1) return;
      event.preventDefault(); suppressTouch = true;
      const bounds = surface.getBoundingClientRect();
      pinch = { surface, ...at, anchorX: at.x - bounds.left, anchorY: at.y - bounds.top,
        left: pane.scrollLeft, top: pane.scrollTop, zoom: currentZoom.current, nextZoom: currentZoom.current, dx: 0, dy: 0 };
      surface.style.transformOrigin = `${pinch.anchorX}px ${pinch.anchorY}px`;
      surface.style.willChange = "transform";
    };
    const move = (event: TouchEvent) => {
      if (suppressTouch) event.preventDefault();
      if (!pinch) return;
      const at = sample(event.touches, pinch.ids);
      if (!at) return;
      pinch.nextZoom = Math.round(Math.max(MIN_PDF_ZOOM, Math.min(MAX_PDF_ZOOM, pinch.zoom * at.distance / pinch.distance)) * 100) / 100;
      pinch.dx = at.x - pinch.x; pinch.dy = at.y - pinch.y;
      // Preview the existing canvas and its ink together; redraw only after release.
      pinch.surface.style.transform = `translate(${pinch.dx}px, ${pinch.dy}px) scale(${pinch.nextZoom / pinch.zoom})`;
    };
    const end = (event: TouchEvent) => {
      if (suppressTouch) event.preventDefault();
      if (pinch && event.touches.length < 2) {
        const scale = pinch.nextZoom / pinch.zoom;
        const next = { pane, left: pinch.left + pinch.anchorX * (scale - 1) - pinch.dx,
          top: pinch.top + pinch.anchorY * (scale - 1) - pinch.dy };
        clearPreview();
        const nextZoom = pinch.nextZoom;
        pinch = undefined;
        if (nextZoom !== currentZoom.current) { pendingScroll.current = next; onZoom(nextZoom); }
        else pane.scrollTo(next.left, next.top);
      }
      if (!event.touches.length) suppressTouch = false;
    };
    const cancel = () => { clearPreview(); pinch = undefined; suppressTouch = false; };
    const interrupt = () => { pens.clear(); cancel(); };
    const penDown = (event: PointerEvent) => { if (event.pointerType === "pen") { pens.add(event.pointerId); cancel(); } };
    const penUp = (event: PointerEvent) => { pens.delete(event.pointerId); };
    // Safari also emits GestureEvents; cancel their viewport zoom only on the PDF.
    const safariGesture = (event: Event) => { if ((event.target as Element).closest(".web-pdf-surface")) event.preventDefault(); };
    const options = { passive: false, capture: true };
    root.addEventListener("touchstart", start, options);
    root.addEventListener("touchmove", move, options);
    root.addEventListener("touchend", end, options);
    root.addEventListener("touchcancel", cancel, options);
    root.addEventListener("gesturestart", safariGesture, options);
    root.addEventListener("gesturechange", safariGesture, options);
    root.addEventListener("pointerdown", penDown, true);
    window.addEventListener("pointerup", penUp, true);
    window.addEventListener("pointercancel", penUp, true);
    window.addEventListener("blur", interrupt);
    window.addEventListener("resize", interrupt);
    return () => {
      cancel(); pendingScroll.current = undefined;
      root.removeEventListener("touchstart", start, true);
      root.removeEventListener("touchmove", move, true);
      root.removeEventListener("touchend", end, true);
      root.removeEventListener("touchcancel", cancel, true);
      root.removeEventListener("gesturestart", safariGesture, true);
      root.removeEventListener("gesturechange", safariGesture, true);
      root.removeEventListener("pointerdown", penDown, true);
      window.removeEventListener("pointerup", penUp, true);
      window.removeEventListener("pointercancel", penUp, true);
      window.removeEventListener("blur", interrupt);
      window.removeEventListener("resize", interrupt);
    };
  }, [container, onZoom, pageKey]);
}
