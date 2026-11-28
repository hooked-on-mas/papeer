import { useLayoutEffect, useRef, type RefObject } from "react";
import { createScrollSync } from "./scrollSync";
import { READER_SCROLL_INTENT } from "./readerCommands";

type PaneRefs = readonly RefObject<HTMLElement | null>[];

/** Synchronize user-owned scrolling only. Restores, layout clamps and late canvases are not input. */
export function usePairedReaderScroll({ rootRef, panes, enabled, resetKey, getOwner, ready }: {
  rootRef: RefObject<HTMLElement | null>;
  panes: PaneRefs | (() => readonly HTMLElement[]);
  enabled: boolean;
  resetKey: unknown;
  getOwner: () => HTMLElement | null;
  ready: (pane: HTMLElement) => boolean;
}) {
  const current = useRef({ panes, getOwner, ready });
  current.current = { panes, getOwner, ready };
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    const readPanes = () => {
      const supplied = current.current.panes;
      return (typeof supplied === "function" ? supplied() : supplied.flatMap(ref => ref.current ? [ref.current] : []))
        .filter(pane => root.contains(pane));
    };
    let leader: HTMLElement | null = null;
    const sync = createScrollSync(() => {
      const owner = current.current.getOwner();
      return owner && readPanes().includes(owner) ? owner : null;
    });
    const follow = () => {
      const mounted = readPanes();
      if (!leader || !mounted.includes(leader) || !current.current.ready(leader)) return;
      for (const target of mounted) if (target !== leader && current.current.ready(target)) sync(leader, target);
    };
    const claim = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || (event.type !== "wheel" && target.closest("button, a, input, select, textarea, summary, [contenteditable=true]"))) return;
      const pane = readPanes().find(pane => pane.contains(target));
      if (pane) leader = pane;
    };
    const scroll = (event: Event) => { if (event.target === leader) follow(); };
    const resize = new ResizeObserver(() => { leader = null; });
    let observed = new Set<HTMLElement>();
    const observePanes = () => {
      const mounted = new Set(readPanes());
      for (const pane of observed) if (!mounted.has(pane)) { resize.unobserve(pane); if (leader === pane) leader = null; }
      for (const pane of mounted) if (!observed.has(pane)) resize.observe(pane);
      observed = mounted;
    };
    observePanes();
    // Both hosts expose data-rendered; a late translation catches up to the last user-scrolled pane.
    const rendered = new MutationObserver(() => { observePanes(); follow(); });
    rendered.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-rendered"] });
    const inputEvents = ["pointerdown", "touchstart", "wheel", "keydown", READER_SCROLL_INTENT] as const;
    inputEvents.forEach(type => root.addEventListener(type, claim, { capture: true, passive: true }));
    root.addEventListener("scroll", scroll, { capture: true, passive: true });
    return () => {
      resize.disconnect(); rendered.disconnect();
      inputEvents.forEach(type => root.removeEventListener(type, claim, true));
      root.removeEventListener("scroll", scroll, true);
    };
  }, [rootRef, enabled, resetKey]);
}
