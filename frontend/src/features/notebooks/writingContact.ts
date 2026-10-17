import { useEffect, useRef, useState, type RefObject } from "react";
import { contactAfter, penNear } from "./pageSidebar";

let down: ReadonlySet<number> = new Set();
let watchers = 0;
let remove: (() => void) | null = null;

function install() {
  const press = (kind: "down" | "up") => (event: PointerEvent) => { down = contactAfter(down, { kind, pointerId: event.pointerId, pointerType: event.pointerType }); };
  const onDown = press("down"), onUp = press("up");
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
  window.addEventListener("blur", () => { down = new Set(); });
  remove = () => {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
    down = new Set();
  };
}

/** Whether a pen is on the page now (or a mouse button held down on it): the wheel must not turn the page. */
export function writingContactActive(): boolean {
  return down.size > 0;
}

/** Watches the pointers for writingContactActive while the component is mounted. */
export function useWritingContact(): void {
  useEffect(() => {
    if (watchers++ === 0) install();
    return () => { if (--watchers === 0) { remove?.(); remove = null; } };
  }, []);
}

/** How long a pen that stopped moving over the page counts as near, in ms. */
const PEN_IDLE_MS = 1500;
/** How close to the button a hovering pen is taken to be on its way to it, in px. */
const PEN_REACH = 96;

/**
 * Whether the pen is at the page (touching it, or hovering near `target`), so that the button laid over
 * the paper's corner steps out of the way of the writing. A mouse or a finger never hides it.
 */
export function usePenNear(area: RefObject<HTMLElement | null>, target: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [near, setNear] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const element = area.current;
    if (!element || !enabled) { setNear(false); return; }
    const set = (value: boolean) => setNear((now) => now === value ? now : value);
    const idle = () => { clearTimeout(timer.current); timer.current = setTimeout(() => set(false), PEN_IDLE_MS); };
    const seen = (event: PointerEvent) => {
      if (event.pointerType !== "pen") return;
      const box = target.current?.getBoundingClientRect();
      // Touching anywhere on the page counts: the hand is on its way across it.
      if (event.buttons > 0 || (box && penNear({ x: event.clientX, y: event.clientY }, box, PEN_REACH))) { set(true); idle(); }
      else { clearTimeout(timer.current); set(false); }
    };
    const left = (event: PointerEvent) => { if (event.pointerType === "pen") { clearTimeout(timer.current); set(false); } };
    element.addEventListener("pointermove", seen, true);
    element.addEventListener("pointerdown", seen, true);
    element.addEventListener("pointerleave", left, true);
    return () => {
      clearTimeout(timer.current);
      element.removeEventListener("pointermove", seen, true);
      element.removeEventListener("pointerdown", seen, true);
      element.removeEventListener("pointerleave", left, true);
    };
  }, [area, target, enabled]);
  return near;
}
