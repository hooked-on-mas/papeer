import { apiRequest } from "@/api/client";
import { useStore } from "@/store";

type UiStateFile = {
  reading_pages: Record<string, number>; // zero-based, as the old window.ini stored them
  last_paper: string;
  sort: number;
  expanded_collections: string[];
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let lastSaved = "";

function snapshot(): UiStateFile {
  const s = useStore.getState();
  const reading_pages: Record<string, number> = {};
  for (const [id, page] of Object.entries(s.paperPages)) reading_pages[id] = Math.max(0, page - 1);
  return {
    reading_pages,
    last_paper: s.activePaperId || "",
    sort: s.sortOrder,
    expanded_collections: s.expandedCollections ?? [],
  };
}

export async function flushUiState(): Promise<void> {
  clearTimeout(saveTimer);
  const body = snapshot();
  const serialized = JSON.stringify(body);
  if (serialized === lastSaved || !useStore.getState().uiStateLoaded) return;
  lastSaved = serialized;
  try {
    await apiRequest("PUT", "/api/ui-state", body);
  } catch {
    lastSaved = "";
  }
}

/** Restore the last paper and page (「前回の続き」) and keep ui-state.json up to date. */
export async function initUiStateSync(): Promise<() => void> {
  try {
    const state = await apiRequest<UiStateFile>("GET", "/api/ui-state");
    const paperPages: Record<string, number> = {};
    for (const [id, page] of Object.entries(state.reading_pages || {})) paperPages[id] = Number(page) + 1;
    const expanded = Array.isArray(state.expanded_collections) ? state.expanded_collections : [];
    useStore.setState({
      paperPages,
      sortOrder: Number(state.sort) || 0,
      // An empty list from a fresh install means nothing was ever collapsed.
      expandedCollections: expanded.length ? expanded : null,
      uiStateLoaded: true,
    });
    if (state.last_paper) {
      useStore.getState().setActivePaperId(state.last_paper);
      const page = useStore.getState().currentPage;
      useStore.getState().setStatus(`前回の続き：${page}ページから再開しました。`);
    }
    lastSaved = JSON.stringify(snapshot());
  } catch {
    useStore.setState({ uiStateLoaded: true });
  }
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (s.paperPages === prev.paperPages && s.activePaperId === prev.activePaperId
        && s.sortOrder === prev.sortOrder && s.expandedCollections === prev.expandedCollections) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushUiState, 800);
  });
  window.addEventListener("beforeunload", flushUiState);
  return () => {
    unsubscribe();
    window.removeEventListener("beforeunload", flushUiState);
  };
}
