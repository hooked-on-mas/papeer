import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const MIN_PDF_ZOOM = .5;
export const MAX_PDF_ZOOM = 4;
let activePinchPane: HTMLElement | undefined;

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
    type Pinch = { source: "touch" | "safari"; safariScale: number; surface: HTMLElement; ids: number[]; distance: number; x: number; y: number; anchorX: number; anchorY: number;
      left: number; top: number; zoom: number; nextZoom: number; dx: number; dy: number };
    let pinch: Pinch | undefined;
    let suppressTouch = false;
    let firstTouch: { x: number; y: number } | undefined;
    let safariActive = false;
    let safariScale = 1;
    const pens = new Set<number>();
    const inPane = (target: EventTarget | null) => target instanceof Element && target.closest(".web-pdf-pane") === pane
      && !target.closest("button, a, input, textarea, select, summary, [contenteditable=true]");
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
    const begin = (source: Pinch["source"], at: { x: number; y: number; distance: number; ids: number[] }) => {
      if (activePinchPane && activePinchPane !== pane) return;
      const surface = root.querySelector<HTMLElement>(".web-pdf-surface");
      if (!surface) return;
      activePinchPane = pane;
      clearPreview();
      const bounds = surface.getBoundingClientRect();
      pinch = { source, safariScale: safariActive ? safariScale : 1, surface, ...at, anchorX: at.x - bounds.left, anchorY: at.y - bounds.top,
        left: pane.scrollLeft, top: pane.scrollTop, zoom: currentZoom.current, nextZoom: currentZoom.current, dx: 0, dy: 0 };
      suppressTouch = true;
      surface.style.transformOrigin = `${pinch.anchorX}px ${pinch.anchorY}px`;
      surface.style.willChange = "transform";
    };
    const preview = (scale: number, x: number, y: number) => {
      if (!pinch) return;
      pinch.nextZoom = Math.round(Math.max(MIN_PDF_ZOOM, Math.min(MAX_PDF_ZOOM, pinch.zoom * scale)) * 100) / 100;
      pinch.dx = x - pinch.x; pinch.dy = y - pinch.y;
      // Preview the existing canvas and its ink together; redraw only after release.
      pinch.surface.style.transform = `translate(${pinch.dx}px, ${pinch.dy}px) scale(${pinch.nextZoom / pinch.zoom})`;
    };
    const start = (event: TouchEvent) => {
      if (activePinchPane && activePinchPane !== pane) return;
      if (pens.size || (!inPane(event.target) && !firstTouch)) return;
      if (event.touches.length === 1 && !pinch) {
        firstTouch = { x: event.touches[0].clientX, y: event.touches[0].clientY }; return;
      }
      if (pinch?.source === "touch" || event.touches.length !== 2) return;
      const at = sample(event.touches);
      if (!at || at.distance < 1) return;
      event.preventDefault();
      begin("touch", at);
    };
    const move = (event: TouchEvent) => {
      if (!pinch && event.touches.length === 2) start(event);
      if (suppressTouch) event.preventDefault();
      if (!pinch || pinch.source !== "touch") return;
      const at = sample(event.touches, pinch.ids);
      if (!at) return;
      preview(at.distance / pinch.distance, at.x, at.y);
    };
    const finish = () => {
      if (pinch) {
        const scale = pinch.nextZoom / pinch.zoom;
        const next = { pane, left: pinch.left + pinch.anchorX * (scale - 1) - pinch.dx,
          top: pinch.top + pinch.anchorY * (scale - 1) - pinch.dy };
        clearPreview();
        const nextZoom = pinch.nextZoom;
        pinch = undefined;
        if (activePinchPane === pane) activePinchPane = undefined;
        if (nextZoom !== currentZoom.current) { pendingScroll.current = next; onZoom(nextZoom); }
        else pane.scrollTo(next.left, next.top);
      }
    };
    const end = (event: TouchEvent) => {
      if (suppressTouch) event.preventDefault();
      if (event.touches.length < 2) finish();
      if (!event.touches.length) { suppressTouch = false; firstTouch = undefined; safariActive = false; }
    };
    const cancel = () => {
      clearPreview(); pinch = undefined; suppressTouch = false; firstTouch = undefined; safariActive = false; safariScale = 1;
      if (activePinchPane === pane) activePinchPane = undefined;
    };
    const interrupt = () => { pens.clear(); cancel(); };
    const penDown = (event: PointerEvent) => { if (event.pointerType === "pen") { pens.add(event.pointerId); cancel(); } };
    const penUp = (event: PointerEvent) => { pens.delete(event.pointerId); };
    // On iOS, gesturestart precedes touchstart #2 and can target a common ancestor.
    // Listen at document capture, scoped to this pane/its first finger, and support
    // GestureEvent.scale directly when WebKit does not deliver low-level touch moves.
    const safariGesture = (event: Event) => {
      if (activePinchPane && activePinchPane !== pane) return;
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      const hit = Number.isFinite(gesture.clientX) && Number.isFinite(gesture.clientY)
        ? document.elementFromPoint(gesture.clientX!, gesture.clientY!) : null;
      if (pens.size || (!safariActive && !firstTouch && !inPane(event.target) && !inPane(hit))) return;
      event.preventDefault();
      if (event.type === "gestureend") {
        if (pinch?.source === "safari") finish();
        safariActive = false;
        if (!firstTouch) suppressTouch = false;
        return;
      }
      if (event.type === "gesturestart") safariScale = 1;
      safariActive = true;
      const bounds = pane.getBoundingClientRect();
      const x = gesture.clientX || (pinch ? pinch.x + pinch.dx : firstTouch?.x) || bounds.left + bounds.width / 2;
      const y = gesture.clientY || (pinch ? pinch.y + pinch.dy : firstTouch?.y) || bounds.top + bounds.height / 2;
      if (!pinch) begin("safari", { x, y, distance: 1, ids: [] });
      if (event.type === "gesturechange" && pinch && Number.isFinite(gesture.scale) && gesture.scale! > 0) {
        safariScale = gesture.scale!;
        preview(safariScale / pinch.safariScale, x, y);
      }
    };
    const options = { passive: false, capture: true };
    pane.addEventListener("touchstart", start, options);
    pane.addEventListener("touchmove", move, options);
    pane.addEventListener("touchend", end, options);
    pane.addEventListener("touchcancel", cancel, options);
    document.addEventListener("gesturestart", safariGesture, options);
    document.addEventListener("gesturechange", safariGesture, options);
    document.addEventListener("gestureend", safariGesture, options);
    pane.addEventListener("pointerdown", penDown, true);
    window.addEventListener("pointerup", penUp, true);
    window.addEventListener("pointercancel", penUp, true);
    window.addEventListener("blur", interrupt);
    window.addEventListener("resize", interrupt);
    return () => {
      cancel(); pendingScroll.current = undefined;
      pane.removeEventListener("touchstart", start, true);
      pane.removeEventListener("touchmove", move, true);
      pane.removeEventListener("touchend", end, true);
      pane.removeEventListener("touchcancel", cancel, true);
      document.removeEventListener("gesturestart", safariGesture, true);
      document.removeEventListener("gesturechange", safariGesture, true);
      document.removeEventListener("gestureend", safariGesture, true);
      pane.removeEventListener("pointerdown", penDown, true);
      window.removeEventListener("pointerup", penUp, true);
      window.removeEventListener("pointercancel", penUp, true);
      window.removeEventListener("blur", interrupt);
      window.removeEventListener("resize", interrupt);
    };
  }, [container, onZoom, pageKey]);
}
