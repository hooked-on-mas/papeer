import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";

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

export function PwaStatus({ online }: { online: boolean }) {
  const [install, setInstall] = useState<InstallPrompt>();
  const [standalone, setStandalone] = useState(() => matchMedia("(display-mode: standalone)").matches
    || !!(navigator as Navigator & { standalone?: boolean }).standalone);
  const [updateReady, setUpdateReady] = useState(false);
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
    const inspect = () => { if (!disposed && registration?.waiting) setUpdateReady(true); };
    const updateFound = () => {
      const worker = registration?.installing;
      worker?.addEventListener("statechange", () => {
        inspect();
        if (!disposed && worker.state === "redundant") setCacheFailed(true);
      });
    };
    const check = () => { if (navigator.onLine) void registration?.update().catch(() => {}); };
    const focus = () => { if (document.visibilityState === "visible") check(); };
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL, updateViaCache: "none" })
      .then(value => {
        if (disposed) return;
        registration = value; inspect(); updateFound();
        value.addEventListener("updatefound", updateFound);
      }).catch(() => { if (!disposed) setCacheFailed(true); });
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", focus);
    return () => {
      disposed = true; registration?.removeEventListener("updatefound", updateFound);
      window.removeEventListener("online", check); document.removeEventListener("visibilitychange", focus);
    };
  }, []);

  return <div className="pwa-status">
    {!online && <p role="status">オフラインです。新しい資料の取得・Googleログイン・Driveへの保存には通信が必要です。未送信の書き込みはこの端末に保持し、接続後に再送します。</p>}
    {updateReady && <p role="status">更新があります。書き込みを終え、Papeerのタブとアプリをすべて閉じて開き直すと反映されます。</p>}
    {cacheFailed && <p role="status">オフライン起動の準備を完了できませんでした。通信と端末の空き容量を確認し、次回の起動時に再試行してください。</p>}
    {!standalone && <details className="pwa-install">
      <summary>アプリとして使う</summary>
      <div className="pwa-install-help">
        {install && <Button size="sm" onClick={() => {
          const pending = install; setInstall(undefined);
          void pending.prompt().then(() => pending.userChoice).catch(() => {});
        }}>Papeerをインストール</Button>}
        <p>iPad・iPhone：Safariの共有メニューから「ホーム画面に追加」を選びます。「Webアプリとして開く」がある場合はオンにしてください。</p>
        <p>PC・Android：ブラウザーのメニューから「アプリをインストール」または「ホーム画面に追加」を選びます。</p>
        <p>PDFやノートはDriveから読み込むため通信が必要です。Googleへのログインは起動後に行います。</p>
      </div>
    </details>}
  </div>;
}
