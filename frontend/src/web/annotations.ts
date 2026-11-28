import type { InkStroke } from "../features/ink/inkGeometry.ts";
import type { Manifest } from "./drive.ts";
import type { LibraryTransport } from "./offlineLibrary.ts";

export type Anchor = { paper_id: string; side: "original" | "translated"; source_sha256: string; page: number };
export type InkChange = { action: "add"; stroke: InkStroke } | { action: "remove"; target: string };
export type Operation = Anchor & { id: string; library_id: string } &
  (({ version: 1 } & InkChange) | { version: 2; action: 'edit'; changes: InkChange[] });
export type PageInk = { strokes: InkStroke[]; highlights: { color: string; rects: number[][] }[] };
export type BaseInk = { version: 1; pages: Record<string, PageInk>; applied: string[] };
const uuid = /^[a-f0-9-]{36}$/;
const webId = /^web-[a-f0-9-]{36}$/;
// A grouped Undo may restore an entire legal page (200k points and 3k text objects).
export const MAX_INK_OPERATION_BYTES = 32 * 1024 * 1024;
export function validStroke(s: InkStroke): boolean {
  return !!s && typeof s.id === "string" && s.id.length > 0 && s.id.length <= 80 && /^#[a-f\d]{6}$/i.test(s.color) && Number.isFinite(s.width) && s.width > 0 && s.width <= .08
    && Array.isArray(s.points) && s.points.length > 0 && s.points.length <= 20000
    && s.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1))
    && (!s.kind || ["pen", "highlighter", "text", "line", "arrow", "rectangle", "ellipse"].includes(s.kind))
    && (s.kind !== "text" || (typeof s.text === "string" && !!s.text.trim() && s.text.length <= 2000 && s.points.length === 4));
}
export function parseOperation(value: unknown, libraryId: string): Operation {
  const op = value as Operation;
  if (!op || ![1, 2].includes(op.version) || typeof op.id !== "string" || op.id.length !== 36 || !uuid.test(op.id) || op.library_id !== libraryId
    || typeof op.paper_id !== "string" || !/^[a-f0-9]{32}$/.test(op.paper_id) || !["original", "translated"].includes(op.side)
    || typeof op.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(op.source_sha256)
    || !Number.isSafeInteger(op.page) || op.page < 1 || op.page > 100000
    || Object.keys(op).some(key => !["paper_id", "side", "source_sha256", "page", "version", "id", "library_id", "action", "stroke", "target", "changes"].includes(key))) {
    throw new Error("保存されたWeb書き込みの形式が不正です。再読み込みしても続く場合はDriveの書き込みファイルを確認してください。");
  }
  const validChange = (change: InkChange) => !!change && (change.action === 'add'
    ? Object.keys(change).every(key => key === 'action' || key === 'stroke') && validStroke(change.stroke) && change.stroke.id.length === 40 && webId.test(change.stroke.id)
    : change.action === 'remove' && Object.keys(change).every(key => key === 'action' || key === 'target') && typeof change.target === 'string' && change.target.length === 40 && webId.test(change.target));
  if (op.version === 1) {
    const change: InkChange = op.action === 'add' ? { action: 'add', stroke: op.stroke } : { action: 'remove', target: op.target };
    if ('changes' in op || !['add', 'remove'].includes(op.action) || !validChange(change)
      || (op.action === 'add' ? 'target' in op || op.stroke.id !== 'web-' + op.id : 'stroke' in op)) throw new Error('保存されたWeb書き込みの操作が不正です。');
  } else {
    if (op.action !== 'edit' || 'stroke' in op || 'target' in op || !Array.isArray(op.changes) || !op.changes.length || op.changes.length > 3000
      || !op.changes.every(validChange)) throw new Error('保存されたWeb書き込みの一括操作が不正です。');
    const ids = op.changes.map(change => change.action === 'add' ? change.stroke.id : change.target);
    if (new Set(ids).size !== ids.length) throw new Error('一括操作の書き込みIDが重複しています。');
  }
  return op;
}
export const operationChanges = (op: Operation): InkChange[] => op.version === 2 ? op.changes : [op.action === 'add' ? { action: 'add', stroke: op.stroke } : { action: 'remove', target: op.target }];
export const samePage = (a: Anchor, b: Anchor) => a.paper_id === b.paper_id && a.side === b.side
  && a.source_sha256 === b.source_sha256 && a.page === b.page;

