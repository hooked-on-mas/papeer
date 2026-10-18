import type { Anchor } from "./annotations.ts";
import type { Point } from "../features/reader/inkGeometry.ts";

export type TextDraft = { at: Point; value: string };

/** Scratch text is separate from immutable ink operations and never contains credentials. */
export class TextDrafts {
  private memory = new Map<string, TextDraft | null>();
  private pending = new Map<string, TextDraft | null>();
  private versions = new Map<string, string | null>();
  private storage: () => Storage;
  constructor(storage: () => Storage) { this.storage = storage; }
  key(libraryId: string, anchor: Anchor) {
    return `papeer-text:v1:${libraryId}:${anchor.paper_id}:${anchor.side}:${anchor.source_sha256}:${anchor.page}`;
  }
  read(key: string): TextDraft | undefined {
    if (this.memory.has(key)) return this.memory.get(key) ?? undefined;
    const raw = this.storage().getItem(key);
    this.versions.set(key, raw);
    if (!raw) return;
    const draft = JSON.parse(raw) as TextDraft | null;
    if (!draft || typeof draft.value !== "string" || draft.value.length > 2000
        || !Array.isArray(draft.at) || draft.at.length !== 2
        || !draft.at.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error("文字メモの下書きを読み込めません。元のデータは端末に残しています。");
    }
    this.memory.set(key, draft);
    return draft;
  }
  write(key: string, draft: TextDraft | undefined) {
    // Keep the latest edit in memory even when durable storage is temporarily unavailable.
    this.memory.set(key, draft ?? null); this.pending.set(key, draft ?? null);
    this.save(key, draft ?? null);
  }
  private save(key: string, draft: TextDraft | null) {
    const storage = this.storage(), current = storage.getItem(key);
    if (!this.versions.has(key)) this.versions.set(key, current);
    if (current !== null && current !== this.versions.get(key)) {
      // Another tab edited this scratch note. Never overwrite or delete its text.
      if (draft?.value) throw new Error("別のタブで文字メモが変更されました。保存またはコピーしてから続けてください。");
      this.pending.delete(key); return;
    }
    const value = draft?.value ? JSON.stringify(draft) : null;
    if (value) storage.setItem(key, value); else storage.removeItem(key);
    this.versions.set(key, value);
    this.pending.delete(key);
  }
  prepareNavigation(): boolean {
    for (const [key, draft] of this.pending) {
      try { this.save(key, draft); } catch { /* The editor shows the error; retain the in-memory copy. */ }
    }
    return this.pending.size === 0;
  }
}

export const textDrafts = new TextDrafts(() => localStorage);
const guards = new Set<() => boolean>();
export function registerNavigationGuard(guard: () => boolean) {
  guards.add(guard); return () => { guards.delete(guard); };
}
export function prepareWebNavigation() {
  let ready = textDrafts.prepareNavigation();
  for (const guard of guards) if (!guard()) ready = false;
  return ready;
}
