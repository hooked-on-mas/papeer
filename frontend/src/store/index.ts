import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { JobKind } from "@/features/jobs/jobKinds";
import { clampZoom } from "@/features/reader/zoomLevels";
import { EMPTY_HISTORY, type ReaderHistory } from "@/features/reader/readerHistory";
import { mergeSavedSettings, pageFilterOf, type PageFilter } from "@/features/reader/pageAppearance";

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

export type LibraryUndoRecord = MoveRecord | { kind: "delete-folder"; path: string; token: string };

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
  activeJobs: Job[];
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  readerSplit: number; // 0-1 ratio
  translatedOnly: boolean;
  focusMode: boolean;
  /** Tab shown beside the reader in focus mode ("summary" | "chat" | "notes"), or null. */
  focusPanel: string | null;
  focusPanelWidth: number;
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
  setSidebarWidth: (w: number) => void;
  setSidebarCollapsed: (c: boolean) => void;
  setReaderSplit: (r: number) => void;
  setTranslatedOnly: (t: boolean) => void;
  setFocusMode: (f: boolean) => void;
  setFocusPanel: (panel: string | null) => void;
  setFocusPanelWidth: (w: number) => void;
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
      activeJobs: [],
      sidebarWidth: 280,
      sidebarCollapsed: false,
      readerSplit: 0.5,
      translatedOnly: false,
      focusMode: false,
      focusPanel: null,
      focusPanelWidth: 420,
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
          readerHistory: id === state.activePaperId ? state.readerHistory : EMPTY_HISTORY,
        };
      }),
      // Sticky notes always open as a full tab; other tools can open beside the focused reader.
      setActiveTab: (tab) => set((state) =>
        tab === "sticky-notes" ? { activeTab: tab, focusMode: false, focusPanel: null }
          : state.focusMode && tab !== "reader" ? { focusPanel: tab } : { activeTab: tab }),
      setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
      setPageFilter: (filter) => set({ pageFilter: pageFilterOf(filter) }),
      setCurrentPage: (page) => set((state) => ({
        currentPage: page,
        paperPages: state.activePaperId ? { ...state.paperPages, [state.activePaperId]: page } : state.paperPages
      })),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setReaderSplit: (readerSplit) => set({ readerSplit }),
      setTranslatedOnly: (translatedOnly) => set({ translatedOnly }),
      setFocusMode: (focusMode) => set((state) => ({
        focusMode,
        activeTab: focusMode ? "reader" : state.activeTab,
      })),
      setFocusPanel: (focusPanel) => set({ focusPanel }),
      setFocusPanelWidth: (focusPanelWidth) => set({ focusPanelWidth }),
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

      addJob: (job) => set((state) => ({
        activeJobs: state.activeJobs.some((j) => j.job_id === job.job_id)
          ? state.activeJobs.map((j) => j.job_id === job.job_id ? { ...j, ...job } : j)
          : [...state.activeJobs, job],
      })),
      removeJob: (job_id) => set((state) => ({
        activeJobs: state.activeJobs.filter(j => j.job_id !== job_id)
      })),
    }),
    {
      name: 'papeer-storage',
      version: 2,
      migrate: (persisted: any, version) => {
        // v1 stored 0 for "fit width" and absolute scales otherwise.
        if (version < 2 && persisted) {
          persisted.zoom = persisted.zoom && persisted.zoom >= 1 ? persisted.zoom : 1;
        }
        return persisted;
      },
      merge: mergeSavedSettings,
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
        focusPanel: state.focusPanel,
        focusPanelWidth: state.focusPanelWidth,
      }),
    }
  )
);

export function isRunning(job: Job): boolean {
  return (job.status ?? "running") === "running";
}

export function paperBusy(jobs: Job[], paperId: string | null): boolean {
  return !!paperId && jobs.some((j) => isRunning(j) && j.paper_id === paperId);
}
