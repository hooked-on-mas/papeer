import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { boundsOf, eraseInk, fitInk, hitInk, inBounds, kindOf, rectBetween, selectInk, shapePoints, snapRotation, textPoints, textUnits, transformInk,
  type Bounds, type InkKind, type InkStroke, type Point } from "./inkGeometry";
import type { InkEditor } from "./useInkEditor";
import { AnnotationTextEditor } from "./AnnotationTextEditor";
import { canResumeShape, SHAPE_LIFT_GRACE_MS } from "./inkInteraction";
export type { InkTool } from "./inkGeometry";

type Gesture = {
  pointerId: number; mode: "draw" | "erase" | "select" | "capture" | "move" | "resize" | "rotate";
  start: Point; path: Point[]; base: InkStroke[]; result: InkStroke[]; selected: InkStroke[];
  stroke?: InkStroke; center: Point; anchor: Point; moved: boolean; commit: (strokes: InkStroke[]) => void;
  pointerType: string; end: Point;
};

const InkLayer = memo(function InkLayer({ strokes, ratio }: { strokes: InkStroke[]; ratio: number }) {
  return <>{strokes.map(stroke => <g key={stroke.id} data-ink-id={stroke.id} data-ink-kind={kindOf(stroke)} style={{ pointerEvents: "none" }}><InkDrawing stroke={stroke} ratio={ratio} /></g>)}</>;
});

const resultOf = (g: Gesture, ratio: number) => g.mode === "draw"
  ? [...g.base, ...fitInk([g.stroke!], ratio)] : g.result;

export function InkDrawing({ stroke, ratio }: { stroke: InkStroke; ratio: number }) {
  const height = 1000 * ratio;
  if (kindOf(stroke) === "text") {
    const [a, b, , d] = stroke.points;
    const lines = (stroke.text ?? "").split("\n"), units = Math.max(1, ...lines.map(textUnits));
    const ux = (b[0] - a[0]) * 1000, uy = (b[1] - a[1]) * height;
    const vx = (d[0] - a[0]) * 1000, vy = (d[1] - a[1]) * height;
    const size = Math.hypot(vx, vy) / (lines.length * 1.3), textWidth = units * size;
    const textHeight = lines.length * size * 1.3;
    if (!textWidth || !textHeight) return null;
    return <g transform={`matrix(${ux / textWidth} ${uy / textWidth} ${vx / textHeight} ${vy / textHeight} ${a[0] * 1000} ${a[1] * height})`}>
      {lines.map((line, i) => <text key={i} x={0} y={size * (0.9 + i * 1.3)} fontFamily="sans-serif" fontSize={size} fill={stroke.color}
        textLength={textUnits(line) * size || undefined} lengthAdjust="spacingAndGlyphs">{line}</text>)}
    </g>;
  }
  const opacity = kindOf(stroke) === "highlighter" ? 0.3 : 1;
  return stroke.points.length === 1
    ? <circle cx={stroke.points[0][0] * 1000} cy={stroke.points[0][1] * height} r={stroke.width * 500} fill={stroke.color} opacity={opacity} />
    : <polyline points={stroke.points.map(([x, y]) => `${x * 1000},${y * height}`).join(" ")} fill="none" stroke={stroke.color}
      strokeWidth={stroke.width * 1000} strokeLinecap="round" strokeLinejoin="round" opacity={opacity} />;
}

