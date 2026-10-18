import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DriveSession, fileLabel, itemFiles, type Database, type Item, type LibraryChoice, type Manifest } from "./drive";
import { PdfReader } from "./PdfReader";
import { AnnotationStore } from "./annotations";
import "./style.css";

const session = new DriveSession();
const title = (item: Item) => String(item.title || item.original_name || "無題");

function Asset({ path, manifest, annotations }: { path: string; manifest: Manifest; annotations?: AnnotationStore }) {
  const [data, setData] = useState<{ url: string; text: string }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    const load = async () => {
      try {
        const blob = await session.file(manifest.files[path], controller.signal);
        const text = /\.(md|txt|json|html|csv)$/i.test(path) ? await blob.text() : "";
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setData({ url, text });
      } catch (e) { if (!controller.signal.aborted) setError(String(e)); }
    };
    void load();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [path, manifest]);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p role="status" className="empty">ファイルを読み込んでいます…</p>;
  const html = "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'\">" + data.text;
  return <>
    <div className="asset-heading"><span>{fileLabel(path, manifest)}</span>
      <a href={data.url} download={path.split("/").pop()}>{/^papers\/.+\/(original|translated)\.pdf$/.test(path) ? "PDF本体を保存 ↓" : "ダウンロード ↓"}</a></div>
    {path.endsWith(".pdf") ? <PdfReader url={data.url} path={path} manifest={manifest} store={annotations} />
      : path.endsWith(".md") ? <article className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        img: ({ src, alt }) => <MemoImage src={src} alt={alt} path={path} manifest={manifest} />,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}>{data.text}</ReactMarkdown></article>
      : path.endsWith(".html") ? <iframe className="html-document" title={fileLabel(path, manifest)} sandbox="" referrerPolicy="no-referrer" srcDoc={html} />
      : /\.(png|jpe?g|gif|webp)$/i.test(path) ? <img className="asset-image" src={data.url} alt={fileLabel(path, manifest)} />
      : data.text ? <pre className="raw">{data.text}</pre> : <p className="empty">このファイルはダウンロードして開けます。</p>}
  </>;
}

function MemoImage({ src, alt, path, manifest }: { src?: string | Blob; alt?: string; path: string; manifest: Manifest }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (typeof src !== "string" || /^(?:[a-z]+:|\/\/)/i.test(src)) return;
    const resolved = new URL(src, "https://library.invalid/" + path);
    const file = manifest.files[decodeURIComponent(resolved.pathname.slice(1))];
    if (!file) return;
    const controller = new AbortController();
    let objectUrl = "";
    void session.file(file, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => undefined);
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, path, manifest]);
  return url ? <img src={url} alt={alt || "メモの画像"} /> : <span>{alt || "画像"}（ダウンロードからも確認できます）</span>;
}

function ReadingData({ item, manifest }: { item: Item; manifest: Manifest }) {
  const [data, setData] = useState<Database>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const file = manifest.files["library-data.json"];
    if (!file) return;
    void session.file(file, controller.signal).then(b => b.text()).then(text => {
      if (!controller.signal.aborted) setData(JSON.parse(text));
    }).catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, [manifest]);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p className="empty">読書データを読み込んでいます…</p>;
  const notes = (data.bookmarks || []).filter(row => row.paper_id === item.id);
  const messages = (data.messages || []).filter(row => row.paper_id === item.id);
  return <article className="prose reading-data">
    <h2>付箋・ハイライト <small>{notes.length}</small></h2>
    {!notes.length && <p>付箋はありません。</p>}
    {notes.map((note, i) => <section key={i}><strong>p.{String(note.page)} · {note.side === "translated" ? "日本語訳" : "原文・ノート"}　{String(note.label || "")}</strong>
      {note.quote ? <blockquote>{String(note.quote)}</blockquote> : null}<p>{String(note.note || "")}</p></section>)}
    <h2>チャット <small>{messages.length}</small></h2>
    {!messages.length && <p>チャットはありません。</p>}
    {messages.map((message, i) => <section key={i}><strong>{message.role === "user" ? "あなた" : "回答"}</strong>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null }}>{String(message.content || "")}</ReactMarkdown></section>)}
    <details><summary>書誌情報・タグなど</summary><pre className="raw">{JSON.stringify(item, null, 2)}</pre></details>
  </article>;
}

