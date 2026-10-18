import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PaperSettings } from "./PaperSettings";
import type { NotebookPaper } from "./notebooks";
import { usePageActions } from "./useNotebookPageActions";

/** 用紙を変更: the dialog that the menus over the sidebar's thumbnails and the paper, and the toolbar's 「…」 menu (for the page shown), open for one page. */
export function NotebookPaperDialog() {
  const { paperTarget, closePaper, applyPaper, busy } = usePageActions();
  const [value, setValue] = useState<NotebookPaper | null>(null);
  // Starts from the page's paper each time the dialog is opened for a page.
  const pageId = paperTarget?.pageId;
  useEffect(() => { setValue(paperTarget?.paper ?? null); }, [pageId]); // eslint-disable-line react-hooks/exhaustive-deps -- only a different page starts the form over
  return <Dialog open={!!paperTarget} onOpenChange={(open) => { if (!open) closePaper(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>p.{paperTarget?.number} の用紙を変更</DialogTitle>
        <DialogDescription>書き込みはページ内の同じ比率の位置に保ちます。サイズや向きに合わせて伸縮します。</DialogDescription>
      </DialogHeader>
      {value && <fieldset disabled={busy}><PaperSettings value={value} onChange={setValue} /></fieldset>}
      <Button disabled={busy || !value} onClick={() => { if (value) void applyPaper(value); }}>{busy ? "変更中…" : "変更"}</Button>
    </DialogContent>
  </Dialog>;
}
