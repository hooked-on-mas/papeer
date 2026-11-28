import { useMemo, type RefObject } from "react";
import { useStore } from "@/store";
import { useNotebookBusy } from "@/features/notebooks/notebooks";
import { useWritingContact, writingContactActive } from "@/features/notebooks/writingContact";
import { changeZoom, focusPageInput, historyBack, historyForward, jumpToPage, movePage, moveToEdgePage, resetZoom, setZoomOf, zoomOf, type ZoomSubject } from "./navigation";
import type { ReaderCommandPort } from "./navigation/readerCommands";
import { useReaderInput } from "./useLegacyReaderInput";

/** Desktop state/commands are kept outside the input controller used by both hosts. */
export function desktopReaderCommands(zoomSubject: ZoomSubject): ReaderCommandPort {
  const blocked = () => {
    const id = useStore.getState().activePaperId;
    return !id || useNotebookBusy.getState().ids.includes(id) || writingContactActive();
  };
  return {
    getSnapshot: () => ({ active: useStore.getState().activeTab === "reader", blocked: blocked(), zoom: zoomOf(zoomSubject) }),
    dispatch(command) {
      if (blocked()) return { status: "blocked" };
      const before = useStore.getState();
      const beforeZoom = zoomOf(zoomSubject);
      switch (command.type) {
        case "step": movePage(command.amount, { toEnd: command.toEnd }); break;
        case "jump":
          if (!Number.isFinite(command.page)) return { status: "blocked" };
          jumpToPage(command.page);
          if (command.toEnd) {
            const state = useStore.getState();
            state.setReaderJump({ paperId: state.activePaperId!, page: state.currentPage, side: "original", text: "", anchor_y: 1, toEnd: true });
          }
          break;
        case "edge": moveToEdgePage(command.edge); break;
        case "history": if (command.direction === "back") historyBack(); else historyForward(); break;
        case "zoom": setZoomOf(zoomSubject, command.value); break;
        case "zoom-step": changeZoom(command.steps, zoomSubject); break;
        case "zoom-reset": resetZoom(zoomSubject); break;
        case "focus-page-input": focusPageInput(); return { status: "applied" };
      }
      const after = useStore.getState();
      return { status: before.currentPage !== after.currentPage || before.readerJump !== after.readerJump
        || before.readerHistory !== after.readerHistory || beforeZoom !== zoomOf(zoomSubject) ? "applied" : "unchanged" };
    },
  };
}

/** Compatibility host for the PDF reader and notebook; neither owns a separate input implementation. */
export function useViewerInput({ zoomSubject = "pdf", ...input }: {
  rootRef: RefObject<HTMLElement | null>;
  panes: RefObject<HTMLElement | null>[];
  wheelTurns: () => boolean;
  resetKey: unknown;
  zoomSubject?: ZoomSubject;
}) {
  useWritingContact();
  const commands = useMemo(() => desktopReaderCommands(zoomSubject), [zoomSubject]);
  return useReaderInput({ ...input, commands });
}
