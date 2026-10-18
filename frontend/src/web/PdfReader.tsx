import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import { PdfDocument as Document, PdfPage as Page } from "../features/reader/PdfDocument";
import { PageNavigatorView } from "../features/reader/PageNavigatorView";
import { cappedPixelRatio } from "../features/reader/canvasBudget";
import { InkDrawing } from "../features/reader/InkDrawing";
import { fitInk, hitInk, textPoints, type InkStroke, type Point } from "../features/reader/inkGeometry";
import { AnnotationStore, type Anchor, type PageInk } from "./annotations";
import type { AnnotationTarget } from "../runtime/contracts";
import { AlertCircle, Check, Eraser, Hand, Highlighter, Loader2, Pen, Redo2, RefreshCw, Settings2, Type, Undo2 } from "lucide-react";
import { prepareWebNavigation, registerNavigationGuard, textDrafts, type TextDraft } from "./textDrafts";
import { useMediaQuery } from "../lib/useMediaQuery";
import { PHONE_LAYOUT_QUERY } from "./phoneLayout";

type Tool = "read" | "pen" | "highlighter" | "eraser" | "text";

const SavedInk = memo(function SavedInk({ ink, ratio }: { ink: PageInk; ratio: number }) {
  return <>{ink.highlights.flatMap((h, i) => h.rects.map(([x, y, w, height], j) => <rect key={`${i}:${j}`} x={x * 1000} y={y * 1000 * ratio}
    width={w * 1000} height={height * 1000 * ratio} fill={h.color} opacity={.3} />))}
    {ink.strokes.map(stroke => <g key={stroke.id} data-ink-id={stroke.id}><InkDrawing stroke={stroke} ratio={ratio} /></g>)}</>;
});

export function PdfReader({ url, target, store, pageNumber, onPageCount, zoom = 1, navigation = true, editing = true }: {
  url: string; target?: AnnotationTarget; store?: AnnotationStore; pageNumber?: number;
  onPageCount?: (count: number) => void; zoom?: number; navigation?: boolean; editing?: boolean;
}) {
  const [pages, setPages] = useState(0), [localPage, setPage] = useState(1);
  const page = pageNumber ?? localPage;
  useEffect(() => { if (pages > 0) onPageCount?.(pages); }, [pages, onPageCount]);
  const [width, setWidth] = useState(700), [ratio, setRatio] = useState(1.414);
  const [tool, setTool] = useState<Tool>("pen"), [color, setColor] = useState("#d93c36"), [inkWidth, setInkWidth] = useState(.003);
  const [finger, setFinger] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, entry.contentRect.width)));
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
    {pages > 0 && (page < 1 || page > pages) ? <p role="alert" className="error">保存されたPDFに指定ページがありません。PCから再アップロードしてください。</p>
    : <Page key={render.key} pageNumber={page} width={drawnWidth} devicePixelRatio={pixelRatio}
      renderAnnotationLayer={false} onLoadSuccess={pdf => {
      const viewport = pdf.getViewport({ scale: 1 }); setRatio(viewport.height / viewport.width);
    }} onRenderSuccess={() => {
      // A cancelled old canvas can finish late. It must not enable or disable the current editor.
      if (activeRender.current === render) setRendered(render);
    }} onRenderError={() => { if (activeRender.current === render) setRendered(null); }} />}
  </Document>;
  return <div className="pdf" ref={container}>
    {navigation && <div className="pdf-tools"><PageNavigatorView paperId={url} currentPage={page} count={pages} compact shortcuts={false}
      atStart={page <= 1} atEnd={page >= pages} onJump={setPage} onMove={delta => setPage(value => Math.max(1, Math.min(pages || 1, value + delta)))} /></div>}
    {store && anchor ? <EditablePage key={`${url}:${page}`} store={store} anchor={anchor} ratio={ratio} pageWidth={drawnWidth}
      tool={editing ? tool : "read"} editing={editing} setTool={setTool} color={color} setColor={setColor} width={inkWidth} setWidth={setInkWidth} finger={finger} setFinger={setFinger}
      enabled={rendered === render}>{document}</EditablePage>
      : <>{editing && <p className="ink-help">書き込みを有効にするには、最新版のPCアプリからアップロードし、原文または日本語訳を開いてください。</p>}{document}</>}
  </div>;
}

