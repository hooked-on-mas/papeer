import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api, ApiError, unwrap } from "@/api/client";
import { useStore } from "@/store";
import { registerPendingSaves, registerHeldDrafts } from "@/lib/pendingSaves";
import { emitAppEvent } from "@/lib/appEvents";

export type InkSide = "original" | "translated";
import type { InkStroke } from "./inkGeometry";
export type { InkStroke } from "./inkGeometry";
type Snapshot = { strokes: InkStroke[]; ready: boolean; dirty: boolean; saving: boolean; error: string; canUndo: boolean; canRedo: boolean };

// Entries outlive PDF panes: turning a page never cancels a pending save.
const pages = new Map<string, InkPage>();
const blockedOwners = new Set<string>();
// The newest notebook revision whose pages the entries were matched against: an older reply is ignored.
const acceptedRevisions = new Map<string, number>();

export class InkPage {
  snapshot: Snapshot = { strokes: [], ready: false, dirty: false, saving: false, error: "", canUndo: false, canRedo: false };
  private listeners = new Set<() => void>();
  private undoStack: InkStroke[][] = [];
  private redoStack: InkStroke[][] = [];
  private loading: Promise<void> | null = null;
  private saving: Promise<void> | null = null;
  private version = 0;
  private draftKey: string;
  private active = true;
  constructor(readonly paperId: string, readonly side: InkSide, public page: number, readonly pageId?: string) {
    this.draftKey = pageId ? `papeer-notebook-ink:${paperId}:${pageId}` : `papeer-ink:${paperId}:${side}:${page}`;
  }
  // Older sidecars silently discard unknown stroke properties. The v2 route prevents
  // a hot-reloaded editor from losing typed text or highlighter styles on an old server.
  private get params() { return { path: { paper_id: this.paperId, side: this.side, page: this.page } }; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(update: Partial<Snapshot>) {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...update, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
    this.listeners.forEach(listener => listener());
  }
  load = async () => {
    if (this.snapshot.ready) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        this.update({ error: "" });
        const { strokes } = await (this.pageId
          ? unwrap(api.GET("/api/notebooks/{notebook_id}/pages/{page_id}/ink", { params: { path: { notebook_id: this.paperId, page_id: this.pageId } } }))
          : unwrap(api.GET("/api/papers/{paper_id}/ink-v2/{side}/{page}", { params: this.params }))) as { strokes: InkStroke[] };
        if (!this.active) return;
        let draft: InkStroke[] | null = null;
        try {
          const raw = localStorage.getItem(this.draftKey);
          if (raw) draft = JSON.parse(raw);
        } catch { /* Saving to the library still works if browser storage is unavailable. */ }
        this.update({ strokes: draft ?? strokes, ready: true, dirty: draft !== null });
        if (draft) void this.save().catch(() => {});
      } catch (error) {
        this.update({ error: error instanceof ApiError && error.status === 404
          ? "書き込み機能が更新されました。バックエンドを再起動してから再試行してください。"
          : String(error instanceof Error ? error.message : error) });
      } finally { this.loading = null; }
    })();
    return this.loading;
  };
  private commit(strokes: InkStroke[]) {
    if (!this.active || blockedOwners.has(this.paperId)) return;
    this.version++;
    // A local journal also protects ink if the app exits while the server is unavailable.
    try { localStorage.setItem(this.draftKey, JSON.stringify(strokes)); } catch { /* Keep the in-memory draft. */ }
    this.update({ strokes, dirty: true, error: "" });
    emitAppEvent("ink-changed", { paperId: this.paperId });
    void this.save().catch(() => {});
  }
  change = (strokes: InkStroke[]) => {
    if (!this.active || blockedOwners.has(this.paperId) || !this.snapshot.ready) return;
    if (strokes.length === this.snapshot.strokes.length && strokes.every((s, i) => s === this.snapshot.strokes[i])) return;
    this.undoStack.push(this.snapshot.strokes);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this.commit(strokes);
  };
  undo = () => {
    if (!this.active || blockedOwners.has(this.paperId)) return;
    const strokes = this.undoStack.pop();
    if (!strokes) return;
    this.redoStack.push(this.snapshot.strokes);
    this.commit(strokes);
  };
  redo = () => {
    if (!this.active || blockedOwners.has(this.paperId)) return;
    const strokes = this.redoStack.pop();
    if (!strokes) return;
    this.undoStack.push(this.snapshot.strokes);
    this.commit(strokes);
  };
  save = async (): Promise<void> => {
    if (this.saving) return this.saving;
    if (!this.snapshot.dirty) return;
    this.saving = (async () => {
      this.update({ saving: true, error: "" });
      try {
        while (this.active && this.snapshot.dirty) {
          const version = this.version;
          if (this.pageId) await unwrap(api.PUT("/api/notebooks/{notebook_id}/pages/{page_id}/ink", { params: { path: { notebook_id: this.paperId, page_id: this.pageId } }, body: { strokes: this.snapshot.strokes } }));
          else await unwrap(api.PUT("/api/papers/{paper_id}/ink-v2/{side}/{page}", { params: this.params, body: { strokes: this.snapshot.strokes } }));
          if (!this.active) return;
          if (version === this.version) {
            try { localStorage.removeItem(this.draftKey); } catch { /* Optional journal. */ }
            this.update({ dirty: false });
          }
        }
      } catch (error) {
        if (!this.active) return;
        this.update({ error: String(error instanceof Error ? error.message : error) });
        useStore.getState().setStatus(`p.${this.page}（${this.side === "original" ? "原文" : "日本語訳"}）の書き込みが未保存です。保存ボタンで再試行してください。`);
        throw error;
      } finally { this.update({ saving: false }); this.saving = null; }
    })();
    return this.saving;
  };
  forget() {
    this.active = false; this.version++;
    try { localStorage.removeItem(this.draftKey); } catch { /* Optional journal. */ }
  }
}

