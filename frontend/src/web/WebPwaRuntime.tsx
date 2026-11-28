import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, WifiOff } from 'lucide-react';
import { Button } from '../components/ui/button';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface WebPwaRuntimeState {
  online: boolean;
  standalone: boolean;
  updateReady: boolean;
  applyingUpdate: boolean;
  updateError: string;
  cacheFailed: boolean;
  canInstall: boolean;
  installApp(): void;
  applyUpdate(): void;
}

export function useWebPwaRuntime(canReload: () => boolean): WebPwaRuntimeState {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const [install, setInstall] = useState<InstallPrompt>();
  const [standalone, setStandalone] = useState(() => typeof window !== 'undefined' && (
    window.matchMedia('(display-mode: standalone)').matches
    || !!(navigator as Navigator & { standalone?: boolean }).standalone
  ));
  const [waiting, setWaiting] = useState<ServiceWorker>();
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const [cacheFailed, setCacheFailed] = useState(false);
  const applyRequested = useRef(false);
  const canReloadRef = useRef(canReload);
  canReloadRef.current = canReload;

  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(display-mode: standalone)');
    const displayChanged = () => setStandalone(media.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone);
    const prompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallPrompt); };
    const installed = () => { setInstall(undefined); setStandalone(true); };
    window.addEventListener('beforeinstallprompt', prompt);
    window.addEventListener('appinstalled', installed);
    media.addEventListener('change', displayChanged);
    return () => {
      window.removeEventListener('beforeinstallprompt', prompt);
      window.removeEventListener('appinstalled', installed);
      media.removeEventListener('change', displayChanged);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    let observedWaiting: ServiceWorker | undefined;
    let registering = false;

    const inspect = () => {
      if (disposed) return;
      const worker = registration?.waiting ?? undefined;
      if (worker !== observedWaiting) {
        observedWaiting?.removeEventListener('statechange', inspect);
        observedWaiting = worker;
        worker?.addEventListener('statechange', inspect);
      }
      const nextWaiting = worker?.state === 'installed' ? worker : undefined;
      setWaiting(nextWaiting);
      if (!nextWaiting) setUpdateError('');
    };

    const controllerChanged = () => {
      if (applyRequested.current) window.location.reload();
      else inspect();
    };

    const updateFound = () => {
      const worker = registration?.installing;
      worker?.addEventListener('statechange', () => {
        inspect();
        if (!disposed && worker.state === 'activated') setCacheFailed(false);
        if (!disposed && worker.state === 'redundant' && !registration?.active) setCacheFailed(true);
      });
    };

    const attach = (value: ServiceWorkerRegistration) => {
      if (disposed) return;
      registration?.removeEventListener('updatefound', updateFound);
      registration = value;
      inspect();
      updateFound();
      value.addEventListener('updatefound', updateFound);
      if (value.active) setCacheFailed(false);
    };

    const register = () => {
      if (registering || disposed) return;
      registering = true;
      void Promise.resolve()
        .then(() => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
          scope: import.meta.env.BASE_URL,
          updateViaCache: 'none',
        }))
        .then(attach)
        .catch(async () => {
          let existing: ServiceWorkerRegistration | undefined;
          try { existing = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL); } catch { /* Browser policy may block this API too. */ }
          if (existing?.active) attach(existing);
          else if (!disposed) setCacheFailed(true);
        })
        .finally(() => { registering = false; });
    };

    const check = () => {
      if (!navigator.onLine) return;
      if (registration) void registration.update().catch(() => {});
      else register();
    };
    const focus = () => { if (document.visibilityState === 'visible') check(); };

    register();
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', focus);
    return () => {
      disposed = true;
      registration?.removeEventListener('updatefound', updateFound);
      observedWaiting?.removeEventListener('statechange', inspect);
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', focus);
    };
  }, []);

  const installApp = useCallback(() => {
    const pending = install;
    if (!pending) return;
    setInstall(undefined);
    void pending.prompt().then(() => pending.userChoice).catch(() => {});
  }, [install]);

  const applyUpdate = useCallback(() => {
    if (!waiting || applyingUpdate) return;
    if (!canReloadRef.current()) {
      setUpdateError('保存できていない変更や確認中の処理があります。完了してから更新してください。');
      return;
    }
    setUpdateError('');
    setApplyingUpdate(true);
    applyRequested.current = true;
    const channel = new MessageChannel();
    const fail = (message: string) => {
      applyRequested.current = false;
      setApplyingUpdate(false);
      setUpdateError(message);
    };
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      fail('更新を適用できませんでした。Papeerのタブとアプリをすべて閉じて、開き直してください。');
    }, 8000);
    channel.port1.onmessage = event => {
      channel.port1.close();
      if (event.data !== 'updating') {
        window.clearTimeout(timeout);
        fail('ほかのPapeerのタブやアプリを閉じてから、もう一度更新してください。');
      }
    };
    waiting.postMessage({ type: 'PAPEER_APPLY_UPDATE' }, [channel.port2]);
  }, [waiting, applyingUpdate]);

  return {
    online,
    standalone,
    updateReady: !!waiting,
    applyingUpdate,
    updateError,
    cacheFailed,
    canInstall: !!install,
    installApp,
    applyUpdate,
  };
}

export function WebPwaBanner({ pwa }: { pwa: WebPwaRuntimeState }) {
  if (pwa.online && !pwa.updateReady && !pwa.cacheFailed && !pwa.updateError) return null;
  return <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs">
    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
      {!pwa.online && <span role="status" className="inline-flex items-center gap-1.5 text-foreground">
        <WifiOff className="size-3.5 shrink-0" />
        オフラインです。保存済みのライブラリを開き、編集は端末に保持して復帰後に送信できます。
      </span>}
      {pwa.cacheFailed && <span role="status">オフライン起動の準備を完了できませんでした。通信と空き容量を確認して再試行してください。</span>}
      {pwa.updateError && <span role="alert" className="text-destructive">{pwa.updateError}</span>}
    </div>
    {pwa.updateReady && <div className="flex items-center gap-2">
      <span role="status" className="text-muted-foreground">新しいバージョンがあります。</span>
      <Button type="button" size="xs" variant="outline" disabled={pwa.applyingUpdate} onClick={pwa.applyUpdate}>
        <RefreshCw className="size-3.5" />{pwa.applyingUpdate ? '更新中…' : '更新を適用'}
      </Button>
    </div>}
  </div>;
}

export function WebPwaInstallHint({ pwa }: { pwa: WebPwaRuntimeState }) {
  if (pwa.standalone) return null;
  return <details className="border-t pt-3 text-xs text-muted-foreground">
    <summary className="cursor-pointer select-none font-medium text-foreground/80 hover:text-foreground">
      アプリとして使う（ホーム画面に追加）
    </summary>
    <div className="mt-2 space-y-1.5 leading-relaxed">
      {pwa.canInstall && <Button type="button" size="xs" variant="outline" onClick={pwa.installApp}>
        <Download className="size-3.5" />Papeerをインストール
      </Button>}
      <p>iPad・iPhone：Safari の共有メニューから「ホーム画面に追加」を選びます（「Webアプリとして開く」をオン）。</p>
      <p>PC・Android：ブラウザーのメニューから「アプリをインストール」または「ホーム画面に追加」を選びます。</p>
      <p>オフラインで開くには、オンライン接続中にライブラリ内の「オフライン利用…」から端末のパスフレーズを設定してください。</p>
    </div>
  </details>;
}
