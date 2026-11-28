import { startReplicationPolling } from '../../library/replication/replicationPolling';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { assertDocumentLibraryBinding, type DocumentLibraryBinding } from '../../reader/DocumentLibraryBinding';
import { ReaderPlacementSession, type ReaderPlacement } from '../../reader/ReaderPlacementSession';
import { EditGraph } from '../../../runtime/edits/editGraph';
import type { MarkdownEditSession, MarkdownEditState, MarkdownImagePort } from './MarkdownEditSession';
import type { MarkdownConflictPort } from './MarkdownConflictPanel';
import { useNoteAutosave } from '../useNoteAutosave';
import { useWorkspaceEditor, useWorkspaceFocusGuard } from '../../workspace/WorkspaceCommandContext';
import { useContentNavigation } from '../../reader/navigation/ContentNavigationContext';
import { useLibraryItemDeleted, useLibraryItemTitle } from '../../library/useLibraryItemTitle';

export type MarkdownLibraryView = {
  binding: DocumentLibraryBinding; documentId: string; title: string; loading: boolean; error: string; status: string; syncDisabled: boolean;
  setTemplateOpen(open: boolean): void;
  conflict: MarkdownConflictPort;
  session: MarkdownEditSession; state: MarkdownEditState;
  rootRef: RefObject<HTMLDivElement | null>; owner: symbol; editable: boolean; scopeWriteHeld: boolean; deleted?: boolean;
  placement: ReaderPlacement; heads: string[];
  resources: Pick<MarkdownImagePort, 'scope' | 'readResource'>; canAppendImage: boolean;
  moveEditor(placement: ReaderPlacement): Promise<boolean>;
  editText(text: string): void; flush(): Promise<void>;
  appendImage(file: File): Promise<void>; cancelImage(): void;
  undo(): void; redo(): void; retry(): void; sync(): void; checkout(version: string): void;
};

/** The canonical body authority is shared by both hosts; the view supplies no writer or storage. */
export function MarkdownLibraryConnection({ binding, render }: {
  binding: DocumentLibraryBinding; render(view: MarkdownLibraryView): ReactNode;
}) {
  assertDocumentLibraryBinding(binding);
  const scope = binding.repository.scope;
  return <MarkdownLibraryState key={JSON.stringify([scope.accountId, scope.libraryId, scope.epoch, binding.documentId])}
    binding={binding} render={render} />;
}

