import { WritingHistoryButtons, WritingToolbarPortal, WritingTarget, useWritingPane } from "../features/reader/WritingToolbar";
import { usePdfWritingSettings, usePdfWritingHistory, type PdfTool as Tool } from "./PdfWritingTools";
import { moveInkHistory } from './pdfWritingHistory';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type PointerEvent, type ReactNode } from "react";
import { InkDrawing } from "../features/reader/InkDrawing";
import { DrawingKindSelect } from '../features/reader/DrawingKindSelect';
import { advanceInkDraft, beginInkDraft, finishInkDraft } from '../features/ink/inkDraft';
import { fitInk, hitInk, textPoints, type InkStroke, type Point } from "../features/ink/inkGeometry";
import { AnnotationStore, type Anchor, type PageInk } from "./annotations";
import type { AnnotationTarget } from "../runtime/contracts";
import { AlertCircle, Check, Eraser, Hand, Highlighter, Loader2, Pen, RefreshCw, Settings2, Type, type LucideIcon } from "lucide-react";
import { prepareWebNavigation, registerNavigationGuard, textDrafts, type TextDraft } from "./textDrafts";
import { ReaderMenu } from "./ReaderMenu";

const SavedInk = memo(function SavedInk({ ink, ratio }: { ink: PageInk; ratio: number }) {
  return <>{ink.highlights.flatMap((h, i) => h.rects.map(([x, y, w, height], j) => <rect key={`${i}:${j}`} x={x * 1000} y={y * 1000 * ratio}
    width={w * 1000} height={height * 1000 * ratio} fill={h.color} opacity={.3} />))}
    {ink.strokes.map(stroke => <g key={stroke.id} data-ink-id={stroke.id} data-ink-kind={stroke.kind ?? 'pen'}><InkDrawing stroke={stroke} ratio={ratio} /></g>)}</>;
});


