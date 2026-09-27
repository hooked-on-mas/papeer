import { useState } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TabsContent } from "@/components/ui/tabs";
import { useStore } from "@/store";
import { Reader } from "../features/reader/Reader";
import { sidePanelOpen, shownSidePanel } from "../features/reader/sidePanel";
import { ChatPane, NotesPane, SummaryPane } from "./lazyPanes";

const SIDE_PANEL_LABELS = { summary: "サマリー", chat: "チャット", notes: "メモ" } as const;

/** Whether the side panel takes room beside the reader (see sidePanelOpen). */
export function useSidePanelOpen(): boolean {
  return useStore((s) => sidePanelOpen({ sidePanel: s.sidePanel, hasPaper: !!s.activePaperId }));
}

/**
 * The 「PDFを読む」 tab: the reader, and beside it the side panel with the サマリー, チャット or メモ,
 * in focus mode and the normal view alike (see features/reader/sidePanel.ts).
 */
export function ReaderArea() {
  const open = useSidePanelOpen();
  const sidePanel = useStore((s) => s.sidePanel);
  const panel = useStore((s) => shownSidePanel({ activeTab: s.activeTab, sidePanel: s.sidePanel, hasPaper: !!s.activePaperId }));
  // The panel opens at the width it was last left at. Changing defaultSize while it is open would
  // re-register it and interrupt a resize, so the width is read only when it opens.
  const [openWidth, setOpenWidth] = useState<number | null>(null);
  if (open && openWidth === null) setOpenWidth(useStore.getState().sidePanelWidth);
  if (!open && openWidth !== null) setOpenWidth(null);

  return (
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
      {/* First and always there, so that opening the panel keeps the loaded PDFs. */}
      <ResizablePanel id="reader" minSize="320px" className="flex flex-col min-w-0">
        <Reader />
      </ResizablePanel>
      {open && sidePanel && (
        <>
          <ResizableHandle className="w-1 bg-border hover:bg-primary/60 transition-colors cursor-col-resize" />
          <ResizablePanel
            id="side-panel"
            defaultSize={`${openWidth ?? useStore.getState().sidePanelWidth}px`}
            minSize="320px"
            maxSize="80%"
            onResize={(size) => { if (size.inPixels > 0) useStore.getState().setSidePanelWidth(Math.round(size.inPixels)); }}
            className="flex flex-col min-w-0 bg-background"
          >
            {/* Empty while another tab is shown, keeping its room so that the hidden reader keeps its size. */}
            {panel && (
              <aside className="flex-1 flex flex-col min-h-0" aria-label={`${SIDE_PANEL_LABELS[panel]}（右パネル）`} data-side-panel={panel}>
                {panel === "summary" && <SummaryPane />}
                {panel === "chat" && <ChatPane />}
                {panel === "notes" && <NotesPane compact />}
              </aside>
            )}
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}

/**
 * The 「PDFを読む」 tab's panel. The reader stays mounted while another tab is shown, so that its PDFs,
 * page and scroll position are there on coming back. It is hidden with visibility rather than
 * display: none (hidden={false} overrides the panel's own hidden attribute), which keeps its size and
 * scroll position, so it is neither laid out anew nor redrawn meanwhile. The panel is inert while
 * inactive, so the hidden reader takes no keys, clicks, wheel or focus.
 */
export function ReaderTab() {
  const active = useStore((s) => s.activeTab === "reader");
  return (
    <TabsContent value="reader" keepMounted hidden={false}
      className={`flex-1 p-0 m-0 overflow-hidden outline-none flex min-h-0 ${active ? "" : "invisible absolute inset-0"}`}>
      <ReaderArea />
    </TabsContent>
  );
}
