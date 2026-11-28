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
  const [fit, setFit] = useState(false);
  // Starts from the page's paper each time the dialog is opened for a page.
  const pageId = paperTarget?.pageId;
  useEffect(() => { setValue(paperTarget?.paper ?? null); setFit(false); }, [pageId]); // eslint-disable-line react-hooks/exhaustive-deps -- only a different page starts the form over
  return <Dialog open={!!paperTarget} onOpenChange={(open) => { if (!open) closePaper(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>p.{paperTarget?.number} の用紙を変更</DialogTitle>
        <DialogDescription>書き込みの実寸と位置を保ちます。内容がはみ出す場合は、等比縮小して収める方法を選べます。</DialogDescription>
      </DialogHeader>
      {value && <fieldset disabled={busy}><PaperSettings value={value} onChange={setValue} /></fieldset>}
      <label><input type="checkbox" checked={fit} disabled={busy} onChange={event => setFit(event.target.checked)} />内容を等比縮小して用紙内に収める</label>
      <Button disabled={busy || !value} onClick={() => { if (value) void applyPaper(value, fit); }}>{busy ? "変更中…" : "変更"}</Button>
    </DialogContent>
  </Dialog>;
}
