import { useReaderInput } from "../features/reader/useLegacyReaderInput";
import type { ReaderCommandPort } from "../features/reader/navigation/readerCommands";
import { clampZoom, stepZoom } from "../features/reader/zoomLevels";
import { EMPTY_HISTORY, goBack, goForward, rememberPlace } from "../features/reader/navigation/readerHistory";
import { ReadingLanding } from "../features/reader/ReadingLanding";
import { WritingToolbarSlot, useWritingToolbar } from "../features/reader/WritingToolbar";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { PageNavigatorView } from "../features/reader/PageNavigatorView";
import { DocumentReader, type ReaderControls } from "./DocumentReader";
import type { ArtifactView, DocumentPagesView } from "../runtime/contracts";
import type { DriveLibraryRuntime } from "./libraryRuntime";
import type { AnnotationStore } from "./annotations";
import { PdfWritingTools } from "./PdfWritingTools";
import { LegacyPdfReaderConnection } from "./LegacyPdfReaderConnection";
import { useMediaQuery } from "../lib/useMediaQuery";
import { prepareWebNavigation } from "./textDrafts";
import { documentPlaceKey, getDocumentPlace, saveDocumentPlace, pdfPlaceKey } from "./readingPlace";
import { Ellipsis, Hand, Pen, ZoomIn, ZoomOut } from "lucide-react";
import { COMPACT_LAYOUT_QUERY } from "./readerLayout";
import { useReaderLayout } from "./useReaderLayout";
import { ReaderMenu } from "./ReaderMenu";
import { usePairedPdfScroll } from "./usePairedPdfScroll";


export function LegacyDocumentReaderConnection(props: ComponentProps<typeof DocumentReaderContent>) {
  return <PdfWritingTools key={props.artifact.id} initialActive={props.artifact.annotationTarget?.side ?? "original"}>
    <DocumentReaderContent {...props} />
  </PdfWritingTools>;
}

