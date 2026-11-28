import React, { useEffect, useState } from "react";
import { PdfPane, type JumpTarget } from "./PdfPane";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { desktopReaderCommands } from "./useViewerInput";
import { authToken } from "@/api/client";
import { shell } from "@/shell/index";
import { useStore } from "@/store/index";
import { useTheme } from "@/app/ThemeProvider";
import { externalHttpUrl } from "@/lib/externalLinks";
import { PdfContextMenu } from "./PdfContextMenu";
import { inkToolActive, useInkEditor } from "./useInkEditor";
import type { PersistedInkEditor as InkEditor } from "./inkEditor";
import { zoomOf, setZoomOf, type ZoomSubject } from "./navigation";
import { InkToolbar } from "./InkToolbar";
import type { InkToolbarProps } from "./inkControls";
import { InkCapture } from "./InkCapture";
import type { Bounds } from "../ink/inkGeometry";
import { isHighlight, type StickyNote } from "./sticky/stickyNotes";
import { StickyNoteMarker } from "./sticky/StickyNoteMarker";
import { openStickyNote, useStickyNotes } from "./sticky/stickyNotesStore";
import { SelectionToolbar } from "./SelectionToolbar";
import type { PdfPlace } from "./pdfLinks";
import { pageAppearance } from "./pageAppearance";
import { useWritingPane } from "./WritingToolbar";
import { writingContactActive } from "../notebooks/writingContact";

/** What a menu over the page is given (see PdfPaneProps.pageMenu). */
export interface PageMenuProps {
  translated: boolean;
  /** The menu must not open now (a sticky note is being placed, or the PDF's writing tool is picked). */
  disabled: boolean;
  editor: InkEditor;
  inkPage?: { paperId: string; page: number; pageId?: string };
  /** The page's scroller; the menu opens on a right click anywhere in it. */
  children: React.ReactNode;
}

/** The PDF's menu over a page: copying, chat, sticky notes and the page and zoom controls. */
function PdfPageMenu({ translated, disabled, children }: PageMenuProps) {
  return <PdfContextMenu translated={translated} disabled={disabled}>{children}</PdfContextMenu>;
}

export interface LegacyPdfPaneProps {
  inkPage?: { paperId: string; page: number; pageId?: string };
  preservePaperColor?: boolean;
  url: string | null;
  pageNumber: number;
  /** Multiplier over the width that fits the pane, or ZOOM_FIT_PAGE to fit the whole page. */
  zoom: number;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  /** Shown instead of a page, e.g. while a translation is pending. */
  placeholder?: React.ReactNode;
  missingPageMessage?: string;
  /** Marks quotes taken from this pane as coming from the translation. */
  translated?: boolean;
  searchTerm?: string;
  jumpTarget?: JumpTarget | null;
  /** The sticky notes and highlights on the page shown, of this pane's side. */
  savedHighlights?: StickyNote[];
  /** Called with each PDF once it has loaded, e.g. to read its table of contents. */
  onDocumentLoad?: (doc: PDFDocumentProxy) => void;
  /** A link to another place in this PDF was clicked; `page` is the PDF's own page number. */
  onInternalLink?: (place: PdfPlace) => void;
  /** Names the pane over its top-left corner while the view is at the top of the page. */
  caption?: React.ReactNode;
  /** A small mark kept over the top-right corner however far the page is scrolled, e.g. 翻訳中. */
  badge?: React.ReactNode;
  /**
   * Where the writing toolbar goes, shared by both panes: the pane it serves places it there.
   * When omitted, use the document scope's slot, or show it in place for a standalone pane.
   */
  inkToolbarSlot?: HTMLElement | null;
  /** The writing toolbar to show: the PDF's own by default (the notebook has its own). */
  inkToolbar?: React.ComponentType<InkToolbarProps>;
  /**
   * Shown just below the writing selected on the page, over it (the notebook's copy, cut and delete);
   * `ratio` is the page's height over its width.
   */
  selectionBar?: (editor: InkEditor, ratio: number) => React.ReactNode;
  /** What to call the page's surface in the messages over it: the PDF, or a notebook's paper. */
  surfaceName?: string;
  /**
   * The menu a right click on the page opens: the PDF's by default. With another one (the notebook's),
   * a right click that the writing layer has no menu of its own for reaches it whichever tool is picked.
   */
  pageMenu?: React.ComponentType<PageMenuProps>;
  /** Whose zoom a pinch on this page changes: the PDF's (the default), or the notebook's own. */
  zoomSubject?: ZoomSubject;
}