function EditablePage({ store, anchor, ratio, enabled, pageWidth, children, tool, setTool, color, setColor, width, setWidth, finger, setFinger, editing }: {
  store: AnnotationStore; anchor: Anchor; ratio: number; enabled: boolean; pageWidth: number; children: ReactNode;
  tool: Tool; setTool: (tool: Tool) => void; color: string; setColor: (color: string) => void;
  width: number; setWidth: (width: number) => void; finger: boolean; setFinger: (finger: boolean) => void;
  editing: boolean;
}) {
  const phone = useMediaQuery(PHONE_LAYOUT_QUERY);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [preview, setPreview] = useState<InkStroke>();
  const draftKey = textDrafts.key(store.libraryId, anchor);
  const [initialDraft] = useState(() => {
    try { return { text: textDrafts.read(draftKey), error: "" }; }
    catch (error) { return { text: undefined, error: String(error) }; }
  });
  const [text, setText] = useState<TextDraft | undefined>(initialDraft.text);
  // Inserting/autofocusing the form on pointerdown moves the page. Chromium may
  // retarget the same touch's compatibility click to Save/Cancel under the finger.
  // A subsequent pointerdown or key press is a new, intentional form interaction.
  const placementClick = useRef(false);
  const [draftError, setDraftError] = useState(initialDraft.error);
  const editText = (draft: TextDraft | undefined) => {
    setText(draft);
    try { textDrafts.write(draftKey, draft); setDraftError(""); }
    catch { setDraftError("入力中の文字メモを端末に保存できません。空き容量・別タブの編集を確認し、文字をコピーするか、保存・キャンセルしてから画面を切り替えてください。"); }
  };
  const [history, setHistory] = useState<{ action: "add" | "remove"; stroke: InkStroke }[]>([]);
  const [redo, setRedo] = useState<typeof history>([]);
  const gesture = useRef<{ id: number; stroke: InkStroke; tool: Tool } | undefined>(undefined);
  const failed = useRef<InkStroke | undefined>(undefined);
  const [failedStroke, setFailedStroke] = useState<InkStroke>();
  const touches = useRef(new Map<number, { x: number; y: number }>());
  useEffect(() => {
    // Rotation/zoom removes the old SVG; its lost-capture event may never reach React.
    if (!enabled) { gesture.current = undefined; touches.current.clear(); setPreview(failed.current); }
  }, [enabled]);
  // Pen moves update only the live stroke, rather than re-merging and painting every saved annotation.
  const pageInk = useMemo(() => ({ version: state.version, ink: store.page(anchor) }), [store, anchor, state.version]).ink;
  const writable = state.ready && enabled;
  const remember = useCallback((action: "add" | "remove", stroke: InkStroke) => { setHistory(h => [...h, { action, stroke }]); setRedo([]); }, []);
  const retryStroke = useCallback(() => {
    const stroke = failed.current; if (!stroke) return true;
    try {
      remember("add", store.add(anchor, stroke));
      failed.current = undefined; setFailedStroke(undefined); setPreview(undefined); return true;
    } catch { return false; }
  }, [store, anchor, remember]);
  useLayoutEffect(() => registerNavigationGuard(() => !gesture.current && retryStroke()), [retryStroke]);
  const point = (e: PointerEvent<SVGSVGElement>, sample: { clientX: number; clientY: number } = e): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (sample.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (sample.clientY - rect.top) / rect.height))];
  };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "touch" && !finger) {
      // Drawing disables browser panning for *all* pointer types, including Pencil.
      // Route a single finger to the PDF scroller instead; native pinch zoom stays available.
      if (!gesture.current) { touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); e.currentTarget.setPointerCapture(e.pointerId); }
      return;
    }
    if (!writable || failed.current || tool === "read" || gesture.current || (e.button !== 0 && e.button !== 5)) return;
    touches.current.clear(); // A resting palm must not move the page while writing.
    e.preventDefault();
    const at = point(e);
    if (tool === "text") { placementClick.current = true; editText({ at, value: text?.value ?? "" }); return; }
    const kind = e.button === 5 ? "eraser" : tool;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { id: e.pointerId, tool: kind,
      stroke: { id: "preview", kind: kind === "highlighter" ? kind : "pen", color, width: kind === "highlighter" ? Math.max(.018, width * 5) : width, points: [at] } };
    if (kind !== "eraser") setPreview(gesture.current.stroke);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const touch = touches.current.get(e.pointerId);
    if (touch) {
      touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!gesture.current && touches.current.size === 1) {
        e.currentTarget.closest(".web-pdf-pane")?.scrollBy(touch.x - e.clientX, touch.y - e.clientY);
      }
      return;
    }
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    e.preventDefault();
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const points = (samples.length ? samples : [e.nativeEvent]).map(sample => point(e, sample));
    g.stroke = { ...g.stroke, points: [...g.stroke.points, ...points].slice(0, 20000) };
    if (g.tool !== "eraser") setPreview(g.stroke);
  };
  const up = (e: PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = undefined; setPreview(undefined);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    try {
      if (g.tool === "eraser") {
        const removed = pageInk.strokes.filter(s => s.id.startsWith("web-") && g.stroke.points.some(p => hitInk(s, p, .015, ratio)));
        for (const stroke of removed) { store.remove(anchor, stroke.id); remember("remove", stroke); }
      } else remember("add", store.add(anchor, g.stroke));
    } catch {
      if (g.tool !== "eraser") { failed.current = g.stroke; setFailedStroke(g.stroke); setPreview(g.stroke); }
    }
  };
  const cancel = (e: PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId);
    if (gesture.current?.id === e.pointerId) { gesture.current = undefined; setPreview(undefined); }
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
  const saveStatus = failedStroke || draftError ? "端末に保存できていない書き込みがあります。"
    : text?.value.trim() ? "文字メモは端末の下書きです。配置してDriveに保存してください。"
    : !state.ready ? state.error ? "書き込みを読み込めません。再試行してください。" : "書き込みを読み込んでいます…"
    : state.saving ? `Driveに保存中…（残り${state.pending}件）`
    : state.pending ? `未保存 ${state.pending}件 · この端末に下書きがあります`
    : state.error ? "書き込みの保存状態を確認してください。" : "Driveに保存済み";
  const historyTools = <>
      <button title="元に戻す" disabled={!writable || !history.length} onClick={undo}><Undo2 aria-hidden="true" /><span className={phone ? "" : "sr-only"}>元に戻す</span></button>
      <button title="やり直す" disabled={!writable || !redo.length} onClick={redoLast}><Redo2 aria-hidden="true" /><span className={phone ? "" : "sr-only"}>やり直す</span></button>
  </>;
  const syncTool = <button title="書き込みを同期・再試行" disabled={state.saving} onClick={() => void store.retry()}><RefreshCw aria-hidden="true" /><span className={phone ? "" : "sr-only"}>書き込みを同期・再試行</span></button>;
  return <>
    {editing && <div className="ink-tools" role="toolbar" aria-label="PDFの書き込みツール">
      {([["read", "閲覧", Hand], ["pen", "ペン", Pen], ["highlighter", "蛍光ペン", Highlighter], ["text", "文字メモ", Type], ["eraser", "消しゴム", Eraser]] as const).map(([value, label, Icon]) =>
        <button key={value} disabled={!writable} title={label} aria-pressed={tool === value}
          onClick={() => { if (!prepareWebNavigation()) return; gesture.current = undefined; touches.current.clear(); setPreview(undefined); setTool(value); }}><Icon aria-hidden="true" /><span className="sr-only">{label}</span></button>)}
      {!phone && historyTools}
      <details className="ink-options"><summary title="書き込み設定" aria-label="書き込み設定"><Settings2 aria-hidden="true" /></summary>
        <div><label>色 <input type="color" aria-label="書き込みの色" value={color} onChange={e => setColor(e.target.value)} /></label>
          <label>太さ <select aria-label="ペンの太さ" value={width} onChange={e => setWidth(Number(e.target.value))}>
            <option value={.002}>細い</option><option value={.003}>標準</option><option value={.006}>太い</option></select></label>
          <label><input type="checkbox" checked={finger} onChange={e => setFinger(e.target.checked)} /> 指でも書く</label>
          {phone && <div className="ink-mobile-actions">{historyTools}{syncTool}</div>}</div>
      </details>
      <span className="ink-save" role="status" title={saveStatus}>
        {failedStroke || draftError || state.error ? <AlertCircle aria-hidden="true" /> : !state.ready || state.saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : state.pending ? <span>{state.pending}</span> : <Check aria-hidden="true" />}
        <span className="sr-only">{saveStatus}</span>
      </span>
      {!phone && syncTool}
    </div>}
    {state.error && <p className="error" role="alert">{state.error}</p>}
    {failedStroke && <div role="alert" className="error">この線はまだ端末に保存できていません。
      <button onClick={retryStroke}>線を再保存</button> <button onClick={() => {
        failed.current = undefined; setFailedStroke(undefined); setPreview(undefined); void store.retry();
      }}>この線を破棄</button></div>}
    {draftError && <p className="error" role="alert">{draftError}</p>}
    {state.stale > 0 && <p className="ink-help">以前のPDF版への書き込みが{state.stale}件Driveに残っています。PDFが更新されているため、現在の版には重ねていません。</p>}
    {text && editing && <form className="ink-text"
      onPointerDownCapture={() => { placementClick.current = false; }}
      onKeyDownCapture={() => { placementClick.current = false; }}
      onClickCapture={e => {
        if (placementClick.current && e.detail > 0) { placementClick.current = false; e.preventDefault(); e.stopPropagation(); }
      }}
      onSubmit={e => {
      e.preventDefault(); if (!text.value.trim()) return;
      try {
        const stroke = fitInk([{ id: "draft", kind: "text", text: text.value, color, width,
          points: textPoints(text.value, text.at, .023, ratio) }], ratio)[0];
        remember("add", store.add(anchor, stroke)); editText(undefined);
      } catch { /* Store reports the error. */ }
    }}><label>文字メモ <textarea aria-label="PDFに追加するメモ" value={text.value} maxLength={2000} autoFocus onChange={e => editText({ ...text, value: e.target.value })} /></label>
      <button type="submit" disabled={!text.value.trim()}>メモを保存</button><button type="button" onClick={() => editText(undefined)}>キャンセル</button></form>}
    <div className="ink-page" style={{ width: pageWidth }}>{children}
      {enabled && <svg className={`web-ink ${tool === "read" ? "reading" : "writing"}`} data-testid="web-ink" aria-label="PDF書き込み面"
        viewBox={`0 0 1000 ${1000 * ratio}`} style={{ touchAction: tool === "read" ? "auto" : finger ? "none" : "pinch-zoom" }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel}>
        <SavedInk ink={pageInk} ratio={ratio} />
        {preview && <InkDrawing stroke={preview} ratio={ratio} />}
      </svg>}
    </div>
  </>;
}
