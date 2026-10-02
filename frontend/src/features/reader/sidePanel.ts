/**
 * The panel beside the reader, which shows the サマリー, チャット or メモ of the open paper next to the
 * PDF, in focus mode and in the normal view alike. Kept apart from React so that the rules can be tested.
 */

/** The tabs the side panel can show. */
export const SIDE_PANELS = ["summary", "chat", "notes"] as const;
export type SidePanel = (typeof SIDE_PANELS)[number];

export function isSidePanel(value: unknown): value is SidePanel {
  return (SIDE_PANELS as readonly unknown[]).includes(value);
}

/**
 * Whether the side panel takes room beside the reader. It keeps it while another tab is shown, empty
 * (see shownSidePanel), so that the hidden reader keeps its size and is not redrawn meanwhile.
 */
export function sidePanelOpen({ sidePanel, hasPaper }: { sidePanel: SidePanel | null; hasPaper: boolean }): boolean {
  return sidePanel !== null && hasPaper;
}

/**
 * The pane shown in the side panel, or null. It belongs to the 「PDFを読む」 tab: while another tab is
 * shown, the reader stays mounted but hidden and the panel is not rendered, so that a pane is never
 * mounted twice (the チャット tab and a チャット panel), which would register its unsaved edits twice.
 */
export function shownSidePanel({ activeTab, sidePanel, hasPaper }: {
  activeTab: string;
  sidePanel: SidePanel | null;
  hasPaper: boolean;
}): SidePanel | null {
  return activeTab === "reader" && hasPaper ? sidePanel : null;
}

interface TabState {
  activeTab: string;
  focusMode: boolean;
  sidePanel: SidePanel | null;
}

/**
 * What choosing `tab` changes. Focus mode keeps the reader and opens the サマリー, チャット or メモ beside
 * it; 付箋 always opens as a full tab, leaving focus mode. The side panel stays as it is otherwise: it
 * comes back with the reader tab.
 */
export function tabChange(state: TabState, tab: string): Partial<TabState> {
  if (tab === "sticky-notes" || tab === "references") return { activeTab: tab, focusMode: false };
  if (state.focusMode && tab !== "reader") return isSidePanel(tab) ? { activeTab: "reader", sidePanel: tab } : {};
  return { activeTab: tab };
}

/**
 * Where to show text handed over from the reader (「説明してもらう」「メモに引用」「チャットに添付」):
 * in the side panel, keeping the PDF on screen.
 */
export function openBesideReader(panel: SidePanel): Partial<TabState> {
  return { activeTab: "reader", sidePanel: panel };
}

/**
 * Where a 解説 that has just been written is shown: in the side panel while the reader is shown with
 * the panel open, keeping the PDF in view ("none" when the panel already shows it); in its tab otherwise
 * (focus mode turns that into the side panel too, see tabChange).
 */
export function summaryPlacement({ activeTab, sidePanel }: { activeTab: string; sidePanel: SidePanel | null }): "panel" | "tab" | "none" {
  if (activeTab === "reader" && sidePanel === "summary") return "none";
  if (activeTab === "reader" && sidePanel !== null) return "panel";
  return "tab";
}

/**
 * The position within its page that the reader keeps for a paper (JumpTarget.anchor_y, see viewAnchor
 * in Reader.tsx), rounded so that small scrolls don't rewrite ui-state.json; null at the top of the
 * page, where a paper opens anyway.
 */
export function savedAnchor(scrollTop: number, anchor: number | null): number | null {
  if (!(scrollTop > 0) || anchor === null || !Number.isFinite(anchor)) return null;
  const rounded = Math.round(Math.max(0, Math.min(1, anchor)) * 1000) / 1000;
  return rounded > 0 ? rounded : null;
}

/** The positions read back from ui-state.json, leaving out anything that isn't one. */
export function parseAnchors(raw: unknown): Record<string, number> {
  const anchors: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return anchors;
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1) anchors[id] = value;
  }
  return anchors;
}

/**
 * The places to keep once ui-state.json has been read, which can happen after papers were opened and
 * scrolled while waiting for the sidecar: the places set meanwhile win, and a saved place is dropped for
 * a paper whose page was turned meanwhile, as it belongs to the saved page.
 */
export function mergeSavedAnchors({ saved, savedPages, pages, anchors }: {
  /** reading_anchors as read from the file. */
  saved: unknown;
  /** The saved pages, as the store counts them (from 1). */
  savedPages: Record<string, number>;
  /** The store's pages and places now. */
  pages: Record<string, number>;
  anchors: Record<string, number>;
}): Record<string, number> {
  const kept = Object.entries(parseAnchors(saved)).filter(([id]) => pages[id] === undefined || pages[id] === savedPages[id]);
  return { ...Object.fromEntries(kept), ...anchors };
}
