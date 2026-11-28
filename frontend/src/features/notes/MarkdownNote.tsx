import { useEffect, useState } from 'react';
import { MarkdownRenderer } from '@/components/ui/MarkdownRenderer';
import { noteApi, refreshNotes, type NoteRecord } from './noteApi';
import { apiRequest } from '@/api/client';
import { registerPendingSaves } from '@/lib/pendingSaves';
import type { NoteDocument } from '../../runtime/noteDocuments';
import { NoteEditSession } from './noteEditSession';
import { MarkdownSessionEditor } from './markdown/MarkdownSessionEditor';
import { NoteTemplates } from './NoteTemplates';
import { loadMarkdownDraft } from '../../adapters/browser/markdownDrafts';

const sessions = new Map<string, NoteEditSession>();
const loads = new Map<string, Promise<NoteEditSession>>();
const asDocument = (note: NoteRecord): NoteDocument => ({ id: note.id, kind: 'markdown', title: note.title,
  parent_id: note.parent_id ?? null, collection_name: note.collection_name ?? '', note_position: note.note_position,
  revision: note.revision, content: note.content ?? '' });

async function loadSession(id: string): Promise<NoteEditSession> {
  const running = loads.get(id); if (running) return running;
  const requestedSession = sessions.get(id), token = requestedSession?.beginRead();
  const work = (async () => {
    const note = asDocument(await noteApi.read(id));
    const existing = sessions.get(id);
    if (existing) { if (existing === requestedSession) existing.receive(note, token); return existing; }
    const key = `papeer-markdown-session:${id}`;
    const recovered = loadMarkdownDraft(localStorage, key, `papeer-note-draft:${id}`, note);
    const session = new NoteEditSession(note, {
      writeDraft: next => localStorage.setItem(key, JSON.stringify(next)),
      clearDraft: () => localStorage.removeItem(key),
      clearRecoveredDrafts: recovered.clearRecoveries,
      createCopy: async copy => {
        await apiRequest('POST', '/api/notes', { kind: 'markdown', title: copy.title, content: copy.content, collection: copy.collection_name });
        await refreshNotes();
      },
      save: async next => asDocument(await noteApi.update(id, next.revision, { content: next.content })),
    }, recovered.draft, recovered.recoveries);
    sessions.set(id, session); return session;
  })();
  loads.set(id, work);
  try { return await work; } finally { loads.delete(id); }
}

export async function saveMarkdownNote(id: string): Promise<void> { await sessions.get(id)?.flush(); }
export async function appendMarkdownNote(id: string, text: string, appended?: () => void, operationId = crypto.randomUUID()) {
  const session = sessions.get(id) ?? await loadSession(id);
  session.appendText(text, operationId); appended?.(); await session.flush();
}
registerPendingSaves(async () => { await Promise.all([...sessions.values()].map(session => session.flush())); },
  'ノートを保存できませんでした。下書きを確認してください。');

export function MarkdownNote({ id }: { id: string }) {
  const [loaded, setLoaded] = useState<{ id: string; session: NoteEditSession } | undefined>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void loadSession(id).then(session => { if (alive) setLoaded({ id, session }); }).catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, [id]);
  const session = sessions.get(id) ?? (loaded?.id === id ? loaded.session : undefined);
  if (!session) return <p role={error ? 'alert' : 'status'}>{error || 'ノートを読み込み中…'}</p>;
  return <MarkdownSessionEditor key={id} session={session} renderPreview={content => <MarkdownRenderer content={content} paperId={id} />}
    renderTemplates={(content, insert) => <NoteTemplates note={content} onInsert={insert} />} />;
}