export function InkOverlay({ editor, aspectRatio: ratio, onCapture }: { editor: InkEditor; aspectRatio: number; onCapture: (box: Bounds) => void }) {
  const { strokes, tool, color, width, preferences, selectedIds } = editor;
  const active = useRef<Gesture | null>(null);
  const pending = useRef<{ gesture: Gesture; liftedAt: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const live = useRef<SVGPathElement>(null);
  const frame = useRef<number | null>(null);
  const [preview, setPreview] = useState<InkStroke[] | null>(null);
  const [path, setPath] = useState<Point[]>([]);
  const [pointerType, setPointerType] = useState("mouse");
  const [captureBounds, setCaptureBounds] = useState<Bounds | null>(null);
  const [textDraft, setTextDraft] = useState<{ at: Point; text: string; previous?: InkStroke } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const height = 1000 * ratio;
  const interactive = tool === "capture" || (editor.visible && !editor.locked && tool !== "select");
  const eraserRadius = preferences.eraserRadius;
  const cursorSize = eraserRadius * 2 + 4, cursorCenter = eraserRadius + 2;
  const eraserCursor = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${cursorSize}" height="${cursorSize}"><circle cx="${cursorCenter}" cy="${cursorCenter}" r="${eraserRadius}" fill="none" stroke="white" stroke-width="3"/><circle cx="${cursorCenter}" cy="${cursorCenter}" r="${eraserRadius}" fill="none" stroke="black" stroke-width="1"/></svg>`)}") ${cursorCenter} ${cursorCenter}, crosshair`;
  const clearLive = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    live.current?.setAttribute("d", "");
  };
  const paint = (g: Gesture) => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const s = g.stroke!, points = s.points;
      // The live path is isolated from React's saved-stroke tree. No page-wide
      // reconciliation, geometry fitting or storage work on pointermove.
      const d = points.map(([x, y], i) => `${i ? "L" : "M"}${x * 1000},${y * height}`).join(" ");
      live.current?.setAttribute("d", points.length === 1 ? `${d} l0.001,0` : d);
    });
  };
  const commitPending = () => {
    const value = pending.current;
    if (!value) return null;
    clearTimeout(value.timer); pending.current = null;
    const result = resultOf(value.gesture, ratio);
    value.gesture.commit(result); clearLive();
    return result;
  };
  const flushPending = useRef(commitPending);
  flushPending.current = commitPending;
  useLayoutEffect(() => {
    // Flush before toolbar actions, keyboard Undo or export can observe the page.
    const flush = () => { flushPending.current(); };
    editor.beforeCommand.current = flush;
    const outside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) flushPending.current();
    };
    const hidden = () => { if (document.hidden) flushPending.current(); };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      if (editor.beforeCommand.current === flush) editor.beforeCommand.current = null;
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [editor.beforeCommand]);
  useEffect(() => () => {
    const gesture = active.current ?? pending.current?.gesture;
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null; active.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (gesture && !["select", "capture"].includes(gesture.mode) && (gesture.mode === "draw" || gesture.result !== gesture.base)) gesture.commit(resultOf(gesture, ratio));
  }, []);
  const point = (event: { clientX: number; clientY: number }, clamp = true, rect = root.current!.getBoundingClientRect()): Point => {
    const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
    return clamp ? [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))] : [x, y];
  };
  const saveText = () => {
    if (!textDraft || !textDraft.text.trim()) return;
    const previous = textDraft.previous;
    let points = textPoints(textDraft.text, textDraft.at, 0.025, ratio);
    if (previous) {
      const [a, b, , d] = previous.points;
      const fontSize = Math.hypot(d[0] - a[0], (d[1] - a[1]) * ratio) / ((previous.text ?? "").split("\n").length * 1.3);
      const angle = Math.atan2((b[1] - a[1]) * ratio, b[0] - a[0]);
      points = transformInk([{ ...previous, points: textPoints(textDraft.text, a, fontSize, ratio) }], a, 1, angle, [0, 0], ratio)[0].points;
    }
    const item = fitInk([{ id: previous?.id ?? crypto.randomUUID(), color: previous?.color ?? color, width,
      kind: "text", text: textDraft.text, points }], ratio)[0];
    editor.change(previous ? strokes.map(s => s.id === previous.id ? item : s) : [...strokes, item]);
    setTextDraft(null); editor.setTool("region"); editor.setSelectedIds([item.id]);
  };
  const down = (event: PointerEvent<SVGSVGElement>) => {
    if (!interactive || active.current || event.pointerType === "touch" || (event.button !== 0 && event.button !== 5)) return;
    event.preventDefault(); event.stopPropagation();
    // The layer spans the whole PDF page; focusing it must not scroll the page
    // before we measure the pointer position for capture or drawing.
    event.currentTarget.focus({ preventScroll: true });
    window.getSelection()?.removeAllRanges();
    const p = point(event), selection = editor.selection;
    const waiting = pending.current;
    const rect = root.current!.getBoundingClientRect();
    if (waiting && event.button === 0 && canResumeShape({
      kind: kindOf(waiting.gesture.stroke!), pointerType: event.pointerType,
      elapsed: performance.now() - waiting.liftedAt, previous: waiting.gesture.end, next: p,
      width: rect.width, height: rect.height,
    })) {
      clearTimeout(waiting.timer); pending.current = null;
      const g = waiting.gesture;
      g.pointerId = event.pointerId; active.current = g;
      event.currentTarget.setPointerCapture(event.pointerId);
      move(event); return;
    }
    // A new, separate stroke must include the just-committed shape even before
    // React has delivered the updated editor props.
    const base = commitPending() ?? strokes;
    if (tool === "text") {
      const existing = [...strokes].reverse().find(s => kindOf(s) === "text" && hitInk(s, p, 0, ratio));
      setTextDraft({ at: existing?.points[0] ?? p, text: existing?.text ?? "", previous: existing }); return;
    }
    const handle = (event.target as Element).getAttribute("data-ink-handle");
    let mode: Gesture["mode"] = "draw";
    let anchor: Point = p, center: Point = p;
    if (tool === "capture") { mode = "capture"; setCaptureBounds(null); }
    else if (tool === "eraser" || event.button === 5) mode = "erase";
    else if (tool === "region" || tool === "lasso") {
      if (selection && (handle || inBounds(p, selection))) {
        mode = handle === "rotate" ? "rotate" : handle ? "resize" : "move";
        center = [selection.x + selection.width / 2, selection.y + selection.height / 2];
        if (handle && handle !== "rotate") {
          const i = Number(handle);
          anchor = [selection.x + (i === 0 || i === 3 ? selection.width : 0), selection.y + (i < 2 ? selection.height : 0)];
        }
      } else { mode = "select"; editor.setSelectedIds([]); }
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: InkStroke = { id: crypto.randomUUID(), color, width, kind: tool as InkKind, points: [p] };
    const gesture: Gesture = { pointerId: event.pointerId, pointerType: event.pointerType, end: p, mode, start: p, path: [p], base, result: base,
      selected: editor.selected, center, anchor, moved: false, commit: editor.change, stroke: mode === "draw" ? stroke : undefined };
    active.current = gesture;
    if (mode === "draw") {
      live.current?.setAttribute("stroke", color);
      live.current?.setAttribute("stroke-width", String(width * 1000));
      live.current?.setAttribute("opacity", tool === "highlighter" ? "0.3" : "1");
      paint(gesture);
    }
    if (mode === "select" || mode === "capture") setPath([p]);
    if (mode === "erase") {
      gesture.result = eraseInk(base, p, eraserRadius / rect.width, ratio, preferences.partial, preferences.highlightOnly);
      setPreview(gesture.result);
    }
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const g = active.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const rect = root.current!.getBoundingClientRect();
    const p = point(event, !["move", "rotate", "resize"].includes(g.mode), rect);
    g.end = p;
    g.moved ||= Math.hypot(p[0] - g.start[0], (p[1] - g.start[1]) * ratio) > 0.003;
    if (g.mode === "select" || g.mode === "capture") {
      g.path.push(p); setPath([...g.path]); return;
    }
    if (g.mode === "erase") {
      const previous = g.path[g.path.length - 1];
      const radius = eraserRadius / rect.width;
      const steps = Math.max(1, Math.ceil(Math.hypot(p[0] - previous[0], (p[1] - previous[1]) * ratio) / radius));
      for (let i = 1; i <= steps; i++) g.result = eraseInk(g.result, [previous[0] + (p[0] - previous[0]) * i / steps,
        previous[1] + (p[1] - previous[1]) * i / steps], radius, ratio, preferences.partial, preferences.highlightOnly);
      g.path.push(p);
    } else if (g.mode === "draw") {
      const kind = kindOf(g.stroke!);
      if (kind === "pen" || (kind === "highlighter" && !preferences.straight && !event.shiftKey)) {
        const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
        for (const sample of samples.length ? samples : [event]) {
          const next = point(sample, true, rect), previous = g.stroke!.points[g.stroke!.points.length - 1];
          if (Math.hypot(next[0] - previous[0], (next[1] - previous[1]) * ratio) > 0.0004 && g.stroke!.points.length < 20000) g.stroke!.points.push(next);
        }
      } else {
        const end: Point = kind === "highlighter" && event.shiftKey ? [p[0], g.start[1]] : p;
        g.stroke!.points = shapePoints(kind, g.start, end, ratio);
      }
      paint(g); return;
    } else {
      let scale = 1, angle = 0, delta: Point = [0, 0], center = g.center;
      if (g.mode === "move") delta = [p[0] - g.start[0], p[1] - g.start[1]];
      if (g.mode === "rotate") {
        angle = Math.atan2((p[1] - center[1]) * ratio, p[0] - center[0]) - Math.atan2((g.start[1] - center[1]) * ratio, g.start[0] - center[0]);
        if (event.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
        else angle = snapRotation(angle, g.selected, ratio);
      }
      if (g.mode === "resize") {
        center = g.anchor;
        scale = Math.max(0.05, Math.min(20, Math.hypot(p[0] - center[0], (p[1] - center[1]) * ratio) / (Math.hypot(g.start[0] - center[0], (g.start[1] - center[1]) * ratio) || 1)));
      }
      const transformed = new Map(fitInk(transformInk(g.selected, center, scale, angle, delta, ratio), ratio).map(s => [s.id, s]));
      g.result = g.base.map(s => transformed.get(s.id) ?? s);
    }
    setPreview(g.result);
  };
  const finish = (event: PointerEvent<SVGSVGElement>) => {
    const g = active.current;
    if (!g || g.pointerId !== event.pointerId) return;
    if (event.type === "pointerup") move(event);
    active.current = null;
    if (g.mode === "draw" && g.pointerType === "pen" && event.type === "pointerup"
      && ["line", "arrow", "rectangle", "ellipse"].includes(kindOf(g.stroke!))) {
      pending.current = { gesture: g, liftedAt: performance.now(), timer: setTimeout(commitPending, SHAPE_LIFT_GRACE_MS) };
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (g.mode === "select") {
      const hit = [...strokes].reverse().find(s => hitInk(s, g.start, 0.01, ratio));
      editor.setSelectedIds(g.moved ? selectInk(strokes, g.path, tool === "region") : hit ? [hit.id] : []);
    } else if (g.mode === "capture" && event.type === "pointerup") {
      const box = rectBetween(g.start, point(event));
      if (box.width > 0.005 && box.height > 0.005) { setCaptureBounds(box); onCapture(box); }
    } else if (g.mode === "draw" || g.result !== g.base) g.commit(resultOf(g, ratio));
    clearLive();
    setPreview(null); setPath([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const shown = preview ?? strokes;
  const selection = boundsOf(shown.filter(s => selectedIds.includes(s.id)));
  const selecting = tool === "region" || tool === "lasso";
  const rubber = path.length ? rectBetween(path[0], path[path.length - 1]) : null;
  return <div ref={root} className="absolute inset-px z-10" style={{ pointerEvents: "none" }}>
    <svg aria-label="PDF書き込みレイヤー" tabIndex={interactive ? 0 : -1} className="w-full h-full outline-none"
      style={{ pointerEvents: interactive ? "auto" : "none", touchAction: interactive ? "none" : "auto",
        cursor: tool === "pen" || tool === "highlighter" ? pointerType === "pen" ? "none" : "default" : tool === "eraser" ? eraserCursor : selecting ? "default" : "crosshair" }}
      viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none"
      onClick={event => event.stopPropagation()} onContextMenu={event => { if (interactive) { event.preventDefault(); event.stopPropagation(); } }}
      onPointerEnter={event => setPointerType(event.pointerType)}
      onPointerDown={event => { setPointerType(event.pointerType); down(event); }}
      onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
      onDoubleClick={event => {
        if (!selecting) return;
        const p = point(event), item = [...strokes].reverse().find(s => kindOf(s) === "text" && hitInk(s, p, 0, ratio));
        if (item) setTextDraft({ at: item.points[0], text: item.text ?? "", previous: item });
      }}>
      {editor.visible && <InkLayer strokes={shown} ratio={ratio} />}
      <path ref={live} data-ink-preview="true" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "none" }} />
      {tool === "capture" && captureBounds && !path.length && <rect data-image-selection="true"
        x={captureBounds.x * 1000} y={captureBounds.y * height} width={captureBounds.width * 1000} height={captureBounds.height * height}
        stroke="#d97706" fill="#d97706" fillOpacity={0.06} strokeDasharray="8 4" style={{ pointerEvents: "none" }} />}
      {interactive && selecting && selection && <g data-ink-selection="true">
        <rect x={selection.x * 1000 - 3} y={selection.y * height - 3} width={Math.max(6, selection.width * 1000 + 6)} height={Math.max(6, selection.height * height + 6)}
          stroke="#0284c7" strokeWidth={1.5} strokeDasharray="5 3" fill="#0284c7" fillOpacity={0.04} style={{ cursor: "move" }} />
        {[[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y], i) => <circle key={i} data-ink-handle={i} aria-label="サイズ変更"
          cx={(selection.x + x * selection.width) * 1000} cy={(selection.y + y * selection.height) * height} r={7} fill="white" stroke="#0284c7" strokeWidth={2} style={{ cursor: i % 2 ? "nesw-resize" : "nwse-resize" }} />)}
        <line x1={(selection.x + selection.width / 2) * 1000} y1={selection.y * height} x2={(selection.x + selection.width / 2) * 1000} y2={selection.y * height - 28} stroke="#0284c7" />
        <circle data-ink-handle="rotate" aria-label="回転" cx={(selection.x + selection.width / 2) * 1000} cy={selection.y * height - 28} r={8} fill="white" stroke="#0284c7" strokeWidth={2} style={{ cursor: "grab" }} />
      </g>}
      {rubber && (tool === "lasso" ? <polygon points={path.map(([x, y]) => `${x * 1000},${y * height}`).join(" ")} stroke="#0284c7" fill="#0284c7" fillOpacity={0.1} strokeDasharray="5 3" />
        : <rect x={rubber.x * 1000} y={rubber.y * height} width={rubber.width * 1000} height={rubber.height * height} stroke={tool === "capture" ? "#d97706" : "#0284c7"} fill={tool === "capture" ? "#d97706" : "#0284c7"} fillOpacity={0.1} strokeDasharray={tool === "capture" ? "8 4" : "5 3"} />)}
    </svg>
    {textDraft && <div className="absolute z-20 max-w-full"
      style={{ left: `${Math.min(0.5, textDraft.at[0]) * 100}%`, top: `${Math.min(0.65, textDraft.at[1]) * 100}%` }}>
      <AnnotationTextEditor label="書き込みテキスト" value={textDraft.text} onChange={text => setTextDraft({ ...textDraft, text })} onSave={saveText} onCancel={() => setTextDraft(null)} />
    </div>}
  </div>;
}
