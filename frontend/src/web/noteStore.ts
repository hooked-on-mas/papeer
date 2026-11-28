import { validateNoteDocument, replayNotes, type NoteDocument, type NoteOperation } from '../runtime/noteDocuments.ts';
import type { DriveSession, Manifest } from './drive';
export class WebNoteStore {
  private base: NoteDocument[] = [];
  private applied: string[] = [];
  private operations = new Map<string, NoteOperation>();
  private pending = new Set<string>();
  private own = new Set<string>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private sending?: Promise<void>;
  private state = { notes: [] as NoteDocument[], conflicts: [] as string[], error: '', status: '読み込み中…', ready: false };
  private prefix: string;
  private session: DriveSession;
  readonly library: string;
  private manifest: Manifest;
  private reader: Pick<DriveSession, 'file'>;
  constructor(session: DriveSession, library: string, manifest: Manifest, reader: Pick<DriveSession, 'file'> = session) {
    this.session = session; this.library = library; this.manifest = manifest; this.reader = reader;
    this.prefix = `papeer-notes:v1:${library}:`;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private emit(fields = {}) {
    if (this.disposed) return;
    this.state = { ...this.state, ...replayNotes(this.base, [...this.operations.values()], this.applied), ...fields };
    this.listeners.forEach(fn => fn());
  }
  async start() {
    try {
      const snapshot = this.manifest.files['web-notes.json'];
      if (snapshot) {
        const data = JSON.parse(await (await this.reader.file(snapshot)).text()) as { notes: NoteDocument[]; applied: string[] };
        this.base = data.notes.map(validateNoteDocument); this.applied = data.applied;
      }
      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);
      for (const key of keys) {
        if (!key.startsWith(this.prefix) || key.startsWith(this.prefix + 'ack:')) continue;
        const op = JSON.parse(localStorage.getItem(key)!) as NoteOperation;
        if (op.library_id !== this.library) throw new Error('別ライブラリの下書きです。');
        if (op.note) validateNoteDocument(op.note);
        if (this.applied.includes(op.id)) { localStorage.removeItem(key); localStorage.removeItem(this.prefix + 'ack:' + op.id); continue; }
        this.operations.set(op.id, op);
        if (!key.startsWith(this.prefix + 'remote:')) { this.own.add(op.id); if (!localStorage.getItem(this.prefix + 'ack:' + op.id)) this.pending.add(op.id); }
      }
      this.emit({ ready: true, status: this.pending.size ? '端末に保存' : 'Driveへ同期済み' });
      await this.refresh();
      await this.flush();
    } catch (error) { this.emit({ error: String(error), status: '同期できません' }); }
  }
  edit(note: NoteDocument | null, current?: NoteDocument) {
    if (!this.state.ready) throw new Error('ノートの読み込みを待ってください。');
    if (note) {
      validateNoteDocument(note);
      if (note.parent_id === note.id || (note.parent_id && (this.state.notes.some(n => n.parent_id === note.id) || this.manifest.items.some(n => n.parent_id === note.id) || this.manifest.attachments.some(a => a.owner_id === note.id)))) throw new Error('付属ノートや資料を整理してから付属化してください。');
      const owner = note.parent_id ? this.state.notes.find(n => n.id === note.parent_id) ?? this.manifest.items.find(n => n.id === note.parent_id) : undefined;
      if (note.parent_id && (!owner || owner.parent_id)) throw new Error('独立した持ち主を選んでください。');
    }
    const op: NoteOperation = { version: 1, id: crypto.randomUUID(), library_id: this.library, note_id: (note ?? current)!.id, base: current?.revision ?? null, note };
    localStorage.setItem(this.prefix + op.id, JSON.stringify(op)); // Durable before updating the UI.
    this.operations.set(op.id, op); this.pending.add(op.id); this.own.add(op.id);
    this.emit({ error: '', status: '端末に保存' });
    void this.flush();
  }
  async refresh() {
    if (this.disposed || !navigator.onLine) return;
    try {
      const files = await this.session.noteFiles(this.library);
      for (const file of files) {
        if (this.disposed) return;
        const op = await this.session.annotation(file.id) as NoteOperation;
        if (op.version !== 1 || op.library_id !== this.library || typeof op.id !== 'string' || !/^[a-f0-9-]{36}$/.test(op.id)) throw new Error('ノート変更の形式が不正です。');
        if (this.applied.includes(op.id) || this.operations.has(op.id)) continue;
        let note: NoteDocument | null = null;
        if (op.blob) note = JSON.parse(await (await this.session.file({ ...op.blob, mime: 'application/json' })).text()) as NoteDocument;
        if (note) {
      validateNoteDocument(note);
      if (note.parent_id === note.id || (note.parent_id && (this.state.notes.some(n => n.parent_id === note.id) || this.manifest.items.some(n => n.parent_id === note.id) || this.manifest.attachments.some(a => a.owner_id === note.id)))) throw new Error('付属ノートや資料を整理してから付属化してください。');
      const owner = note.parent_id ? this.state.notes.find(n => n.id === note.parent_id) ?? this.manifest.items.find(n => n.id === note.parent_id) : undefined;
      if (note.parent_id && (!owner || owner.parent_id)) throw new Error('独立した持ち主を選んでください。');
    }
        if (note && note.id !== op.note_id) throw new Error('ノートIDが一致しません。');
        this.operations.set(op.id, { ...op, note });
        localStorage.setItem(this.prefix + 'remote:' + op.id, JSON.stringify({ ...op, note }));
      }
      this.emit({ error: '' });
    } catch (error) { this.emit({ error: String(error), status: '同期できません' }); }
  }
  flush(): Promise<void> {
    if (this.sending) return this.sending;
    this.sending = Promise.resolve().then(async () => {
      try {
        for (const id of this.pending) {
          if (this.disposed) return;
          const op = this.operations.get(id)!;
          if (this.applied.includes(id)) { this.pending.delete(id); localStorage.removeItem(this.prefix + id); continue; }
          this.emit({ status: '同期中' });
          await this.session.saveNote(this.library, this.manifest.folder_id, op);
          localStorage.setItem(this.prefix + 'ack:' + id, '1');
          this.pending.delete(id);
          // Keep the acknowledged version locally until the snapshot incorporates it.
        }
        this.emit({ error: '', status: 'Driveへ同期済み' });
      } catch (error) { this.emit({ error: String(error), status: '同期できません' }); }
      finally { this.sending = undefined; }
    });
    return this.sending;
  }
  editingId(id: string) {
    const ownCopy = [...this.operations.values()].reverse().find(op => op.note_id === id && this.own.has(op.id) && this.state.conflicts.includes(op.id.replace(/-/g, '')));
    return ownCopy ? ownCopy.id.replace(/-/g, '') : id;
  }
  async image(noteId: string, src: string): Promise<Blob | undefined> {
    if (!/^media\/[A-Za-z0-9_.-]+\.png$/.test(src)) return;
    const conflict = [...this.operations.values()].find(op => op.id.replace(/-/g, '') === noteId);
    const file = this.manifest.files[`papers/${noteId}/${src}`] ?? this.manifest.files[`papers/${conflict?.note_id}/${src}`];
    return file ? this.reader.file(file) : undefined;
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