import { PdfReader } from "./PdfReader";
import { getPdfPlace, rememberPdfPlace, persistPdfPlaces } from "./readingPlace";
const readingPlace = { get: getPdfPlace, remember: rememberPdfPlace, flush: persistPdfPlaces };
export function LegacyPdfReaderConnection({ target, store, ...props }: Omit<ComponentProps<typeof PdfReader>, "renderPage" | "readingPlace" | "swipeEnabled" | "beforeNavigate"> & {
  target?: AnnotationTarget; store?: AnnotationStore;
}) {
  const { tool, setTool, color, setColor, width, setWidth, finger, setFinger } = usePdfWritingSettings();
  const editing = props.editing ?? true;
  return <PdfReader {...props} readingPlace={readingPlace} beforeNavigate={prepareWebNavigation}
    swipeEnabled={!editing || !finger || tool === "read"}
    renderPage={store && target ? ({ page, ratio, pageWidth, enabled, compactTools, children }) =>
      <EditablePage key={`${props.url}:${page}`} store={store}
        anchor={{ paper_id: target.paperId, side: target.side, source_sha256: target.sourceSha256, page }}
        ratio={ratio} pageWidth={pageWidth} enabled={enabled} compactTools={compactTools}
        tool={editing ? tool : "read"} editing={editing} setTool={setTool} color={color} setColor={setColor}
        width={width} setWidth={setWidth} finger={finger} setFinger={setFinger}>{children}</EditablePage>
      : undefined}
    emptyEditingHint={editing && <p className="ink-help">書き込みを有効にするには、最新版のPCアプリからアップロードし、原文または日本語訳を開いてください。</p>} />;
}
function EditablePage({ store, anchor, ratio, enabled, pageWidth, children, tool, setTool, color, setColor, width, setWidth, finger, setFinger, editing, compactTools }: {
  store: AnnotationStore; anchor: Anchor; ratio: number; enabled: boolean; pageWidth: number; children: ReactNode;
  tool: Tool; setTool: (tool: Tool) => void; color: string; setColor: (color: string) => void;
  width: number; setWidth: (width: number) => void; finger: boolean; setFinger: (finger: boolean) => void;
  editing: boolean; compactTools: boolean;
}) {
  const side = anchor.side;
  const { servesToolbar, slot } = useWritingPane(side, true);
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
  const { history, redo, changeHistory } = usePdfWritingHistory(draftKey);
  const gesture = useRef<{ id: number; stroke: InkStroke; start: Point; tool: Tool } | undefined>(undefined);
  const failed = useRef<InkStroke | undefined>(undefined);
  const [failedStroke, setFailedStroke] = useState<InkStroke>();
  const failedErase = useRef<InkStroke[] | undefined>(undefined);
  const [failedEraseCount, setFailedEraseCount] = useState(0);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  useEffect(() => {
    // Rotation/zoom removes the old SVG; its lost-capture event may never reach React.
    if (!enabled) { gesture.current = undefined; touches.current.clear(); setPreview(failed.current); }
  }, [enabled]);
  // Pen moves update only the live stroke, rather than re-merging and painting every saved annotation.
  const pageInk = useMemo(() => ({ version: state.version, ink: store.page(anchor) }), [store, anchor, state.version]).ink;
  const writable = state.ready && enabled;
  const remember = useCallback((action: "add" | "remove", value: InkStroke | InkStroke[]) => {
    changeHistory(page => ({ undo: [...page.undo, { action, strokes: Array.isArray(value) ? value : [value] }], redo: [] }));
  }, [changeHistory]);
  const retryStroke = useCallback(() => {
    const removed = failedErase.current;
    if (removed) {
      try { store.edit(anchor, { remove: removed.map(stroke => stroke.id) }); remember('remove', removed); failedErase.current = undefined; setFailedEraseCount(0); }
      catch { return false; }
    }
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
      // Route a single finger to the PDF scroller; the PDF host handles two-finger zoom.
      if (!gesture.current) { touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); e.currentTarget.setPointerCapture(e.pointerId); }
      return;
    }
    if (!writable || failed.current || failedErase.current || tool === "read" || gesture.current || (e.button !== 0 && e.button !== 5)) return;
    touches.current.clear(); // A resting palm must not move the page while writing.
    e.preventDefault();
    const at = point(e);
    if (tool === "text") { placementClick.current = true; editText({ at, value: text?.value ?? "" }); return; }
    const kind = e.button === 5 ? "eraser" : tool;
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { id: e.pointerId, tool: kind, start: at,
      stroke: beginInkDraft('preview', kind === 'eraser' ? 'pen' : kind, at, color, kind === 'highlighter' ? Math.max(.018, width * 5) : width) };
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
    g.stroke = advanceInkDraft(g.stroke, g.start, points, ratio, { shift: e.shiftKey });
    if (g.tool !== "eraser") setPreview(g.stroke);
  };
  const up = (e: PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    g.stroke = advanceInkDraft(g.stroke, g.start, [point(e)], ratio, { shift: e.shiftKey });
    gesture.current = undefined; setPreview(undefined);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const completed = g.tool === 'eraser' ? g.stroke : finishInkDraft(g.stroke, ratio);
    if (!completed) return;
    const removed = g.tool === 'eraser' ? pageInk.strokes.filter(s => s.id.startsWith("web-") && g.stroke.points.some(p => hitInk(s, p, .015, ratio))) : [];
    try {
      if (g.tool === "eraser") {
        if (removed.length) { store.edit(anchor, { remove: removed.map(stroke => stroke.id) }); remember('remove', removed); }
      } else remember("add", store.add(anchor, completed));
    } catch {
      if (g.tool !== "eraser") { failed.current = completed; setFailedStroke(completed); setPreview(completed); }
      else { failedErase.current = removed; setFailedEraseCount(removed.length); }
    }
  };
  const cancel = (e: PointerEvent<SVGSVGElement>) => {
    touches.current.delete(e.pointerId);
    if (gesture.current?.id === e.pointerId) { gesture.current = undefined; setPreview(undefined); }
  };
  const undo = () => {
    const previous = history[history.length - 1]; if (!previous) return;
    const entry = { ...previous };
    try {
      if (entry.action === "add") store.edit(anchor, { remove: entry.strokes.map(stroke => stroke.id) });
      else entry.strokes = store.edit(anchor, { add: entry.strokes });
      changeHistory(page => moveInkHistory(page, 'undo', entry.action === 'remove' ? entry.strokes : undefined));
    } catch { /* Store reports the error. */ }
  };
  const redoLast = () => {
    const previous = redo[redo.length - 1]; if (!previous) return;
    const entry = { ...previous };
    try {
      if (entry.action === "add") entry.strokes = store.edit(anchor, { add: entry.strokes });
      else store.edit(anchor, { remove: entry.strokes.map(stroke => stroke.id) });
      changeHistory(page => moveInkHistory(page, 'redo', entry.action === 'add' ? entry.strokes : undefined));
    } catch { /* Store reports the error. */ }
  };
  const saveStatus = failedStroke || failedEraseCount || draftError ? "端末に保存できていない書き込みがあります。"
    : text?.value.trim() ? "文字メモは端末の下書きです。配置してDriveに保存してください。"
    : !state.ready ? state.error ? "書き込みを読み込めません。再試行してください。" : "書き込みを読み込んでいます…"
    : state.saving ? `Driveに保存中…（残り${state.pending}件）`
    : state.pending ? `未保存 ${state.pending}件 · この端末に下書きがあります`
    : state.error ? "書き込みの保存状態を確認してください。" : "Driveに保存済み";
  const historyTools = <WritingHistoryButtons canUndo={writable && history.length > 0} canRedo={writable && redo.length > 0} onUndo={undo} onRedo={redoLast} />;
  const syncTool = <button title="書き込みを同期・再試行" disabled={state.saving} onClick={() => void store.retry()}><RefreshCw aria-hidden="true" /><span className="sr-only">書き込みを同期・再試行</span></button>;
  const penSettings = <>
    <label>描画 <DrawingKindSelect value={tool} disabled={!writable} onChange={value => {
      if (!prepareWebNavigation()) return;
      gesture.current = undefined; touches.current.clear(); setPreview(undefined); setTool(value);
    }} /></label>
    <label className="ink-color-control">色 <span className="ink-color-swatch" style={{ backgroundColor: color }}><input type="color" aria-label="書き込みの色" value={color} onChange={e => setColor(e.target.value)} /></span></label>
    <label>太さ <select aria-label="ペンの太さ" value={width} onChange={e => setWidth(Number(e.target.value))}>
      <option value={.002}>細い</option><option value={.003}>標準</option><option value={.006}>太い</option></select></label>
  </>;
  const fingerControl = <label className="ink-finger-control"><input type="checkbox" checked={finger} onChange={e => setFinger(e.target.checked)} /> 指でも書く</label>;
  const toolButton = (value: Tool, label: string, Icon: LucideIcon) => <button key={value} disabled={!writable} title={label} aria-pressed={tool === value}
    onClick={() => { if (!prepareWebNavigation()) return; gesture.current = undefined; touches.current.clear(); setPreview(undefined); setTool(value); }}><Icon aria-hidden="true" /><span className="sr-only">{label}</span></button>;
  const toolbar = editing && <div className={`ink-tools${compactTools ? " ink-tools-compact" : ""}`} role="toolbar" aria-label="PDFの書き込みツール">
      <WritingTarget side={side} presentation="select" className="ink-target" beforeChange={prepareWebNavigation} />
      {toolButton("read", "閲覧", Hand)}
      <span className="ink-tool-divider" aria-hidden="true" />
      <span className="ink-tool-set">{toolButton("pen", "ペン", Pen)}{toolButton("highlighter", "蛍光ペン", Highlighter)}</span>
      {!compactTools && <div className="ink-settings-inline">{penSettings}</div>}
      <span className="ink-tool-set">{toolButton("eraser", "消しゴム", Eraser)}{toolButton("text", "文字メモ", Type)}</span>
      <span className="ink-tool-divider" aria-hidden="true" />
      <span className="ink-history-inline">{historyTools}</span>
      {compactTools ? <ReaderMenu className="ink-options" label="書き込み設定" icon={<Settings2 aria-hidden="true" />} floating>
        {penSettings}{fingerControl}
          <div className="ink-history-menu ink-mobile-actions">{historyTools}{syncTool}</div>
      </ReaderMenu> : fingerControl}
      <span className="ink-save" role="status" title={saveStatus}>
        {failedStroke || failedEraseCount || draftError || state.error ? <AlertCircle aria-hidden="true" /> : !state.ready || state.saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : state.pending ? <span>{state.pending}</span> : <Check aria-hidden="true" />}
        <span className="sr-only">{saveStatus}</span>
      </span>
      <span className="ink-history-inline">{syncTool}</span>
    </div>;
  return <>
    {servesToolbar && <WritingToolbarPortal slot={slot}>{toolbar}</WritingToolbarPortal>}
    {state.error && <p className="error" role="alert">{state.error}</p>}
    {failedEraseCount > 0 && <div role="alert" className="error">{failedEraseCount}件の消去を保存できませんでした。内容は変更していません。
      <button onClick={retryStroke}>消去を再保存</button> <button onClick={() => { failedErase.current = undefined; setFailedEraseCount(0); }}>消去を取り消す</button></div>}
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
    <div className="ink-page web-pdf-surface" style={{ width: pageWidth, minHeight: pageWidth * ratio }}
      onTouchStartCapture={event => {
        if (event.touches.length > 1) { gesture.current = undefined; touches.current.clear(); setPreview(failed.current); }
      }}>{children}
      {enabled && <svg className={`web-ink ${tool === "read" ? "reading" : "writing"}`} data-testid="web-ink" aria-label="PDF書き込み面"
        viewBox={`0 0 1000 ${1000 * ratio}`} style={{ touchAction: tool === "read" ? "auto" : finger ? "none" : "pinch-zoom" }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel}>
        <SavedInk ink={pageInk} ratio={ratio} />
        {preview && <InkDrawing stroke={preview} ratio={ratio} />}
      </svg>}
    </div>
  </>;
}
