import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { prepareWebNavigation } from "./textDrafts";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function useConnectivity() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return online;
}

export function PwaStatus({ online, compact = false }: { online: boolean; compact?: boolean }) {
  const [install, setInstall] = useState<InstallPrompt>();
  const [standalone, setStandalone] = useState(() => matchMedia("(display-mode: standalone)").matches
    || !!(navigator as Navigator & { standalone?: boolean }).standalone);
  const [waiting, setWaiting] = useState<ServiceWorker>();
  const updateReady = !!waiting;
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const applyRequested = useRef(false);
  const [cacheFailed, setCacheFailed] = useState(false);
  useEffect(() => {
    const media = matchMedia("(display-mode: standalone)");
    const displayChanged = () => setStandalone(media.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone);
    const prompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallPrompt); };
    const installed = () => { setInstall(undefined); setStandalone(true); };
    window.addEventListener("beforeinstallprompt", prompt);
    window.addEventListener("appinstalled", installed);
    media.addEventListener("change", displayChanged);
    return () => {
      window.removeEventListener("beforeinstallprompt", prompt); window.removeEventListener("appinstalled", installed);
      media.removeEventListener("change", displayChanged);
    };
  }, []);
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    let registering = false;
    const inspect = () => { if (!disposed) setWaiting(registration?.waiting ?? undefined); };
    const controllerChanged = () => {
      if (applyRequested.current) window.location.reload();
      else inspect();
    };
    const updateFound = () => {
      const worker = registration?.installing;
      worker?.addEventListener("statechange", () => {
        inspect();
        if (!disposed && worker.state === "activated") setCacheFailed(false);
        if (!disposed && worker.state === "redundant") setCacheFailed(true);
      });
    };
    const attach = (value: ServiceWorkerRegistration) => {
      if (disposed) return;
      registration?.removeEventListener("updatefound", updateFound);
      registration = value; inspect(); updateFound();
      value.addEventListener("updatefound", updateFound);
      if (value.active) setCacheFailed(false);
    };
    const register = () => {
      if (registering || disposed) return;
      registering = true;
      void Promise.resolve().then(() => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL, updateViaCache: "none" }))
      .then(value => {
        attach(value);
      }).catch(async () => {
        // An offline launch may already have a valid cached worker.
        let existing: ServiceWorkerRegistration | undefined;
        try { existing = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL); } catch { /* Browser policy may block this API too. */ }
        if (existing?.active) attach(existing);
        else if (!disposed) setCacheFailed(true);
      }).finally(() => { registering = false; });
    };
    const check = () => { if (navigator.onLine) { if (registration) void registration.update().catch(() => {}); else register(); } };
    const focus = () => { if (document.visibilityState === "visible") check(); };
    register();
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", focus);
    return () => {
      disposed = true; registration?.removeEventListener("updatefound", updateFound);
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
      window.removeEventListener("online", check); document.removeEventListener("visibilitychange", focus);
    };
  }, []);

  const applyUpdate = () => {
    if (!waiting || applyingUpdate) return;
    if (!prepareWebNavigation()) {
      setUpdateError("保存できていない書き込みがあります。保存エラーを解消してから更新してください。"); return;
    }
    setUpdateError(""); setApplyingUpdate(true); applyRequested.current = true;
    const channel = new MessageChannel();
    const fail = (message: string) => {
      applyRequested.current = false; setApplyingUpdate(false); setUpdateError(message);
    };
    const timeout = setTimeout(() => {
      channel.port1.close();
      fail("更新を適用できませんでした。Papeerのタブとアプリをすべて閉じて、開き直してください。");
    }, 8000);
    channel.port1.onmessage = event => {
      channel.port1.close();
      if (event.data !== "updating") {
        clearTimeout(timeout);
        fail("ほかのPapeerのタブやアプリを閉じてから、もう一度更新してください。");
      }
    };
    waiting.postMessage({ type: "PAPEER_APPLY_UPDATE" }, [channel.port2]);
  };

  const notices = <>
    {!online && <p role="status">オフラインです。ダウンロード済みのPDFは読めます。新しい資料の取得・Googleログイン・Driveへの保存には通信が必要です。未送信の書き込みはこの端末に保持し、接続・ログイン後に再送します。</p>}
    {updateReady && <p role="status">更新があります。 <Button size="sm" disabled={applyingUpdate} onClick={applyUpdate}>{applyingUpdate ? "更新中…" : "更新を適用"}</Button></p>}
    {updateError && <p role="alert">{updateError}</p>}
    {cacheFailed && <p role="status">オフライン起動の準備を完了できませんでした。通信と端末の空き容量を確認し、次回の起動時に再試行してください。</p>}
  </>;
  return <div className="pwa-status">
    {compact ? (!online || updateReady || cacheFailed) && <details className="pwa-notices">
      <summary><span role="status">{!online ? "オフライン · 書き込みは端末に保持" : updateReady ? "更新があります" : "オフライン起動の準備が必要です"}</span></summary>
      <div>{notices}</div>
    </details> : notices}
    {!standalone && <details className="pwa-install">
      <summary>アプリとして使う</summary>
      <div className="pwa-install-help">
        {install && <Button size="sm" onClick={() => {
          const pending = install; setInstall(undefined);
          void pending.prompt().then(() => pending.userChoice).catch(() => {});
        }}>Papeerをインストール</Button>}
        <p>iPad・iPhone：Safariの共有メニューから「ホーム画面に追加」を選びます。「Webアプリとして開く」がある場合はオンにしてください。</p>
        <p>PC・Android：ブラウザーのメニューから「アプリをインストール」または「ホーム画面に追加」を選びます。</p>
        <p>ダウンロード済みのPDFやノートは、ログインせずにオフラインで読めます。新しい資料の取得とDriveへの保存にはGoogleログインと通信が必要です。</p>
      </div>
    </details>}
  </div>;
}
