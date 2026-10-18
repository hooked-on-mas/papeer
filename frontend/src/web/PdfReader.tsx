import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { InkDrawing } from "../features/reader/InkDrawing";
import { fitInk, hitInk, textPoints, type InkStroke, type Point } from "../features/reader/inkGeometry";
import { AnnotationStore, type Anchor } from "./annotations";
import type { Manifest } from "./drive";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
const options = { cMapUrl: "./pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "./pdfjs/standard_fonts/" };
type Tool = "read" | "pen" | "highlighter" | "eraser" | "text";

export function PdfReader({ url, path, manifest, store }: { url: string; path: string; manifest: Manifest; store?: AnnotationStore }) {
  const [pages, setPages] = useState(0), [page, setPage] = useState(1);
  const [width, setWidth] = useState(700), [ratio, setRatio] = useState(1.414);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.min(1100, Math.max(200, entry.contentRect.width))));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const match = /^papers\/([a-f0-9]{32})\/(original|translated)\.pdf$/.exec(path);
  const anchor: Anchor | undefined = match ? { paper_id: match[1], side: match[2] as Anchor["side"],
    source_sha256: manifest.files[path].sha256, page } : undefined;
  const [renderedPage, setRenderedPage] = useState(0);
  const document = <Document file={url} options={options} loading="PDFを読み込んでいます…" error="PDFを表示できません。ダウンロードしてご確認ください。"
    onLoadSuccess={({ numPages }) => setPages(numPages)}>
    <Page pageNumber={page} width={width} renderAnnotationLayer={false} onLoadSuccess={pdf => {
      const viewport = pdf.getViewport({ scale: 1 }); setRatio(viewport.height / viewport.width);
    }} onRenderSuccess={() => setRenderedPage(page)} />
  </Document>;
  return <div className="pdf" ref={container}>
    <div className="pdf-tools">
      <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← 前</button>
      <label>ページ <input aria-label="ページ番号" type="number" min="1" max={pages || 1} value={page}
        onChange={e => setPage(Math.max(1, Math.min(pages || 1, Number(e.target.value) || 1)))} /> / {pages || "…"}</label>
      <button disabled={page >= pages} onClick={() => setPage(p => p + 1)}>次 →</button>
    </div>
    {store && anchor ? <EditablePage key={`${path}:${page}`} store={store} anchor={anchor} ratio={ratio}
      enabled={renderedPage === page}>{document}</EditablePage>
      : <><p className="ink-help">書き込みを有効にするには、最新版のPCアプリからアップロードし、原文または日本語訳を開いてください。</p>{document}</>}
  </div>;
}

