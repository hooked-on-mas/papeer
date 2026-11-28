import { toLibraryItem } from "../runtime/libraryItems";
import { WebNoteStore } from "./noteStore";
import { WebNotesNavigation, WebNoteEditor } from "./WebNotes";
import type { DriveSession } from "./drive";
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type Dispatch, type SetStateAction, type ReactNode } from "react";
import { ArrowLeftRight, Folder, Maximize2, Minimize2, PanelLeft, Pin, X } from "lucide-react";
import { MarkdownContent } from "../components/ui/MarkdownContent";
import { WorkspaceHeader, WorkspaceSidebar, WorkspaceRail, WorkspaceTabList } from "../components/WorkspaceChrome";
import { WebLibrary } from "./WebLibrary";
import { Button } from "../components/ui/button";
import { Tabs, TabsContent, TabsTrigger } from "../components/ui/tabs";
import { ReaderDock } from "../features/reader/layout/ReaderDock";
import { SidePanelChooser } from "../features/reader/SidePanelChooser";
import type { SidePanel } from "../features/reader/sidePanel";
import type { ArtifactView, SavedReadingView } from "../runtime/contracts";
import type { DriveLibraryRuntime } from "./libraryRuntime";
import type { Manifest } from "./drive";
import type { LibraryTransport } from "./offlineLibrary";
import { AnnotationStore } from "./annotations";
import type { ReaderControls } from "./DocumentReader";
import { LegacyDocumentReaderConnection } from "./LegacyDocumentReaderConnection";
import { useMediaQuery } from "../lib/useMediaQuery";
import { WebLibrarySidebar } from "./WebLibrarySidebar";
import { prepareWebNavigation } from "./textDrafts";
import { artifactPlaceKey, getLibraryPlace, saveLibraryPlace } from "./readingPlace";
import { COMPACT_LAYOUT_QUERY, SIDEBAR_OVERLAY_QUERY, SINGLE_PANE_QUERY } from "./readerLayout";
import { preferredReadingArtifact } from "./readingArtifact";
import { itemCapabilities } from "../lib/itemKinds";
import { readerPanelCapabilities } from "../runtime/capabilities";

const EMPTY_NOTES: import("../runtime/noteDocuments").NoteDocument[] = [];
const emptyNoteSnapshot = () => EMPTY_NOTES;
const emptyNoteSubscribe = () => () => undefined;

function guardedSelection<T>(setter: Dispatch<SetStateAction<T>>): Dispatch<SetStateAction<T>> {
  return value => { if (prepareWebNavigation()) setter(value); };
}

const PANEL_LABELS = { summary: "サマリー", chat: "チャット", notes: "ノート" } as const;

