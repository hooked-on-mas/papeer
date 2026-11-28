import { useCallback, useEffect, useId, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { BookOpen, FolderPlus, Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { LibraryContentConnection } from '../reader/LibraryContentConnection';
import type { DocumentLibraryBinding } from '../reader/DocumentLibraryBinding';
import type { BootstrapSession } from './BootstrapSession';
import { ProviderConnectionPanel } from './provider/ProviderConnectionPanel.tsx';
import type { ProviderConnectionState } from './provider/providerConnectionPorts.ts';
import { ProviderOfflinePanel } from './provider/ProviderOfflinePanel.tsx';
import type { ProviderOfflineState } from './provider/providerOfflinePorts.ts';


/** The host owns the session lifetime, including final close. */
export function BootstrapConnection({ session, renderDocument, renderMarkdown, topNotice, chooserFooter }: {
  session: BootstrapSession;
  renderDocument(binding: DocumentLibraryBinding): ReactNode;
  renderMarkdown(binding: DocumentLibraryBinding): ReactNode;
  topNotice?: ReactNode;
  chooserFooter?: ReactNode;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const provider = session.getProviderConnection();
  const subscribeProvider = useCallback((listener: () => void) => provider ? provider.subscribe(listener) : () => {}, [provider]);
  const readProvider = useCallback((): ProviderConnectionState | null => provider?.getSnapshot() ?? null, [provider]);
  const providerState = useSyncExternalStore(subscribeProvider, readProvider, readProvider);
  const offline = session.getOfflineConnection();
  const subscribeOffline = useCallback((listener: () => void) => offline ? offline.subscribe(listener) : () => {}, [offline]);
  const readOffline = useCallback((): ProviderOfflineState | null => offline?.getSnapshot() ?? null, [offline]);
  const offlineState = useSyncExternalStore(subscribeOffline, readOffline, readOffline);
  const newLibraryTitleId = useId();
  const [title, setTitle] = useState('');
  const [leaveError, setLeaveError] = useState(false);
  const [reconnectRequested, setReconnectRequested] = useState(false);
  const [offlineDialogOpen, setOfflineDialogOpen] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const runtime = session.getRetainedRuntime();
  const offlineRuntime = !!runtime && session.getRuntimeProviderOffline();
  useEffect(() => { if (!offlineRuntime) setReconnectRequested(false); }, [offlineRuntime]);
  useEffect(() => { if (!runtime || state.locked || state.phase !== 'ready') setOfflineDialogOpen(false); }, [runtime, state.locked, state.phase]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);

  useEffect(() => {
    const resume = () => { void session.resumePage(); };
    const hide = () => session.setPageAvailable(false);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const creation = session.getSnapshot().creation;
      if (session.getRetainedRuntime()?.binding.sessions.needsExitConfirmation() ||
          provider?.getSnapshot().pendingGuard || offline?.getSnapshot().pendingGuard || offline?.getSnapshot().busy ||
          (creation && ['preparing', 'unknown', 'pending'].includes(creation.stage))) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    const show = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    window.addEventListener('beforeunload', beforeUnload);
    if (session.getSnapshot().phase === 'idle') resume();
    return () => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [session, provider, offline]);

  const retry = () => { void session.resumePage(); };
  const providerBlocks = (!!providerState && (providerState.busy || providerState.pendingGuard)) || (!!offlineState && (offlineState.busy || offlineState.pendingGuard));
  const retainedProviderRecovery = !!runtime && state.locked && session.getRuntimeStorageKind() === 'google-drive';
  const reconnectBlocked = !!providerState && (providerState.busy || providerState.pendingGuard) || !!offlineState?.busy || !!offlineState?.pendingGuard && !retainedProviderRecovery;
  const create = (event: FormEvent) => { event.preventDefault(); if (!providerBlocks && title.trim()) void session.createLibrary(title); };
  const leave = () => { setLeaveError(false); setOfflineDialogOpen(false); void session.returnToChooser().then(result => setLeaveError(result.status !== 'allowed')); };
  const busy = state.phase === 'checking' || state.phase === 'opening' || state.phase === 'creating';
  const creation = state.creation;
  const otherCreations = state.discovery?.creations.filter(item => item.requestId !== creation?.requestId) ?? [];
  const storageKind = session.getRuntimeStorageKind();
  const canManageOffline = !!offline && !!offlineState && offlineState.phase !== 'unavailable' && storageKind === 'google-drive';
  const offlineDialogForced = !!offlineState && (offlineState.busy || offlineState.outcome === 'unknown' || offlineState.revocation === 'unknown');
  const offlineDialogVisible = !!runtime && !state.locked && state.phase === 'ready' && canManageOffline
    && (offlineDialogOpen || offlineDialogForced);
  const showChooserOffline = !!offline && !!offlineState && offlineState.phase !== 'unavailable';
  const expandChooserOffline = !online || offlineState?.phase === 'unlocked' || (offlineState?.choices.length ?? 0) > 0
    || !!offlineState?.offlineActive || !!offlineState?.busy || !!offlineState?.error
    || offlineState?.outcome === 'unknown' || offlineState?.revocation === 'unknown' || offlineRuntime;
  const storageLabel = offlineRuntime
    ? 'Google Drive（オフライン）'
    : storageKind === 'google-drive'
      ? 'Google Drive'
      : 'この端末に保存';
  const offlineButton = canManageOffline ? (
    <Button type="button" variant="ghost" size="xs" className="mt-1 w-full justify-start gap-1.5 text-muted-foreground"
      onClick={() => setOfflineDialogOpen(true)}>
      <WifiOff className="size-3.5 shrink-0" />オフライン利用…
    </Button>
  ) : undefined;

  return <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
    {topNotice}
    {runtime && <div hidden={state.locked || state.phase !== 'ready'} inert={state.locked || state.phase !== 'ready'}
      style={state.locked || state.phase !== 'ready' ? { display: 'none' } : undefined}
      aria-hidden={state.locked || state.phase !== 'ready'} className="flex min-h-0 flex-1 flex-col">
      {offlineRuntime && provider && providerState && (
        <div className="shrink-0 space-y-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span role="status" className="inline-flex items-center gap-1.5 text-foreground">
              <WifiOff className="size-3.5 shrink-0 text-muted-foreground" />
              Google Drive（オフライン）・同期停止中（未送信の変更は保持されます）
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              {!reconnectRequested && <Button type="button" variant="outline" size="xs" disabled={providerBlocks} onClick={() => setReconnectRequested(true)}>Googleへ再接続</Button>}
              {canManageOffline && <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => setOfflineDialogOpen(true)}>オフライン設定</Button>}
            </div>
          </div>
          {reconnectRequested && <ProviderConnectionPanel controller={provider} state={providerState} initiallyExpanded disabled={!!offlineState?.busy || !!offlineState?.pendingGuard} />}
        </div>
      )}
      <LibraryContentConnection key={JSON.stringify([runtime.proof.scope.accountId, runtime.proof.scope.libraryId, runtime.proof.scope.epoch])}
        binding={runtime.binding} navigation={runtime.navigation}
        librarySwitcher={{ label: storageLabel, onSwitch: leave, error: leaveError, extra: offlineButton }}
        renderDocument={renderDocument} renderMarkdown={renderMarkdown} />
      {canManageOffline && offline && offlineState && (
        <Dialog open={offlineDialogVisible} onOpenChange={open => { if (!open && !offlineDialogForced) setOfflineDialogOpen(false); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>オフライン利用の設定</DialogTitle>
            </DialogHeader>
            <ProviderOfflinePanel controller={offline} state={offlineState} disabled={busy} />
          </DialogContent>
        </Dialog>
      )}
    </div>}
    {(state.locked || !runtime) && <section className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-muted/30 p-4 sm:p-8" aria-label="ライブラリ">
      <div className="w-full max-w-md space-y-5 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
        <div className="flex items-center gap-3 border-b pb-4">
          <img src={`${import.meta.env.BASE_URL}papeer.png`} alt="" className="size-9 shrink-0 object-contain" />
          <div className="min-w-0">
            <div className="text-base font-semibold leading-tight">Papeer</div>
            <p className="text-xs text-muted-foreground">論文リーダ・手書き・Markdown ノート</p>
          </div>
        </div>
        {busy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />確認しています…</p>}
        {offlineRuntime && provider && providerState && !reconnectRequested && (
          <Button type="button" variant="outline" className="w-full" disabled={reconnectBlocked} onClick={() => setReconnectRequested(true)}>Googleへ再接続</Button>
        )}
        {state.phase === 'idle' && <div className="space-y-3">
          <p className="text-sm text-muted-foreground">保存先の状態を確認してライブラリを開きます。</p>
          <Button type="button" className="w-full" onClick={retry}>保存先を確認</Button>
        </div>}
        {state.phase === 'setup-required' && <div className="space-y-4">
          <div className="space-y-1">
            <h1 className="text-base font-semibold">ライブラリを準備</h1>
            <p className="text-sm text-muted-foreground">この端末にライブラリを保存する準備が必要です。</p>
          </div>
          <Button type="button" className="w-full" disabled={providerBlocks} onClick={() => { void session.provisionLocal(); }}>この端末で使い始める</Button>
          {provider && providerState && <ProviderConnectionPanel controller={provider} state={providerState} />}
        </div>}
        {state.phase === 'recovery-required' && <div className="space-y-3">
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">保存先を確認できません。接続と保存データを確認してください。</p>
          <Button type="button" variant="outline" className="w-full" onClick={retry}>再確認</Button>
          {provider && providerState && session.getRuntimeStorageKind() === 'google-drive' && (!offlineRuntime || reconnectRequested) &&
            <ProviderConnectionPanel controller={provider} state={providerState} initiallyExpanded />}
        </div>}
        {state.phase === 'closed' && <p className="text-sm text-muted-foreground">ライブラリを閉じました。</p>}
        {state.phase === 'choosing' && <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-base font-semibold">ライブラリを選択</h1>
            <Button type="button" variant="ghost" size="icon-sm" title="一覧を更新" aria-label="一覧を更新" disabled={providerBlocks} onClick={() => { void session.refresh(); }}>
              <RefreshCw className="size-4" />
            </Button>
          </div>
          {state.error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive">操作を完了できませんでした。再確認してください。</p>}
          {state.discovery?.libraries.length ? (
            <ul className="space-y-1.5">{state.discovery.libraries.map((library, index) => <li key={index}>
              {library.status === 'available' ? (
                <Button type="button" variant="outline" className="h-auto w-full justify-start gap-2.5 px-3 py-2.5 text-left font-medium"
                  disabled={providerBlocks || (!!creation && ['unknown', 'pending', 'preparing'].includes(creation.stage))}
                  onClick={() => { void session.openLibrary(library.handle); }}>
                  <BookOpen className="size-4 shrink-0 text-primary" />
                  <span className="truncate">{library.title}</span>
                </Button>
              ) : (
                <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">{library.title}（確認が必要です）</div>
              )}
            </li>)}</ul>
          ) : (
            <p className="text-sm text-muted-foreground">ライブラリはまだありません。下から新しく作成してください。</p>
          )}
          {creation && <CreationResult title={creation.title} stage={creation.stage} requestId={creation.requestId} session={session} disabled={providerBlocks} />}
          {otherCreations.map(item => <CreationResult key={item.requestId} title={item.title}
            stage={item.outcome.status === 'not-found' ? 'unknown' : item.outcome.status} requestId={item.requestId} session={session} disabled={providerBlocks} />)}
          {!creation && otherCreations.length === 0 && state.discovery?.canCreateLibrary && (
            <form onSubmit={create} className="space-y-2 border-t pt-3">
              <div className="space-y-1.5">
                <label htmlFor={newLibraryTitleId} className="block text-xs font-medium text-muted-foreground">
                  新しいライブラリの名前
                </label>
                <div className="flex gap-2">
                  <Input id={newLibraryTitleId} value={title} onChange={event => setTitle(event.target.value)} placeholder="例: 研究メモ" disabled={providerBlocks} required />
                  <Button type="submit" disabled={providerBlocks || !title.trim()}>
                    <FolderPlus className="size-4" />作成
                  </Button>
                </div>
              </div>
            </form>
          )}
          {provider && providerState && <ProviderConnectionPanel controller={provider} state={providerState}
            disabled={!!creation && ['preparing', 'unknown', 'pending'].includes(creation.stage)} />}
        </div>}
        {showChooserOffline && <ProviderOfflinePanel controller={offline} state={offlineState} collapsible initiallyExpanded={expandChooserOffline} disabled={busy || !!providerState?.busy} />}
        {chooserFooter}
      </div>
    </section>}
  </main>;
}

function CreationResult({ title, stage, requestId, session, disabled = false }: {
  title: string; stage: 'preparing' | 'unknown' | 'pending' | 'accepted' | 'rejected'; requestId: string; session: BootstrapSession; disabled?: boolean;
}) {
  const terminal = stage === 'accepted' || stage === 'rejected';
  return <div role="status" className="space-y-2 rounded-lg border bg-muted/30 p-3 text-sm">
    <p>{title}: {stage === 'accepted' ? '作成しました。一覧を更新してください。' : stage === 'rejected' ? '作成できませんでした。' : '作成状況を確認してください。'}</p>
    {terminal ? (
      <Button type="button" size="sm" disabled={disabled} onClick={() => { void session.recoverCreation(requestId).then(() => session.acknowledgeCreation(requestId)).then(() => session.refresh()); }}>確認しました</Button>
    ) : (
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { void session.recoverCreation(requestId); }}>作成状況を再確認</Button>
    )}
  </div>;
}
