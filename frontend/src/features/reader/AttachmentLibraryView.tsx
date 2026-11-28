import { startReplicationPolling } from '../library/replication/replicationPolling';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DocumentLibraryBinding } from './DocumentLibraryBinding';
import { useContentNavigation } from './navigation/ContentNavigationContext';
import { attachmentText, readAttachmentResource } from './attachmentResource';
import { useWorkspaceFocusGuard } from '../workspace/WorkspaceCommandContext';

/** Common read-only resource surface. Untrusted text/HTML is rendered only as escaped source. */
export function AttachmentLibraryView({ binding }: { binding: DocumentLibraryBinding }) {
  const { navigation } = useContentNavigation();
  const library = binding.sessions.getLibrary();
  const catalog = useSyncExternalStore(library.subscribe, library.getSnapshot, library.getSnapshot);
  const replication = useSyncExternalStore(binding.replication.subscribe, binding.replication.getSnapshot, binding.replication.getSnapshot);
  const [attempt, setAttempt] = useState(0), [error, setError] = useState('');
  const [loaded, setLoaded] = useState<{ title: string; mediaType: string; text: string | null; url: string; deleted: boolean } | null>(null);
  const lifetime = useRef({ active: false, generation: 0 });
  useWorkspaceFocusGuard('reader', () => lifetime.current.active && binding.sessions.getSnapshot().active);
  const syncing = useRef(false);
  useLayoutEffect(() => {
    const value = lifetime.current;
    const show = (event?: PageTransitionEvent) => {
      if (event && !event.persisted) return;
      value.active = true; value.generation++;
      if (event?.persisted) setAttempt(current => current + 1);
    };
    const hide = () => { value.active = false; value.generation++; };
    show(); window.addEventListener('pageshow', show); window.addEventListener('pagehide', hide);
    const release = navigation?.registerCurrent(binding.documentId, { prepareClose: async () => true, canClose: () => true });
    return () => { hide(); release?.(); window.removeEventListener('pageshow', show); window.removeEventListener('pagehide', hide); };
  }, [binding.documentId, navigation]);
  const sync = useCallback(async () => {
    if (syncing.current || !lifetime.current.active || !binding.sessions.getSnapshot().active || binding.replication.getSnapshot().suspended) return;
    syncing.current = true; const generation = lifetime.current.generation;
    try {
      await binding.replication.flush();
      if (lifetime.current.active && generation === lifetime.current.generation && binding.sessions.getSnapshot().active) await library.refresh();
    } catch { /* Replication retains its diagnostics and the loaded attachment stays available. */ }
    finally { syncing.current = false; }
  }, [binding, library]);
  useEffect(() => {
    return startReplicationPolling(() => binding.replication.getSnapshot().running, sync);
  }, [binding, sync]);
  useEffect(() => {
    let disposed = false, url: string | undefined;
    const generation = lifetime.current.generation;
    const alive = () => !disposed && lifetime.current.active && generation === lifetime.current.generation;
    setLoaded(null); setError('');
    void (async () => {
      try {
        let result;
        try { result = await readAttachmentResource(binding.repository, binding.documentId, binding.catalogVersion); }
        catch {
          if (!alive()) return;
          await binding.replication.flush(); if (!alive()) return;
          result = await readAttachmentResource(binding.repository, binding.documentId, binding.catalogVersion);
        }
        if (!alive()) return;
        const { item, resource, deleted } = result;
        url = URL.createObjectURL(new Blob([Uint8Array.from(resource.bytes).buffer], { type: resource.metadata.mediaType }));
        setLoaded({ title: item.title, mediaType: resource.metadata.mediaType, url, deleted,
          text: attachmentText(resource.metadata.mediaType, item.title, resource.bytes) });
      } catch { if (alive()) setError('添付ファイルを取得できません。接続と保存データを確認して再試行してください。'); }
    })();
    const releaseUrl = () => { if (url) { URL.revokeObjectURL(url); url = undefined; } };
    window.addEventListener('pagehide', releaseUrl);
    return () => { disposed = true; releaseUrl(); window.removeEventListener('pagehide', releaseUrl); };
  }, [binding, attempt, catalog.selectedVersion]);
  return <section className="flex h-full min-h-0 flex-col" aria-label="添付ファイル" data-attachment-id={binding.documentId}>
    <h1 className="asset-heading shrink-0 border-b p-3">{loaded?.title ?? '添付ファイル'}</h1>
    <div className="shrink-0 border-b p-2">
      <p role="status">{loaded?.deleted ? 'この添付は削除されています（閲覧のみ）。' : '添付ファイル（閲覧のみ）'}</p>
      <button type="button" disabled={replication.running || replication.suspended} onClick={() => { if (!binding.replication.getSnapshot().suspended) void sync(); }}>同期</button>
      <span role="status">{replication.suspended ? '同期停止中（未送信の変更は保持されます）' : replication.running ? '同期しています…' : replication.error ? '同期できません。内容は保持しています。再試行できます。' : '同期済み'}</span>
      {loaded && <a href={loaded.url} download={loaded.title}>元のファイルをダウンロード</a>}
    </div>
    {error ? <div role="alert">{error}<button type="button" onClick={() => setAttempt(value => value + 1)}>再試行</button></div>
      : !loaded ? <p role="status">添付ファイルを読み込んでいます…</p>
        : loaded.text !== null ? <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3">{loaded.text}</pre>
          : loaded.mediaType === 'application/pdf' ? <iframe title="PDF添付（閲覧のみ）" sandbox="" src={loaded.url} className="min-h-0 w-full flex-1" />
            : <p className="p-3">この形式はダウンロードして確認できます。</p>}
  </section>;
}
