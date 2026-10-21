import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { PageNavigatorView } from "../features/reader/PageNavigatorView";
import { ReaderSplit } from "../features/reader/ReaderSplit";
import type { ArtifactView, DocumentPagesView } from "../runtime/contracts";
import type { DriveLibraryRuntime } from "./libraryRuntime";
import type { AnnotationStore } from "./annotations";
import { PdfReader } from "./PdfReader";
import { PdfTextReader } from "./PdfTextReader";
import { useMediaQuery } from "../lib/useMediaQuery";
import { prepareWebNavigation } from "./textDrafts";
import { documentPlaceKey, getDocumentPlace, saveDocumentPlace } from "./readingPlace";
import { Ellipsis, ZoomIn, ZoomOut } from "lucide-react";
import { PHONE_LAYOUT_QUERY } from "./phoneLayout";

export type PhoneReaderControls = { title: string; leading: ReactNode; language: ReactNode; menu: ReactNode };

export function DocumentReader({ artifact, runtime, store, controls, phoneControls }: {
  artifact: ArtifactView; runtime: DriveLibraryRuntime; store?: AnnotationStore; controls?: ReactNode; phoneControls?: PhoneReaderControls;
}) {
  const [mapping, setMapping] = useState<DocumentPagesView | null>(null);
  const [mappingError, setMappingError] = useState("");
  const placeKey = documentPlaceKey(runtime.scope.libraryId, artifact.itemId, artifact);
  const [initialPlace] = useState(() => getDocumentPlace(placeKey));
  const [page, setPage] = useState(initialPlace?.page ?? 1), [counts, setCounts] = useState<Record<string, number>>({}), [zoom, setZoom] = useState(initialPlace?.zoom ?? 1);
  const [mode, setMode] = useState<"auto" | "single" | "split">(initialPlace?.mode ?? "auto");
  useLayoutEffect(() => { saveDocumentPlace(placeKey, { page, zoom, mode }); }, [placeKey, page, zoom, mode]);
  const [fraction, setFraction] = useState(.5);
  const narrow = useMediaQuery("(max-width: 900px)");
  const phone = useMediaQuery(PHONE_LAYOUT_QUERY);
  const [editing, setEditing] = useState(false);
  const [textView, setTextView] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const fileUrl = useCallback((id: string, url: string) => setUrls(previous => previous[id] === url ? previous : { ...previous, [id]: url }), []);
  useEffect(() => {
    if (!artifact.itemId) return;
    const controller = new AbortController();
    void runtime.query.readDocumentPages(artifact.itemId, controller.signal).then(setMapping).catch(reason => {
      if (!controller.signal.aborted) setMappingError(String(reason));
    });
    return () => controller.abort();
  }, [runtime, artifact.itemId]);
  const files = runtime.query.listArtifacts(artifact.itemId);
  const original = files.find(file => file.role === "original" && file.annotationTarget?.side === "original");
  const canSplit = !!mapping && !!original && !!artifact.annotationTarget && (artifact.role === "original" || artifact.role === "translated")
    && Object.values(mapping.translatedPages).some(Boolean);
  const desiredSplit = canSplit && (mode === "split" || (mode === "auto" && !narrow));
  const [activeSplit, setActiveSplit] = useState(false);
  useLayoutEffect(() => {
    if (activeSplit !== desiredSplit && prepareWebNavigation()) setActiveSplit(desiredSplit);
  }, [activeSplit, desiredSplit]);
  const split = canSplit && activeSplit;
  // Canonical original/translation views navigate source pages in either layout.
  // A translated page may live at a different index (or be absent entirely).
  const maxPage = canSplit ? Math.min(mapping!.pageCount, counts[original!.id] ?? Infinity) : counts[artifact.id] ?? 0;
  useEffect(() => { if (maxPage > 0) setPage(value => Math.max(1, Math.min(maxPage, value))); }, [maxPage]);
  const loadedCount = useCallback((id: string, count: number) => setCounts(value => value[id] === count ? value : { ...value, [id]: count }), []);
  const jump = (value: number) => { if (prepareWebNavigation()) setPage(Math.max(1, Math.min(maxPage || 1, value))); };
  const translated = mapping?.translatedPages[String(page)];
  const translatedFile = translated ? files.find(file => file.id === translated.artifactId) : undefined;
  const singleTranslation = !split && canSplit && artifact.annotationTarget?.side === "translated";
  const download = singleTranslation ? translatedFile : artifact;
  const missingTranslation = <div className="empty" role="status">この原文ページの日本語訳はまだ保存されていません。</div>;
  const displaySettings = <>
      <button aria-pressed={textView} onClick={() => {
        if (!prepareWebNavigation()) return;
        setEditing(false); setTextView(value => !value);
      }}>{textView ? "PDF表示に戻る" : "本文をテキストで表示"}</button>
      {!textView && <label>倍率 <select aria-label="表示倍率" value={zoom} onChange={e => setZoom(Number(e.target.value))}>
        {[...new Set([.5, .75, 1, 1.25, 1.5, 2, 3, 4, zoom])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{value === 1 ? "幅に合わせる" : `${Math.round(value * 100)}%`}</option>)}
      </select></label>}
      {canSplit && <label>表示 <select aria-label="本文の表示方法" value={split ? "split" : "single"} onChange={e => { if (prepareWebNavigation()) setMode(e.target.value as "split" | "single"); }}>
        <option value="single">1つずつ表示</option><option value="split">原文と日本語訳</option>
      </select></label>}
  </>;
  return <div className="web-document-reader">
    {phone && phoneControls && <h1 className="web-reader-title" title={phoneControls.title}>{phoneControls.title}</h1>}
    <div className="web-reader-tools" aria-label="本文の表示操作">
      {phone && phoneControls?.leading}
      <div className="web-page-navigation">
      <PageNavigatorView paperId={artifact.id} currentPage={page} count={maxPage} atStart={page <= 1} atEnd={page >= maxPage}
        compact shortcuts={false} inputId="web-page-input" onJump={jump} onMove={delta => jump(page + delta)} />
      </div>
      {phone && !textView && <button className="web-quick-zoom" aria-label={zoom === 1 ? "本文を拡大" : "幅に合わせる"} title={zoom === 1 ? "150%に拡大" : "幅に合わせる"}
        aria-pressed={zoom !== 1} onClick={() => setZoom(zoom === 1 ? 1.5 : 1)}>{zoom === 1 ? <ZoomIn aria-hidden="true" /> : <ZoomOut aria-hidden="true" />}</button>}
      {phone && phoneControls?.language}
      {phone ? <details className="web-display-options">
        <summary aria-label="読書メニュー" title="読書メニュー"><Ellipsis aria-hidden="true" /></summary>
        <div onClick={e => {
          const button = (e.target as Element).closest("button");
          if (button && !button.hasAttribute("aria-haspopup")) e.currentTarget.closest("details")!.open = false;
        }}>
          {!textView && store && artifact.annotationTarget && <button onClick={() => {
            if (prepareWebNavigation()) setEditing(value => !value);
          }}>{editing ? "書き込みを終了" : "書き込みを開始"}</button>}
          {displaySettings}
          {download && urls[download.id] && <a href={urls[download.id]} target="_blank" rel="noopener noreferrer">PDFを別タブで開く</a>}
          {download && urls[download.id] && <a href={urls[download.id]} download={download.filename}>PDF本体を保存</a>}
          {store && <PhoneSaveStatus store={store} />}
          {phoneControls?.menu}
        </div>
      </details> : displaySettings}
      {!phone && controls}
    </div>
    {mappingError && <p role="alert" className="error">対訳のページ情報を読み込めませんでした。資料を1つずつ表示します。{mappingError}</p>}
    <ReaderSplit fraction={fraction} onResize={setFraction} stacked={phone} original={
      singleTranslation ? translatedFile && translated ?
        <PdfArtifact key={translatedFile.id} artifact={translatedFile} runtime={runtime} store={store} page={translated.page} zoom={zoom} onZoom={setZoom} onPageCount={loadedCount} editing={!phone || editing} textView={textView} onFileUrl={fileUrl} /> : missingTranslation
      : <PdfArtifact key={(split ? original! : artifact).id} artifact={split ? original! : artifact} runtime={runtime} store={store}
        page={page} zoom={zoom} onZoom={setZoom} onPageCount={loadedCount} editing={!phone || editing} textView={textView} onFileUrl={fileUrl} />
    } translated={split ? translatedFile && translated ?
      <PdfArtifact key={translatedFile.id} artifact={translatedFile} runtime={runtime} store={store} page={translated.page} zoom={zoom} onZoom={setZoom} editing={!phone || editing} textView={textView} onFileUrl={fileUrl} />
      : missingTranslation : undefined} />
  </div>;
}

