import { useEffect, useMemo, useSyncExternalStore } from "react";
import { apiRequest, ApiError } from "@/api/client";
import { useStore } from "@/store";
import { registerPendingSaves } from "@/lib/pendingSaves";
import { emitAppEvent } from "@/lib/appEvents";

export type InkSide = "original" | "translated";
import type { InkStroke } from "./inkGeometry";
export type { InkStroke } from "./inkGeometry";
type Snapshot = { strokes: InkStroke[]; ready: boolean; dirty: boolean; saving: boolean; error: string; canUndo: boolean; canRedo: boolean };

// Entries outlive PDF panes: turning a page never cancels a pending save.
const pages = new Map<string, InkPage>();

class InkPage {
  snapshot: Snapshot = { strokes: [], ready: false, dirty: false, saving: false, error: "", canUndo: false, canRedo: false };
  private listeners = new Set<() => void>();
  private undoStack: InkStroke[][] = [];
  private redoStack: InkStroke[][] = [];
  private loading: Promise<void> | null = null;
  private saving: Promise<void> | null = null;
  private version = 0;
  private draftKey: string;
  constructor(readonly paperId: string, readonly side: InkSide, readonly page: number) {
    this.draftKey = `paperdesk-ink:${paperId}:${side}:${page}`;
  }
  // Older sidecars silently discard unknown stroke properties. The v2 route prevents
  // a hot-reloaded editor from losing typed text or highlighter styles on an old server.
  private get path() { return `/api/papers/${this.paperId}/ink-v2/${this.side}/${this.page}`; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(update: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...update, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
    this.listeners.forEach(listener => listener());
  }
  load = async () => {
    if (this.snapshot.ready) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        this.update({ error: "" });
        const { strokes } = await apiRequest<{ strokes: InkStroke[] }>("GET", this.path);
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
    this.version++;
    // A local journal also protects ink if the app exits while the server is unavailable.
    try { localStorage.setItem(this.draftKey, JSON.stringify(strokes)); } catch { /* Keep the in-memory draft. */ }
    this.update({ strokes, dirty: true, error: "" });
    emitAppEvent("ink-changed", { paperId: this.paperId });
    void this.save().catch(() => {});
  }
  change = (strokes: InkStroke[]) => {
    if (!this.snapshot.ready) return;
    if (strokes.length === this.snapshot.strokes.length && strokes.every((s, i) => s === this.snapshot.strokes[i])) return;
    this.undoStack.push(this.snapshot.strokes);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this.commit(strokes);
  };
  undo = () => {
    const strokes = this.undoStack.pop();
    if (!strokes) return;
    this.redoStack.push(this.snapshot.strokes);
    this.commit(strokes);
  };
  redo = () => {
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
        while (this.snapshot.dirty) {
          const version = this.version;
          await apiRequest("PUT", this.path, { strokes: this.snapshot.strokes });
          if (version === this.version) {
            try { localStorage.removeItem(this.draftKey); } catch { /* Optional journal. */ }
            this.update({ dirty: false });
          }
        }
      } catch (error) {
        this.update({ error: String(error instanceof Error ? error.message : error) });
        useStore.getState().setStatus(`p.${this.page}（${this.side === "original" ? "原文" : "日本語訳"}）の書き込みが未保存です。保存ボタンで再試行してください。`);
        throw error;
      } finally { this.update({ saving: false }); this.saving = null; }
    })();
    return this.saving;
  };
}

export function cachedInkPages(paperId: string) {
  return [...pages.values()].filter(entry => entry.paperId === paperId && entry.snapshot.ready)
    .map(entry => ({ page: entry.page, side: entry.side, count: entry.snapshot.strokes.length }));
}

export function useInkPage(paperId: string | undefined, side: InkSide, page: number) {
  const entry = useMemo(() => {
    if (!paperId) return null;
    const key = `${paperId}:${side}:${page}`;
    let value = pages.get(key);
    if (!value) { value = new InkPage(paperId, side, page); pages.set(key, value); }
    return value;
  }, [paperId, side, page]);
  const snapshot = useSyncExternalStore(entry?.subscribe ?? emptySubscribe, entry?.getSnapshot ?? emptySnapshot);
  useEffect(() => { void entry?.load(); }, [entry]);
  return { entry, ...snapshot };
}
const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export async function flushInkSaves(paperId?: string, side?: InkSide) {
  await Promise.all([...pages.values()].filter(entry => (!paperId || entry.paperId === paperId) && (!side || entry.side === side))
    .map(entry => entry.save()));
}

window.addEventListener("beforeunload", event => {
  if ([...pages.values()].some(entry => entry.snapshot.dirty)) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("online", () => { void flushInkSaves().catch(() => {}); });
registerPendingSaves(() => flushInkSaves(),
  "書き込みを保存できませんでした。PDFの保存ボタンで再試行してください。");
