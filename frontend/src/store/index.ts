import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { JobKind } from "@/features/jobs/jobKinds";
import { clampZoom } from "@/features/reader/zoomLevels";
import { EMPTY_HISTORY, type ReaderHistory } from "@/features/reader/readerHistory";
import { pageFilterOf, type PageFilter } from "@/features/reader/pageAppearance";
import { openBesideReader, tabChange, type SidePanel } from "@/features/reader/sidePanel";
import { mergePersisted, migratePersisted, PERSIST_VERSION } from "./persisted";
import { upsertJob } from "@/features/jobs/jobSelectors";

export { ZOOM_FIT_PAGE, ZOOM_LEVELS, ZOOM_PRESETS } from "@/features/reader/zoomLevels";

export interface Job {
  job_id: string;
  paper_id?: string | null;
  kind?: JobKind;
  message?: string;
  done?: number | null;
  total?: number | null;
  status?: "running" | "succeeded" | "cancelled" | "failed";
}

export interface MoveRecord {
  paperId: string;
  from: string;
  to: string;
}

/** Several papers moved at once (selected, or dragged together), undone together. */
export interface MovePapersRecord {
  kind: "move-papers";
  moves: MoveRecord[];
}

export type LibraryUndoRecord = MoveRecord | MovePapersRecord | { kind: "delete-folder"; path: string; token: string };

/** Text handed from the reader to the チャット or メモ tab, used once by that paper's pane. */
export interface PaperHandoff {
  paperId: string;
  text: string;
  /** Chat only: send right away instead of leaving the text in the input. */
  send?: boolean;
  /** Chat only: passages sent with this message, apart from those waiting in the input. */
  attachments?: PassageAttachment[];
}

/** Where a passage selected in the PDF sits, as the ask API takes and returns it. */
export interface PassageLocation {
  page: number;
  side: "original" | "translated";
  /** The passage as the AI reads it. */
  text: string;
  anchor_y: number;
  /** Offsets into the page's text layer and the text they covered, to select the passage again. */
  start?: number | null;
  end?: number | null;
  raw?: string;
}

/** A passage waiting in the chat input to be sent. */
export interface PassageAttachment extends PassageLocation {
  id: string;
  paperId: string;
}

/** A request for the reader to show, and select, a passage. */
export interface ReaderJump extends PassageLocation {
  paperId: string;
  anchor_x?: number;
  /** Show the end of the page in both panes instead, when paging back from the next page. */
  toEnd?: boolean;
}

interface UiState {
  activePaperId: string | null;
  activeTab: string;
  /** Relative to the fitted page width, or ZOOM_FIT_PAGE; see features/reader/zoomLevels.ts. */
  zoom: number;
  /** How pages look under the dark theme (設定「表示」); see features/reader/pageAppearance.ts. */
  pageFilter: PageFilter;
  currentPage: number;
  paperPages: Record<string, number>;
  /**
   * Where the view was within each paper's page in paperPages (JumpTarget.anchor_y); none at the top.
   * Saved to ui-state.json with the pages, and dropped when the page changes.
   */
  paperAnchors: Record<string, number>;
  activeJobs: Job[];
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  readerSplit: number; // 0-1 ratio
  translatedOnly: boolean;
  focusMode: boolean;
  /** Tab shown beside the reader, in focus mode and the normal view alike; see features/reader/sidePanel.ts. */
  sidePanel: SidePanel | null;
  sidePanelWidth: number;
  /** Whether the writing toolbar is shown while no writing tool is picked; see readerBars.ts. */
  inkBarOpen: boolean;
  statusMessage: string;
  /** Folder that new PDFs go into ("" = 未分類); follows the selected tree row. */
  currentCollection: string;
  /** Folder row selected in the library, or null when a paper row is selected. */
  selectedFolder: string | null;
  librarySearch: string;
  sortOrder: number;
  /** null until known: expand everything, as the old tree did on first launch. */
  expandedCollections: string[] | null;
  /** Library moves made during this session, newest last. */
  moveHistory: LibraryUndoRecord[];
  uiStateLoaded: boolean;
  chatDraft: PaperHandoff | null;
  noteInsert: PaperHandoff | null;
  /** Passages waiting in each paper's chat input; kept while the chat tab is closed. */
  chatAttachments: PassageAttachment[];
  /** Unsent chat text by paper, kept while the reader is used to attach passages. */
  chatInputs: Record<string, string>;
  readerJump: ReaderJump | null;
  /** Places to go back to in the open paper (Alt+←); cleared when another paper opens. */
  readerHistory: ReaderHistory;

  setActivePaperId: (id: string | null, page?: number) => void;
  setActiveTab: (tab: string) => void;
  setZoom: (zoom: number) => void;
  setPageFilter: (filter: PageFilter) => void;
  setCurrentPage: (page: number) => void;
  setPaperAnchor: (paperId: string, anchor: number | null) => void;
  setSidebarWidth: (w: number) => void;
  setSidebarCollapsed: (c: boolean) => void;
  setReaderSplit: (r: number) => void;
  setTranslatedOnly: (t: boolean) => void;
  setFocusMode: (f: boolean) => void;
  setSidePanel: (panel: SidePanel | null) => void;
  /** Opens a panel beside the reader, showing the reader if another tab was shown. */
  openSidePanel: (panel: SidePanel) => void;
  setSidePanelWidth: (w: number) => void;
  setInkBarOpen: (open: boolean) => void;
  setStatus: (message: string) => void;
  setCurrentCollection: (collection: string) => void;
  setSelectedFolder: (folder: string | null) => void;
  setLibrarySearch: (query: string) => void;
  setSortOrder: (order: number) => void;
  setExpandedCollections: (paths: string[] | null) => void;
  setMoveHistory: (history: LibraryUndoRecord[]) => void;
  setChatDraft: (draft: PaperHandoff | null) => void;
  setNoteInsert: (insert: PaperHandoff | null) => void;
  addChatAttachment: (attachment: PassageAttachment) => void;
  removeChatAttachments: (ids: string[]) => void;
  setChatInput: (paperId: string, text: string) => void;
  setReaderJump: (jump: ReaderJump | null) => void;
  setReaderHistory: (history: ReaderHistory) => void;