function PhoneSaveStatus({ store }: { store: AnnotationStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return state.ready && !state.pending && !state.error ? null
    : <p role="status">{state.error ? "保存状態を確認してください。" : !state.ready ? "書き込みを確認中…" : `未送信の書き込み ${state.pending}件（端末に保存済み）`}</p>;
}

function PdfArtifact({ artifact, runtime, store, page, zoom, onZoom, onPageCount, editing = true, textView = false, onFileUrl }: {
  artifact: ArtifactView; runtime: DriveLibraryRuntime; store?: AnnotationStore; page: number; zoom: number;
  onPageCount?: (id: string, count: number) => void; onZoom: (zoom: number) => void;
  editing?: boolean; textView?: boolean; onFileUrl?: (id: string, url: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const pageCount = useCallback((count: number) => onPageCount?.(artifact.id, count), [artifact.id, onPageCount]);
  useEffect(() => { onFileUrl?.(artifact.id, url); return () => onFileUrl?.(artifact.id, ""); }, [artifact.id, url, onFileUrl]);
  useEffect(() => {
    setError(""); setUrl("");
    const controller = new AbortController(); let objectUrl = "";
    void runtime.artifacts.read(artifact.id, controller.signal).then(blob => {
      if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [runtime, artifact, attempt]);
  return <section className="web-pdf-pane" aria-label={artifact.role === "translated" ? "日本語訳" : artifact.role === "original" ? "原文" : artifact.label}>
    <div className="asset-heading"><span>{artifact.label}</span>{url && <span><a href={url} target="_blank" rel="noopener noreferrer">PDFを別タブで開く</a>{" · "}<a href={url} download={artifact.filename}>PDF本体を保存 ↓</a></span>}</div>
    {error ? <div role="alert" className="error">{error} <button onClick={() => setAttempt(value => value + 1)}>PDFを再試行</button></div> : !url ? <p role="status">PDFを読み込んでいます…</p>
      : textView ? <PdfTextReader key={url} url={url} pageNumber={page} onPageCount={pageCount} />
      : <PdfReader url={url} target={artifact.annotationTarget} store={store} pageNumber={page} zoom={zoom} onZoom={onZoom} navigation={false} onPageCount={pageCount} editing={editing} />}
  </section>;
}