/** Web host supplies saved data to the same sidebar rows and reader dock as desktop. */
export function LegacyWebLibraryConnection({ runtime, session, manifest, actions, focusMode, onFocusModeChange: changeFocusMode, transitioning, libraryPicker, noteSession }: {
  runtime: DriveLibraryRuntime; session: LibraryTransport; manifest: Manifest; actions: ReactNode;
  focusMode: boolean; onFocusModeChange: (focus: boolean) => void;
  transitioning: boolean;
  libraryPicker?: ReactNode;
  noteSession?: DriveSession;
}) {
  const onFocusModeChange = useCallback((value: boolean) => { if (prepareWebNavigation()) changeFocusMode(value); }, [changeFocusMode]);
  useEffect(() => {
    if (!focusMode) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]"))) onFocusModeChange(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [focusMode, onFocusModeChange]);
  const noteStore = useMemo(() => noteSession ? new WebNoteStore(noteSession, runtime.scope.libraryId, manifest, session) : undefined, [noteSession, runtime, manifest, session]);
  const [webNoteId, setWebNoteIdState] = useState('');
  const setWebNoteId = guardedSelection(setWebNoteIdState);
  const liveNotes = useSyncExternalStore(noteStore?.subscribe ?? emptyNoteSubscribe, noteStore ? () => noteStore.getSnapshot().notes : emptyNoteSnapshot);
  const sidebarRuntime = useMemo(() => {
    const baseItems = runtime.query.listItems();
    const known = new Set(liveNotes.map(note => note.id));
    const items = [...baseItems.filter(item => !known.has(item.id) && (!manifest.files['web-notes.json'] || item.kind !== 'notebook' && item.kind !== 'markdown')), ...liveNotes.map(toLibraryItem)];
    return { ...runtime, query: { ...runtime.query, listItems: () => items } };
  }, [runtime, liveNotes, manifest]);
  useEffect(() => {
    if (!noteStore) return;
    void noteStore.start();
    const refresh = () => { void noteStore.refresh().then(() => noteStore.flush()); };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('online', refresh); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); noteStore.dispose(); };
  }, [noteStore]);
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
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const portrait = useMediaQuery(SINGLE_PANE_QUERY);
  const singlePane = compact || portrait;
  const [defaultToTranslation] = useState(compact);
  const [initialPlace] = useState(() => getLibraryPlace(runtime.scope.libraryId));
  const [selected, setSelected] = useState(initialPlace && (!initialPlace.itemId || items.some(item => item.id === initialPlace.itemId)) ? initialPlace.itemId : items[0]?.id ?? "");
  const [artifactId, setArtifactId] = useState(() => initialPlace ? runtime.query.listReadingMaterials(selected || null).find(row => artifactPlaceKey(row) === initialPlace.artifact)?.id ?? "" : "");
  const [tab, setTabState] = useState("reader");
  const setTab = guardedSelection(setTabState);
  const narrowViewport = useMediaQuery(SIDEBAR_OVERLAY_QUERY);
  const stackedViewport = useMediaQuery("(max-width: 760px)");
  const narrow = narrowViewport || compact;
  const stacked = stackedViewport || compact;
  const [collapsed, setCollapsed] = useState(narrow);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidePanelWidth, setSidePanelWidth] = useState(380);
  const [sidePanel, setSidePanelState] = useState<SidePanel | null>(null);
  const setSidePanel = guardedSelection(setSidePanelState);
  useEffect(() => { if (narrow) setCollapsed(true); }, [narrow]);
  const item = items.find(row => row.id === selected);
  const artifacts = runtime.query.listReadingMaterials(item?.id ?? null);
  const artifact = artifacts.find(row => row.id === artifactId) ?? (defaultToTranslation ? preferredReadingArtifact(artifacts) : artifacts[0]);
  const originalPdf = artifacts.find(row => row.role === "original" && row.annotationTarget)
    ?? artifacts.find(row => row.role === "original" && row.filename.endsWith(".pdf"));
  const translatedPdf = artifacts.find(row => row.role === "translated" && row.annotationTarget)
    ?? artifacts.find(row => row.role === "translated" && row.filename.endsWith(".pdf"));
  useLayoutEffect(() => {
    if (artifact) saveLibraryPlace(runtime.scope.libraryId, { itemId: selected, artifact: artifactPlaceKey(artifact) });
  }, [runtime.scope.libraryId, selected, artifact]);
  const summary = artifacts.find(row => row.filename === "article.md" && row.role === "other");
  const memos = artifacts.filter(row => row.role === "attachment");
  const [memoId, setMemoIdState] = useState("");
  const setMemoId = guardedSelection(setMemoIdState);
  const childNotes = liveNotes.filter(note => note.parent_id === selected).sort((a, b) => a.note_position - b.note_position);
  const panelNote = childNotes.find(note => note.id === memoId) ?? childNotes[0];
  const memo = memos.find(row => row.id === memoId) ?? memos[0];
  const panels = readerPanelCapabilities(itemCapabilities(item ? { kind: item.kind, parent_id: item.parentId } : { kind: "unknown" }), {
    readSaved: runtime.capabilities["library.read"], generateSummary: false,
    generateChat: runtime.capabilities["chat.generate"], editNotes: false, editStickyNotes: false,
  }, { summary: !!summary, chat: !!item && runtime.capabilities["chat.read"],
    notes: memos.length > 0 || childNotes.length > 0, "sticky-notes": !!item && runtime.capabilities["notes.read"] });
  const available: SidePanel[] = item ? (["summary", "chat", "notes"] as const).filter(panel => panels[panel]) : [];
  const chosen = sidePanel && available.includes(sidePanel) ? sidePanel : null;
  const choose = (id: string, file?: string) => {
    if (!prepareWebNavigation()) return;
    if (noteStore?.getSnapshot().notes.some(note => note.id === id)) { setWebNoteId(id); if (narrow) setCollapsed(true); return; }
    setWebNoteId(''); setSidePanel(null);
    setSelected(id); setArtifactId(file ?? ""); setTab("reader");
    if (narrow) setCollapsed(true);
  };
  const chooseChild = (id: string, file: string) => {
    if (!prepareWebNavigation()) return;
    const child = runtime.query.listReadingMaterials(id).find(row => row.id === file);
    if (child?.role === "attachment" && /\.md$/i.test(child.filename)) {
      setSelected(id); if (id !== selected) setArtifactId("");
      setMemoId(file); setTab("notes");
      if (narrow) setCollapsed(true);
    } else choose(id, file);
  };
  const openBeside = (panel: SidePanel) => { setSidePanel(panel); setTab("reader"); };
  const openTab = (value: string) => { setTab(value); onFocusModeChange(false); };
  const chooser = <SidePanelChooser selected={chosen} available={available} onChange={setSidePanel}
    className={`web-panel-choice ${chosen ? "bg-accent text-accent-foreground" : ""}`} />;
  const readerControls = <>
    {!focusMode && !singlePane && chooser}
    <Button variant="ghost" size="icon-sm" title={focusMode ? "集中表示を終了" : "集中表示"}
      aria-label={focusMode ? "集中表示を終了" : "集中表示"} aria-pressed={focusMode}
      onClick={() => { setTab("reader"); onFocusModeChange(!focusMode); }}>
      {focusMode ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
    </Button>
  </>;
  const readerActions: ReaderControls = {
    title: item?.title ?? artifact?.label ?? "ライブラリ",
    leading: <Button variant="ghost" size="icon" aria-label="ライブラリ" onClick={() => {
      if (focusMode) { onFocusModeChange(false); setCollapsed(false); }
      else setCollapsed(value => !value);
    }}><PanelLeft /></Button>,
    language: originalPdf && translatedPdf && (artifact?.role === "original" || artifact?.role === "translated")
      ? <button className="web-language-switch" aria-label={artifact.role === "translated" ? "原文を表示" : "日本語訳を表示"} title={artifact.role === "translated" ? "原文に切り替える" : "日本語訳に切り替える"}
        onClick={() => { if (prepareWebNavigation()) setArtifactId(artifact.role === "translated" ? originalPdf.id : translatedPdf.id); }}>{artifact.role === "translated" ? "日本語訳" : "原文"}<ArrowLeftRight aria-hidden="true" /></button>
      : <span className="web-language-label">{artifact?.role === "translated" ? "日本語訳" : artifact?.role === "original" ? "原文" : "添付"}</span>,
    menu: <>
      <p className="web-reading-title">{item?.title ?? "ライブラリ"}</p>
      {focusMode && <button onClick={() => onFocusModeChange(false)}>集中表示を終了</button>}
      {artifact?.role !== "original" && artifact?.role !== "translated" && <button onClick={() => choose(selected, preferredReadingArtifact(artifacts)?.id)}>本文に戻る</button>}
      {available.map(kind => <button key={kind} onClick={() => openTab(kind)}>{PANEL_LABELS[kind]}を開く</button>)}
      {item && panels["sticky-notes"] && <button onClick={() => openTab("sticky-notes")}>付箋を開く</button>}
      {artifacts.filter(row => row.role === "attachment" && !/\.md$/i.test(row.filename)).map(row => <button key={row.id} onClick={() => chooseChild(selected, row.id)}>{row.label}を開く</button>)}
      {actions}
      {libraryPicker}
      <small>ホーム画面に追加：Safariの共有メニューから追加できます。</small>
    </>,
  };
  const pane = (kind: SidePanel, beside = false) => <ReadOnlyPane title={PANEL_LABELS[kind]}
    onClose={beside ? () => setSidePanel(null) : undefined} onPin={!beside && !singlePane ? () => openBeside(kind) : undefined}>
    {kind === "summary" && summary ? <AssetContent key={summary.id} artifact={summary} runtime={runtime} />
      : kind === "chat" && item ? <SavedReading key={`${item.id}:chat`} runtime={runtime} itemId={item.id} tab="chat" />
      : kind === "notes" && panelNote && noteStore ? <>
        <label>ノート<select aria-label="表示するノート" value={panelNote.id} onChange={e => setMemoId(e.target.value)}>{childNotes.map(note => <option key={note.id} value={note.id}>{note.title}（{note.kind === 'markdown' ? 'Markdown' : '手書き'}）</option>)}</select></label>
        <button className="min-h-11" onClick={() => setWebNoteId(panelNote.id)}>中央で開く</button>
        <WebNoteEditor key={panelNote.id} store={noteStore} id={panelNote.id} manifest={manifest} onClose={() => setSidePanel(null)} />
      </> : kind === "notes" && memo ? <><label className="memo-picker">ノート <select aria-label="表示するノート" value={memo.id} onChange={e => setMemoId(e.target.value)}>
        {memos.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
      </select></label><AssetContent key={memo.id} runtime={runtime} artifact={memo} /></> : <p className="empty">保存された内容はありません。</p>}
  </ReadOnlyPane>;
  const sidebar = <WorkspaceSidebar onCollapse={() => setCollapsed(true)}>
    {noteStore && <WebNotesNavigation store={noteStore} manifest={manifest} showList={false} onOpen={id => { setWebNoteId(id); if (narrow) setCollapsed(true); }} />}
    <WebLibrarySidebar runtime={sidebarRuntime} selectedItemId={webNoteId || selected} selectedArtifactId={tab === "notes" ? memo?.id : artifactId}
      onSelectItem={choose} onShowNotes={id => { choose(id); setTab("notes"); }} onSelectArtifact={chooseChild} onAllFiles={() => choose("")} />
  </WorkspaceSidebar>;
  const main = <main className="web-reader-main relative">
    {noteStore && webNoteId && <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background"><WebNoteEditor store={noteStore} id={webNoteId} manifest={manifest} onClose={() => { const parent = liveNotes.find(note => note.id === webNoteId)?.parent_id; setWebNoteId(''); if (parent) { setSelected(parent); setArtifactId(''); setTab('reader'); } }} /></div>}
    <WorkspaceHeader className="web-document-header">
      <Button variant="ghost" size="icon" aria-label="ライブラリ" onClick={() => setCollapsed(value => !value)}><PanelLeft /></Button>
      <div className="document-title"><h1>{item?.title ?? "ライブラリ全体のファイル"}</h1>
        <small>{item?.kind === "notebook" ? "ノート" : "PDF"} · {item?.collectionName || "未分類"}</small></div>{actions}
    </WorkspaceHeader>
    <Tabs value={tab} onValueChange={value => setTab(String(value))} className="flex-1 flex flex-col min-h-0 gap-0">
      <div className="web-document-navigation">
      <WorkspaceTabList>
        <TabsTrigger value="reader">{item?.kind === "notebook" ? "ノート" : "本文"}</TabsTrigger>
        {panels.summary && <TabsTrigger value="summary">サマリー</TabsTrigger>}
        {item && panels.chat && <TabsTrigger value="chat">チャット</TabsTrigger>}
        {panels.notes && <TabsTrigger value="notes">ノート</TabsTrigger>}
        {item && panels["sticky-notes"] && <TabsTrigger value="sticky-notes">付箋</TabsTrigger>}
      </WorkspaceTabList>
      {!singlePane && <div className="document-controls"><label>資料 <select aria-label="表示する資料" value={artifact?.id ?? ""}
        onChange={e => { if (prepareWebNavigation()) { setArtifactId(e.target.value); setTab("reader"); } }}>
        {artifacts.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
      </select></label></div>}
      </div>
      <div className="relative flex flex-1 min-h-0 flex-col">
        <TabsContent value="reader" keepMounted hidden={false} inert={tab !== "reader"}
          className={`web-reader-tab ${tab === "reader" ? "" : "invisible absolute inset-0"}`}>
          <ReaderDock open={!!chosen && !focusMode && !singlePane} panelId={chosen ?? undefined} label={chosen ? `${PANEL_LABELS[chosen]}（右パネル）` : undefined}
            width={sidePanelWidth} onWidthChange={focusMode ? undefined : setSidePanelWidth} stacked={stacked} preserveWidth
            panel={chosen && tab === "reader" ? pane(chosen, true) : undefined}>
            {artifact ? <AssetView key={/\.pdf$/i.test(artifact.filename) && artifact.annotationTarget ? `${artifact.itemId ?? artifact.id}:pdf` : artifact.id}
              artifact={artifact} runtime={runtime} annotations={annotations} controls={readerControls} readerActions={readerActions} focusMode={focusMode} />
              : <p className="empty">まだファイルがありません。Windows版でアップロードしてください。</p>}
          </ReaderDock>
        </TabsContent>
        {(["summary", "chat", "notes"] as const).filter(kind => available.includes(kind)).map(kind =>
          <TabsContent key={kind} value={kind} className="web-content-tab data-hidden:hidden">{tab === kind && pane(kind)}</TabsContent>)}
        {item && <TabsContent value="sticky-notes" className="web-content-tab data-hidden:hidden">
          {tab === "sticky-notes" && <ReadOnlyPane title="付箋・ハイライト"><SavedReading key={`${item.id}:sticky-notes`} runtime={runtime} itemId={item.id} tab="sticky-notes" /></ReadOnlyPane>}
        </TabsContent>}
      </div>
    </Tabs>
  </main>;
  return <WebLibrary compactReading={compact && tab === "reader" && /\.pdf$/i.test(artifact?.filename ?? "")}
    transitioning={transitioning} narrow={narrow} collapsed={collapsed} focusMode={focusMode}
    onCloseSidebar={() => setCollapsed(true)} sidebar={sidebar}
    rail={<WorkspaceRail onExpand={() => setCollapsed(false)}>
      <button data-slot="all-files" aria-label="ライブラリ全体のファイル" className="w-8 h-8 flex items-center justify-center hover:bg-muted rounded" onClick={() => choose("")}><Folder className="size-4 text-muted-foreground" /></button>
    </WorkspaceRail>}
    sidebarWidth={sidebarWidth} onSidebarWidth={setSidebarWidth}
    mainMinSize={focusMode || singlePane || narrow ? "240px" : chosen ? "644px" : "480px"} main={main} />;

}

function ReadOnlyPane({ title, children, onClose, onPin }: { title: string; children: ReactNode; onClose?: () => void; onPin?: () => void }) {
  return <div className="web-saved-pane">
    <div className="min-h-12 flex items-center justify-between gap-2 px-4 py-2 border-b shrink-0 bg-background/50">
      <h2 className="text-[0.875rem] font-semibold">{title}</h2>
      {onClose ? <Button variant="ghost" size="icon-sm" aria-label="右パネルを閉じる" onClick={onClose}><X className="size-4" /></Button>
        : onPin && <Button variant="ghost" size="icon-sm" aria-label={`${title}を右に表示`} onClick={onPin}><Pin className="size-4" /></Button>}
    </div>
    <div className="web-saved-pane-body">{children}</div>
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
  return <article className="reading-data">{tab === "chat" ? <>

    {!reading.messages.length && <p>保存されたチャットはありません。</p>}
    {reading.messages.map(message => <section key={message.id}><div className="text-[0.75rem] font-medium text-muted-foreground mb-1">{message.role === "user" ? "あなた" : "回答"}</div><div className={message.role === "user" ? "rounded-lg bg-muted/60 border px-4 py-2.5 text-[0.875rem]" : "prose"}>
      <MarkdownContent content={message.content} components={{ img: () => null }} /></div></section>)}
  </> : <><p className="text-xs text-muted-foreground mb-3">{reading.notes.length}件</p>
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

function AssetView({ artifact, runtime, annotations, controls, readerActions, focusMode }: { artifact: ArtifactView; runtime: DriveLibraryRuntime; annotations?: AnnotationStore; controls?: ReactNode; readerActions?: ReaderControls; focusMode?: boolean }) {
  if (/\.pdf$/i.test(artifact.filename)) return <LegacyDocumentReaderConnection artifact={artifact} runtime={runtime} store={annotations} controls={controls} readerActions={readerActions} focusMode={focusMode} />;
  return <div className="web-asset-reader"><div className="web-reader-tools">{controls}</div><div className="web-saved-pane-body"><AssetContent artifact={artifact} runtime={runtime} /></div></div>;
}

function AssetContent({ artifact, runtime }: { artifact: ArtifactView; runtime: DriveLibraryRuntime }) {
  const { data, error } = useAsset(runtime, artifact);
  if (error) return <p role="alert" className="error">{error}</p>;
  if (!data) return <p role="status" className="empty">ファイルを読み込んでいます…</p>;
  const html = "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'\">" + data.text;
  return <><div className="asset-heading"><span>{artifact.label}</span><a href={data.url} download={artifact.filename}>ダウンロード ↓</a></div>
    {/\.md$/i.test(artifact.filename) ? <article className="prose"><MarkdownContent content={data.text} components={{
      img: ({ src, alt }) => <MemoImage runtime={runtime} artifact={artifact} src={src} alt={alt} />,
    }} /></article>
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
  return url ? <img src={url} alt={alt || "ノートの画像"} /> : <span>{alt || "画像"}（ダウンロードからも確認できます）</span>;
}
