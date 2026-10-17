import { useEffect, useState, type RefObject } from "react";

/** The paper's place in the view, in CSS pixels. */
export type PaperBox = {
  /** Width of the area the paper is centred in (the scroller's, less its scrollbar). */
  viewWidth: number;
  /** The paper's width as drawn, 0 while it is not. */
  paperWidth: number;
  /** The scrollbar's width, which the view's right edge gives up. */
  gutter: number;
};

const UNKNOWN: PaperBox = { viewWidth: 0, paperWidth: 0, gutter: 0 };

/**
 * Follows the paper drawn by PdfPane inside `root`: the width of the view it is centred in and its own
 * width, re-measured whenever either changes (the window, a side panel, the zoom, a page of another
 * shape). The measurements are of the elements as laid out, so they are right at any zoom without
 * knowing how PdfPane sizes the page.
 */
export function usePaperBox(root: RefObject<HTMLElement | null>, resetKey: unknown): PaperBox {
  const [box, setBox] = useState<PaperBox>(UNKNOWN);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    // Another notebook starts from nothing known; the same one keeps its last width while its paper reloads.
    setBox(UNKNOWN);
    let frame = 0;
    let observed: Element[] = [];
    const resizes = new ResizeObserver(() => schedule());
    // PdfPane scales the paper with a style (CSS zoom) while it redraws at a new width.
    const styles = new MutationObserver(() => schedule());
    const measure = () => {
      frame = 0;
      const scroller = element.querySelector<HTMLElement>("[data-pdf-scroller]");
      const surface = element.querySelector<HTMLElement>("[data-pdf-surface]");
      const next = [scroller, surface].filter((item): item is HTMLElement => !!item);
      if (next.length !== observed.length || next.some((item, i) => item !== observed[i])) {
        resizes.disconnect();
        styles.disconnect();
        next.forEach((item) => resizes.observe(item));
        if (surface) styles.observe(surface, { attributes: true, attributeFilter: ["style"] });
        observed = next;
      }
      // The paper's element is gone for a moment whenever the notebook's file changes (a page added, moved or
      // deleted) and react-pdf loads it again: the width it had stays, so that what is placed by it does not jump.
      const drawn = surface ? Math.round(surface.getBoundingClientRect().width) : null;
      setBox((now) => {
        const measured: PaperBox = scroller ? {
          viewWidth: scroller.clientWidth, paperWidth: drawn ?? now.paperWidth, gutter: scroller.offsetWidth - scroller.clientWidth,
        } : UNKNOWN;
        return now.viewWidth === measured.viewWidth && now.paperWidth === measured.paperWidth && now.gutter === measured.gutter ? now : measured;
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    // The paper's element comes and goes as pages load and are replaced.
    const mutations = new MutationObserver(schedule);
    mutations.observe(element, { childList: true, subtree: true });
    resizes.observe(element);
    schedule();
    return () => { cancelAnimationFrame(frame); mutations.disconnect(); styles.disconnect(); resizes.disconnect(); };
  }, [root, resetKey]);
  return box;
}
