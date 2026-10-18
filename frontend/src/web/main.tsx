import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DriveSession, type LibraryChoice, type Manifest } from "./drive";
import { WorkspaceHeader, WorkspaceRoot } from "../components/WorkspaceChrome";
import { Button } from "../components/ui/button";
import { createDriveLibraryRuntime, type DriveLibraryRuntime } from "./libraryRuntime";
import { WebLibrary } from "./WebLibrary";
import { PwaStatus, useConnectivity } from "./PwaStatus";
import "./style.css";

const session = new DriveSession();
function App() {
  const online = useConnectivity();
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [libraries, setLibraries] = useState<LibraryChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [manifest, setManifest] = useState<Manifest>();
  const [runtime, setRuntime] = useState<DriveLibraryRuntime>();
  useEffect(() => () => runtime?.dispose(), [runtime]);
  const load = async (id: string) => {
    const next = await session.manifest(id);
    const nextRuntime = createDriveLibraryRuntime(session, { sessionKey: crypto.randomUUID(), libraryId: id, revision: next.revision }, next);
    runtime?.dispose(); setRuntime(nextRuntime); setManifest(next); setSelected(id);
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const login = () => run(async () => {
    runtime?.dispose(); setRuntime(undefined); setManifest(undefined); setSignedIn(false); setLibraries([]); setSelected(""); session.signOut();
    await session.signIn(); setSignedIn(true);
    const found = await session.libraries(); setLibraries(found);
    if (found.length) await load(found[0].id);
  });
  const actions = <div className="header-actions">
        {signedIn && <Button variant="outline" size="sm" disabled={busy || !online} onClick={() => void run(async () => {
          const found = await session.libraries(); setLibraries(found);
          if (found.length) await load(found.some(f => f.id === selected) ? selected : found[0].id);
          else { runtime?.dispose(); setRuntime(undefined); setManifest(undefined); }
        })}>更新</Button>}
        <Button variant="outline" size="sm" disabled={busy || !online} onClick={() => void login()}>{signedIn ? "再ログイン" : "Googleでログイン"}</Button>
        {signedIn && <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
          runtime?.dispose(); setRuntime(undefined); session.signOut(); setSignedIn(false); setManifest(undefined); setLibraries([]); setSelected(""); setError("");
        }}>ログアウト</Button>}
      </div>;
  return <WorkspaceRoot className="web-app">
    {!manifest && <WorkspaceHeader className="web-document-header"><a className="brand" href="./">
      <img src={`${import.meta.env.BASE_URL}papeer.png`} alt="" />Papeer</a>{actions}</WorkspaceHeader>}
    {error && <p role="alert" className="error banner">{error}</p>}
    {busy && <p role="status" className="banner">Google Driveから読み込んでいます…</p>}
    {libraries.length > 1 && <label className="library-picker">保存ライブラリ <select value={selected} disabled={busy}
      onChange={e => void run(() => load(e.target.value))}>{libraries.map((library, i) =>
        <option key={library.id} value={library.id}>ライブラリ {i + 1} · {new Date(library.modifiedTime).toLocaleString()}</option>)}</select></label>}
    {manifest && runtime ? <WebLibrary key={runtime.scope.sessionKey} runtime={runtime} session={session} manifest={manifest} actions={actions} /> : <main className="welcome">
      <h1>論文を選んで、読み始めよう</h1>
      <p>Windows版Papeerで保存した翻訳PDF、手書きノート、<br />メモやチャットを、Google Driveから開けます。</p>
      {!signedIn ? <Button disabled={busy || !online} onClick={() => void login()}>Googleでログインして開く →</Button>
        : !busy && <p className="empty">保存されたライブラリが見つかりません。Windows版の「保存先・同期 → Google Drive API」でアップロードし、同じGoogleアカウントで開いてください。</p>}
      <div className="welcome-note">PDFへの手書き・文字メモに対応 · あなたのGoogle Driveに保存</div>
    </main>}
    <PwaStatus online={online} />
    <footer className="site-footer"><span>{manifest ? `Drive保存 ${new Date(manifest.updated_at).toLocaleString()}` : "Papeer · Web"}</span>
      <span><a href="https://github.com/hooked-on-mas/papeer" target="_blank" rel="noreferrer">ソースコード</a> · <a href="./licenses.md" target="_blank" rel="noreferrer">ライセンス</a> · <a href="./geist-OFL.txt" target="_blank" rel="noreferrer">フォント</a></span></footer>
  </WorkspaceRoot>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