export function mergeInk(base: InkStroke[], operations: Operation[], anchor: Anchor, applied: readonly string[]): InkStroke[] {
  const page = operations.filter(op => samePage(op, anchor));
  const deleted = new Set(page.flatMap(op => operationChanges(op).flatMap(change => change.action === 'remove' ? [change.target] : [])));
  const result = new Map(base.map(s => [s.id, s]));
  const imported = new Set(applied);
  for (const op of page) for (const change of operationChanges(op)) if (change.action === "add" && !imported.has(op.id) && !deleted.has(change.stroke.id) && !result.has(change.stroke.id)) result.set(change.stroke.id, change.stroke);
  // Imported deletes are already represented by the snapshot. Later PC edits/undo stay authoritative.
  for (const op of page) for (const change of operationChanges(op)) if (change.action === "remove" && !imported.has(op.id)) result.delete(change.target);
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
  private admissionPrefix: string;
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
    this.admissionPrefix = `papeer-ink-admission:${libraryId}:`;
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
      // A closed tab can leave a capacity probe behind. It is never an operation.
      const abandonedProbes: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)!;
        if (key.startsWith(this.admissionPrefix)) abandonedProbes.push(key);
      }
      for (const key of abandonedProbes) this.storage.removeItem(key);
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
        if (Number(file.size) > MAX_INK_OPERATION_BYTES) throw new Error("Web書き込みファイルが大きすぎます。");
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
  edit(anchor: Anchor, change: { remove?: string[]; add?: Omit<InkStroke, 'id'>[] }): InkStroke[] {
    const added = (change.add ?? []).map(stroke => ({ ...stroke, id: 'web-' + crypto.randomUUID() }));
    const changes: InkChange[] = [...(change.remove ?? []).map(target => ({ action: 'remove' as const, target })), ...added.map(stroke => ({ action: 'add' as const, stroke }))];
    if (changes.length) this.commit({ ...anchor, version: 2, id: crypto.randomUUID(), library_id: this.libraryId, action: 'edit', changes });
    return added;
  }
  private commit(value: Operation) {
    try {
      const op = structuredClone(value);
      if (!this.state.ready || this.disposed) throw new Error("書き込みの読み込みが終わるまでお待ちください。");
      parseOperation(op, this.libraryId);
      const changes = operationChanges(op), removed = new Set(changes.flatMap(change => change.action === 'remove' ? [change.target] : []));
      const strokes = [...this.page(op).strokes.filter(stroke => !removed.has(stroke.id)), ...changes.flatMap(change => change.action === 'add' ? [change.stroke] : [])];
      if (strokes.length > 3000 || strokes.reduce((n, s) => n + s.points.length, 0) > 200000) {
        throw new Error("このページの書き込みが多すぎます。別のページに追加してください。");
      }
      if (new TextEncoder().encode(JSON.stringify(op)).byteLength > MAX_INK_OPERATION_BYTES) throw new Error('一操作の書き込みが大きすぎます。');
      const restored = this.page(op).strokes.filter(stroke => removed.has(stroke.id));
      if (restored.length) {
        // Wire limits are larger than localStorage's quota. Admit a destructive
        // operation only when its complete inverse fits the actual local journal.
        // This cannot reserve capacity against later writes by other tabs.
        const inverse: Operation = { paper_id: op.paper_id, side: op.side, source_sha256: op.source_sha256, page: op.page,
          id: crypto.randomUUID(), library_id: this.libraryId, version: 2, action: 'edit', changes: [
          ...changes.flatMap(change => change.action === 'add' ? [{ action: 'remove' as const, target: change.stroke.id }] : []),
          ...restored.map(stroke => ({ action: 'add' as const, stroke: { ...stroke, id: 'web-' + crypto.randomUUID() } })),
        ] };
        const probeKey = this.admissionPrefix + crypto.randomUUID();
        try {
          const body = JSON.stringify(inverse);
          if (new TextEncoder().encode(body).byteLength > MAX_INK_OPERATION_BYTES) throw new Error('復元操作が大きすぎます。');
          // Offline Undo must coexist with the still-pending forward operation.
          // Probe both bodies and both durable keys in one scratch write; never
          // persist a real deletion until admission succeeds. JSON array syntax
          // adds a small conservative margin to the Storage UTF-16 footprint.
          const keyPadding = Math.max(0, (this.prefix + op.id).length + (this.prefix + inverse.id).length - probeKey.length);
          this.storage.setItem(probeKey, JSON.stringify([op, inverse]) + ' '.repeat(keyPadding));
          this.storage.removeItem(probeKey);
        } catch (error) {
          try { this.storage.removeItem(probeKey); } catch { /* Next initialization cleans abandoned probes. */ }
          throw new Error('元に戻すための保存領域が足りません。一度に消去する量を減らしてください。' + String(error));
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
