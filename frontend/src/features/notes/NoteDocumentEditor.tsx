import { desktopNotebookSession, loadDesktopNotebookSession } from '../../adapters/desktop/notebookSessions';
import { useLoadedNoteSession } from './useLoadedNoteSession';
import { HandwrittenNote } from './HandwrittenNote';
import { NoteEditSession } from './noteEditSession';
import { useNoteEditSession } from './useNoteEditSession';
import { noteSaveStatus } from './useNoteAutosave';

export function NoteDocumentEditor({ id }: { id: string }) {
  const { session, error } = useLoadedNoteSession(id, loadDesktopNotebookSession, desktopNotebookSession);
  if (!session) return <p role={error ? 'alert' : 'status'}>{error || '読み込み中…'}</p>;
  return <NoteSessionEditor session={session} loadError={error} />;
}

function NoteSessionEditor({ session, loadError }: { session: NoteEditSession; loadError: string }) {
  const state = useNoteEditSession(session);
  return <div className="flex flex-1 min-h-0 flex-col">
    <span role="status">{noteSaveStatus({ saving: state.saving, dirty: state.pending, durable: state.durable })}</span>
    {(loadError || state.error) && <p role="alert">{loadError || state.error}</p>}
    {state.pending && <button className="min-h-11" disabled={state.saving} onClick={() => void session.flush().catch(() => undefined)}>下書きを保存・再試行</button>}
    <NotebookDraftRecovery session={session} />
    <div className="flex flex-1 min-h-0 flex-col"><HandwrittenNote session={session} /></div>
  </div>;
}

export function NotebookDraftRecovery({ session }: { session: NoteEditSession }) {
  const state = useNoteEditSession(session);
  return state.recoveredDrafts.length ? <details className="border p-2"><summary>以前のページ下書きを保全しています</summary>
    <p>元の版が記録されていないため、自動で上書きしていません。内容を保存して確認できます。</p>
    {state.recoveredDrafts.map((draft, index) => <textarea key={index} readOnly aria-label={`保全したページ下書き ${index + 1}`} value={draft} className="w-full min-h-24" />)}
  </details> : null;
}
