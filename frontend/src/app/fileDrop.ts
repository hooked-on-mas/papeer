import { useEffect } from "react";
import { create } from "zustand";
import { shell } from "@/shell";
import { useStore } from "@/store";
import { importPaths } from "./actions";
import { importMemoPaths } from "@/api/attachments";
import { queryClient } from "@/lib/queryClient";
import { showError } from "@/components/errorDialog";
import { selectMemo } from "@/features/notes/memoState";

/** Folder under an OS file drag: a collection path, or null when outside the library tree. */
export const useDropTarget = create<{ active: boolean; target: string | null }>(() => ({ active: false, target: null }));

function collectionAt(x: number, y: number): string | null {
  const element = document.elementFromPoint(x, y)?.closest("[data-drop-collection]");
  return element ? element.getAttribute("data-drop-collection") : null;
}

/**
 * PDFs dropped on a folder row go into that folder; anywhere else they go into the
 * current 追加先, as with the old window.
 */
export function useFileDrop(): void {
  useEffect(() => shell.onFileDrop((event) => {
    if (event.type === "leave") {
      useDropTarget.setState({ active: false, target: null });
      return;
    }
    const target = collectionAt(event.x, event.y);
    if (event.type === "over") {
      useDropTarget.setState({ active: true, target });
      return;
    }
    useDropTarget.setState({ active: false, target: null });
    const memos = event.paths.filter(path => path.toLowerCase().endsWith(".md"));
    if (memos.length) {
      const owner = document.elementFromPoint(event.x, event.y)?.closest("[data-memo-owner]")?.getAttribute("data-memo-owner");
      if (!owner || memos.length !== event.paths.length) {
        useStore.getState().setStatus(".md ファイルだけを論文の行かメモ欄にドロップしてください。");
        return;
      }
      void importMemoPaths(owner, memos, queryClient).then(rows => {
        if (rows[0]) selectMemo(owner, rows[0].id);
        useStore.getState().setStatus(`メモ ${rows.length}件を取り込みました。`);
      }).catch(error => showError(error, "メモを取り込めませんでした"));
      return;
    }
    const pdfs = event.paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) {
      useStore.getState().setStatus("PDFファイルをドロップしてください。");
      return;
    }
    importPaths(pdfs, target ?? undefined);
  }), []);
}