export function LegacyPdfPaneConnection({ url, pageNumber, zoom, onScroll, scrollRef, placeholder, missingPageMessage,
  translated = false, searchTerm = "", jumpTarget,
  savedHighlights = [], inkPage, preservePaperColor = false, onDocumentLoad, onInternalLink, caption, badge, inkToolbarSlot,
  inkToolbar: WritingToolbar = InkToolbar, selectionBar, surfaceName = "PDF", pageMenu: PageMenu = PdfPageMenu, zoomSubject = "pdf" }: LegacyPdfPaneProps) {
  const [inkViewport, setInkViewport] = useState<{ key: string; ratio: number } | null>(null);
  const side = translated ? "translated" : "original";
  const editor = useInkEditor(url && !placeholder ? inkPage?.paperId : undefined, side, inkPage?.page ?? pageNumber, inkViewport?.ratio ?? 1, inkPage?.pageId);
  // Whether this pane has a page to write on, and so can be the one the writing toolbar serves.
  const inkHost = !!inkPage && !!url && !placeholder;
  const { servesToolbar, activate: activateToolbar, slot: sharedToolbarSlot } = useWritingPane(side, inkHost);
  const toolbarSlot = inkToolbarSlot === undefined ? sharedToolbarSlot : inkToolbarSlot;
  // The toolbar's keys (Ctrl+Z, Delete…) follow it when it moves to this pane from its 原文/訳文 switch.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- editor is new on every render: activate only when the toolbar comes here
  useEffect(() => { if (servesToolbar) editor.activate(); }, [servesToolbar]);
  const [capture, setCapture] = useState<Bounds | null>(null);
  useEffect(() => setCapture(null), [url, pageNumber, editor.tool]);
  const [placingNote, setPlacingNote] = useState(false);
  useEffect(() => setPlacingNote(false), [url, pageNumber]);
  useEffect(() => { if (editor.tool !== "select") setPlacingNote(false); }, [editor.tool]);
  const inkKey = `${url}:${pageNumber}`;
  const notes = savedHighlights.filter(item => !isHighlight(item));
  const highlights = savedHighlights.filter(isHighlight);
  const selectedId = useStickyNotes(s => s.selectedId);
  const appearance = pageAppearance(useStore(s => s.pageFilter), useTheme().dark && !preservePaperColor);
  const token = authToken();
  const options = React.useMemo(() => ({ cMapUrl: "/pdfjs/cmaps/", cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/", httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined }), [token]);
  return <PdfPane
    url={url} pageNumber={pageNumber} zoom={zoom} onScroll={onScroll} scrollRef={scrollRef}
    placeholder={placeholder} missingPageMessage={missingPageMessage} translated={translated}
    searchTerm={searchTerm} jumpTarget={jumpTarget} savedHighlights={savedHighlights}
    onDocumentLoad={onDocumentLoad} onInternalLink={onInternalLink} caption={caption} badge={badge}
    surfaceName={surfaceName} surfaceKey={`${inkPage?.paperId}:${inkPage?.page}`} editor={editor} inkEnabled={!!editor.ink.entry} inkReady={!!editor.ink.ready}
    appearance={appearance} options={options} selectedHighlightId={selectedId}
    pointerZoom={{ get: () => zoomOf(zoomSubject), set: value => setZoomOf(zoomSubject, value) }}
    allowTouch={() => !writingContactActive()}
    onPageSwipe={direction => { if (!inkToolActive()) desktopReaderCommands(zoomSubject).dispatch({ type: "step", amount: direction }); }}
    onExternalLink={url => {
      const safe = externalHttpUrl(url);
      if (!safe) { useStore.getState().setStatus("このリンクは開けません（開けるのは http・https のリンクだけです）。"); return; }
      shell.openUrl(safe).catch(() => useStore.getState().setStatus(`リンクを開けませんでした: ${safe}`));
    }}
    onViewport={setInkViewport} onActivate={activateToolbar} onCapture={setCapture}
    inkPageMenu={PageMenu !== PdfPageMenu}
    pageMenu={children => <PageMenu translated={translated} editor={editor} inkPage={inkPage}
      disabled={placingNote || (PageMenu === PdfPageMenu && editor.tool !== "select")}>{children}</PageMenu>}
    selectionBar={selectionBar ? (_editor, ratio) => selectionBar(editor, ratio) : undefined}
    selectionToolbar={(scroller, frame) => <SelectionToolbar container={scroller} frame={frame} translated={translated}
      highlights={highlights} inkTool={editor.tool !== "select"} placingNote={placingNote} />}
    toolbar={inkPage && inkHost && <WritingToolbar editor={editor} side={side} errorsOnly={!servesToolbar} slot={servesToolbar ? toolbarSlot : undefined}
      disabled={inkViewport?.key !== inkKey} onStickyNote={selection => {
        const box = editor.selection;
        if (selection && box) {
          void openStickyNote({ paperId: inkPage.paperId, pageId: inkPage.pageId, page: inkPage.page, side: translated ? "translated" : "original",
            anchorY: box.y, anchorX: box.x, quote: editor.selected.map(s => s.text ?? "").filter(Boolean).join("\n") });
        } else {
          editor.setTool("select"); setCapture(null); setPlacingNote(value => !value);
        }
      }} />}
    notice={placingNote && <div role="status" className="flex items-center gap-2 border-b bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">
      {surfaceName}上の貼りたい場所をクリックしてください。
      <button className="ml-auto underline" onClick={() => setPlacingNote(false)}>キャンセル</button>
    </div>}
    capture={capture && inkPage && <InkCapture key={`${inkPage.paperId}:${inkPage.page}`} paperId={inkPage.paperId} page={inkPage.page} pageId={inkPage.pageId}
      side={translated ? "translated" : "original"} box={capture} onClose={() => setCapture(null)} />}
    annotations={<>
                  {notes.map(item => <StickyNoteMarker key={`sticky-${item.id}`} item={item}
                    movable={!editor.locked && !placingNote && ["select", "region", "lasso"].includes(editor.tool)} />)}
                  {placingNote && inkPage && <button autoFocus aria-label={`${surfaceName}のこの位置に付箋を貼る`} className="absolute inset-0 z-30 cursor-copy bg-amber-100/10 outline-2 outline-amber-400"
                    onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setPlacingNote(false); } }}
                    onClick={e => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      void openStickyNote({ paperId: inkPage.paperId, pageId: inkPage.pageId, page: inkPage.page, side: translated ? "translated" : "original", quote: "",
                        anchorY: e.detail === 0 ? 0.5 : Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
                        anchorX: e.detail === 0 ? 0.5 : Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) });
                      setPlacingNote(false);
                    }} />}
    </>}
  />;
}
