import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store';
import { usePaper } from '@/api/hooks';
import { apiRequest } from '@/api/client';
import { openPaper } from '@/features/library/selectionStore';
import { newNotebook } from '@/features/notebooks/NotebookDialogs';
import { DocumentsPane } from '@/features/documents/DocumentsPane';
import { useDocumentState, openDocument, showMemos } from '@/features/documents/documentState';
import { useNotes, refreshNotes } from './noteApi';
import { MarkdownNote, appendMarkdownNote } from './MarkdownNote';
import { NoteDocumentEditor } from './NoteDocumentEditor';
import { selectMemo, useMemoSelection } from './memoState';

const button = 'min-h-11 rounded border px-2 text-sm';
export function NotesPane({ compact = false }: { compact?: boolean }) {
  const owner = useStore(s => s.activePaperId);
  const { data: paper } = usePaper(owner);
  const { data: all, error, refetch } = useNotes();
  const notes = useMemo(() => (all ?? []).filter(n => n.parent_id === owner).sort((a, b) => a.note_position - b.note_position), [all, owner]);
  const selected = useMemoSelection(s => owner ? s.selected[owner] : undefined);
  const current = notes.find(n => n.id === selected);
  const mode = useDocumentState(s => owner ? s.modes[owner] : undefined);
  const insert = useStore(s => s.noteInsert);
  const inserting = useRef(false);
  const [handoffVersion, setHandoffVersion] = useState(0);
  const [failure, setFailure] = useState('');
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    if (!owner || selected) return;
    const remembered = localStorage.getItem(`papeer-note-destination:${owner}`);
    if (remembered && notes.some(n => n.id === remembered && n.kind === 'markdown')) selectMemo(owner, remembered);
  }, [owner, selected, notes]);
  useEffect(() => {
    if (!owner || !insert || insert.paperId !== owner || inserting.current) return;
    showMemos(owner);
    if (!current || current.kind !== 'markdown') { setChoosing(true); return; }
    inserting.current = true;
    void appendMarkdownNote(current.id, insert.text, () => { if (useStore.getState().noteInsert === insert) useStore.getState().setNoteInsert(null); }).then(() => { useStore.getState().setStatus(`「${current.title}」に追加しました。`); setChoosing(false);
      localStorage.setItem(`papeer-note-destination:${owner}`, current.id);
    }).catch(e => setFailure(String(e))).finally(() => { inserting.current = false; if (useStore.getState().noteInsert !== insert) setHandoffVersion(value => value + 1); });
  }, [insert, current, owner, handoffVersion]);
  if (!owner) return <p>左のライブラリから項目を選んでください。</p>;
  const choose = (id: string) => { selectMemo(owner, id); const row = notes.find(n => n.id === id); if (row?.kind === 'markdown') localStorage.setItem(`papeer-note-destination:${owner}`, id); };
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-2 p-2 border-b">
      <strong>{paper?.title}</strong><button className={button} onClick={() => showMemos(owner)}>{paper?.kind === 'pdf' ? 'ノート' : '付属ノート'}</button><button className={button} onClick={() => openDocument(owner)}>資料</button>
    </div>
    {mode === 'html' ? <DocumentsPane owner={owner} /> : <>
      <div className="flex flex-wrap gap-2 p-2 border-b">
        <button className={button} disabled={!paper} onClick={() => paper && newNotebook({ owner: paper })}>＋ ノートを作る</button>
        <label>開くノート<select className={button} aria-label="ノートを選択" value={current?.id ?? ''} onChange={e => choose(e.target.value)}><option value="">選択してください</option>{notes.map(n => <option key={n.id} value={n.id}>{n.title}（{n.kind === 'markdown' ? 'Markdown' : '手書き'}）</option>)}</select></label>
        {current && <button className={button} onClick={() => openPaper(current.id, current.collection_name)}>中央で開く</button>}
        {current && [-1, 1].map(direction => <button className={button} key={direction} disabled={notes.indexOf(current) + direction < 0 || notes.indexOf(current) + direction >= notes.length} onClick={async () => {
          const ids = notes.map(n => n.id), index = ids.indexOf(current.id);
          [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
          try { await apiRequest('PUT', `/api/notes/owners/${owner}/order`, { ids }); await refreshNotes(); } catch (e) { setFailure(String(e)); }
        }}>{direction < 0 ? '前へ' : '後ろへ'}</button>)}
        <label className={button}>.md を取り込む<input className="sr-only" type="file" accept=".md" multiple onChange={async e => {
          try { for (const file of Array.from(e.target.files ?? [])) {
            const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
            const row = await apiRequest<{ id: string }>('POST', '/api/notes', { kind: 'markdown', title: file.name, parent_id: owner, content }); selectMemo(owner, row.id);
          } await refreshNotes(); } catch (e) { setFailure(String(e)); }
        }} /></label>
        {!compact && <span className="text-xs">入力後に自動保存します。</span>}
      </div>
      {choosing && <div role="dialog" aria-label="引用先のノート" className="border p-3">
        <p>追加先のMarkdownノートを選んでください。</p>
        {notes.filter(n => n.kind === 'markdown').map(n => <button className={button} key={n.id} onClick={() => choose(n.id)}>「{n.title}」に追加</button>)}
        <button className={button} onClick={async () => {
          const row = await apiRequest<{ id: string }>('POST', '/api/notes', { kind: 'markdown', title: '引用ノート', parent_id: owner });
          await refreshNotes(); choose(row.id);
        }}>新しいMarkdownノートに追加</button><button className={button} onClick={() => { useStore.getState().setNoteInsert(null); setChoosing(false); }}>キャンセル</button>
      </div>}
      {(failure || error) && <p role="alert">{failure || String(error)}<button onClick={() => void refetch()}>再読み込み</button></p>}
      {current ? <><p className="px-2 text-xs">{paper?.title} · {current.title} · {current.kind === 'markdown' ? 'Markdown' : '手書き'}</p>{current.kind === 'markdown' ? <MarkdownNote key={current.id} id={current.id} /> : <NoteDocumentEditor key={current.id} id={current.id} />}</> : <p className="p-4">ノートを選ぶか、新しいノートを作成してください。</p>}
    </>}
  </div>;
}
