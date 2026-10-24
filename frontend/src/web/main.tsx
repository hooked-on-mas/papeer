import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DriveSession, type LibraryChoice, type Manifest } from "./drive";
import { WorkspaceHeader, WorkspaceRoot } from "../components/WorkspaceChrome";
import { Button } from "../components/ui/button";
import { createDriveLibraryRuntime, type DriveLibraryRuntime } from "./libraryRuntime";
import { WebLibrary } from "./WebLibrary";
import { PwaStatus, useConnectivity } from "./PwaStatus";
import { prepareWebNavigation } from "./textDrafts";
import { clearReadingPlaces } from "./readingPlace";
import { loadGoogleSdk } from "./googleSdk";
import { useMediaQuery } from "../lib/useMediaQuery";
import { UserRound, X } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { COMPACT_LAYOUT_QUERY } from "./readerLayout";
import { OfflineLibraryStore, offlineLibraryTransport, type LibraryTransport, type OfflineLibrary } from "./offlineLibrary";
import "./style.css";

const session = new DriveSession();
const offlineStore = new OfflineLibraryStore();
function App() {
  const online = useConnectivity();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [sdkStatus, setSdkStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sdkAttempt, setSdkAttempt] = useState(0);
  useEffect(() => {
    if (!online) return;
    let active = true;
    setSdkStatus("loading");
    void loadGoogleSdk().then(() => { if (active) setSdkStatus("ready"); }).catch(() => { if (active) setSdkStatus("error"); });
    return () => { active = false; };
  }, [online, sdkAttempt]);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [libraries, setLibraries] = useState<LibraryChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [manifest, setManifest] = useState<Manifest>();
  const [runtime, setRuntime] = useState<DriveLibraryRuntime>();
  const [transport, setTransport] = useState<LibraryTransport>(session);
  const [savedLibraries, setSavedLibraries] = useState<OfflineLibrary[]>([]);
  const [localOnly, setLocalOnly] = useState(false);
  const [localNoticeDismissed, setLocalNoticeDismissed] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const storageFailed = () => setStorageError(true);
  const [focusMode, setFocusMode] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const actionEpoch = useRef(0);
  const offlineEpoch = useRef(0);
  useEffect(() => () => runtime?.dispose(), [runtime]);
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => { if (!prepareWebNavigation()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, []);
  const load = async (id: string, active = () => true) => {
    const next = await session.manifest(id);
    if (!active() || !prepareWebNavigation()) return;
    try {
      await offlineStore.saveLibrary(id, next);
      const found = await offlineStore.libraries();
      if (active()) setSavedLibraries(found);
    } catch { if (active()) storageFailed(); }
    if (!active()) return;
    const nextTransport = offlineLibraryTransport(session, offlineStore, id, false, storageFailed);
    const nextRuntime = createDriveLibraryRuntime(nextTransport, { sessionKey: crypto.randomUUID(), libraryId: id, revision: next.revision }, next);
    runtime?.dispose(); setRuntime(nextRuntime); setTransport(nextTransport); setManifest(next); setSelected(id); setLocalOnly(false);
  };
  const openSaved = (saved: OfflineLibrary) => {
    if (!prepareWebNavigation()) return;
    actionEpoch.current++;
    session.cancelSignIn();
    const nextTransport = offlineLibraryTransport(session, offlineStore, saved.id, true, storageFailed);
    const nextRuntime = createDriveLibraryRuntime(nextTransport, { sessionKey: crypto.randomUUID(), libraryId: saved.id, revision: saved.manifest.revision }, saved.manifest);
    runtime?.dispose(); setRuntime(nextRuntime); setTransport(nextTransport); setManifest(saved.manifest); setSelected(saved.id);
    setLocalOnly(true); setError(""); setBusy(false); setAuthenticating(false);
  };
  useEffect(() => {
    let active = true;
    const epoch = actionEpoch.current;
    const savedEpoch = offlineEpoch.current;
    void offlineStore.libraries().catch(() => {
      if (active) storageFailed();
      return [] as OfflineLibrary[];
    }).then(async found => {
      if (!active || savedEpoch !== offlineEpoch.current) return;
      setSavedLibraries(found);
      const current = () => active && epoch === actionEpoch.current;
      if (!current()) return;
      // Reachability and Google authentication are irrelevant to local documents.
      // navigator.onLine can stay true on Wi-Fi with no Internet connection.
      if (!online || !session.hasValidToken()) {
        if (found.length) openSaved(found[0]);
        return;
      }
      // Restore an unexpired tab session without opening a Google popup or waiting for its SDK.
      // Check Drive access before loading any protected artifacts from this login.
      setBusy(true);
      try {
        const available = await session.libraries();
        if (!current()) return;
        setLibraries(available); setSignedIn(true);
        if (available.length) await load(available.some(library => library.id === found[0]?.id) ? found[0].id : available[0].id, current);
      } catch (error) {
        if (!current()) return;
        setSignedIn(false);
        if (found.length) openSaved(found[0]);
        setError(error instanceof Error ? error.message : String(error));
      } finally { if (current()) setBusy(false); }
    });
    return () => { active = false; };
    // Restore only at startup; reconnecting must not replace an open reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (action: (active: () => boolean) => Promise<void>) => {
    if (!prepareWebNavigation()) return;
    const epoch = ++actionEpoch.current;
    const active = () => actionEpoch.current === epoch;
    setBusy(true); setError("");
    try { await action(active); } catch (e) { if (active()) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (active()) { setBusy(false); setAuthenticating(false); } }
  };
  const login = (selectAccount = false) => run(async active => {
    setAuthenticating(true);
    await session.signIn({ selectAccount }); if (!active()) return;
    setAuthenticating(false); setSignedIn(true); setLocalOnly(false);
    // Re-read protected artifacts with the new token; only numeric reading state and
    // durable drafts survive reauthorization, never another login's loaded PDF bodies.
    runtime?.dispose(); setRuntime(undefined); setManifest(undefined);
    let found: LibraryChoice[];
    try { found = await session.libraries(); }
    catch (error) {
      // A new token must prove access before retaining another login's view.
      if (active()) { runtime?.dispose(); setRuntime(undefined); setManifest(undefined); setSelected(""); setLibraries([]); }
      throw error;
    }
    if (!active()) return;
    setLibraries(found);
    setSelected("");
    if (found.length) await load(found.some(library => library.id === selected) ? selected : found[0].id, active);
  });
  const refresh = () => void run(async active => {
          const found = await session.libraries(); if (!active()) return; setLibraries(found);
          if (found.length) await load(found.some(f => f.id === selected) ? selected : found[0].id, active);
          else { runtime?.dispose(); setRuntime(undefined); setManifest(undefined); }
        });
  const logout = () => void run(async () => {
          offlineEpoch.current++;
          clearReadingPlaces();
          runtime?.dispose(); setRuntime(undefined); session.signOut(); setSignedIn(false); setManifest(undefined); setLibraries([]); setSelected(""); setError("");
          setLocalOnly(false); setSavedLibraries([]);
          try { await offlineStore.clear(); setStorageError(false); }
          catch { throw new Error("端末のダウンロード済み資料を削除できませんでした。ブラウザーのサイトデータを削除してください。"); }
        });
  const actions = <div className="header-actions">
    {signedIn || (compact && localOnly) ? <DropdownMenu>
      <DropdownMenuTrigger className="web-account-trigger" aria-label="Google接続メニュー"><UserRound aria-hidden="true" /><span className="web-account-label">Google接続</span></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 web-account-menu">
        <DropdownMenuItem disabled={busy || !online || !signedIn} onClick={refresh}>更新</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !online || sdkStatus !== "ready"} onClick={() => void login()}>再ログイン</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !online || sdkStatus !== "ready"} onClick={() => void login(true)}>アカウントを切り替える</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={logout}>{signedIn ? "ログアウト" : "端末の保存を削除"}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu> : <>
        {signedIn && <Button variant="outline" size="sm" disabled={busy || !online} onClick={refresh}>更新</Button>}
        <Button variant="outline" size="sm" disabled={busy || !online || sdkStatus !== "ready"} onClick={() => void login()}>{signedIn ? "再ログイン" : "Googleでログイン"}</Button>
        {(signedIn || localOnly || savedLibraries.length > 0) && <Button variant="ghost" size="sm" disabled={busy} onClick={logout}>{signedIn ? "ログアウト" : "端末の保存を削除"}</Button>}
    </>}
      </div>;
  const chooseLocal = localOnly || !online;
  const choices = chooseLocal ? savedLibraries.map(saved => ({ id: saved.id, name: "", modifiedTime: saved.manifest.updated_at })) : libraries;
  const libraryPicker = choices.length > 1 ? <label className="library-picker">保存ライブラリ <select value={selected} disabled={busy}
    onChange={e => { const id = e.target.value; if (chooseLocal) { const saved = savedLibraries.find(row => row.id === id); if (saved) openSaved(saved); } else void run(active => load(id, active)); }}>{choices.map((library, i) =>
      <option key={library.id} value={library.id}>ライブラリ {i + 1} · {new Date(library.modifiedTime).toLocaleString()}</option>)}</select></label> : null;
  return <WorkspaceRoot className={`web-app ${manifest && focusMode ? "reader-focus" : ""}`}>
    {!manifest && <WorkspaceHeader className="web-document-header"><a className="brand" href="./">
      <img src={`${import.meta.env.BASE_URL}papeer.png`} alt="" />Papeer</a>{actions}</WorkspaceHeader>}
    {error && <p role="alert" className="error banner">{error}</p>}
    {storageError && <p role="alert" className="error banner">資料を端末に保存できません。オフラインでは開けない場合があります。空き容量とブラウザーの保存設定を確認してください。</p>}
    {localOnly && online && !signedIn && !localNoticeDismissed && <div role="status" className="banner local-library-notice">
      <span>端末に保存した資料を表示しています。最新の資料の取得・書き込みの送信にはGoogleでログインしてください。</span>
      <Button variant="outline" size="sm" disabled={busy || sdkStatus === "loading"}
        onClick={() => { if (sdkStatus === "error") setSdkAttempt(value => value + 1); else void login(); }}>
        {sdkStatus === "error" ? "ログインの準備を再試行" : "Googleでログイン"}
      </Button>
      <Button variant="ghost" size="icon" className="local-library-notice-close" aria-label="保存済み資料の案内を閉じる"
        onClick={() => setLocalNoticeDismissed(true)}><X aria-hidden="true" /></Button>
    </div>}
    {online && !signedIn && sdkStatus === "error" && <div role="alert" className="error banner">Googleログイン機能を読み込めませんでした。
      <Button variant="outline" size="sm" onClick={() => setSdkAttempt(value => value + 1)}>ログインの準備を再試行</Button></div>}
    {busy && <div role="status" className="banner">{authenticating ? "Googleへの接続を待っています…" : "Google Driveから読み込んでいます…"}
      {authenticating && <Button variant="outline" size="sm" onClick={() => session.cancelSignIn()}>接続をキャンセル</Button>}</div>}
    {(!compact || !manifest) && libraryPicker}
    {manifest && runtime ? <WebLibrary key={runtime.scope.sessionKey} runtime={runtime} session={transport} manifest={manifest} actions={actions}
      focusMode={focusMode} onFocusModeChange={setFocusMode} transitioning={busy} libraryPicker={libraryPicker} /> : <main className="welcome">
      <h1>論文を選んで、読み始めよう</h1>
      <p>Windows版Papeerで保存した翻訳PDF、手書きノート、<br />メモやチャットを、Google Driveから開けます。</p>
      {savedLibraries.length > 0 && <Button onClick={() => openSaved(savedLibraries[0])}>ダウンロード済みのライブラリを開く</Button>}
      {!signedIn ? <Button variant={savedLibraries.length ? "outline" : "default"} disabled={busy || !online || sdkStatus !== "ready"} onClick={() => void login()}>Googleでログインして開く →</Button>
        : !busy && !error && <p className="empty">保存されたライブラリが見つかりません。Windows版の「保存先・同期 → Google Drive API」でアップロードし、同じGoogleアカウントで開いてください。</p>}
      {!online && !savedLibraries.length && <p>このブラウザーには保存済みの資料がありません。オンラインでPDFを一度開くと、次回からログインせずに読めます。</p>}
      <div className="welcome-note">開いたPDFはこの端末にも保存され、オフラインで読めます。ログアウトすると端末の資料を削除します。</div>
    </main>}
    <PwaStatus online={online} compact={compact && !!manifest} />
    <footer className="site-footer"><span>{manifest ? `Drive保存 ${new Date(manifest.updated_at).toLocaleString()}` : "Papeer · Web"}</span>
      <span><a href="https://github.com/hooked-on-mas/papeer" target="_blank" rel="noreferrer">ソースコード</a> · <a href="./licenses.md" target="_blank" rel="noreferrer">ライセンス</a> · <a href="./geist-OFL.txt" target="_blank" rel="noreferrer">フォント</a></span></footer>
  </WorkspaceRoot>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