function DocumentReaderContent({ artifact, runtime, store, controls, readerActions, focusMode = false }: {
  artifact: ArtifactView; runtime: DriveLibraryRuntime; store?: AnnotationStore; controls?: ReactNode; readerActions?: ReaderControls; focusMode?: boolean;
}) {
  const [mapping, setMapping] = useState<DocumentPagesView | null>(null);
  const [mappingError, setMappingError] = useState("");
  const placeKey = documentPlaceKey(runtime.scope.libraryId, artifact.itemId, artifact);
  const [initialPlace] = useState(() => getDocumentPlace(placeKey));
  const [page, setPage] = useState(initialPlace?.page ?? 1), [counts, setCounts] = useState<Record<string, number>>({}), [zoom, setZoom] = useState(initialPlace?.zoom ?? 1);
  const [mode, setMode] = useState<"single" | "split" | null>(initialPlace?.mode && initialPlace.mode !== "auto" ? initialPlace.mode : null);
  const [fraction, setFraction] = useState(.5);
  const compactViewport = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const compact = compactViewport || focusMode;
  const [editing, setEditing] = useState(typeof initialPlace?.editing === "boolean" ? initialPlace.editing : !compact);
  const [fitPage, setFitPage] = useState(initialPlace?.fitPage === true);
  const changeZoom = useCallback((value: number) => { setFitPage(value === 0); setZoom(value === 0 ? 1 : value); }, []);
  const layout = useReaderLayout();
  // Choose once after the reader has its actual size; later resizes keep the user's selection.
  useLayoutEffect(() => {
    if (mode === null && layout.width > 0) setMode(layout.split ? "split" : "single");
  }, [mode, layout.width, layout.split]);
  useLayoutEffect(() => { if (mode) saveDocumentPlace(placeKey, { page, zoom, mode, editing, fitPage }); }, [placeKey, page, zoom, mode, editing, fitPage]);
  const denseTools = compact || (layout.width > 0 && layout.width < 800);
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
  const desiredSplit = canSplit && mode === "split";
  const [activeSplit, setActiveSplit] = useState(false);
  useLayoutEffect(() => {
    if (activeSplit !== desiredSplit && prepareWebNavigation()) setActiveSplit(desiredSplit);
  }, [activeSplit, desiredSplit]);
  const split = canSplit && activeSplit;
  usePairedPdfScroll(layout.ref, split, JSON.stringify([placeKey, page, zoom, fitPage]));
  // Canonical original/translation views navigate source pages in either layout.
  // A translated page may live at a different index (or be absent entirely).
  const maxPage = canSplit ? Math.min(mapping!.pageCount, counts[original!.id] ?? Infinity) : counts[artifact.id] ?? 0;
  useEffect(() => { if (maxPage > 0) setPage(value => Math.max(1, Math.min(maxPage, value))); }, [maxPage]);
  const loadedCount = useCallback((id: string, count: number) => setCounts(value => value[id] === count ? value : { ...value, [id]: count }), []);
  const [landing, setLanding] = useState<{ toEnd: boolean; consumed: Set<string> } | null>(null);
  const current = useRef({ page, zoom, fitPage, maxPage });
  current.current = { page, zoom, fitPage, maxPage };
  const history = useRef(EMPTY_HISTORY);
  // History stores logical source pages. Each pane's existing reading-place journal restores its
  // passage; translated artifact indices must never become navigation history entries.
  const historyScope = useRef(placeKey);
  if (historyScope.current !== placeKey) { historyScope.current = placeKey; history.current = EMPTY_HISTORY; }
  const commands: ReaderCommandPort = {
    getSnapshot: () => ({ active: true, blocked: false, zoom: current.current.fitPage ? 0 : current.current.zoom }),
    dispatch(command) {
      if (!prepareWebNavigation()) return { status: "blocked" };
      const state = current.current;
      if (command.type === "focus-page-input") { document.getElementById("web-page-input")?.focus(); return { status: "applied" }; }
      if (command.type === "history") {
        const here = { paperId: placeKey, page: state.page, anchor_y: 0 };
        const result = (command.direction === "back" ? goBack : goForward)(history.current, here);
        if (!result || state.maxPage <= 0 || result.target.page > state.maxPage) return { status: "unchanged" };
        history.current = result.history;
        setLanding(null); setPage(result.target.page);
        current.current = { ...state, page: result.target.page };
        return { status: "applied" };
      }
      if (command.type === "zoom" || command.type === "zoom-step" || command.type === "zoom-reset") {
        if (command.type === "zoom" && !Number.isFinite(command.value)) return { status: "blocked" };
        const value = command.type === "zoom" ? clampZoom(command.value) : command.type === "zoom-reset" ? 1 : stepZoom(state.fitPage ? 0 : state.zoom, command.steps);
        if (value === (state.fitPage ? 0 : state.zoom)) return { status: "unchanged" };
        current.current = { ...state, fitPage: value === 0, zoom: value === 0 ? 1 : value };
        changeZoom(value); return { status: "applied" };
      }
      if (state.maxPage <= 0) return { status: "blocked" };
      const next = command.type === "step" ? state.page + command.amount : command.type === "jump" ? command.page : command.edge === "first" ? 1 : state.maxPage;
      if (!Number.isFinite(next)) return { status: "blocked" };
      const target = Math.max(1, Math.min(state.maxPage, Math.round(next)));
      if (target === state.page) return { status: "unchanged" };
      // Explicit page jumps form history. Plain stepping, including touch/wheel, does not.
      if (command.type === "jump") history.current = rememberPlace(history.current, { paperId: placeKey, page: state.page, anchor_y: 0 });
      setLanding({ toEnd: "toEnd" in command && !!command.toEnd, consumed: new Set() }); setPage(target);
      current.current = { ...state, page: target };
      return { status: "applied" };
    },
  };
  const commandPort = useRef(commands);
  commandPort.current = commands;
  const zoomCommand = useCallback((value: number) => { commandPort.current.dispatch({ type: "zoom", value }); }, []);
  const leftPane = useRef<HTMLElement | null>(null), rightPane = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const panes = layout.ref.current?.querySelectorAll<HTMLElement>(".web-pdf-pane");
    leftPane.current = panes?.[0] ?? null; rightPane.current = panes?.[1] ?? null;
  });
  useReaderInput({ rootRef: layout.ref, panes: [leftPane, rightPane], resetKey: artifact.id, wheelTurns: () => !editing, commands, safariGestures: false });
  const swipe = (direction: -1 | 1) => { commands.dispatch({ type: "step", amount: direction }); };
  const translated = mapping?.translatedPages[String(page)];
  const translatedFile = translated ? files.find(file => file.id === translated.artifactId) : undefined;
  const singleTranslation = !split && canSplit && artifact.annotationTarget?.side === "translated";
  const download = singleTranslation ? translatedFile : artifact;
  const missingTranslation = <div className="empty" role="status">この原文ページの日本語訳はまだ保存されていません。</div>;
  const displaySettings = <>
      <label>倍率 <select aria-label="表示倍率" value={fitPage ? "page" : zoom} onChange={e => {
        commands.dispatch({ type: "zoom", value: e.target.value === "page" ? 0 : Number(e.target.value) });
      }}>
        <option value="page">ページ全体</option>
        {[...new Set([.5, .75, 1, 1.25, 1.5, 2, 3, 4, zoom])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{value === 1 ? "幅に合わせる" : `${Math.round(value * 100)}%`}</option>)}
      </select></label>
      {canSplit && <label>表示 <select aria-label="本文の表示方法" value={mode ?? "single"} onChange={e => { if (prepareWebNavigation()) setMode(e.target.value as "single" | "split"); }}>
        <option value="single">1つずつ表示</option><option value="split">左右に表示</option>
      </select></label>}
  </>;
  const writingToggle = store && artifact.annotationTarget && <button className="web-writing-toggle" aria-pressed={editing}
    aria-label={editing ? "書き込みを終了" : "書き込みを開始"} title={editing ? "読むモードに切り替える" : "書き込みモードに切り替える"}
    onClick={() => { if (prepareWebNavigation()) setEditing(value => !value); }}>
    {editing ? <Hand aria-hidden="true" /> : <Pen aria-hidden="true" />}<span>{editing ? "読む" : "書き込む"}</span>
  </button>;
  return <ReadingLanding.Provider value={landing}><DocumentReader rootRef={layout.ref} split={split} fraction={fraction} onResize={setFraction} header={<>
    {compact && readerActions && <div className="web-reader-title-row"><h1 className="web-reader-title" title={readerActions.title}>{readerActions.title}</h1>{writingToggle}{focusMode && controls}</div>}
    <div className="web-reader-tools" aria-label="本文の表示操作">
      {compact && readerActions?.leading}
      <div className="web-page-navigation">
      <PageNavigatorView paperId={artifact.id} currentPage={page} count={maxPage} atStart={page <= 1} atEnd={page >= maxPage}
        compact shortcuts={false} inputId="web-page-input" onJump={value => { commands.dispatch({ type: "jump", page: value }); }} onMove={delta => { commands.dispatch({ type: "step", amount: delta < 0 ? -1 : 1 }); }} />
      </div>
      {compact && <button className="web-quick-zoom" aria-label={!fitPage && zoom === 1 ? "本文を拡大" : "幅に合わせる"} title={!fitPage && zoom === 1 ? "150%に拡大" : "幅に合わせる"}
        aria-pressed={fitPage || zoom !== 1} onClick={() => zoomCommand(!fitPage && zoom === 1 ? 1.5 : 1)}>{!fitPage && zoom === 1 ? <ZoomIn aria-hidden="true" /> : <ZoomOut aria-hidden="true" />}</button>}
      {!split && readerActions?.language}
      {!compact && writingToggle}
      {denseTools ? <ReaderMenu className="web-display-options" label="読書メニュー" icon={<Ellipsis aria-hidden="true" />} closeOnAction>
          {displaySettings}
          {download && urls[download.id] && <a href={urls[download.id]} download={download.filename}>PDF本体を保存</a>}
          {store && <PhoneSaveStatus store={store} />}
          {compact && readerActions?.menu}
      </ReaderMenu> : displaySettings}
      {!compact && controls}
    </div>
    </>} toolbar={<WritingToolbarSlot className="web-writing-toolbar-slot" />} message={<>
    {mappingError && <p role="alert" className="error">対訳のページ情報を読み込めませんでした。資料を1つずつ表示します。{mappingError}</p>}
    </>} original={
      singleTranslation ? translatedFile && translated ?
        <PdfArtifact key={translatedFile.id} artifact={translatedFile} runtime={runtime} store={store} page={translated.page} zoom={zoom} fitPage={fitPage} onPageSwipe={swipe} onZoom={zoomCommand} onPageCount={loadedCount} editing={editing} onFileUrl={fileUrl} /> : missingTranslation
      : <PdfArtifact key={(split ? original! : artifact).id} artifact={split ? original! : artifact} runtime={runtime} store={store}
        page={page} zoom={zoom} fitPage={fitPage} onPageSwipe={swipe} onZoom={zoomCommand} onPageCount={loadedCount} editing={editing} onFileUrl={fileUrl} />
    } translated={split ? translatedFile && translated ?
      <PdfArtifact key={translatedFile.id} artifact={translatedFile} runtime={runtime} store={store} page={translated.page} zoom={zoom} fitPage={fitPage} onPageSwipe={swipe} onZoom={zoomCommand} editing={editing} onFileUrl={fileUrl} />
      : missingTranslation : undefined} />
  </ReadingLanding.Provider>;
}

