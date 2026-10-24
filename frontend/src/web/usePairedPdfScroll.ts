import { useLayoutEffect, type RefObject } from "react";
import { createScrollSync } from "../features/reader/scrollSync";
import { getPdfPinchOwner } from "./usePdfPinchZoom";

/** Follow the pane the reader is scrolling, without treating restored positions as user input. */
export function usePairedPdfScroll(root: RefObject<HTMLDivElement | null>, enabled: boolean, resetKey: string) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !enabled) return;
    const panes = [...element.querySelectorAll<HTMLElement>(".web-pdf-pane")];
    let leader: HTMLElement | null = null;
    const sync = createScrollSync(getPdfPinchOwner);
    const ready = (pane: HTMLElement) => pane.querySelector('.pdf[data-rendered="true"]')
      && !pane.querySelector<HTMLElement>(".web-pdf-surface")?.style.transform;
    const follow = () => {
      const target = panes.find(pane => pane !== leader);
      if (leader && target && ready(leader) && ready(target)) sync(leader, target);
    };
    const claim = (event: Event) => {
      if (!(event.target instanceof Element) || (event.type !== "wheel" && event.target.closest("button, a, input, select, textarea, summary"))) return;
      const pane = event.target.closest<HTMLElement>(".web-pdf-pane");
      if (pane && panes.includes(pane)) leader = pane;
    };
    const scroll = (event: Event) => { if (event.target === leader) follow(); };
    const resize = new ResizeObserver(() => { leader = null; });
    panes.forEach(pane => resize.observe(pane));
    // A translation can finish rendering after the user scrolled the original.
    const rendered = new MutationObserver(follow);
    rendered.observe(element, { subtree: true, attributes: true, attributeFilter: ["data-rendered"] });
    const inputEvents = ["pointerdown", "touchstart", "wheel", "keydown"] as const;
    inputEvents.forEach(type => element.addEventListener(type, claim, { capture: true, passive: true }));
    element.addEventListener("scroll", scroll, { capture: true, passive: true });
    return () => {
      resize.disconnect(); rendered.disconnect();
      inputEvents.forEach(type => element.removeEventListener(type, claim, true));
      element.removeEventListener("scroll", scroll, true);
    };
  }, [root, enabled, resetKey]);
}
