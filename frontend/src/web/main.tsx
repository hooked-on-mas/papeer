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
import { UserRound } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { PHONE_LAYOUT_QUERY } from "./phoneLayout";
import "./style.css";

const session = new DriveSession();
function App() {
  const online = useConnectivity();
  const phone = useMediaQuery(PHONE_LAYOUT_QUERY);
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
  const [focusMode, setFocusMode] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const actionEpoch = useRef(0);
  useEffect(() => () => runtime?.dispose(), [runtime]);
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => { if (!prepareWebNavigation()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, []);
  const load = async (id: string, active = () => true) => {
    const next = await session.manifest(id);
    if (!active() || !prepareWebNavigation()) return;
    const nextRuntime = createDriveLibraryRuntime(session, { sessionKey: crypto.randomUUID(), libraryId: id, revision: next.revision }, next);
    runtime?.dispose(); setRuntime(nextRuntime); setManifest(next); setSelected(id);
  };
  const run = async (action: (active: () => boolean) => Promise<void>) => {
    if (!prepareWebNavigation()) return;
    const epoch = ++actionEpoch.current;
    const active = () => actionEpoch.current === epoch;
    setBusy(true); setError("");
    try { await action(active); } catch (e) { if (active()) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (active()) { setBusy(false); setAuthenticating(false); } }
  };
  const login = () => run(async active => {
    setAuthenticating(true);
    await session.signIn(); if (!active()) return;
    setAuthenticating(false); setSignedIn(true);
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
  const logout = () => {
          if (!prepareWebNavigation()) return;
          actionEpoch.current++;
          clearReadingPlaces();
          runtime?.dispose(); setRuntime(undefined); session.signOut(); setSignedIn(false); setManifest(undefined); setLibraries([]); setSelected(""); setError("");
        };
  const actions = <div className="header-actions">
    {phone && signedIn ? <DropdownMenu>
      <DropdownMenuTrigger className="web-account-trigger" aria-label="Google接続メニュー"><UserRound aria-hidden="true" /><span className="web-account-label">Google接続</span></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48 web-account-menu">
        <DropdownMenuItem disabled={busy || !online} onClick={refresh}>更新</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !online || sdkStatus !== "ready"} onClick={() => void login()}>再ログイン</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={logout}>ログアウト</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu> : <>
        {signedIn && <Button variant="outline" size="sm" disabled={busy || !online} onClick={refresh}>更新</Button>}
        <Button variant="outline" size="sm" disabled={busy || !online || sdkStatus !== "ready"} onClick={() => void login()}>{signedIn ? "再ログイン" : "Googleでログイン"}</Button>
        {signedIn && <Button variant="ghost" size="sm" disabled={busy} onClick={logout}>ログアウト</Button>}
    </>}
      </div>;
  const libraryPicker = libraries.length > 1 ? <label className="library-picker">保存ライブラリ <select value={selected} disabled={busy}
    onChange={e => void run(active => load(e.target.value, active))}>{libraries.map((library, i) =>
      <option key={library.id} value={library.id}>ライブラリ {i + 1} · {new Date(library.modifiedTime).toLocaleString()}</option>)}</select></label> : null;
  return <WorkspaceRoot className={`web-app ${manifest && focusMode ? "reader-focus" : ""}`}>
    {!manifest && <WorkspaceHeader className="web-document-header"><a className="brand" href="./">
      <img src={`${import.meta.env.BASE_URL}papeer.png`} alt="" />Papeer</a>{actions}</WorkspaceHeader>}
    {error && <p role="alert" className="error banner">{error}</p>}
    {online && sdkStatus === "error" && <div role="alert" className="error banner">Googleログイン機能を読み込めませんでした。
      <Button variant="outline" size="sm" onClick={() => setSdkAttempt(value => value + 1)}>ログインの準備を再試行</Button></div>}
    {busy && <div role="status" className="banner">{authenticating ? "Googleへの接続を待っています…" : "Google Driveから読み込んでいます…"}
      {authenticating && <Button variant="outline" size="sm" onClick={() => session.cancelSignIn()}>接続をキャンセル</Button>}</div>}
    {(!phone || !manifest) && libraryPicker}
    {manifest && runtime ? <WebLibrary key={runtime.scope.sessionKey} runtime={runtime} session={session} manifest={manifest} actions={actions}
      focusMode={focusMode} onFocusModeChange={setFocusMode} transitioning={busy} libraryPicker={phone ? libraryPicker : null} /> : <main className="welcome">
      <h1>論文を選んで、読み始めよう</h1>
      <p>Windows版Papeerで保存した翻訳PDF、手書きノート、<br />メモやチャットを、Google Driveから開けます。</p>
      {!signedIn ? <Button disabled={busy || !online || sdkStatus !== "ready"} onClick={() => void login()}>Googleでログインして開く →</Button>
        : !busy && !error && <p className="empty">保存されたライブラリが見つかりません。Windows版の「保存先・同期 → Google Drive API」でアップロードし、同じGoogleアカウントで開いてください。</p>}
      <div className="welcome-note">PDFへの手書き・文字メモに対応 · あなたのGoogle Driveに保存</div>
    </main>}
    <PwaStatus online={online} compact={phone && !!manifest} />
    <footer className="site-footer"><span>{manifest ? `Drive保存 ${new Date(manifest.updated_at).toLocaleString()}` : "Papeer · Web"}</span>
      <span><a href="https://github.com/hooked-on-mas/papeer" target="_blank" rel="noreferrer">ソースコード</a> · <a href="./licenses.md" target="_blank" rel="noreferrer">ライセンス</a> · <a href="./geist-OFL.txt" target="_blank" rel="noreferrer">フォント</a></span></footer>
  </WorkspaceRoot>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