function PhoneSaveStatus({ store }: { store: AnnotationStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return state.ready && !state.pending && !state.error ? null
    : <p role="status">{state.error ? "保存状態を確認してください。" : !state.ready ? "書き込みを確認中…" : `未送信の書き込み ${state.pending}件（端末に保存済み）`}</p>;
}

function PdfArtifact({ artifact, runtime, store, page, zoom, fitPage, onZoom, onPageCount, editing = true, onFileUrl, onPageSwipe }: {
  artifact: ArtifactView; runtime: DriveLibraryRuntime; store?: AnnotationStore; page: number; zoom: number; fitPage?: boolean;
  onPageSwipe?: (direction: -1 | 1) => void; onPageCount?: (id: string, count: number) => void; onZoom: (zoom: number) => void;
  editing?: boolean; onFileUrl?: (id: string, url: string) => void;
}) {
  const writing = useWritingToolbar();
  const side = artifact.annotationTarget?.side;
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
  return <section onPointerDownCapture={() => { if (side) writing?.setActive(side); }} onFocusCapture={() => { if (side) writing?.setActive(side); }} className="web-pdf-pane" aria-label={artifact.role === "translated" ? "日本語訳" : artifact.role === "original" ? "原文" : artifact.label}>
    <div className="asset-heading"><span>{artifact.label}</span>{url && <a href={url} download={artifact.filename}>PDF本体を保存 ↓</a>}</div>
    {error ? <div role="alert" className="error">{error} <button onClick={() => setAttempt(value => value + 1)}>PDFを再試行</button></div> : !url ? <p role="status">PDFを読み込んでいます…</p>
      : <LegacyPdfReaderConnection onPageSwipe={onPageSwipe} readingKey={pdfPlaceKey(runtime.scope.libraryId, artifact, runtime.scope.revision)} url={url} target={artifact.annotationTarget} store={store} pageNumber={page} zoom={zoom} fitPage={fitPage} onZoom={onZoom} navigation={false} onPageCount={pageCount} editing={editing} />}
  </section>;
}
