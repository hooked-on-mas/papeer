import type { RefObject } from "react";
import { usePairedReaderScroll } from "../features/reader/navigation/usePairedReaderScroll";
import { getPdfPinchOwner } from "./usePdfPinchZoom";

/** The browser host supplies its pane markup; user ownership and synchronization are shared. */
export function usePairedPdfScroll(root: RefObject<HTMLDivElement | null>, enabled: boolean, resetKey: string) {
  usePairedReaderScroll({ rootRef: root, enabled, resetKey,
    panes: () => [...(root.current?.querySelectorAll<HTMLElement>(".web-pdf-pane") ?? [])],
    getOwner: () => getPdfPinchOwner(root.current),
    ready: pane => !!pane.querySelector('.pdf[data-rendered="true"]')
      && !pane.querySelector<HTMLElement>(".web-pdf-surface")?.style.transform,
  });
}
