import { useEffect, useState } from "react";
import { PageNavigatorView } from "../features/reader/PageNavigatorView";
import { ReaderSplit } from "../features/reader/ReaderSplit";
import type { ArtifactView, DocumentPagesView } from "../runtime/contracts";
import type { DriveLibraryRuntime } from "./libraryRuntime";
import type { AnnotationStore } from "./annotations";
import { PdfReader } from "./PdfReader";
import { useMediaQuery } from "../lib/useMediaQuery";

export function DocumentReader({ artifact, runtime, store }: {
  artifact: ArtifactView; runtime: DriveLibraryRuntime; store?: AnnotationStore;
}) {
  const [mapping, setMapping] = useState<DocumentPagesView | null>(null);
  const [mappingError, setMappingError] = useState("");
  const [page, setPage] = useState(1), [count, setCount] = useState(0), [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<"auto" | "single" | "split">("auto");
  const [fraction, setFraction] = useState(.5);
  const narrow = useMediaQuery("(max-width: 900px)");
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
  const split = canSplit && (mode === "split" || (mode === "auto" && !narrow));
  const maxPage = split ? mapping!.pageCount : count;
  const jump = (value: number) => setPage(Math.max(1, Math.min(maxPage || 1, value)));
  const translated = mapping?.translatedPages[String(page)];
  const translatedFile = translated ? files.find(file => file.id === translated.artifactId) : undefined;
  return <div className="web-document-reader">
    <div className="web-reader-tools" aria-label="本文の表示操作">
      <PageNavigatorView paperId={artifact.id} currentPage={page} count={maxPage} atStart={page <= 1} atEnd={page >= maxPage}
        compact shortcuts={false} inputId="web-page-input" onJump={jump} onMove={delta => jump(page + delta)} />
      <label>倍率 <select aria-label="表示倍率" value={zoom} onChange={e => setZoom(Number(e.target.value))}>
        {[.5, .75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value === 1 ? "幅に合わせる" : `${value * 100}%`}</option>)}
      </select></label>
      {canSplit && <label>表示 <select aria-label="本文の表示方法" value={split ? "split" : "single"} onChange={e => { setMode(e.target.value as "split" | "single"); setPage(1); }}>
        <option value="single">資料を1つ表示</option><option value="split">原文と日本語訳</option>
      </select></label>}
    </div>
    {mappingError && <p role="alert" className="error">対訳のページ情報を読み込めませんでした。資料を1つずつ表示します。{mappingError}</p>}
    <ReaderSplit fraction={fraction} onResize={setFraction} original={
      <PdfArtifact key={(split ? original! : artifact).id} artifact={split ? original! : artifact} runtime={runtime} store={store}
        page={page} zoom={zoom} onPageCount={split ? undefined : setCount} />
    } translated={split ? translatedFile && translated ?
      <PdfArtifact key={translatedFile.id} artifact={translatedFile} runtime={runtime} store={store} page={translated.page} zoom={zoom} />
      : <div className="empty">この原文ページの日本語訳はまだ保存されていません。</div> : undefined} />
  </div>;
}

function PdfArtifact({ artifact, runtime, store, page, zoom, onPageCount }: {
  artifact: ArtifactView; runtime: DriveLibraryRuntime; store?: AnnotationStore; page: number; zoom: number;
  onPageCount?: (count: number) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = "";
    void runtime.artifacts.read(artifact.id, controller.signal).then(blob => {
      if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [runtime, artifact]);
  return <section className="web-pdf-pane" aria-label={artifact.role === "translated" ? "日本語訳" : artifact.role === "original" ? "原文" : artifact.label}>
    <div className="asset-heading"><span>{artifact.label}</span>{url && <a href={url} download={artifact.filename}>PDF本体を保存 ↓</a>}</div>
    {error ? <p role="alert" className="error">{error}</p> : !url ? <p role="status">PDFを読み込んでいます…</p>
      : <PdfReader url={url} target={artifact.annotationTarget} store={store} pageNumber={page} zoom={zoom} navigation={false} onPageCount={onPageCount} />}
  </section>;
}
