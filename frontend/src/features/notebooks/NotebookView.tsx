import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store";
import { backendUrl } from "@/api/client";
import { useReading } from "@/api/hooks";
import { PdfPane } from "@/features/reader/PdfPane";
import { SelectionButtons } from "@/features/reader/inkControls";
import { useInkTools } from "@/features/reader/useInkEditor";
import { fitNotebookToolbar } from "@/features/reader/readerBars";
import { useViewerInput } from "@/features/reader/useViewerInput";
import { usePageAnchor } from "@/features/reader/usePageAnchor";
import { usePageNotes } from "@/features/reader/usePageNotes";
import { useRowWidth } from "@/features/reader/useRowWidth";
import { NotebookInkTools } from "./NotebookInkTools";
import { NotebookPageCorner, CORNER_WIDTH } from "./NotebookPageCorner";
import { NotebookPageSidebar } from "./NotebookPageSidebar";
import { NotebookPaperDialog } from "./NotebookPaperDialog";
import { NotebookPaperMenu } from "./NotebookPaperMenu";
import { NotebookToolbar } from "./NotebookToolbar";
import { NotebookBarContext } from "./notebookBar";
import { useNotebook, useNotebookBusy } from "./notebooks";
import { cornerPlacement, sidebarPlacement, SIDEBAR_WIDTH } from "./pageSidebar";
import { NotebookPageActionsContext, useNotebookPageActions } from "./useNotebookPageActions";
import { usePaperBox } from "./usePaperBox";
import { useWritingContact, writingContactActive } from "./writingContact";

/**
 * The 「ノート」 tab of a notebook: its toolbar (one row, whichever tool is picked), the paper, and over
 * the view the page sidebar and the next-page button. The paper is drawn and written on by the same
 * PdfPane as a PDF's page, with the notebook's own writing tools and menu in place of the PDF's (see
 * NotebookInkTools, NotebookPaperMenu); the PDF reader is Reader.tsx.
 *
 * The sidebar and the button are laid over the view, not beside the paper (see pageSidebar.ts), so that
 * the paper is the same size with them as without, and the toolbar is one row for the same reason.
 */
export function NotebookView({ paperId }: { paperId: string }) {
  const currentPage = useStore((s) => s.currentPage);
  const zoom = useStore((s) => s.notebookZoom);
  const sidebarHidden = useStore((s) => s.notebookSidebarHidden);
  const focusMode = useStore((s) => s.focusMode);
  const { data: notebook } = useNotebook(paperId, true);
  const { data: reading } = useReading(paperId);
  const busy = useNotebookBusy((s) => s.ids.includes(paperId));
  const actions = useNotebookPageActions(paperId, notebook);
  // A notebook opens with the pen: its page is there to be written on.
  useEffect(() => { useInkTools.getState().setTool("pen"); }, [paperId]);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  // The wheel turns the page past its end, except while the pen is on the paper; never to a new page.
  useWritingContact();
  useViewerInput({ rootRef, panes: [scrollRef], wheelTurns: () => !writingContactActive(), resetKey: paperId, zoomSubject: "notebook" });
  const paper = usePaperBox(viewRef, paperId);
  const sidebar = sidebarPlacement({ viewWidth: paper.viewWidth, paperWidth: paper.paperWidth, sidebarWidth: SIDEBAR_WIDTH });
  const corner = cornerPlacement({ viewWidth: paper.viewWidth, paperWidth: paper.paperWidth, buttonWidth: CORNER_WIDTH });
  const { jumpTarget, recordAnchor } = usePageAnchor({ paperId, panes: [scrollRef] });
  const { original: notes } = usePageNotes(paperId, currentPage);

  // Keep the page valid for the notebook.
  const pageCount = notebook?.pages.length ?? 0;
  useEffect(() => {
    if (!pageCount) return;
    const { setCurrentPage } = useStore.getState();
    if (currentPage > pageCount) setCurrentPage(pageCount);
    else if (currentPage < 1) setCurrentPage(1);
  }, [currentPage, pageCount]);

  // The toolbar's row and the places in it that the page draws the writing tools and a failed save into.
  const [rowRef, rowWidth] = useRowWidth();
  const fit = fitNotebookToolbar(rowWidth, { focusMode });
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null);
  const [alertSlot, setAlertSlot] = useState<HTMLDivElement | null>(null);
  const inlineStyle = (fit.style ?? -1) >= 0;
  const bar = useMemo(() => ({ inlineStyle, alertSlot }), [inlineStyle, alertSlot]);

  const page = notebook?.pages[currentPage - 1];
  const url = notebook ? backendUrl(`/api/papers/${paperId}/files/original.pdf?v=${notebook.revision}`) : null;

  return (
    <NotebookPageActionsContext.Provider value={actions}>
    <NotebookBarContext.Provider value={bar}>
      <div ref={rootRef} className="flex flex-col h-full w-full bg-reader-bg">
        <NotebookToolbar paperId={paperId} document={notebook} fit={fit} busy={busy}
          rowRef={rowRef} setToolsSlot={setToolsSlot} setAlertSlot={setAlertSlot} />
        <div ref={viewRef} className="flex-1 relative min-h-0">
        <div className="absolute inset-0" role="region" aria-label="ノート" inert={busy}>
          <PdfPane
            url={url}
            preservePaperColor
            inkPage={reading && page ? { paperId, page: currentPage, pageId: page.id } : undefined}
            pageNumber={currentPage}
            zoom={zoom}
            zoomSubject="notebook"
            pageMenu={NotebookPaperMenu}
            onScroll={(e) => recordAnchor(e.currentTarget)}
            scrollRef={scrollRef}
            missingPageMessage="このページはありません。"
            jumpTarget={jumpTarget?.page === currentPage ? jumpTarget : null}
            savedHighlights={notes}
            inkToolbar={NotebookInkTools}
            inkToolbarSlot={toolsSlot}
            selectionBar={(editor) => (
              <div role="toolbar" aria-label="選択した書き込みの操作" className="flex items-center gap-1 rounded-md border bg-popover p-0.5 shadow-md">
                <SelectionButtons editor={editor} />
              </div>
            )}
            surfaceName="用紙"
          />
        </div>
        {notebook && !sidebarHidden && <NotebookPageSidebar paperId={paperId} notebook={notebook} placement={sidebar} />}
        {notebook && <NotebookPageCorner area={viewRef} overlay={corner === "overlay"} gutter={paper.gutter} />}
        {busy && <p role="status" className="pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm">
          書き込みを保存してページを変更中…
        </p>}
        </div>
      </div>
      <NotebookPaperDialog />
    </NotebookBarContext.Provider>
    </NotebookPageActionsContext.Provider>
  );
}
