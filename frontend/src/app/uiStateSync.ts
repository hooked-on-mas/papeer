import { api, unwrap } from "@/api/client";
import { useStore } from "@/store";
import { retryUntil } from "@/lib/retry";
import { librarySortOrder } from "@/lib/librarySort";
import { mergeSavedAnchors } from "@/features/reader/sidePanel";

type UiStateFile = {
  reading_pages: Record<string, number>; // zero-based, as the old window.ini stored them
  /** Where the view was within each paper's page (store paperAnchors); absent from older files. */
  reading_anchors?: Record<string, number>;
  last_paper: string;
  sort: number;
  expanded_collections: string[];
  chat_web_search?: Record<string, boolean>;
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastSaved = "";
let suspended = false;

export function suspendUiStateSync(value: boolean): void {
  suspended = value;
  if (value) clearTimeout(saveTimer);
}

function snapshot(): UiStateFile {
  const s = useStore.getState();
  const reading_pages: Record<string, number> = {};
  for (const [id, page] of Object.entries(s.paperPages)) reading_pages[id] = Math.max(0, page - 1);
  return {
    reading_pages,
    reading_anchors: s.paperAnchors,
    last_paper: s.activePaperId || "",
    sort: s.sortOrder,
    expanded_collections: s.expandedCollections ?? [],
    chat_web_search: s.chatWebSearch,
  };
}

export async function flushUiState(): Promise<void> {
  if (suspended) return;
  clearTimeout(saveTimer);
  const body = snapshot();
  const serialized = JSON.stringify(body);
  if (serialized === lastSaved || !useStore.getState().uiStateLoaded) return;
  lastSaved = serialized;
  try {
    await unwrap(api.PUT("/api/ui-state", { body }));
  } catch {
    lastSaved = "";
  }
}

const RETRY_DELAYS = [250, 500, 1000, 2000, 3000];
const WAITING = "バックエンドの起動を待っています…";
let statusBeforeWaiting = "";

function applyUiState(state: UiStateFile): void {
  const s = useStore.getState();
  const touched = !!s.activePaperId || Object.keys(s.paperPages).length > 0;
  const paperPages: Record<string, number> = {};
  for (const [id, page] of Object.entries(state.reading_pages || {})) paperPages[id] = Number(page) + 1;
  const expanded = Array.isArray(state.expanded_collections) ? state.expanded_collections : [];
  useStore.setState({
    // Pages turned while waiting for the sidecar win over the saved ones.
    paperPages: { ...paperPages, ...s.paperPages },
    // Likewise for the places within those pages.
    paperAnchors: mergeSavedAnchors({ saved: state.reading_anchors, savedPages: paperPages, pages: s.paperPages, anchors: s.paperAnchors }),
    sortOrder: librarySortOrder(state.sort),
    // An empty list from a fresh install means nothing was ever collapsed.
    expandedCollections: expanded.length ? expanded : null,
    chatWebSearch: { ...Object.fromEntries(Object.entries(state.chat_web_search ?? {}).filter(([, value]) => typeof value === "boolean")), ...s.chatWebSearch },
  });
  if (state.last_paper && !s.activePaperId) {
    useStore.getState().setActivePaperId(state.last_paper);
    const page = useStore.getState().currentPage;
    useStore.getState().setStatus(`前回の続き：${page}ページから再開しました。`);
  } else if (useStore.getState().statusMessage === WAITING) {
    useStore.getState().setStatus(statusBeforeWaiting);
  }
  if (useStore.getState().statusMessage === "起動しています…") {
    useStore.getState().setStatus("準備できました。PDFの追加・閲覧・メモ保存にはAI接続は不要です。");
  }
  // Only reveal the empty reader after last_paper has been restored (or there is none).
  useStore.setState({ uiStateLoaded: true });
  if (touched) {
    // A paper opened while waiting is not in the file yet: save it, as any later change would be.
    lastSaved = "";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushUiState, 800);
  } else {
    lastSaved = JSON.stringify(snapshot());
  }
}

/**
 * Restore the last paper and page (「前回の続き」) and keep ui-state.json up to date.
 *
 * Waits for the sidecar (/health) and retries reading until it succeeds: nothing is written back
 * before ui-state.json has been read (uiStateLoaded), so a sidecar that is still starting can never
 * make the saved state be replaced by an empty one. Returns the cleanup, which also stops the retries.
 */
export function initUiStateSync(): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  const retry = {
    delays: RETRY_DELAYS,
    stopped: () => disposed,
    // A packaged sidecar unpacks itself first, which can take a few seconds on a cold start.
    onFailure: (_error: unknown, failures: number) => {
      const current = useStore.getState().statusMessage;
      if (failures !== 8 || current === WAITING) return;
      statusBeforeWaiting = current;
      useStore.getState().setStatus(WAITING);
    },
  };
  void (async () => {
    await retryUntil(() => unwrap(api.GET("/health")), retry);
    const state = await retryUntil(async () => await unwrap(api.GET("/api/ui-state")) as UiStateFile, retry);
    if (disposed || !state) return;
    applyUiState(state);
    unsubscribe = useStore.subscribe((s, prev) => {
      if (s.paperPages === prev.paperPages && s.paperAnchors === prev.paperAnchors && s.activePaperId === prev.activePaperId
          && s.sortOrder === prev.sortOrder && s.expandedCollections === prev.expandedCollections
          && s.chatWebSearch === prev.chatWebSearch) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flushUiState, 800);
    });
    window.addEventListener("beforeunload", flushUiState);
  })();
  return () => {
    disposed = true;
    unsubscribe?.();
    window.removeEventListener("beforeunload", flushUiState);
  };
}