export function cachedInkPages(paperId: string) {
  return [...pages.values()].filter(entry => entry.paperId === paperId && entry.snapshot.ready)
    .map(entry => ({ page: entry.page, side: entry.side, count: entry.snapshot.strokes.length }));
}

export function notebookDraftInk(paperId: string, pageId: string) {
  const entry = pages.get(`${paperId}:original:${pageId}`);
  if (entry?.snapshot.ready) return entry.snapshot.strokes;
  try {
    const saved = localStorage.getItem(`papeer-notebook-ink:${paperId}:${pageId}`);
    return saved ? JSON.parse(saved) as InkStroke[] : undefined;
  } catch { return undefined; }
}

export function useInkPage(paperId: string | undefined, side: InkSide, page: number, pageId?: string) {
  const entry = useMemo(() => {
    if (!paperId) return null;
    const key = `${paperId}:${side}:${pageId ?? page}`;
    let value = pages.get(key);
    if (!value) { value = new InkPage(paperId, side, page, pageId); pages.set(key, value); }
    value.page = page;
    return value;
  }, [paperId, side, page, pageId]);
  // The same snapshot on the server, so that the reader can be rendered there in tests (renderSmoke).
  const getSnapshot = entry?.getSnapshot ?? emptySnapshot;
  const snapshot = useSyncExternalStore(entry?.subscribe ?? emptySubscribe, getSnapshot, getSnapshot);
  useEffect(() => { void entry?.load(); }, [entry]);
  return { entry, ...snapshot };
}
const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export async function flushInkSaves(paperId?: string, side?: InkSide) {
  // A restart may leave journals for pages that have never been mounted this session. Drafts that only live in
  // memory (the journal could not be written) need their notebook reconciled as much as journaled ones.
  const owners = new Set<string>();
  for (const entry of pages.values()) {
    if (entry.pageId && entry.snapshot.dirty && (!paperId || entry.paperId === paperId) && (!side || entry.side === side)) owners.add(entry.paperId);
  }
  try {
    for (const key of Object.keys(localStorage)) {
      const match = /^papeer-notebook-ink:([0-9a-f]{32}):/.exec(key);
      if (match && (!paperId || paperId === match[1]) && (!side || side === "original")) owners.add(match[1]);
    }
  } catch { /* In-memory drafts can still be saved. */ }
  for (const owner of owners) {
    const document = await unwrap(api.GET("/api/notebooks/{notebook_id}", { params: { path: { notebook_id: owner } } }));
    // A page deleted by an operation whose reply was lost would be saved (404) forever otherwise.
    reconcileNotebookInk(owner, document);
    for (const [index, page] of document.pages.entries()) {
      const key = `${owner}:original:${page.id}`;
      let entry = pages.get(key);
      if (!entry) {
        let hasDraft = false;
        try { hasDraft = localStorage.getItem(`papeer-notebook-ink:${owner}:${page.id}`) !== null; } catch { /* Optional journal. */ }
        if (!hasDraft) continue;
        entry = new InkPage(owner, "original", index+1, page.id); pages.set(key, entry);
      }
      await entry.load();
      if (!entry.snapshot.ready) throw new Error(entry.snapshot.error || "書き込みを読み込めませんでした。");
    }
  }
  await Promise.all([...pages.values()].filter(entry => (!paperId || entry.paperId === paperId) && (!side || entry.side === side))
    .map(entry => entry.save()));
}

