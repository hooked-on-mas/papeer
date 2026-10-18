import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import { PdfDocument as Document, PdfPage as Page } from "../features/reader/PdfDocument";
import { PageNavigatorView } from "../features/reader/PageNavigatorView";
import { cappedPixelRatio } from "../features/reader/canvasBudget";
import { InkDrawing } from "../features/reader/InkDrawing";
import { fitInk, hitInk, textPoints, type InkStroke, type Point } from "../features/reader/inkGeometry";
import { AnnotationStore, type Anchor } from "./annotations";
import type { AnnotationTarget } from "../runtime/contracts";

type Tool = "read" | "pen" | "highlighter" | "eraser" | "text";

export function PdfReader({ url, target, store, pageNumber, onPageCount, zoom = 1, navigation = true }: {
  url: string; target?: AnnotationTarget; store?: AnnotationStore; pageNumber?: number;
  onPageCount?: (count: number) => void; zoom?: number; navigation?: boolean;
}) {
  const [pages, setPages] = useState(0), [localPage, setPage] = useState(1);
  const page = pageNumber ?? localPage;
  useEffect(() => { if (pages > 0) onPageCount?.(pages); }, [pages, onPageCount]);
  const [width, setWidth] = useState(700), [ratio, setRatio] = useState(1.414);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.min(1100, Math.max(200, entry.contentRect.width))));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const anchor: Anchor | undefined = target ? { paper_id: target.paperId, side: target.side, source_sha256: target.sourceSha256, page } : undefined;
  // Match react-pdf's integer CSS canvas width, rather than tracking subpixel layout noise.
  const drawnWidth = Math.max(1, Math.floor(width * zoom));
  const pixelRatio = cappedPixelRatio(window.devicePixelRatio, drawnWidth, drawnWidth * ratio);
  const render = useMemo(() => ({ key: `${url}:${page}:${drawnWidth}:${pixelRatio}` }), [url, page, drawnWidth, pixelRatio]);
  const activeRender = useRef<typeof render | null>(render);
  const [rendered, setRendered] = useState<typeof render | null>(null);
  useLayoutEffect(() => {
    activeRender.current = render;
    return () => { activeRender.current = null; };
  }, [render]);
  const document = <Document file={url} loading="PDFを読み込んでいます…" error="PDFを表示できません。ダウンロードしてご確認ください。"
    onLoadSuccess={({ numPages }) => setPages(numPages)}>
    <Page key={render.key} pageNumber={page} width={drawnWidth} devicePixelRatio={pixelRatio}
      renderAnnotationLayer={false} onLoadSuccess={pdf => {
      const viewport = pdf.getViewport({ scale: 1 }); setRatio(viewport.height / viewport.width);
    }} onRenderSuccess={() => {
      // A cancelled old canvas can finish late. It must not enable or disable the current editor.
      if (activeRender.current === render) setRendered(render);
    }} onRenderError={() => { if (activeRender.current === render) setRendered(null); }} />
  </Document>;
  return <div className="pdf" ref={container}>
    {navigation && <div className="pdf-tools"><PageNavigatorView paperId={url} currentPage={page} count={pages} compact shortcuts={false}
      atStart={page <= 1} atEnd={page >= pages} onJump={setPage} onMove={delta => setPage(value => Math.max(1, Math.min(pages || 1, value + delta)))} /></div>}
    {store && anchor ? <EditablePage key={`${url}:${page}`} store={store} anchor={anchor} ratio={ratio} pageWidth={drawnWidth}
      enabled={rendered === render}>{document}</EditablePage>
      : <><p className="ink-help">書き込みを有効にするには、最新版のPCアプリからアップロードし、原文または日本語訳を開いてください。</p>{document}</>}
  </div>;
}

function EditablePage({ store, anchor, ratio, enabled, pageWidth, children }: { store: AnnotationStore; anchor: Anchor; ratio: number;
  enabled: boolean; pageWidth: number; children: ReactNode }) {
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
    <div className="ink-page" style={{ width: pageWidth }}>{children}
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
