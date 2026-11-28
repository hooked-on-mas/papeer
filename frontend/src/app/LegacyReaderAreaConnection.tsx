import { MarkdownNote } from "@/features/notes/MarkdownNote";
import { ReaderArea } from "./ReaderArea";
import { useStore } from "@/store";
import { useItemCapabilities, usePaper } from "@/api/hooks";
import { DESKTOP_READER_PANEL_HOST, readerPanelCapabilities } from "@/runtime/capabilities";
import { LegacyPdfReaderConnection as Reader } from "../features/reader/LegacyPdfReaderConnection";
import { NotebookView } from "@/features/notebooks/NotebookView";
import { sidePanelOpen, shownSidePanel, type SidePanel } from "../features/reader/sidePanel";
import { ChatPane, NotesPane, SummaryPane } from "./lazyPanes";
import { DocumentsPane } from "@/features/documents/DocumentsPane";
import { useDocumentState } from "@/features/documents/documentState";

const SIDE_PANEL_LABELS = { summary: "サマリー", chat: "チャット", notes: "ノート" } as const;

/**
 * The side panel's pane the store has chosen, unless the open item has none of it (a notebook has no
 * サマリー): the choice is kept for the next paper, and the panel takes no room meanwhile.
 */
function useChosenSidePanel(): SidePanel | null {
  const caps = useItemCapabilities(useStore((s) => s.activePaperId));
  const panels = readerPanelCapabilities(caps, DESKTOP_READER_PANEL_HOST);
  return useStore((s) => s.sidePanel !== null && panels[s.sidePanel] ? s.sidePanel : null);
}

/** Whether the side panel takes room beside the reader (see sidePanelOpen). */
export function useSidePanelOpen(): boolean {
  const sidePanel = useChosenSidePanel();
  return useStore((s) => sidePanelOpen({ sidePanel, hasPaper: !!s.activePaperId }));
}

/**
 * The 「本文」 tab (「ノート」 for a notebook): the reader, and beside it the side panel with the サマリー, チャット or メモ,
 * in focus mode and the normal view alike (see features/reader/sidePanel.ts).
 */
export function LegacyReaderAreaConnection() {
  const owner = useStore(s => s.activePaperId);
  const notebook = useItemCapabilities(owner).notebook;
  const usePaperKind = usePaper(owner).data?.kind;
  // Until the open item's kind is known, neither screen is mounted: the PDF reader would take a jump meant
  // for a notebook (see usePageAnchor), and show its toolbar for a moment.
  const kindPending = usePaper(owner).isPending && !!owner;
  const enlarged = useDocumentState(s => s.enlarged);
  const open = useSidePanelOpen();
  const sidePanel = useChosenSidePanel();
  const panel = useStore((s) => shownSidePanel({ activeTab: s.activeTab, sidePanel, hasPaper: !!s.activePaperId }));

  return (
    <ReaderArea dock={{
      onClosePanel: () => useStore.getState().setSidePanel(null),
      open: open && !!sidePanel,
      width: useStore.getState().sidePanelWidth,
      onWidthChange: width => useStore.getState().setSidePanelWidth(width),
      panelId: panel ?? undefined,
      label: panel ? `${SIDE_PANEL_LABELS[panel]}（右パネル）` : undefined,
      panel: panel ? <>
        {panel === "summary" && <SummaryPane />}
        {panel === "chat" && <ChatPane />}
        {panel === "notes" && <NotesPane compact />}
      </> : undefined,
    }}>
        {owner && enlarged === owner ? <DocumentsPane key={owner} owner={owner} enlarged />
          // The only place that tells a notebook's screen from a PDF's.
          : kindPending ? <div className="flex-1 min-h-0 bg-reader-bg" aria-busy="true"><span role="status" className="sr-only">読み込んでいます…</span></div>
          : owner && usePaperKind === "markdown" ? <MarkdownNote key={owner} id={owner} /> : owner && notebook ? <NotebookView key={owner} paperId={owner} /> : <Reader />}
    </ReaderArea>
  );
}

