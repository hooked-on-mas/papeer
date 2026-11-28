import type { NoteDocument } from '../../runtime/noteDocuments.ts';
import type { EditorState } from '@codemirror/state';
import { traceFeature } from '../../runtime/featureTrace.ts';
import { conflictTitle } from '../../runtime/edits/textPolicy.ts';

export type NoteEditPort = {
  save: (next: NoteDocument) => NoteDocument | Promise<NoteDocument>;
  writeDraft?: (next: NoteDocument) => void;
  clearDraft?: () => void;
  clearRecoveredDrafts?: () => void;
  createCopy?: (copy: NoteDocument) => void | Promise<void>;
};
export type NoteEditState = { note: NoteDocument; remote: NoteDocument; pending: boolean; durable: boolean; saving: boolean; error: string;
  canUndo: boolean; canRedo: boolean; editorOwner: symbol | null; insertToken: number; recoveredDrafts: string[]; editingBlocked: boolean; textGeneration: number };
export type NoteReadToken = { contentGeneration: number; requestGeneration: number };

/** Keep edits until the host accepts them. A failed durable write must never discard ink. */
export class NoteEditSession {
  private state: NoteEditState;
  private listeners = new Set<() => void>();
  private flight?: Promise<void>;
  private drawing = false;
  private editorFinalizers = new Map<symbol, Set<() => void>>();
  private port: NoteEditPort;
  private undoStack: NoteDocument[] = [];
  private redoStack: NoteDocument[] = [];
  private appendIds = new Set<string>();
  private contentGeneration = 0;
  private requestGeneration = 0;
  beginRead = (): NoteReadToken => ({ contentGeneration: this.contentGeneration, requestGeneration: ++this.requestGeneration });
  private markdownEditorState?: EditorState;
  getEditorState = () => this.markdownEditorState;
  setEditorState = (state: EditorState) => { this.markdownEditorState = state; };
  reportError = (error: unknown) => this.update({ error: String(error) });
  canSaveCopy = () => !!this.port.createCopy;
  saveCopy = async () => {
    if (!this.port.createCopy) return;
    const copy: NoteDocument = { ...this.state.note, id: crypto.randomUUID().replace(/-/g, ''), revision: '',
      parent_id: null, title: conflictTitle(this.state.note.title) };
    // This recovery write never clears the original dirty buffer or pretends that its failed save succeeded.
    await this.port.createCopy(copy);
  };
  constructor(note: NoteDocument, port: NoteEditPort, draft?: NoteDocument, recoveredDrafts: string[] = []) {
    this.port = port;
    this.state = { note: draft ?? note, remote: note, pending: !!draft, durable: !!draft, saving: false, error: '',
      canUndo: false, canRedo: false, editorOwner: null, insertToken: 0, recoveredDrafts, editingBlocked: false, textGeneration: 0 };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private update(fields: Partial<NoteEditState>) {
    this.state = { ...this.state, ...fields, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 }; this.listeners.forEach(listener => listener());
  }
  clearRecoveredDrafts = () => {
    try { this.port.clearRecoveredDrafts?.(); this.update({ recoveredDrafts: [] }); }
    catch (error) { this.reportError(error); }
  };
  receive(note: NoteDocument, token?: NoteReadToken) {
    if (token && (token.contentGeneration !== this.contentGeneration || token.requestGeneration !== this.requestGeneration)) return;
    if (note === this.state.remote) return;
    this.requestGeneration++;
    if (!this.state.pending && !this.state.saving && !this.drawing) {
      this.adoptRemote(note);
    } else this.update({ remote: note });
  }
  private adoptRemote(note: NoteDocument) {
    if (note.revision !== this.state.note.revision) { this.undoStack = []; this.redoStack = []; }
    const changedText = note.kind === 'markdown' && note.content !== this.state.note.content;
    if (changedText) this.markdownEditorState = undefined;
    this.contentGeneration++;
    this.update({ note, remote: note, textGeneration: this.state.textGeneration + (changedText ? 1 : 0) });
  }
  acquireEditor = (owner: symbol): boolean => {
    if (this.state.editorOwner && this.state.editorOwner !== owner) return false;
    if (!this.state.editorOwner) this.update({ editorOwner: owner });
    return true;
  };
  releaseEditor = (owner: symbol) => {
    if (this.state.editorOwner !== owner) return;
    // Flush surface-owned gestures while their original writer token is still valid.
    for (const finalize of this.editorFinalizers.get(owner) ?? []) finalize();
    this.editorFinalizers.delete(owner);
    this.setDrawing(false); this.update({ editorOwner: null });
  };
  registerEditorFinalizer = (owner: symbol, finalize: () => void) => {
    const callbacks = this.editorFinalizers.get(owner) ?? new Set<() => void>();
    callbacks.add(finalize); this.editorFinalizers.set(owner, callbacks);
    return () => { callbacks.delete(finalize); if (!callbacks.size && this.editorFinalizers.get(owner) === callbacks) this.editorFinalizers.delete(owner); };
  };
  editFrom = (owner: symbol, note: NoteDocument) => { if (this.state.editorOwner === owner) this.edit(note); };
  editDocument = (change: (current: NoteDocument) => NoteDocument) => {
    if (this.state.editingBlocked || this.drawing) throw new Error('描画・ページ変更が終わるまでお待ちください。');
    this.edit(change(this.state.note));
  };
  edit = (note: NoteDocument) => {
    if (this.state.editingBlocked) return;
    traceFeature('notes.edit-session', note.id, 'edit');
    if (this.state.note.kind === 'notebook') {
      this.undoStack.push(this.state.note); this.undoStack = this.undoStack.slice(-50); this.redoStack = [];
    }
    this.stage(note);
    void this.flush().catch(() => undefined);
  };
  private stage(note: NoteDocument) {
    this.contentGeneration++;
    this.update({ note, pending: true, durable: false, error: '' });
  }
  /** Markdown typing keeps the edit-start revision; later remote notifications never become its base. */
  editText = (text: string, owner?: symbol) => {
    if (this.state.editingBlocked || (owner && this.state.editorOwner !== owner) || this.state.note.kind !== 'markdown' || text === this.state.note.content) return;
    traceFeature('notes.edit-session', this.state.note.id, 'type');
    this.stage({ ...this.state.note, content: text });
    try { if (this.port.writeDraft) { this.port.writeDraft(this.state.note); this.update({ durable: true }); } }
    catch (error) { this.update({ error: String(error), durable: false }); }
  };
  appendText = (text: string, operationId: string) => {
    if (this.appendIds.has(operationId)) return;
    const current = this.state.note.content ?? '';
    this.editText(`${current.trimEnd()}${current.trim() ? '\n\n' : ''}${text}\n\n`);
    this.appendIds.add(operationId); this.update({ insertToken: this.state.insertToken + 1 });
  };
  private restore(note: NoteDocument) {
    // Undo changes content; acknowledged identity/revision and current metadata are never rolled back.
    this.stage({ ...this.state.note, document: note.document, ink: note.ink });
    void this.flush().catch(() => undefined);
  }
  undo = (owner?: symbol) => {
    if (this.state.editingBlocked || (owner && this.state.editorOwner !== owner) || this.drawing) return;
    const note = this.undoStack.pop(); if (!note) return;
    traceFeature('notes.edit-session', this.state.note.id, 'undo');
    this.redoStack.push(this.state.note); this.restore(note);
  };
  redo = (owner?: symbol) => {
    if (this.state.editingBlocked || (owner && this.state.editorOwner !== owner) || this.drawing) return;
    const note = this.redoStack.pop(); if (!note) return;
    this.undoStack.push(this.state.note); this.restore(note);
  };
  setDrawing = (drawing: boolean) => {
    this.drawing = drawing;
    // A gesture holds an edit-start snapshot even before its first durable edit.
    // Adopt deferred remote content only if the gesture ended without staging a change.
    if (!drawing && !this.state.pending && !this.state.saving && this.state.note !== this.state.remote) this.adoptRemote(this.state.remote);
  };
  setDrawingFrom = (owner: symbol, drawing: boolean) => { if (this.state.editorOwner === owner) this.setDrawing(drawing); };
  canLeave = () => !this.state.editingBlocked && !this.drawing && !this.state.saving && (!this.state.pending || this.state.durable);
  /** Existing page-structure API stays behind the same writer until canonical DocumentEditBatch replaces it. */
  changeDocument = async (action: (current: NoteDocument) => Promise<NoteDocument>) => {
    if (this.state.editingBlocked || this.drawing) throw new Error('描画・ページ変更が終わるまでお待ちください。');
    this.update({ editingBlocked: true });
    try { await this.flush(); this.receive(await action(this.state.note)); }
    finally { this.update({ editingBlocked: false }); }
  };
  flush = (): Promise<void> => {
    if (this.flight) return this.flight.then(() => this.flush());
    if (!this.state.pending) return Promise.resolve();
    const next = this.state.note;
    // Start in a microtask so synchronous storage errors also clear the flight reliably.
    const work = Promise.resolve().then(async () => {
      this.update({ saving: true, error: '' });
      try {
        if (this.port.writeDraft) { this.port.writeDraft(next); this.update({ durable: this.state.note === next }); }
        const saved = await this.port.save(next);
        this.contentGeneration++;
        traceFeature('notes.edit-session', saved.id, 'accepted');
        if (this.state.note === next) {
          this.update({ note: saved, remote: saved, pending: false, durable: false });
          // Cleanup failure cannot undo a successful revision update or resend it.
          try { this.port.clearDraft?.(); } catch { this.update({ error: '保存済みですが、端末の下書きを削除できません。' }); }
        } else {
          // An edit made during the request must build on the acknowledged revision.
          this.update({ note: { ...this.state.note, id: saved.id, revision: saved.revision }, durable: false });
        }
      } catch (error) { this.update({ error: String(error) }); throw error; }
      finally { this.update({ saving: false }); this.flight = undefined; }
    });
    this.flight = work;
    return work.then(() => this.flush());
  };
}
