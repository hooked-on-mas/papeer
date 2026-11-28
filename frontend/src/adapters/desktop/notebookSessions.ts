import { apiRequest } from '../../api/client';
import { registerHeldDrafts, registerPendingSaves } from '../../lib/pendingSaves';
import { queryClient } from '../../lib/queryClient';
import { QK } from '../../lib/queryKeys';
import { emitAppEvent } from '../../lib/appEvents';
import { validateNoteDocument, type NoteDocument } from '../../runtime/noteDocuments';
import { NoteEditSession } from '../../features/notes/noteEditSession';
import { canonicalJson } from '../../runtime/edits/editModel';

// One writer per notebook, regardless of central/panel placement or page.
const sessions = new Map<string, NoteEditSession>();
const loads = new Map<string, Promise<NoteEditSession>>();
const generations = new Map<string, number>();
export const desktopNotebookSession = (id: string) => sessions.get(id);
function acceptDocument(note: NoteDocument) {
  queryClient.setQueryData([QK.notebook, note.id], note.document);
  emitAppEvent('ink-changed', { paperId: note.id });
}
function notebookContent(note: NoteDocument) {
  const { revision: _revision, ...content } = note;
  return { ...content, ink: Object.fromEntries(note.document!.pages.map(page => [page.id, note.ink?.[page.id] ?? []])) };
}
export async function loadDesktopNotebookSession(id: string): Promise<NoteEditSession> {
  const running = loads.get(id); if (running) return running;
  const requested = sessions.get(id), token = requested?.beginRead();
  const generation = generations.get(id) ?? 0;
  const work = (async () => {
    const note = validateNoteDocument(await apiRequest<NoteDocument>('GET', `/api/notes/${id}/document`));
    if ((generations.get(id) ?? 0) !== generation) throw new Error('ノートは閉じられたか削除されました。');
    if (note.id !== id || note.kind !== 'notebook') throw new Error('手書きノートが見つかりません。');
    const existing = sessions.get(id);
    if (existing) { if (existing === requested) existing.receive(note, token); acceptDocument(existing.getSnapshot().note); return existing; }
    const key = `papeer-handwriting:${id}`;
    let draft: NoteDocument | undefined;
    let unreadableDraft = false, rawDraft: string | null = null;
    const recovered: string[] = [];
    try {
      rawDraft = localStorage.getItem(key);
      if (rawDraft) {
        const value = validateNoteDocument(JSON.parse(rawDraft));
        if (value.id !== id || value.kind !== 'notebook') throw new Error('下書きの対象が一致しません。');
        draft = value;
      }
      // Old per-page journals have no base revision. Preserve them for explicit recovery;
      // never replay a stale full-page PUT over a newer revision from the other placement.
      for (const item of Object.keys(localStorage).filter(item => item.startsWith(`papeer-notebook-ink:${id}:`))) recovered.push(JSON.stringify({ key: item, raw: localStorage.getItem(item) }));
    } catch (error) { unreadableDraft = true; recovered.push(JSON.stringify({ key, raw: rawDraft, error: String(error) })); }
    const session = new NoteEditSession(note, {
      writeDraft: next => {
        if (unreadableDraft) throw new Error('以前の下書きを読み込めません。保全した内容を確認してください。');
        localStorage.setItem(key, JSON.stringify(next));
      },
      clearDraft: () => localStorage.removeItem(key),
      save: async next => {
        let saved: NoteDocument;
        try { saved = validateNoteDocument(await apiRequest<NoteDocument>('PUT', `/api/notes/${id}/document`, { revision: next.revision, note: next })); }
        catch (error) {
          // A committed revision can lose its HTTP reply, including before a restart.
          // Confirm identical content; never promote a different remote body into the draft's base.
          const confirmed = validateNoteDocument(await apiRequest<NoteDocument>('GET', `/api/notes/${id}/document`).catch(() => { throw error; }));
          if (canonicalJson(notebookContent(confirmed)) !== canonicalJson(notebookContent(next))) throw error;
          saved = confirmed;
        }
        if ((generations.get(id) ?? 0) === generation) acceptDocument(saved); return saved;
      },
    }, draft, recovered);
    sessions.set(id, session); acceptDocument(session.getSnapshot().note); return session;
  })();
  loads.set(id, work);
  try { return await work; } finally { if (loads.get(id) === work) loads.delete(id); }
}
export async function flushDesktopNotebooks(id?: string) {
  // A shutdown/export must include revisioned drafts of notebooks not opened since restart.
  const wanted = new Set([...sessions.keys()].filter(key => !id || key === id));
  try {
    for (const key of Object.keys(localStorage)) {
      const match = /^papeer-handwriting:([a-f0-9]{32})$/.exec(key);
      if (match && (!id || id === match[1])) wanted.add(match[1]);
    }
  } catch { /* Known in-memory sessions still retry when storage cannot be read. */ }
  for (const key of wanted) if (!sessions.has(key)) await loadDesktopNotebookSession(key);
  await Promise.all([...sessions.entries()].filter(([key]) => !id || key === id).map(([, session]) => session.flush()));
}
export const refreshDesktopNotebooks = () => Promise.all([...sessions.keys()].map(loadDesktopNotebookSession));
registerPendingSaves(() => flushDesktopNotebooks(), '手書きノートを保存できませんでした。下書きを開いて再試行してください。');
registerHeldDrafts({ describe: () => [], discard: () => {}, forget: ids => { for (const id of ids) {
  generations.set(id, (generations.get(id) ?? 0) + 1); sessions.delete(id); loads.delete(id);
} } });