function EditablePage({ store, anchor, ratio, enabled, children }: { store: AnnotationStore; anchor: Anchor; ratio: number;
  enabled: boolean; children: ReactNode }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [tool, setTool] = useState<Tool>("read"), [color, setColor] = useState("#d93c36"), [width, setWidth] = useState(.003);
  const [finger, setFinger] = useState(false), [preview, setPreview] = useState<InkStroke>();
  const [text, setText] = useState<{ at: Point; value: string }>();
  const [history, setHistory] = useState<{ action: "add" | "remove"; stroke: InkStroke }[]>([]);
  const [redo, setRedo] = useState<typeof history>([]);
  const gesture = useRef<{ id: number; stroke: InkStroke; tool: Tool } | undefined>(undefined);
  const pageInk = store.page(anchor);
  const writable = state.ready && enabled;
  const remember = (action: "add" | "remove", stroke: InkStroke) => { setHistory(h => [...h, { action, stroke }]); setRedo([]); };
  const point = (e: PointerEvent<SVGSVGElement>, sample: { clientX: number; clientY: number } = e): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (sample.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (sample.clientY - rect.top) / rect.height))];
  };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (!writable || tool === "read" || gesture.current || (e.pointerType === "touch" && !finger) || (e.button !== 0 && e.button !== 5)) return;
    e.preventDefault();
    const at = point(e);
    if (tool === "text") { setText({ at, value: "" }); return; }
    const kind = e.button === 5 ? "eraser" : tool;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { id: e.pointerId, tool: kind,
      stroke: { id: "preview", kind: kind === "highlighter" ? kind : "pen", color, width: kind === "highlighter" ? Math.max(.018, width * 5) : width, points: [at] } };
    if (kind !== "eraser") setPreview(gesture.current.stroke);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const points = (samples.length ? samples : [e.nativeEvent]).map(sample => point(e, sample));
    g.stroke = { ...g.stroke, points: [...g.stroke.points, ...points].slice(0, 20000) };
    if (g.tool !== "eraser") setPreview(g.stroke);
  };
  const up = (e: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = undefined; setPreview(undefined);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    try {
      if (g.tool === "eraser") {
        const removed = pageInk.strokes.filter(s => s.id.startsWith("web-") && g.stroke.points.some(p => hitInk(s, p, .015, ratio)));
        for (const stroke of removed) { store.remove(anchor, stroke.id); remember("remove", stroke); }
      } else remember("add", store.add(anchor, g.stroke));
    } catch { /* Store reports durable-save errors. */ }
  };
  const undo = () => {
    const entry = history[history.length - 1]; if (!entry) return;
    try {
      if (entry.action === "add") store.remove(anchor, entry.stroke.id);
      else entry.stroke = store.add(anchor, entry.stroke);
      setHistory(history.slice(0, -1)); setRedo([...redo, entry]);
    } catch { /* Store reports the error. */ }
  };
  const redoLast = () => {
    const entry = redo[redo.length - 1]; if (!entry) return;
    try {
      if (entry.action === "add") entry.stroke = store.add(anchor, entry.stroke);
      else store.remove(anchor, entry.stroke.id);
      setRedo(redo.slice(0, -1)); setHistory([...history, entry]);
    } catch { /* Store reports the error. */ }
  };
  return <>
    <div className="ink-tools" aria-label="PDFの書き込みツール">
      {([["read", "閲覧"], ["pen", "ペン"], ["highlighter", "蛍光ペン"], ["text", "文字メモ"], ["eraser", "消しゴム"]] as const).map(([value, label]) =>
        <button key={value} disabled={!writable} aria-pressed={tool === value} onClick={() => { gesture.current = undefined; setPreview(undefined); setTool(value); }}>{label}</button>)}
      <label>色 <input type="color" aria-label="書き込みの色" value={color} onChange={e => setColor(e.target.value)} /></label>
      <label>太さ <select aria-label="ペンの太さ" value={width} onChange={e => setWidth(Number(e.target.value))}>
        <option value={.002}>細い</option><option value={.003}>標準</option><option value={.006}>太い</option></select></label>
      <button disabled={!writable || !history.length} onClick={undo}>元に戻す</button>
      <button disabled={!writable || !redo.length} onClick={redoLast}>やり直す</button>
      <label><input type="checkbox" checked={finger} onChange={e => setFinger(e.target.checked)} /> 指でも書く</label>
    </div>
    <div className="ink-save" role="status">{!state.ready ? "書き込みを読み込んでいます…" : state.saving ? `Driveに保存中…（残り${state.pending}件）`
      : state.pending ? `未保存 ${state.pending}件 · この端末に下書きがあります` : "Driveに保存済み"}
      <button onClick={() => void store.retry()}>書き込みを同期・再試行</button></div>
    {state.error && <p className="error" role="alert">{state.error}</p>}
    {state.stale > 0 && <p className="ink-help">以前のPDF版への書き込みが{state.stale}件Driveに残っています。PDFが更新されているため、現在の版には重ねていません。</p>}
    <p className="ink-help">ペンはApple Pencil・マウスに対応。指はスクロール用です。消しゴムはWebで追加した書き込みが対象です。</p>
    {text && <form className="ink-text" onSubmit={e => {
      e.preventDefault(); if (!text.value.trim()) return;
      try {
        const stroke = fitInk([{ id: "draft", kind: "text", text: text.value, color, width,
          points: textPoints(text.value, text.at, .023, ratio) }], ratio)[0];
        remember("add", store.add(anchor, stroke)); setText(undefined);
      } catch { /* Store reports the error. */ }
    }}><label>文字メモ <textarea aria-label="PDFに追加するメモ" value={text.value} maxLength={2000} autoFocus onChange={e => setText({ ...text, value: e.target.value })} /></label>
      <button type="submit" disabled={!text.value.trim()}>メモを保存</button><button type="button" onClick={() => setText(undefined)}>キャンセル</button></form>}
    <div className="ink-page">{children}
      {enabled && <svg className={`web-ink ${tool === "read" ? "reading" : "writing"}`} data-testid="web-ink" aria-label="PDF書き込み面"
        viewBox={`0 0 1000 ${1000 * ratio}`} style={{ touchAction: finger && tool !== "read" ? "none" : "pan-x pan-y pinch-zoom" }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { gesture.current = undefined; setPreview(undefined); }}
        onLostPointerCapture={() => { gesture.current = undefined; setPreview(undefined); }}>
        {pageInk.highlights.flatMap((h, i) => h.rects.map(([x, y, w, height], j) => <rect key={`${i}:${j}`} x={x * 1000} y={y * 1000 * ratio}
          width={w * 1000} height={height * 1000 * ratio} fill={h.color} opacity={.3} />))}
        {pageInk.strokes.map(stroke => <g key={stroke.id} data-ink-id={stroke.id}><InkDrawing stroke={stroke} ratio={ratio} /></g>)}
        {preview && <InkDrawing stroke={preview} ratio={ratio} />}
      </svg>}
    </div>
  </>;
}