window.addEventListener("beforeunload", event => {
  if ([...pages.values()].some(entry => entry.snapshot.dirty)) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("online", () => { void flushInkSaves().catch(() => {}); });
registerPendingSaves(() => flushInkSaves(),
  "書き込みを保存できませんでした。PDFの保存ボタンで再試行してください。");


/** The caller blocks editing before flushing and keeps it blocked until the new document is visible. */
export function blockNotebookInk(paperId: string, blocked: boolean) {
  if (blocked) blockedOwners.add(paperId); else blockedOwners.delete(paperId);
}

export async function flushNotebookInk(paperId: string, document: { pages: { id: string }[] }) {
  // Instantiate unseen journals too: navigating away or restarting must not strand a draft.
  for (const [index, page] of document.pages.entries()) {
    const key = `${paperId}:original:${page.id}`;
    let entry = pages.get(key);
    if (!entry) {
      let draft = false;
      try { draft = localStorage.getItem(`papeer-notebook-ink:${paperId}:${page.id}`) !== null; } catch { /* Optional journal. */ }
      if (!draft) continue;
      entry = new InkPage(paperId, "original", index + 1, page.id); pages.set(key, entry);
    }
    await entry.load();
    if (!entry.snapshot.ready) throw new Error(entry.snapshot.error || "書き込みを読み込めませんでした。");
    await entry.save();
  }
  await flushInkSaves(paperId);
}

/**
 * Match the entries and journals to a document the server answered. Pages the document lacks were deleted
 * (their drafts are dropped, the others kept); an answer older than one already accepted is ignored, so that
 * a late reply cannot discard a page or draft made since.
 */
export function reconcileNotebookInk(paperId: string, document: { pages: { id: string }[]; revision?: number }) {
  const known = acceptedRevisions.get(paperId);
  if (document.revision !== undefined) {
    if (known !== undefined && document.revision < known) return false;
    acceptedRevisions.set(paperId, document.revision);
  }
  const numbers = new Map(document.pages.map((page, index) => [page.id, index + 1]));
  for (const [key, entry] of pages) {
    if (entry.paperId !== paperId || !entry.pageId) continue;
    const number = numbers.get(entry.pageId);
    if (number === undefined) { entry.forget(); pages.delete(key); } else entry.page = number;
  }
  try {
    const prefix = `papeer-notebook-ink:${paperId}:`;
    for (const key of Object.keys(localStorage)) if (key.startsWith(prefix) && !numbers.has(key.slice(prefix.length))) localStorage.removeItem(key);
  } catch { /* Optional journal. */ }
  return true;
}

registerHeldDrafts({
  describe: () => [], discard: () => {},
  forget: identities => {
    const ids = new Set(identities);
    for (const id of ids) acceptedRevisions.delete(id);
    for (const [key, entry] of pages) if (ids.has(entry.paperId)) { entry.forget(); pages.delete(key); }
    try {
      for (const key of Object.keys(localStorage)) {
        if ([...ids].some(id => key.startsWith(`papeer-ink:${id}:`) || key.startsWith(`papeer-notebook-ink:${id}:`))) localStorage.removeItem(key);
      }
    } catch { /* Optional journal. */ }
  },
});
