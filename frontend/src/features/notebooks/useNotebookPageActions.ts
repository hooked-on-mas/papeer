import { createContext, useContext, useState } from "react";
import { askConfirm } from "@/components/AppDialogs";
import { showError } from "@/components/errorDialog";
import { changeNotebook, useNotebookBusy, type NotebookChange, type NotebookDocument, type NotebookPaper } from "./notebooks";

/** The page the 用紙を変更 dialog is open for, with the paper it has now. */
export type PaperTarget = { pageId: string; number: number; paper: NotebookPaper };

/**
 * What can be done to a notebook's pages, shared by the page sidebar, the menu over the paper and the
 * button at the paper's corner. Every change goes through `changeNotebook`: the writing is saved first,
 * the page structure is not touched when that fails, and nothing else is done while one change is under
 * way (`busy`).
 */
export type NotebookPageActions = {
  /** A page change is under way: the writing tools and these actions wait for it. */
  busy: boolean;
  count: number;
  insert: (pageId: string, position: "before" | "after") => Promise<boolean>;
  append: () => Promise<boolean>;
  duplicate: (pageId: string) => Promise<boolean>;
  remove: (pageId: string) => Promise<boolean>;
  /** Puts page `from` where page `to` is. */
  reorder: (from: string, to: string) => Promise<boolean>;
  /** Moves a page by `delta` places in the order (Alt+↑↓ on a thumbnail). */
  shift: (pageId: string, delta: number) => Promise<boolean>;
  /** Opens the dialog that changes the page's paper. */
  editPaper: (pageId: string) => void;
  paperTarget: PaperTarget | null;
  closePaper: () => void;
  applyPaper: (spec: NotebookPaper) => Promise<boolean>;
};

export const NotebookPageActionsContext = createContext<NotebookPageActions | null>(null);

/** The page actions of the notebook on screen; the menus and buttons drawn inside NotebookView use them. */
export function usePageActions(): NotebookPageActions {
  const actions = useContext(NotebookPageActionsContext);
  if (!actions) throw new Error("The page actions are provided by NotebookView");
  return actions;
}

export function useNotebookPageActions(id: string, document: NotebookDocument | undefined): NotebookPageActions {
  const busy = useNotebookBusy((s) => s.ids.includes(id));
  const [paperTarget, setPaperTarget] = useState<PaperTarget | null>(null);
  const pages = document?.pages ?? [];

  const run = async (change: Omit<NotebookChange, "revision">) => {
    // A change already under way is not queued behind: the tools and menus are off meanwhile.
    if (!document || useNotebookBusy.getState().ids.includes(id)) return false;
    try { await changeNotebook(id, document, change); return true; }
    catch (error) { showError(error, "ページを変更できませんでした。書き込みを保存してから再試行してください"); return false; }
  };
  const reorder = async (from: string, to: string) => {
    const order = pages.map((item) => item.id);
    const source = order.indexOf(from), target = order.indexOf(to);
    if (source < 0 || target < 0 || source === target) return false;
    order.splice(target, 0, order.splice(source, 1)[0]);
    return run({ action: "reorder", order });
  };

  return {
    busy,
    count: pages.length,
    insert: (pageId, position) => run({ action: "insert", page_id: pageId, position }),
    append: () => run({ action: "append" }),
    duplicate: (pageId) => run({ action: "duplicate", page_id: pageId }),
    remove: async (pageId) => {
      const number = pages.findIndex((item) => item.id === pageId) + 1;
      if (!number || pages.length <= 1) return false;
      if (!(await askConfirm("ページを削除", `p.${number}と、このページの書き込み・付箋を削除します。元に戻せません。`, "削除", true))) return false;
      return run({ action: "delete", page_id: pageId });
    },
    reorder,
    shift: async (pageId, delta) => {
      const target = pages[pages.findIndex((item) => item.id === pageId) + delta];
      return target ? reorder(pageId, target.id) : false;
    },
    editPaper: (pageId) => {
      const index = pages.findIndex((item) => item.id === pageId);
      const page = pages[index];
      if (page) setPaperTarget({ pageId, number: index + 1, paper: { size: page.size, orientation: page.orientation, template: page.template, color: page.color } });
    },
    paperTarget,
    closePaper: () => { if (!busy) setPaperTarget(null); },
    applyPaper: async (spec) => {
      if (!paperTarget) return false;
      const done = await run({ action: "paper", page_id: paperTarget.pageId, spec });
      if (done) setPaperTarget(null);
      return done;
    },
  };
}
