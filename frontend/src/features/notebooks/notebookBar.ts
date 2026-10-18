import { createContext } from "react";

/** Undo and Redo as the 「…」 menu uses them, when the row has no room for their buttons. */
export type NotebookHistory = {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
};

/**
 * What the notebook's toolbar tells the writing tools drawn into it (they are rendered by the page, see
 * PdfPane, and placed in the toolbar by a portal): whether the colours and width have room beside the
 * tools, whether Undo and Redo do (if not, the tools hand them to `setHistory` for the 「…」 menu), and
 * where a failed save is reported.
 */
export type NotebookBar = {
  inlineStyle: boolean;
  historyInBar: boolean;
  setHistory: (history: NotebookHistory | null) => void;
  alertSlot: HTMLElement | null;
};

export const NotebookBarContext = createContext<NotebookBar>({ inlineStyle: false, historyInBar: true, setHistory: () => {}, alertSlot: null });
