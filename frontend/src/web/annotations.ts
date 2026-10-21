import type { InkStroke } from "../features/reader/inkGeometry.ts";
import type { Manifest } from "./drive.ts";
import type { LibraryTransport } from "./offlineLibrary.ts";

export type Anchor = { paper_id: string; side: "original" | "translated"; source_sha256: string; page: number };
export type Operation = Anchor & { version: 1; id: string; library_id: string } &
  ({ action: "add"; stroke: InkStroke } | { action: "remove"; target: string });
export type PageInk = { strokes: InkStroke[]; highlights: { color: string; rects: number[][] }[] };
export type BaseInk = { version: 1; pages: Record<string, PageInk>; applied: string[] };
const uuid = /^[a-f0-9-]{36}$/;
const webId = /^web-[a-f0-9-]{36}$/;
export function validStroke(s: InkStroke): boolean {
  return !!s && typeof s.id === "string" && s.id.length > 0 && s.id.length <= 80 && /^#[a-f\d]{6}$/i.test(s.color) && Number.isFinite(s.width) && s.width > 0 && s.width <= .08
    && Array.isArray(s.points) && s.points.length > 0 && s.points.length <= 20000
    && s.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1))
    && (!s.kind || ["pen", "highlighter", "text", "line", "arrow", "rectangle", "ellipse"].includes(s.kind))
    && (s.kind !== "text" || (typeof s.text === "string" && !!s.text.trim() && s.text.length <= 2000 && s.points.length === 4));
}
export function parseOperation(value: unknown, libraryId: string): Operation {
  const op = value as Operation;
  if (!op || op.version !== 1 || typeof op.id !== "string" || !uuid.test(op.id) || op.library_id !== libraryId
    || typeof op.paper_id !== "string" || !/^[a-f0-9]{32}$/.test(op.paper_id) || !["original", "translated"].includes(op.side)
    || typeof op.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(op.source_sha256)
    || !Number.isSafeInteger(op.page) || op.page < 1 || op.page > 100000
    || Object.keys(op).some(key => !["paper_id", "side", "source_sha256", "page", "version", "id", "library_id", "action", "stroke", "target"].includes(key))
    || (op.action === "add" ? "target" in op || !validStroke(op.stroke) || op.stroke.id !== "web-" + op.id
      : op.action !== "remove" || "stroke" in op || typeof op.target !== "string" || !webId.test(op.target))) {
    throw new Error("保存されたWeb書き込みの形式が不正です。再読み込みしても続く場合はDriveの書き込みファイルを確認してください。");
  }
  return op;
}
export const samePage = (a: Anchor, b: Anchor) => a.paper_id === b.paper_id && a.side === b.side
  && a.source_sha256 === b.source_sha256 && a.page === b.page;

export function mergeInk(base: InkStroke[], operations: Operation[], anchor: Anchor, applied: readonly string[]): InkStroke[] {
  const page = operations.filter(op => samePage(op, anchor));
  const deleted = new Set(page.flatMap(op => op.action === "remove" ? [op.target] : []));
  const result = new Map(base.map(s => [s.id, s]));
  const imported = new Set(applied);
  for (const op of page) if (op.action === "add" && !imported.has(op.id) && !deleted.has(op.stroke.id) && !result.has(op.stroke.id)) result.set(op.stroke.id, op.stroke);
  // Imported deletes are already represented by the snapshot. Later PC edits/undo stay authoritative.
  for (const op of page) if (op.action === "remove" && !imported.has(op.id)) result.delete(op.target);
  return [...result.values()];
}