function MarkdownLibraryState({ binding, render }: {
  binding: DocumentLibraryBinding; render(view: MarkdownLibraryView): ReactNode;
}) {
  const session = useMemo(() => binding.sessions.getMarkdown(binding.documentId), [binding]);
  const registry = useSyncExternalStore(binding.sessions.subscribe, binding.sessions.getSnapshot, binding.sessions.getSnapshot);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const replication = useSyncExternalStore(binding.replication.subscribe, binding.replication.getSnapshot, binding.replication.getSnapshot);
  const reader = useMemo(() => new ReaderPlacementSession({ scope: binding.repository.scope, documentId: binding.documentId,
    persistence: binding.readerState, canMove: () => binding.sessions.getSnapshot().active && session.canLeave() }), [binding, session]);
  const reading = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  const rootRef = useRef<HTMLDivElement>(null), owner = useRef(Symbol('canonical-markdown-editor'));
  const templateOpen = useRef(false);
  const setTemplateOpen = useCallback((open: boolean) => { templateOpen.current = open; }, []);
  const [title, setTitle] = useState('ノート'), [initialized, setInitialized] = useState(false);
  const [initiallyDeleted, setInitiallyDeleted] = useState(false);
  const displayedTitle = useLibraryItemTitle(binding, title);
  const deleted = useLibraryItemDeleted(binding, initiallyDeleted);
  const [loadError, setLoadError] = useState(''), [commandError, setCommandError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0), [pendingCount, setPendingCount] = useState<number | null>(null);
  const lifetime = useRef({ active: false, generation: 0 });
  const { navigation } = useContentNavigation();
  const synchronizing = useRef<Promise<void> | undefined>(undefined);
  useLayoutEffect(() => {
    const current = lifetime.current;
    const show = (event?: PageTransitionEvent) => {
      if (event && !event.persisted) return;
      current.active = true; current.generation++;
      if (event?.persisted) setLoadAttempt(value => value + 1);
    };
    const hide = () => { reader.flush(); current.active = false; current.generation++; };
    show(); window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => { hide(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); };
  }, [reader]);
  useLayoutEffect(() => {
    const token = owner.current;
    session.acquireEditor(token); return () => session.releaseEditor(token);
  }, [session]);
  useLayoutEffect(() => { if (!state.editorOwner) session.acquireEditor(owner.current); }, [session, state.editorOwner]);
  useLayoutEffect(() => {
    if (!navigation) return;
    const canClose = () => {
      const current = session.getSnapshot();
      const readOnlyUnready = !current.ready && !current.dirty && !current.saving && !current.imagePending && !current.imageSaving;
      return lifetime.current.active && !templateOpen.current && current.editorOwner === owner.current && (session.canLeave() || readOnlyUnready);
    };
    return navigation.registerCurrent(binding.documentId, { canClose, prepareClose: async () => {
      reader.flush(); if (session.getSnapshot().ready) await session.flush(); return canClose();
    } });
  }, [navigation, binding.documentId, reader, session]);

  const synchronize = useCallback(() => {
    if (!initialized || !lifetime.current.active || !binding.sessions.getSnapshot().active || !session.canLeave() || binding.replication.getSnapshot().suspended) return Promise.resolve();
    if (synchronizing.current) return synchronizing.current;
    const generation = lifetime.current.generation;
    const alive = () => lifetime.current.active && lifetime.current.generation === generation && binding.sessions.getSnapshot().active;
    const work = Promise.resolve().then(async () => {
      if (!alive() || binding.replication.getSnapshot().suspended) return;
      try {
        await binding.replication.flush();
        if (!alive()) return;
        if (session.canLeave()) await session.refresh();
      } catch { /* Replication keeps the durable outbox and exposes its own retryable error. */ }
      if (!alive()) return;
      try {
        const records = await binding.repository.pendingRecords();
        if (alive()) setPendingCount(records.filter(record => record.batch.targetId === binding.documentId
          || record.publication?.content?.id === binding.documentId).length);
      } catch { if (alive()) setPendingCount(null); }
    });
    synchronizing.current = work;
    return work.finally(() => { if (synchronizing.current === work) synchronizing.current = undefined; });
  }, [binding, session, initialized]);

  useEffect(() => {
    let mounted = true;
    const generation = lifetime.current.generation;
    const alive = () => mounted && lifetime.current.active && lifetime.current.generation === generation;
    setInitialized(false);
    void (async () => {
      try {
        await binding.sessions.initialize();
        if (!alive()) return;
        if (!binding.sessions.getSnapshot().ready || !binding.sessions.getSnapshot().active) throw new Error('recovery-unavailable');
        // Read locally before trying the network. Multiple heads are a selectable local result.
        if ((!session.getSnapshot().ready || session.canLeave()) && !await session.refresh()) {
          if (!alive()) return;
          if (!session.getSnapshot().heads.length) {
            await binding.replication.flush();
            if (!alive()) return;
            if (!await session.refresh() && !session.getSnapshot().heads.length) throw new Error('markdown-unavailable');
          }
        }
        if (!alive()) return;
        const library = await binding.repository.read(binding.repository.scope.libraryId);
        if (!alive()) return;
        const graph = new EditGraph(library.checkpoint);
        const catalogVersion = binding.catalogVersion ?? (library.heads.length === 1 ? library.heads[0] : undefined);
        const current = catalogVersion && library.heads.includes(catalogVersion) ? graph.snapshot(catalogVersion) : undefined;
        if (current?.kind !== 'library') throw new Error('library-unavailable');
        const item = current.items.find(value => value.id === binding.documentId);
        if (item?.kind !== 'markdown') throw new Error('markdown-item-unavailable');
        setInitiallyDeleted(current.deletions.some(record => record.active && record.itemIds.includes(binding.documentId)));
        setTitle(item.title); setLoadError(''); setInitialized(true);
      } catch { if (alive()) setLoadError('ノートを開けません。保存データと接続を確認して再試行してください。'); }
    })();
    return () => { mounted = false; };
  }, [binding, session, loadAttempt]);

  const flush = useCallback(async () => { await session.flush(); }, [session]);
  useNoteAutosave({ dirty: state.dirty, value: state.content, revision: state.accepted?.version,
    save: flush, onError: session.reportError, flushOnUnmount: true });
  useEffect(() => {
    if (registry.ready && state.ready && !state.dirty && !state.saving) void synchronize();
  }, [registry.ready, state.ready, state.dirty, state.saving, state.accepted?.version, synchronize]);
  useEffect(() => {
    return startReplicationPolling(() => binding.replication.getSnapshot().running, synchronize);
  }, [binding, session, synchronize]);
  const moveEditor = async (target: ReaderPlacement, stillCurrent: () => boolean = () => true) => {
    if (!stillCurrent()) return false;
    if (target === reading.placement) return true;
    if (!initialized || !lifetime.current.active || templateOpen.current || !binding.sessions.isScopeWritable()) return false;
    const generation = lifetime.current.generation;
    await session.flush();
    if (!stillCurrent() || !lifetime.current.active || generation !== lifetime.current.generation || templateOpen.current || !binding.sessions.isScopeWritable()) return false;
    if (!session.canLeave()) { setCommandError('保存を確認してから編集面を移動してください。'); return false; }
    if (!stillCurrent() || templateOpen.current || !binding.sessions.isScopeWritable()) return false;
    setCommandError(''); return reader.setPlacement(target);
  };
  const workspaceMoveEditor = useWorkspaceEditor({ id: binding.documentId, kind: 'markdown' }, moveEditor);
  useWorkspaceFocusGuard('reader', () => lifetime.current.active && binding.sessions.getSnapshot().active
    && !templateOpen.current && !session.getSnapshot().imagePending && !session.getSnapshot().imageSaving);
  const run = async (action: (alive: () => boolean) => Promise<unknown>): Promise<void> => {
    if (!initialized || !lifetime.current.active || !binding.sessions.getSnapshot().active) return;
    const generation = lifetime.current.generation;
    const alive = () => lifetime.current.active && lifetime.current.generation === generation && binding.sessions.getSnapshot().active;
    await action(alive).catch(() => { if (alive()) setCommandError('操作を完了できませんでした。内容を保持しています。再試行してください。'); });
  };
  const status = !initialized ? '読み込み中…' : state.imageSaving ? '画像を保存中…' : state.imagePending ? '追加する画像を保持しています'
    : state.saving ? '保存中…' : state.dirty ? '未保存の変更があります'
    : !state.ready ? '表示する版を選択してください' : !state.durable ? '端末の保存状態を確認してください' : deleted ? 'この資料は削除されています（閲覧のみ）'
      : replication.suspended ? '端末保存済み・同期停止中（未送信の変更は保持されます）' : replication.error ? '端末保存済み・送信を再試行できます'
      : pendingCount === null || replication.running ? '端末保存済み・送信状態を確認中' : pendingCount ? '端末保存済み・未送信' : '送信済み';
  const selectionRequired = !state.ready && state.heads.length > 1 && state.error.includes('markdown-head-selection-required');
  const bodyError = (!state.error && !state.imageProblem) || selectionRequired ? '' : !state.ready || state.editingBlocked
    ? 'ノートや下書きの保存データを確認できません。内容は保持しています。'
    : state.dirty || !state.durable ? '変更を保存できません。入力内容を保持しています。再試行してください。'
      : 'ノートを更新できません。現在の内容を保持しています。再試行してください。';
  const preferenceError = reading.error ? '表示設定を確認できません。本文の編集は継続できます。' : '';
  const syncError = !replication.suspended && replication.error ? '同期できません。端末の保存内容は保持しています。再試行してください。' : '';
  const conflict: MarkdownConflictPort = {
    heads: state.heads,
    busy: !initialized || !lifetime.current.active || !binding.sessions.isScopeWritable() || state.saving || state.dirty || state.imagePending || state.imageSaving,
    canDiscardRejected: session.canDiscardRejectedResolution(),
    compare: () => { try { return session.conflictVersions(); } catch { return []; } },
    checkout: async version => {
      if (!lifetime.current.active || !binding.sessions.isScopeWritable() || templateOpen.current || state.dirty || state.saving || state.imagePending || state.imageSaving) return false;
      return session.refresh(version);
    },
    adopt: async (version, heads) => {
      if (!lifetime.current.active || !binding.sessions.isScopeWritable() || templateOpen.current || deleted || state.editorOwner !== owner.current) return false;
      return session.resolveConflict(version, heads);
    },
    discardRejected: () => lifetime.current.active && binding.sessions.getSnapshot().active && !templateOpen.current
      ? session.discardRejectedResolution() : Promise.resolve(false),
  };
  return render({ binding, setTemplateOpen, conflict, documentId: binding.documentId, title: displayedTitle, session, state, rootRef, owner: owner.current,
    loading: !initialized || !registry.ready, error: loadError || commandError || bodyError || preferenceError || syncError, status, syncDisabled: replication.suspended,
    editable: initialized && !deleted && registry.active && binding.sessions.isScopeWritable() && state.ready && !state.editingBlocked && state.editorOwner === owner.current,
    scopeWriteHeld: !binding.sessions.isScopeWritable(),
    deleted, placement: reading.placement, heads: state.heads, moveEditor: workspaceMoveEditor,
    resources: binding.repository, canAppendImage: !deleted && session.canAppendImage(),
    editText: text => { if (initialized && !deleted && lifetime.current.active && binding.sessions.isScopeWritable()) session.editText(text, owner.current); }, flush,
    appendImage: async file => { if (deleted || !binding.sessions.isScopeWritable()) return; await run(async () => {
      const bytes = () => file.arrayBuffer().then(value => new Uint8Array(value));
      if (await session.appendImage({ bytes, mediaType: file.type.toLowerCase(), alt: file.name }, owner.current)) await session.flush();
    }); },
    cancelImage: () => run(async () => { if (session.cancelImage(owner.current)) await session.flush(); }),
    undo: () => { if (!deleted && binding.sessions.isScopeWritable()) run(async alive => { await session.flush(); if (alive() && session.canLeave()) await session.undo(); }); },
    redo: () => { if (!deleted && binding.sessions.isScopeWritable()) run(async alive => { await session.flush(); if (alive() && session.canLeave()) await session.redo(); }); },
    retry: () => { setCommandError(''); reader.flush(); if (loadError) setLoadAttempt(value => value + 1);
      run(async () => { if (!session.getSnapshot().ready) await session.refresh(); else await session.retry(); await synchronize(); }); },
    sync: () => { if (!binding.replication.getSnapshot().suspended) void run(async () => { await session.flush(); await synchronize(); }); },
    checkout: version => { run(async alive => {
      if (!session.getSnapshot().heads.includes(version)) return;
      await session.flush();
      if (alive() && (session.canLeave() || !session.getSnapshot().ready)) {
        setCommandError(''); await session.refresh(version);
      }
    }); },
  });
}
