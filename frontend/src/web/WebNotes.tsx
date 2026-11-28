import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { MarkdownContent } from "../components/ui/MarkdownContent";
import { MarkdownSessionEditor } from '../features/notes/markdown/MarkdownSessionEditor';
import { HandwrittenNote } from '../features/notes/HandwrittenNote';
import { NoteEditSession } from '../features/notes/noteEditSession';
import { useNoteEditSession } from '../features/notes/useNoteEditSession';
import { noteSaveStatus } from '../features/notes/useNoteAutosave';
import { registerNavigationGuard } from './textDrafts';
import { PaperSettings } from '../features/notebooks/PaperSettings';
import type { NotebookPaper } from '../features/notebooks/paperSpec';
import { DEFAULT_PAPER } from '../features/notebooks/paperSpec';
import { newPage, type NoteDocument } from '../runtime/noteDocuments';
import { loadMarkdownDraft } from '../adapters/browser/markdownDrafts';
import { WebNoteStore } from './noteStore';
import type { Manifest } from './drive';

export function WebNotesNavigation({ store, manifest, onOpen, showList = true }: { store: WebNoteStore; manifest: Manifest; showList?: boolean; onOpen: (id: string) => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<'markdown' | 'notebook'>(() => localStorage.getItem('papeer-last-note-kind') === 'markdown' ? 'markdown' : 'notebook');
  const [title, setTitle] = useState('');
  const [paper, setPaper] = useState<Required<NotebookPaper>>(DEFAULT_PAPER);
  const [collection, setCollection] = useState('');
  const [owner, setOwner] = useState('');
  const [error, setError] = useState('');
  const notes = state.notes.slice().sort((a, b) => a.collection_name.localeCompare(b.collection_name) || a.note_position - b.note_position);
  const folders = [...new Set([...manifest.items.map(i => i.collection_name || ''), ...notes.map(i => i.collection_name)])];
  return <section className="p-2 border-b" aria-label="ノート一覧">
    <button className="min-h-11 border rounded px-2" disabled={!state.ready} onClick={() => { setTitle(`ノート ${new Date().getMonth() + 1}/${new Date().getDate()}`); setCreating(true); }}>＋ ノートを作る</button>
    {creating && <form className="flex flex-col gap-2 border p-2" onSubmit={event => {
      event.preventDefault();
      try {
        const id = crypto.randomUUID().replace(/-/g, '');
        const note: NoteDocument = { id, title: title.trim(), kind, collection_name: collection, parent_id: owner || null, note_position: notes.length, revision: '', ...(kind === 'markdown' ? { content: '' } : { document: { version: 1, revision: 1, pages: [newPage(paper)] }, ink: {} }) };
        store.edit(note); localStorage.setItem('papeer-last-note-kind', kind); setCreating(false); onOpen(id);
      } catch (e) { setError(String(e)); }
    }}>
      <label>種類<select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="notebook">手書き</option><option value="markdown">Markdown</option></select></label>
      {kind === "notebook" && <PaperSettings value={paper} onChange={value => setPaper(value as Required<NotebookPaper>)} />}
      <label>ノート名<input autoFocus required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>フォルダー<input list="note-folders" value={collection} onChange={e => setCollection(e.target.value)} placeholder="未分類（新しいフォルダー名も入力可）" /></label>
      <datalist id="note-folders">{folders.map(folder => <option key={folder} value={folder} />)}</datalist>
      <label>持ち主<select value={owner} onChange={e => setOwner(e.target.value)}><option value="">独立ノート</option>{[...manifest.items, ...notes.filter(n => !manifest.items.some(i => i.id === n.id))].filter(i => !i.parent_id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <button className="min-h-11" type="submit" disabled={!title.trim()}>作成</button><button type="button" onClick={() => setCreating(false)}>キャンセル</button>
    </form>}
    {showList && notes.map(note => <button key={note.id} className="block w-full min-h-11 text-left truncate" onClick={() => onOpen(note.id)} title={note.title}>{note.kind === 'markdown' ? 'MD' : '✎'} {note.title}<small className="block">{note.parent_id ? `付属 · ${state.notes.find(n => n.id === note.parent_id)?.title ?? manifest.items.find(i => i.id === note.parent_id)?.title ?? ''}` : note.collection_name || '未分類'}</small></button>)}
    {(error || state.error) && <p role="alert">{error || state.error}<button onClick={() => void store.refresh().then(() => store.flush())}>再試行</button></p>}
  </section>;
}

export function WebNoteEditor({ store, id, manifest, onClose }: { store: WebNoteStore; id: string; manifest: Manifest; onClose: () => void }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const note = state.notes.find(n => n.id === store.editingId(id));
  if (!note) return <div className="p-4"><button onClick={onClose}>戻る</button><p>ノートを読み込み中、または削除されています。</p></div>;
  return <EditableNote key={id} store={store} note={note} manifest={manifest} onClose={onClose} />;
}

const noteSessions = new WeakMap<WebNoteStore, Map<string, NoteEditSession>>();
function editSession(store: WebNoteStore, note: NoteDocument) {
  let sessions = noteSessions.get(store);
  if (!sessions) { sessions = new Map(); noteSessions.set(store, sessions); }
  let session = sessions.get(note.id);
  if (!session) {
    const key = `papeer-note-session:${store.library}:${note.id}`;
    const recovered = note.kind === 'markdown' ? loadMarkdownDraft(localStorage, key, `papeer-note-text:${store.library}:${note.id}`, note) : undefined;
    session = new NoteEditSession(note, { ...(note.kind === 'markdown' ? {
      writeDraft: (next: NoteDocument) => localStorage.setItem(key, JSON.stringify(next)),
      clearDraft: () => localStorage.removeItem(key),
      clearRecoveredDrafts: recovered?.clearRecoveries,
      createCopy: (copy: NoteDocument) => { store.edit(copy); },
    } : {}), save: next => {
      store.edit(next, next);
      return store.getSnapshot().notes.find(row => row.id === store.editingId(next.id)) ?? next;
    } }, recovered?.draft, recovered?.recoveries);
    sessions.set(note.id, session);
  }
  return session;
}

function EditableNote({ store, note, manifest, onClose }: { store: WebNoteStore; note: NoteDocument; manifest: Manifest; onClose: () => void }) {
  const [loaded] = useState(() => {
    try { return { session: editSession(store, note), error: '' }; }
    catch (error) { return { session: undefined, error: String(error) }; }
  });
  if (!loaded.session) return <p role="alert">{loaded.error} 元の下書きは端末に残しています。</p>;
  return <EditableNoteContent store={store} note={note} manifest={manifest} onClose={onClose} session={loaded.session} />;
}

function EditableNoteContent({ store, note, manifest, onClose, session }: { store: WebNoteStore; note: NoteDocument; manifest: Manifest; onClose: () => void; session: NoteEditSession }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const editState = useNoteEditSession(session);
  useEffect(() => session.receive(note), [session, note]);
  useEffect(() => registerNavigationGuard(session.canLeave), [session]);
  const [error, setError] = useState('');
  const [organizing, setOrganizing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [collection, setCollection] = useState(note.collection_name);
  const [parent, setParent] = useState(note.parent_id ?? '');
  const flush = useCallback(() => session.flush(), [session]);
  const owner = state.notes.find(n => n.id === note.parent_id)?.title ?? manifest.items.find(i => i.id === note.parent_id)?.title;
  return <div className="flex flex-1 min-h-0 flex-col bg-background">
    <div className="flex flex-wrap gap-2 items-center p-2 border-b"><button className="min-h-11" onClick={() => { void flush().then(() => { if (session.canLeave()) onClose(); }).catch(e => setError(String(e))); }}>{owner ? `${owner}に戻る` : '戻る'}</button><strong>{note.title}</strong><span>{note.kind === 'markdown' ? 'Markdown' : '手書き'}</span><span role="status">{noteSaveStatus({ saving: editState.saving, dirty: editState.pending, durable: editState.durable, saved: state.status })}</span><button className="min-h-11" disabled={editState.pending} onClick={() => setOrganizing(!organizing)}>… 整理</button></div>
    {editState.error && <p role="alert">{editState.error}</p>}
    {editState.pending && <button disabled={editState.saving} onClick={() => void session.flush().catch(() => undefined)}>下書きを保存・再試行</button>}
    {(error || state.error) && <p role="alert">{error || state.error}<button onClick={() => { void flush().then(() => { setError(''); return store.flush(); }).catch(reason => setError(String(reason))); }}>再試行</button></p>}
    {state.conflicts.length > 0 && <p role="status">別の端末の変更と重なったため、両方を保存しました。一覧の「競合コピー」を確認してください。</p>}
    {organizing && <form className="p-2 flex flex-wrap gap-2" inert={editState.pending} onSubmit={e => { e.preventDefault(); void flush().then(() => { const current = store.getSnapshot().notes.find(row => row.id === store.editingId(note.id)) ?? note; store.edit({ ...current, title, collection_name: collection, parent_id: parent || null }, current); setOrganizing(false); }).catch(e => setError(String(e))); }}>
      <label>名前<input required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>移動先フォルダー<input value={collection} onChange={e => setCollection(e.target.value)} /></label>
      <label>持ち主<select value={parent} onChange={e => setParent(e.target.value)}><option value="">独立ノート</option>{[...manifest.items, ...state.notes.filter(n => !manifest.items.some(i => i.id === n.id))].filter(i => !i.parent_id && i.id !== note.id).map(i => <option key={i.id} value={i.id}>{i.title}</option>)}</select></label>
      {[-1, 1].map(direction => <button key={direction} type="button" className="min-h-11" onClick={() => {
        const siblings = state.notes.filter(n => n.parent_id === note.parent_id && (n.parent_id || n.collection_name === note.collection_name)).sort((a, b) => a.note_position - b.note_position);
        const index = siblings.findIndex(n => n.id === note.id), target = index + direction;
        if (target < 0 || target >= siblings.length) return;
        [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
        try { siblings.forEach((item, position) => { if (item.note_position !== position) store.edit({ ...item, note_position: position }, item); }); } catch (e) { setError(String(e)); }
      }}>{direction < 0 ? '前へ移動' : '後へ移動'}</button>)}
      <button type="submit" className="min-h-11">変更</button><button type="button" className="min-h-11" onClick={() => { if (window.confirm(`「${note.title}」を削除しますか？付属ノートは独立して残ります。`)) { store.edit(null, note); onClose(); } }}>削除</button>
    </form>}
    {note.kind === 'notebook' ? <HandwrittenNote session={session} /> : <MarkdownSessionEditor session={session} showStatus={false}
      renderPreview={content => <article className="prose p-3 overflow-auto"><MarkdownContent content={content} components={{ img: ({ src, alt }) => <NoteImage store={store} noteId={note.id} src={typeof src === 'string' ? src : ''} alt={alt} /> }} /></article>} />}
  </div>;
}

function NoteImage({ store, noteId, src, alt }: { store: WebNoteStore; noteId: string; src: string; alt?: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true, objectUrl = '';
    void store.image(noteId, src).then(blob => { if (alive && blob) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } }).catch(() => undefined);
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [store, noteId, src]);
  return url ? <img src={url} alt={alt || 'ノートの画像'} /> : <span>{alt || '画像'}（読み込み待ち）</span>;
}