type State = { ready: boolean; pending: number; saving: boolean; error: string; version: number; stale: number };
/** One durable key per operation avoids lost drafts across tabs. Credentials are never persisted. */
export class AnnotationStore {
  private operations = new Map<string, Operation>();
  private pending = new Map<string, Operation>();
  private base: BaseInk = { version: 1, pages: {}, applied: [] };
  private listeners = new Set<() => void>();
  private prefix: string;
  private controller = new AbortController();
  private disposed = false;
  private inFlight: Promise<void> | undefined;
  private initializing: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private state: State = { ready: false, pending: 0, saving: false, error: "", version: 0, stale: 0 };
  private session: LibraryTransport;
  readonly libraryId: string;
  private manifest: Manifest;
  private storage: Storage;
  private blockedStorage = false;
  constructor(session: LibraryTransport, libraryId: string, manifest: Manifest, storage?: Storage) {
    this.session = session; this.libraryId = libraryId; this.manifest = manifest;
    try { this.storage = storage ?? localStorage; }
    catch {
      this.blockedStorage = true;
      this.storage = new Proxy({} as Storage, { get() { throw new Error("このブラウザーでは端末の保存領域を利用できません。サイトの保存設定を確認してください。"); } });
    }
    this.prefix = `papeer-ink:${libraryId}:`;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private update(value: Partial<State> = {}) {
    if (this.disposed) return;
    const stale = [...this.operations.values()].filter(op => this.manifest.files[`papers/${op.paper_id}/${op.side}.pdf`]?.sha256 !== op.source_sha256).length;
    this.state = { ...this.state, ...value, pending: this.pending.size, stale, version: this.state.version + 1 };
    this.listeners.forEach(fn => fn());
  }
  page(anchor: Anchor): PageInk {
    const base = this.base.pages[`${anchor.paper_id}/${anchor.side}/${anchor.page}`] ?? { strokes: [], highlights: [] };
    return { strokes: mergeInk(base.strokes, [...this.operations.values()], anchor, this.base.applied), highlights: base.highlights };
  }
  start(): Promise<void> {
    if (this.disposed || this.state.ready) return Promise.resolve();
    if (!this.initializing) this.initializing = this.initialize().finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  private async initialize() {
    try {
      if (this.blockedStorage) {
        try { this.storage = localStorage; this.blockedStorage = false; }
        catch { throw new Error("このブラウザーでは端末の保存領域を利用できないため、書き込みを保存できません。サイトの保存設定を確認してください。"); }
      }
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)!;
        if (!key.startsWith(this.prefix)) continue;
        const op = parseOperation(JSON.parse(this.storage.getItem(key)!), this.libraryId);
        this.operations.set(op.id, op); this.pending.set(op.id, op);
      }
      const file = this.manifest.files["web-annotations.json"];
      if (file) {
        const base = JSON.parse(await (await this.session.file(file, this.controller.signal)).text()) as BaseInk;
        if (!base || base.version !== 1 || !base.pages || typeof base.pages !== "object" || Array.isArray(base.pages) || !Array.isArray(base.applied)
          || base.applied.some(id => typeof id !== "string" || !uuid.test(id))
          || Object.values(base.pages).some(p => !p || !Array.isArray(p.strokes) || !p.strokes.every(validStroke) || !Array.isArray(p.highlights)
            || p.highlights.some(h => !h || !/^#[a-f\d]{6}$/i.test(h.color) || !Array.isArray(h.rects) || h.rects.length > 400
              || h.rects.some(r => !Array.isArray(r) || r.length !== 4 || !r.every(n => Number.isFinite(n) && n >= 0 && n <= 1)
                || r[2] <= 0 || r[3] <= 0 || r[0] + r[2] > 1.00002 || r[1] + r[3] > 1.00002)))) {
          throw new Error("PCの書き込みデータを読み込めません。PCから再アップロードしてください。");
        }
        this.base = base;
      }
      await this.refresh();
      this.update({ ready: true, error: "" });
      await this.flush();
    } catch (e) { this.update({ error: String(e) }); }
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.refreshing) this.refreshing = this.readRemote().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async readRemote() {
    const files = await this.session.annotationFiles(this.libraryId, this.controller.signal);
    // A few requests at once, without starting thousands of simultaneous downloads.
    for (let i = 0; i < files.length; i += 6) {
      const values = await Promise.all(files.slice(i, i + 6).map(async file => {
        if (Number(file.size) > 1024 * 1024) throw new Error("Web書き込みファイルが大きすぎます。");
        const knownId = /^ink-([a-f0-9-]{36})\.json$/.exec(file.name)?.[1];
        if (knownId && this.operations.has(knownId) && !this.pending.has(knownId)) return;
        return parseOperation(await this.session.annotation(file.id, this.controller.signal), this.libraryId);
      }));
      for (const op of values) if (op) {
        const previous = this.operations.get(op.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(op)) throw new Error("同じIDの書き込みの内容が一致しません。");
        this.operations.set(op.id, op);
      }
    }
    this.update();
  }
  add(anchor: Anchor, stroke: Omit<InkStroke, "id">): InkStroke {
    const id = crypto.randomUUID();
    const result = { ...stroke, id: "web-" + id };
    this.commit({ ...anchor, version: 1, id, library_id: this.libraryId, action: "add", stroke: result });
    return result;
  }
  remove(anchor: Anchor, target: string) {
    this.commit({ ...anchor, version: 1, id: crypto.randomUUID(), library_id: this.libraryId, action: "remove", target });
  }
  private commit(op: Operation) {
    try {
      if (!this.state.ready || this.disposed) throw new Error("書き込みの読み込みが終わるまでお待ちください。");
      parseOperation(op, this.libraryId);
      if (op.action === "add") {
        const strokes = this.page(op).strokes;
        if (strokes.length >= 3000 || strokes.reduce((n, s) => n + s.points.length, op.stroke.points.length) > 200000) {
          throw new Error("このページの書き込みが多すぎます。別のページに追加してください。");
        }
      }
      // Synchronous durable write BEFORE showing the stroke or starting the network request.
      this.storage.setItem(this.prefix + op.id, JSON.stringify(op));
      this.operations.set(op.id, op); this.pending.set(op.id, op);
      this.update({ error: "" });
      void this.flush();
    } catch (e) { this.update({ error: "この端末に書き込みを保存できません。" + String(e) }); throw e; }
  }
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed || !this.state.ready || !this.pending.size) return Promise.resolve();
    this.inFlight = this.send().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async send() {
    this.update({ saving: true, error: "" });
    try {
      while (this.pending.size && !this.disposed) {
        const op = this.pending.values().next().value!;
        await this.session.saveAnnotation(this.libraryId, this.manifest.folder_id, op.id, op);
        // A lost response may produce duplicate files on retry; operation IDs make replay idempotent.
        this.storage.removeItem(this.prefix + op.id); this.pending.delete(op.id);
        this.update();
      }
    } catch (e) { this.update({ error: "Driveに未保存です。端末内の下書きを保持しています。" + String(e) }); }
    finally { this.update({ saving: false }); }
  }
  async retry() {
    if (!this.state.ready) return this.start();
    try {
      await this.refresh(); await this.flush();
      if (!this.pending.size) this.update({ error: "" });
    } catch (e) { this.update({ error: String(e) }); }
  }
  dispose() { this.disposed = true; this.controller.abort(); this.listeners.clear(); }
}
