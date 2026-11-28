import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { LibraryCreateIdentity } from '../../library/LibrarySession';
import type { DocumentLibraryBinding } from '../../reader/DocumentLibraryBinding';
import { EditGraph } from '../../../runtime/edits/editGraph';
import { validateTemplateInput } from '../../../runtime/markdown/noteTemplates';
import { analyzeMarkdownImages } from '../../../runtime/markdown/markdownImages';
import { assertResourceBindings } from '../../../runtime/edits/contentPublication';
import { Dialog, DialogContent, DialogTitle } from '../../../components/ui/dialog';

const BUILTIN = ['何を解決する論文？', '新しい点', '主な結果', '前提・限界', '自分に使えそうな点', '疑問・次に調べること'].map(x => `## ${x}`).join('\n\n');
const BUILTIN_NAME = '読書メモ';

export function MarkdownTemplates({ binding, currentContent, onInsert, onOpenChange }: { binding: DocumentLibraryBinding; currentContent: string; onInsert(value: string): void; onOpenChange(open: boolean): void }) {
  const library = useMemo(() => binding.sessions.getLibrary(), [binding]);
  const state = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(''), [content, setContent] = useState(BUILTIN);
  const [draft, setDraft] = useState<{ id: string | null; name: string; content: string; baseVersion?: string } | null>(null);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [editPending, setEditPending] = useState(false);
  const generation = useRef(0), guard = useRef(false), createIdentity = useRef<LibraryCreateIdentity | null>(null);
  const editAttempt = useRef<{ id: string; baseVersion: string; content: string } | null>(null);
  guard.current = open;
  useEffect(() => binding.sessions.registerScopeViewGuard(() => !guard.current), [binding.sessions]);
  useEffect(() => { if (!library.getSnapshot().ready) void library.refresh(); }, [library]);
  useEffect(() => () => { generation.current++; onOpenChange(false); }, [onOpenChange]);
  const choose = async (id: string) => {
    const token = ++generation.current; setSelected(id); setConfirmDelete(false); setError(''); setBusy(true);
    try {
      if (!id) { setSelectedVersion(''); setContent(BUILTIN); return; }
      const read = await binding.repository.read(id); if (token !== generation.current) return;
      if (read.heads.length !== 1 || read.waiting.length) throw new Error('template-head');
      const item = new EditGraph(read.checkpoint).snapshot(read.heads[0]);
      if (!item || item.kind !== 'markdown') throw new Error('template-body');
      const catalogItem = library.getSnapshot().templates.find(entry => entry.id === id);
      if (!catalogItem) throw new Error('template-missing');
      validateTemplateInput(catalogItem.title, item.content);
      setSelectedVersion(item.version);
      setContent(item.content);
    } catch { if (token === generation.current) setError('テンプレートを読み込めません。再試行してください。'); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const save = async () => {
    if (!draft || busy) return; let value: { name: string; content: string };
    try { value = validateTemplateInput(draft.name, draft.content); } catch { setError('名前と本文を確認してください。'); return; }
    if (state.templates.some(item => item.id !== draft.id && item.title === value.name)) { setError('同じ名前のテンプレートがあります。'); return; }
    setBusy(true); setError('');
    try {
      if (!editAttempt.current && !createIdentity.current) {
        const images = analyzeMarkdownImages(value.content);
        if (images.problems.length) throw new Error('template-image-invalid');
        await assertResourceBindings({ kind: 'markdown', id: binding.documentId, version: binding.documentId,
          content: value.content, appendIds: [], imageResources: images.imageResources }, id => binding.repository.resourceMetadata(id));
      }
      if (!draft.id) {
        createIdentity.current ??= { itemId: crypto.randomUUID(), contentVersion: crypto.randomUUID(), batchId: crypto.randomUUID() };
        const identity = createIdentity.current, id = identity.itemId;
        if (!await library.createTemplate(value.name, value.content, identity)) throw new Error('template-create');
        if (!library.getSnapshot().templates.some(item => item.id === id)) throw new Error('template-create-result');
        createIdentity.current = null; setDraft(null); await choose(id);
      } else {
        const session = binding.sessions.getMarkdown(draft.id), owner = Symbol('template-editor');
        if (!editAttempt.current) await session.refresh();
        if (!session.acquireEditor(owner)) throw new Error('template-busy');
        try {
          if (editAttempt.current) {
            if (editAttempt.current.id !== draft.id || editAttempt.current.baseVersion !== draft.baseVersion
              || editAttempt.current.content !== value.content) throw new Error('template-retry-mismatch');
            await session.retry();
          } else {
            if (!session.getSnapshot().ready || session.getSnapshot().heads.length !== 1
              || session.getSnapshot().accepted?.version !== draft.baseVersion) throw new Error('template-conflict');
            editAttempt.current = { id: draft.id, baseVersion: draft.baseVersion!, content: value.content };
            setEditPending(true); session.editText(value.content, owner); await session.flush();
          }
          if (!session.canLeave() || session.getSnapshot().accepted?.content !== value.content) throw new Error('template-save');
        } finally { session.releaseEditor(owner); }
        editAttempt.current = null; setEditPending(false);
        setDraft(null); await choose(draft.id);
      }
    } catch { setError(editAttempt.current || createIdentity.current
      ? 'テンプレートを保存できません。内容を保持しています。再試行してください。'
      : 'テンプレートを保存できません。名前・本文・画像参照を確認してください。'); }
    finally { setBusy(false); }
  };
  const item = state.templates.find(x => x.id === selected);
  return <>{!state.ready && state.error && <button type="button" onClick={() => void library.refresh()}>テンプレート一覧の読み込みを再試行</button>}
    <button type="button" disabled={!state.ready || !!state.pendingId} onClick={() => { onOpenChange(true); setOpen(true); setError(''); }}>テンプレートを使う</button>
    <Dialog open={open} onOpenChange={next => { if (!next && !busy && !draft && !state.pendingId) { generation.current++; onOpenChange(false); setOpen(false); } }}>
    <DialogContent showCloseButton={!busy && !draft && !state.pendingId} className="max-h-[90vh] overflow-auto sm:max-w-xl">
      <DialogTitle>このライブラリのテンプレート</DialogTitle>
      {error && <p role="alert">{error}</p>}
      {draft ? <><label>テンプレート名<input aria-label="テンプレート名" value={draft.name} readOnly={busy || editPending || !!draft.id || !!state.pendingId} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>テンプレート本文<textarea aria-label="テンプレート本文" value={draft.content} readOnly={busy || editPending || !!state.pendingId} onChange={event => setDraft({ ...draft, content: event.target.value })} /></label>
        <button type="button" disabled={busy} onClick={() => void save()}>テンプレートを保存</button>
        <button type="button" disabled={busy || editPending || !!state.pendingId} onClick={() => { createIdentity.current = null; setDraft(null); }}>編集を取り消す</button></>
        : <><label>テンプレート<select aria-label="テンプレート" disabled={busy} value={selected} onChange={event => void choose(event.target.value)}>
          <option value="">{BUILTIN_NAME}</option>{state.templates.map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
          {busy ? <p role="status">{'\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\u3092\u8aad\u307f\u8fbc\u3093\u3067\u3044\u307e\u3059\u2026'}</p> : !error && <pre>{content}</pre>}
          <button type="button" disabled={busy || !!error} onClick={() => { onInsert(content); onOpenChange(false); setOpen(false); }}>ノートに追加</button>
          <button type="button" disabled={busy} onClick={() => setDraft({ id: null, name: '', content: '' })}>新規作成</button>
          <button type="button" disabled={busy} onClick={() => setDraft({ id: null, name: '', content: currentContent })}>現在のノートから作成</button>
          <button type="button" disabled={busy || !!error} onClick={() => setDraft({ id: null, name: '', content })}>コピーして作成</button>
          {item && <><button type="button" disabled={busy || !!error} onClick={() => setDraft({ id: item.id, name: item.title, content, baseVersion: selectedVersion })}>編集</button>
            {!confirmDelete ? <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>削除</button> : <>
              <p>このテンプレートを削除します。追加済みのノートは変わりません。</p>
              <button type="button" disabled={busy} onClick={() => { setBusy(true); void (state.pendingId ? library.retry() : library.deleteItems([item.id])).then(ok => { if (ok) void choose(''); else setError('削除できません。再試行してください。'); }).finally(() => setBusy(false)); }}>削除を確定</button>
              <button type="button" disabled={busy || !!state.pendingId} onClick={() => setConfirmDelete(false)}>削除をやめる</button>
            </>}</>}
          {error && <button type="button" disabled={busy} onClick={() => void choose(selected)}>読み込みを再試行</button>}</>}
      <button type="button" disabled={busy || !!draft || !!state.pendingId} onClick={() => { generation.current++; onOpenChange(false); setOpen(false); }}>閉じる</button>
    </DialogContent></Dialog></>;
}
