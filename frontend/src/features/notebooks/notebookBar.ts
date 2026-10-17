import { createContext } from "react";

/**
 * What the notebook's toolbar tells the writing tools drawn into it (they are rendered by the page, see
 * PdfPane, and placed in the toolbar by a portal): whether the colours and width have room beside the
 * tools, and where a failed save is reported.
 */
export type NotebookBar = {
  inlineStyle: boolean;
  alertSlot: HTMLElement | null;
};

export const NotebookBarContext = createContext<NotebookBar>({ inlineStyle: false, alertSlot: null });
