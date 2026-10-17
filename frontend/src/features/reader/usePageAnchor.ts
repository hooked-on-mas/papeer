import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useStore } from "@/store";
import { bindReaderViewport } from "./navigation";
import { onScreen } from "./pageTurn";
import { savedAnchor } from "./sidePanel";
import type { JumpTarget } from "./PdfPane";

/**
 * Where the view is on the page in `pane`, as JumpTarget.anchor_y takes it: jumping there again
 * brings back the same view.
 */
function viewAnchor(pane: HTMLElement | null): number | null {
  const page = pane?.querySelector<HTMLElement>(".react-pdf__Page");
  if (!pane || !page || !page.clientHeight) return null;
  const top = page.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  return Math.max(0, Math.min(1, (pane.scrollTop + pane.clientHeight * 0.25 - top) / page.clientHeight));
}

/**
 * Where an item is opened on its page, shared by the PDF reader and the notebook: the place it was last
 * left (paperAnchors, saved in ui-state.json) or a passage opened from the chat or a sticky note,
 * as the `jumpTarget` for the pane; the place within the page kept for the item, a moment after
 * scrolling stops (`recordAnchor`, for the pane's onScroll); and new pages starting at the top.
 * `panes` are the scrolling panes, the first of them the one the place is measured in.
 */
export function usePageAnchor({ paperId, panes }: { paperId: string | null; panes: RefObject<HTMLElement | null>[] }): {
  jumpTarget: JumpTarget | null;
  recordAnchor: (pane: HTMLElement) => void;
} {
  const currentPage = useStore((s) => s.currentPage);
  const [jumpTarget, setJumpTarget] = useState<JumpTarget | null>(null);
  const paneRefs = useRef(panes);
  paneRefs.current = panes;
  useEffect(() => bindReaderViewport(() => viewAnchor(paneRefs.current[0]?.current ?? null)), []);

  // A paper opens where its page was last left (paperAnchors, saved in ui-state.json), from the top otherwise;
  // a passage opened from the chat or a sticky note (the store's readerJump, taken here so that it is shown
  // once, not on every remount) takes the place of that. Until the view has moved there, the scrolls to the top
  // of the page on the way are not kept (recordAnchor).
  // One effect for both, which restores only when the paper has changed: where it runs twice on mounting (React's
  // strict mode), the second run must not put back the place over the jump the first one took.
  const restoringAnchor = useRef(false);
  const openedPaper = useRef<string | null | undefined>(undefined);
  const readerJump = useStore((s) => s.readerJump);
  useEffect(() => {
    const store = useStore.getState();
    const jump = store.readerJump;
    if (jump) store.setReaderJump(null);
    const opened = openedPaper.current !== paperId;
    openedPaper.current = paperId;
    if (jump && jump.paperId === paperId) {
      if (opened) restoringAnchor.current = paperId ? store.paperAnchors[paperId] !== undefined : false;
      setJumpTarget({ id: Date.now(), page: jump.page, side: jump.side, anchor_y: jump.anchor_y, anchor_x: jump.anchor_x, passage: jump, toEnd: jump.toEnd });
    } else if (opened) {
      const anchor = paperId ? store.paperAnchors[paperId] : undefined;
      restoringAnchor.current = anchor !== undefined;
      setJumpTarget(anchor === undefined ? null : { id: Date.now(), page: store.currentPage, side: "original", anchor_y: anchor });
    }
  }, [readerJump, paperId]);

  // New pages start at the top, as in the old reader.
  useEffect(() => {
    for (const ref of paneRefs.current) if (ref.current) ref.current.scrollTop = 0;
  }, [currentPage, paperId]);

  // Keeps where the view is within the page for the paper, a moment after scrolling stops. Measured as
  // it scrolls, so that switching to another paper before then keeps the place in this one.
  const pendingAnchor = useRef<{ paperId: string; anchor: number | null } | null>(null);
  const anchorTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const commitAnchor = useCallback(() => {
    clearTimeout(anchorTimer.current);
    const pending = pendingAnchor.current;
    pendingAnchor.current = null;
    if (pending) useStore.getState().setPaperAnchor(pending.paperId, pending.anchor);
  }, []);
  const recordAnchor = useCallback((pane: HTMLElement) => {
    const id = useStore.getState().activePaperId;
    if (!id || !onScreen(pane)) return;
    // The saved place is only ever below the top, so the first scroll away from it is the move there
    // (or the reader's own scrolling, once it has given up on it).
    if (restoringAnchor.current) {
      if (pane.scrollTop <= 0) return;
      restoringAnchor.current = false;
    }
    pendingAnchor.current = { paperId: id, anchor: savedAnchor(pane.scrollTop, viewAnchor(pane)) };
    clearTimeout(anchorTimer.current);
    anchorTimer.current = setTimeout(commitAnchor, 500);
  }, [commitAnchor]);
  useEffect(() => commitAnchor, [paperId, commitAnchor]);

  return { jumpTarget, recordAnchor };
}