function Library({ manifest, libraryId }: { manifest: Manifest; libraryId: string }) {
  const [annotations, setAnnotations] = useState<AnnotationStore>();
  useEffect(() => {
    const store = new AnnotationStore(session, libraryId, manifest);
    setAnnotations(store); void store.start();
    const retry = () => { void store.retry(); };
    const timer = setInterval(retry, 30000);
    window.addEventListener("online", retry); window.addEventListener("focus", retry);
    return () => { clearInterval(timer); window.removeEventListener("online", retry); window.removeEventListener("focus", retry); store.dispose(); };
  }, [manifest, libraryId]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(manifest.items[0]?.id || "");
  const [path, setPath] = useState("");
  const [reading, setReading] = useState(false);
  const item = manifest.items.find(p => p.id === selected);
  const files = item ? itemFiles(manifest, item.id) : Object.keys(manifest.files).filter(p => /^(papers|web)\//.test(p)).sort();
  const selectedPath = files.includes(path) ? path : files[0];
  const visible = manifest.items.filter(p => JSON.stringify(p).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const choose = (id: string) => { setSelected(id); setPath(""); setReading(false); };
  return <div className="workspace">
    <aside>
      <div className="library-title"><span>ライブラリ</span><small>{manifest.items.length} 件</small></div>
      <input className="search" aria-label="論文・ノートを検索" placeholder="論文・ノートを検索…" value={query} onChange={e => setQuery(e.target.value)} />
      <nav aria-label="ライブラリの項目">{visible.map(p => <button key={p.id} className={`item ${p.id === selected ? "selected" : ""}`} onClick={() => choose(p.id)}>
        <span className="item-kind">{p.kind === "notebook" ? "NOTE" : "PDF"}{p.parent_id ? " · 専用ノート" : ""}</span>
        <span>{title(p)}</span><small>{String(p.collection_name || "")}</small>
      </button>)}</nav>
      {!visible.length && <p className="empty">該当する項目はありません。</p>}
      <button className="all-files" onClick={() => choose("")}>ライブラリ全体のファイル</button>
    </aside>
    <main>
      <div className="document-heading"><span className="eyebrow">{item?.kind === "notebook" ? "NOTEBOOK" : item ? "READING DESK" : "LIBRARY FILES"}</span>
        <h1>{item ? title(item) : "ライブラリ全体のファイル"}</h1>
        <div className="document-controls">
          <label>資料 <select aria-label="表示する資料" value={selectedPath || ""} onChange={e => { setPath(e.target.value); setReading(false); }}>
            {files.map(p => <option key={p} value={p}>{item ? fileLabel(p, manifest) : p}</option>)}
          </select></label>
          <button className={reading ? "active" : ""} disabled={!item} onClick={() => setReading(v => !v)}>付箋・チャット</button>
        </div>
      </div>
      <div className="document-body">{reading && item ? <ReadingData key={item.id} item={item} manifest={manifest} />
        : selectedPath ? <Asset key={`${manifest.revision}:${selectedPath}`} path={selectedPath} manifest={manifest} annotations={annotations} />
        : <p className="empty">まだファイルがありません。Windows版でアップロードしてください。</p>}</div>
    </main>
  </div>;
}

function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [libraries, setLibraries] = useState<LibraryChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [manifest, setManifest] = useState<Manifest>();
  const load = async (id: string) => { setManifest(await session.manifest(id)); setSelected(id); };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const login = () => run(async () => {
    await session.signIn(); setSignedIn(true); setManifest(undefined);
    const found = await session.libraries(); setLibraries(found);
    if (found.length) await load(found[0].id);
  });
  return <>
    <header><a className="brand" href="./"><span className="brand-icon">P</span>Papeer <small>WEB LIBRARY</small></a>
      <div className="header-actions">{manifest && <span className="updated">保存 {new Date(manifest.updated_at).toLocaleString()}</span>}
        {signedIn && <button disabled={busy} onClick={() => void run(async () => {
          const found = await session.libraries(); setLibraries(found);
          if (found.length) await load(found.some(f => f.id === selected) ? selected : found[0].id);
          else setManifest(undefined);
        })}>更新</button>}
        <button disabled={busy} onClick={() => void login()}>{signedIn ? "再ログイン" : "Googleでログイン"}</button>
        {signedIn && <button disabled={busy} onClick={() => {
          session.signOut(); setSignedIn(false); setManifest(undefined); setLibraries([]); setSelected(""); setError("");
        }}>ログアウト</button>}
      </div>
    </header>
    {error && <p role="alert" className="error banner">{error}</p>}
    {busy && <p role="status" className="banner">Google Driveから読み込んでいます…</p>}
    {libraries.length > 1 && <label className="library-picker">保存ライブラリ <select value={selected} disabled={busy}
      onChange={e => void run(() => load(e.target.value))}>{libraries.map((library, i) =>
        <option key={library.id} value={library.id}>ライブラリ {i + 1} · {new Date(library.modifiedTime).toLocaleString()}</option>)}</select></label>}
    {manifest ? <Library key={`${selected}:${manifest.revision}`} manifest={manifest} libraryId={selected} /> : <main className="welcome">
      <div className="eyebrow">YOUR READING, EVERYWHERE</div>
      <h1>いつもの論文とノートを、<br />ブラウザーでも。</h1>
      <p>Windows版Papeerで保存した翻訳PDF、手書きノート、<br />メモやチャットを、Google Driveから開けます。</p>
      {!signedIn ? <button className="primary" disabled={busy} onClick={() => void login()}>Googleでログインして開く →</button>
        : !busy && <p className="empty">保存されたライブラリが見つかりません。Windows版の「保存先・同期 → Google Drive API」でアップロードし、同じGoogleアカウントで開いてください。</p>}
      <div className="welcome-note">PDFへの手書き・文字メモに対応 · あなたのGoogle Driveに保存</div>
    </main>}
    <footer className="site-footer">Papeer · <a href="https://github.com/hooked-on-mas/papeer" target="_blank" rel="noreferrer">ソースコード</a> · <a href="./licenses.md" target="_blank" rel="noreferrer">ライセンス</a> · <a href="./geist-OFL.txt" target="_blank" rel="noreferrer">フォント</a></footer>
  </>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
