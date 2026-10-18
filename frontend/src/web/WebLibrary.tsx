import { useEffect, useState, type ReactNode } from "react";
import { FileText, Folder, NotebookPen, PanelLeft } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { WorkspaceHeader, WorkspaceSidebar, WorkspaceTabList } from "../components/WorkspaceChrome";
import { Button } from "../components/ui/button";
import { Tabs, TabsContent, TabsTrigger } from "../components/ui/tabs";
import type { ArtifactView, SavedReadingView } from "../runtime/contracts";
import type { DriveLibraryRuntime } from "./libraryRuntime";
import type { DriveSession, Manifest } from "./drive";
import { AnnotationStore } from "./annotations";
import { DocumentReader } from "./DocumentReader";
import { useMediaQuery } from "../lib/useMediaQuery";

/** Web host owns annotation transport/lifecycle; the shared chrome has no Drive dependency. */
export function WebLibrary({ runtime, session, manifest, actions }: {
  runtime: DriveLibraryRuntime; session: DriveSession; manifest: Manifest; actions: ReactNode;
}) {
  const [annotations, setAnnotations] = useState<AnnotationStore>();
  useEffect(() => {
    const store = new AnnotationStore(session, runtime.scope.libraryId, manifest);
    setAnnotations(store); void store.start();
    const retry = () => { void store.retry(); };
    const timer = setInterval(retry, 30000);
    window.addEventListener("online", retry); window.addEventListener("focus", retry);
    return () => { clearInterval(timer); window.removeEventListener("online", retry); window.removeEventListener("focus", retry); store.dispose(); };
  }, [runtime, session, manifest]);
  const items = runtime.query.listItems();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(items[0]?.id ?? "");
  const [artifactId, setArtifactId] = useState("");
  const [tab, setTab] = useState("reader");
  const narrow = useMediaQuery("(max-width: 800px)");
  const [collapsed, setCollapsed] = useState(narrow);
  useEffect(() => { if (narrow) setCollapsed(true); }, [narrow]);
  const item = items.find(row => row.id === selected);
  const artifacts = runtime.query.listArtifacts(item?.id ?? null);
  const artifact = artifacts.find(row => row.id === artifactId) ?? artifacts[0];
  const summary = artifacts.find(row => row.filename === "article.md");
  const memos = artifacts.filter(row => row.role === "attachment");
  const [memoId, setMemoId] = useState("");
  const memo = memos.find(row => row.id === memoId) ?? memos[0];
  const visible = items.filter(row => `${row.title} ${row.collectionName}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const collections = [...new Set(visible.map(row => row.collectionName || "未分類"))].sort();
  const choose = (id: string) => {
    setSelected(id); setArtifactId(""); setTab("reader");
    if (matchMedia("(max-width: 800px)").matches) setCollapsed(true);
  };
  return <div className="workspace">
    {!collapsed && <><button className="sidebar-backdrop" aria-label="ライブラリを閉じる" onClick={() => setCollapsed(true)} />
      <aside className="web-sidebar" aria-label="ライブラリ一覧"><WorkspaceSidebar onCollapse={() => setCollapsed(true)} footer={
        <button className="all-files" onClick={() => choose("")}><Folder className="size-4" />ライブラリ全体のファイル</button>}>
        <div className="library-list">
          <div className="library-title"><span>ライブラリ</span><small>{items.length} 件</small></div>
          <input className="search" aria-label="論文・ノートを検索" placeholder="論文・ノートを検索…" value={query} onChange={e => setQuery(e.target.value)} />
          <nav aria-label="ライブラリの項目">{collections.map(collection => <section key={collection}>
            <div className="collection-heading"><Folder className="size-4" />{collection}</div>
            {visible.filter(row => (row.collectionName || "未分類") === collection).map(row => <button key={row.id}
              className={`item ${row.id === selected ? "selected" : ""}`} aria-current={row.id === selected ? "page" : undefined} onClick={() => choose(row.id)}>
              {row.kind === "notebook" ? <NotebookPen className="size-4" /> : <FileText className="size-4" />}
              <span>{row.title}{row.parentId && <small> · 専用ノート</small>}</span>
            </button>)}
          </section>)}</nav>
          {!visible.length && <p className="empty">該当する項目はありません。</p>}
        </div>
      </WorkspaceSidebar></aside></>}
    <main className="web-reader-main">
      <WorkspaceHeader className="web-document-header">
        <Button variant="ghost" size="icon" aria-label="ライブラリ" onClick={() => setCollapsed(value => !value)}><PanelLeft /></Button>
        <div className="document-title"><h1>{item?.title ?? "ライブラリ全体のファイル"}</h1>
          <small>{item?.kind === "notebook" ? "ノート" : "PDF"} · {item?.collectionName || "未分類"}</small></div>
        {actions}
      </WorkspaceHeader>
      <Tabs value={tab} onValueChange={value => setTab(String(value))} className="flex-1 flex flex-col min-h-0 gap-0">
        <WorkspaceTabList>
          <TabsTrigger value="reader">{item?.kind === "notebook" ? "ノート" : "本文"}</TabsTrigger>
          {summary && <TabsTrigger value="summary">サマリー</TabsTrigger>}
          {item && runtime.capabilities["chat.read"] && <TabsTrigger value="chat">チャット</TabsTrigger>}
          {memos.length > 0 && <TabsTrigger value="notes">メモ</TabsTrigger>}
          {item && runtime.capabilities["notes.read"] && <TabsTrigger value="sticky-notes">付箋</TabsTrigger>}
        </WorkspaceTabList>
        <div className="document-controls"><label>資料 <select aria-label="表示する資料" value={artifact?.id ?? ""}
          onChange={e => { setArtifactId(e.target.value); setTab("reader"); }}>
          {artifacts.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
        </select></label></div>
        <TabsContent value="reader" keepMounted hidden={false} inert={tab !== "reader"}
          className={`document-body ${tab === "reader" ? "" : "hidden"}`}>
          {artifact ? <AssetView key={artifact.id} artifact={artifact} runtime={runtime} annotations={annotations} />
            : <p className="empty">まだファイルがありません。Windows版でアップロードしてください。</p>}
        </TabsContent>
        {item && ["chat", "sticky-notes"].map(value => <TabsContent key={value} value={value} className="document-body data-hidden:hidden">
          {tab === value && <SavedReading key={`${item.id}:${value}`} runtime={runtime} itemId={item.id} tab={value} />}
        </TabsContent>)}
        {summary && <TabsContent value="summary" className="document-body data-hidden:hidden">
          {tab === "summary" && <AssetView key={summary.id} runtime={runtime} artifact={summary} />}
        </TabsContent>}
        {memo && <TabsContent value="notes" className="document-body data-hidden:hidden">
          {tab === "notes" && <><label className="memo-picker">メモ <select aria-label="表示するメモ" value={memo.id} onChange={e => setMemoId(e.target.value)}>
            {memos.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
          </select></label><AssetView key={memo.id} runtime={runtime} artifact={memo} /></>}
        </TabsContent>}
      </Tabs>
    </main>
  </div>;
}

function SavedReading({ runtime, itemId, tab }: { runtime: DriveLibraryRuntime; itemId: string; tab: string }) {
  const [reading, setReading] = useState<SavedReadingView>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void runtime.query.readSavedReading(itemId, controller.signal).then(setReading).catch(reason => {
      if (!controller.signal.aborted) setError(String(reason));
    });
    return () => controller.abort();
  }, [runtime, itemId]);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!reading) return <p className="empty">読書データを読み込んでいます…</p>;
  return <article className="prose reading-data">{tab === "chat" ? <>
    <h2>チャット <small>{reading.messages.length}</small></h2>
    {!reading.messages.length && <p>保存されたチャットはありません。</p>}
    {reading.messages.map(message => <section key={message.id}><strong>{message.role === "user" ? "あなた" : "回答"}</strong>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}>{message.content}</ReactMarkdown></section>)}
  </> : <><h2>付箋・ハイライト <small>{reading.notes.length}</small></h2>
    {!reading.notes.length && <p>付箋はありません。</p>}
    {reading.notes.map(note => <section key={note.id}><strong>p.{note.page ?? "—"} · {note.side === "translated" ? "日本語訳" : "原文・ノート"}　{note.label}</strong>
      {note.quote && <blockquote>{note.quote}</blockquote>}<p>{note.note}</p></section>)}
  </>}</article>;
}

function useAsset(runtime: DriveLibraryRuntime, artifact: ArtifactView) {
  const [data, setData] = useState<{ url: string; text: string }>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    void (async () => {
      try {
        const blob = await runtime.artifacts.read(artifact.id, controller.signal);
        const text = /\.(md|txt|json|html|csv)$/i.test(artifact.filename) ? await blob.text() : "";
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob); setData({ url, text });
      } catch (reason) { if (!controller.signal.aborted) setError(String(reason)); }
    })();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [runtime, artifact]);
  return { data, error };
}

function AssetView({ artifact, runtime, annotations }: { artifact: ArtifactView; runtime: DriveLibraryRuntime; annotations?: AnnotationStore }) {
  if (/\.pdf$/i.test(artifact.filename)) return <DocumentReader artifact={artifact} runtime={runtime} store={annotations} />;
  return <AssetContent artifact={artifact} runtime={runtime} />;
}

function AssetContent({ artifact, runtime }: { artifact: ArtifactView; runtime: DriveLibraryRuntime }) {
  const { data, error } = useAsset(runtime, artifact);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p role="status" className="empty">ファイルを読み込んでいます…</p>;
  const html = "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'\">" + data.text;
  return <><div className="asset-heading"><span>{artifact.label}</span><a href={data.url} download={artifact.filename}>ダウンロード ↓</a></div>
    {/\.md$/i.test(artifact.filename) ? <article className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      img: ({ src, alt }) => <MemoImage runtime={runtime} artifact={artifact} src={src} alt={alt} />,
      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    }}>{data.text}</ReactMarkdown></article>
      : /\.html$/i.test(artifact.filename) ? <iframe className="html-document" title={artifact.label} sandbox="" referrerPolicy="no-referrer" srcDoc={html} />
      : /\.(png|jpe?g|gif|webp)$/i.test(artifact.filename) ? <img className="asset-image" src={data.url} alt={artifact.label} />
      : data.text ? <pre className="raw">{data.text}</pre> : <p className="empty">このファイルはダウンロードして開けます。</p>}
  </>;
}

function MemoImage({ runtime, artifact, src, alt }: { runtime: DriveLibraryRuntime; artifact: ArtifactView; src?: string | Blob; alt?: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (typeof src !== "string") return;
    const image = runtime.artifacts.resolveRelative(artifact.id, src);
    if (!image) return;
    const controller = new AbortController(); let objectUrl = "";
    void runtime.artifacts.read(image.id, controller.signal).then(blob => {
      if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }).catch(() => undefined);
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [runtime, artifact, src]);
  return url ? <img src={url} alt={alt || "メモの画像"} /> : <span>{alt || "画像"}（ダウンロードからも確認できます）</span>;
}