  addJob: (job: Job) => void;
  removeJob: (job_id: string) => void;
}

export const useStore = create<UiState>()(
  persist(
    (set) => ({
      activePaperId: null,
      activeTab: "reader",
      zoom: 1,
      pageFilter: "normal",
      currentPage: 1,
      paperPages: {},
      paperAnchors: {},
      activeJobs: [],
      sidebarWidth: 280,
      sidebarCollapsed: false,
      readerSplit: 0.5,
      translatedOnly: false,
      focusMode: false,
      sidePanel: null,
      sidePanelWidth: 420,
      inkBarOpen: false,
      statusMessage: "準備できました。PDFの追加・閲覧・メモ保存にはAI接続は不要です。",
      currentCollection: "",
      selectedFolder: null,
      librarySearch: "",
      sortOrder: 0,
      expandedCollections: null,
      moveHistory: [],
      uiStateLoaded: false,
      chatDraft: null,
      noteInsert: null,
      chatAttachments: [],
      chatInputs: {},
      readerJump: null,
      readerHistory: EMPTY_HISTORY,

      setActivePaperId: (id, page) => set((state) => {
        const target = page ?? (id ? (state.paperPages[id] || 1) : 1);
        return {
          activePaperId: id,
          currentPage: target,
          paperPages: id ? { ...state.paperPages, [id]: target } : state.paperPages,
          paperAnchors: id && target !== state.paperPages[id] ? withoutKey(state.paperAnchors, id) : state.paperAnchors,
          readerHistory: id === state.activePaperId ? state.readerHistory : EMPTY_HISTORY,
        };
      }),
      setActiveTab: (tab) => set((state) => tabChange(state, tab)),
      setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
      setPageFilter: (filter) => set({ pageFilter: pageFilterOf(filter) }),
      setCurrentPage: (page) => set((state) => ({
        currentPage: page,
        paperPages: state.activePaperId ? { ...state.paperPages, [state.activePaperId]: page } : state.paperPages,
        paperAnchors: state.activePaperId && page !== state.currentPage ? withoutKey(state.paperAnchors, state.activePaperId) : state.paperAnchors,
      })),
      setPaperAnchor: (paperId, anchor) => set((state) => {
        if ((state.paperAnchors[paperId] ?? null) === anchor) return {};
        return { paperAnchors: anchor === null ? withoutKey(state.paperAnchors, paperId) : { ...state.paperAnchors, [paperId]: anchor } };
      }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setReaderSplit: (readerSplit) => set({ readerSplit }),
      setTranslatedOnly: (translatedOnly) => set({ translatedOnly }),
      setFocusMode: (focusMode) => set((state) => ({
        focusMode,
        activeTab: focusMode ? "reader" : state.activeTab,
      })),
      setSidePanel: (sidePanel) => set({ sidePanel }),
      openSidePanel: (panel) => set(openBesideReader(panel)),
      setSidePanelWidth: (sidePanelWidth) => set({ sidePanelWidth }),
      setInkBarOpen: (inkBarOpen) => set({ inkBarOpen }),
      setStatus: (statusMessage) => set({ statusMessage }),
      setCurrentCollection: (currentCollection) => set({ currentCollection }),
      setSelectedFolder: (selectedFolder) => set({ selectedFolder }),
      setLibrarySearch: (librarySearch) => set({ librarySearch }),
      setSortOrder: (sortOrder) => set({ sortOrder }),
      setExpandedCollections: (expandedCollections) => set({ expandedCollections }),
      setMoveHistory: (moveHistory) => set({ moveHistory }),
      setChatDraft: (chatDraft) => set({ chatDraft }),
      setNoteInsert: (noteInsert) => set({ noteInsert }),
      addChatAttachment: (attachment) => set((state) => ({ chatAttachments: [...state.chatAttachments, attachment] })),
      removeChatAttachments: (ids) => set((state) => ({
        chatAttachments: state.chatAttachments.filter((item) => !ids.includes(item.id)),
      })),
      setChatInput: (paperId, text) => set((state) => ({ chatInputs: { ...state.chatInputs, [paperId]: text } })),
      setReaderJump: (readerJump) => set({ readerJump }),
      setReaderHistory: (readerHistory) => set({ readerHistory }),

      addJob: (job) => set((state) => ({ activeJobs: upsertJob(state.activeJobs, job) })),
      removeJob: (job_id) => set((state) => ({
        activeJobs: state.activeJobs.filter(j => j.job_id !== job_id)
      })),
    }),
    {
      name: 'papeer-storage',
      version: PERSIST_VERSION,
      migrate: migratePersisted,
      merge: mergePersisted,
      // Reading position, sort and folder expansion live in the sidecar's ui-state.json
      // (migrated from the old window.ini); see app/uiStateSync.ts.
      partialize: (state) => ({
        activeTab: state.activeTab,
        zoom: state.zoom,
        pageFilter: state.pageFilter,
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        readerSplit: state.readerSplit,
        translatedOnly: state.translatedOnly,
        sidePanel: state.sidePanel,
        sidePanelWidth: state.sidePanelWidth,
        inkBarOpen: state.inkBarOpen,
      }),
    }
  )
);

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

// Components select a boolean, a count or one job through these rather than activeJobs itself.
export { isRunning, paperBusy } from "@/features/jobs/jobSelectors";
