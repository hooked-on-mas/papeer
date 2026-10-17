import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Trash2 } from "lucide-react";
import { boundsOf, constrainedShapeEnd, eraseInk, fitInk, hitInk, hitShape, inBounds, isShape, kindOf, rectBetween, reshapeShape, selectInk, SHAPE_KINDS, shapeHandleCursor, shapeHandles, shapePoints, snapRotation, textPoints, textUnits, transformInk,
  type Bounds, type InkKind, type InkStroke, type Point, type ShapeHit } from "./inkGeometry";
import type { InkEditor } from "./useInkEditor";
import { AnnotationTextEditor } from "./AnnotationTextEditor";
import { canResumeShape, inkChanged, LONG_PRESS_MS, LONG_PRESS_SLOP_PX, mayEditSelectedShape, pressTarget, shapeToolTarget, SHAPE_LIFT_GRACE_MS } from "./inkInteraction";
import { useOpenEdit } from "@/lib/pendingSaves";
import { usePdfTouchOwner } from "./usePdfTouch";
export type { InkTool } from "./inkGeometry";

type Gesture = {
  pointerId: number; mode: "draw" | "erase" | "select" | "capture" | "move" | "resize" | "rotate" | "reshape";
  start: Point; path: Point[]; base: InkStroke[]; result: InkStroke[]; selected: InkStroke[];
  stroke?: InkStroke; center: Point; anchor: Point; moved: boolean; commit: (strokes: InkStroke[]) => void;
  pointerType: string; end: Point; target?: InkStroke; hit?: ShapeHit; clickTarget?: InkStroke;
};

/** How an ink colour shows over the page, e.g. lightened over a page inverted for the dark theme. */
type InkColor = (color: string) => string;
const asPicked: InkColor = color => color;

/** Cursor for the selected shape's editable parts. */
function hoverCursor(stroke: InkStroke, hit: ShapeHit, ratio: number) {
  if (hit.part === "body") return "move";
  if (hit.part === "rim") return "nwse-resize";
  return shapeHandleCursor(stroke, hit.index, ratio);
}

// Keep the rotation handle inside the page, below a shape that is too close to the top.
const ROTATE_STEM = 28, ROTATE_REACH = 16;
const rotationHandle = (box: Bounds, height: number): { point: Point; edge: number } => {
  const above = box.y * height >= ROTATE_STEM + ROTATE_REACH;
  const edge = above ? box.y : box.y + box.height;
  const y = Math.max(ROTATE_REACH, Math.min(height - ROTATE_REACH, edge * height + (above ? -ROTATE_STEM : ROTATE_STEM)));
  return { point: [box.x + box.width / 2, y / height], edge };
};
const onRotateHandle = (box: Bounds, p: Point, height: number) => {
  const [x, y] = rotationHandle(box, height).point;
  return Math.hypot((p[0] - x) * 1000, (p[1] - y) * height) <= ROTATE_REACH;
};

const InkLayer = memo(function InkLayer({ strokes, ratio, inkColor }: { strokes: InkStroke[]; ratio: number; inkColor: InkColor }) {
  return <>{strokes.map(stroke => <g key={stroke.id} data-ink-id={stroke.id} data-ink-kind={kindOf(stroke)} style={{ pointerEvents: "none" }}><InkDrawing stroke={stroke} ratio={ratio} inkColor={inkColor} /></g>)}</>;
});

const resultOf = (g: Gesture, ratio: number) => g.mode === "draw"
  ? [...g.base, ...fitInk([g.stroke!], ratio)] : g.result;

export function InkDrawing({ stroke, ratio, inkColor = asPicked }: { stroke: InkStroke; ratio: number; inkColor?: InkColor }) {
  const height = 1000 * ratio;
  const color = inkColor(stroke.color);
  if (kindOf(stroke) === "text") {
    const [a, b, , d] = stroke.points;
    const lines = (stroke.text ?? "").split("\n"), units = Math.max(1, ...lines.map(textUnits));
    const ux = (b[0] - a[0]) * 1000, uy = (b[1] - a[1]) * height;
    const vx = (d[0] - a[0]) * 1000, vy = (d[1] - a[1]) * height;
    const size = Math.hypot(vx, vy) / (lines.length * 1.3), textWidth = units * size;
    const textHeight = lines.length * size * 1.3;
    if (!textWidth || !textHeight) return null;
    return <g transform={`matrix(${ux / textWidth} ${uy / textWidth} ${vx / textHeight} ${vy / textHeight} ${a[0] * 1000} ${a[1] * height})`}>
      {lines.map((line, i) => <text key={i} x={0} y={size * (0.9 + i * 1.3)} fontFamily="sans-serif" fontSize={size} fill={color}
        textLength={textUnits(line) * size || undefined} lengthAdjust="spacingAndGlyphs">{line}</text>)}
    </g>;
  }
  const opacity = kindOf(stroke) === "highlighter" ? 0.3 : 1;
  return stroke.points.length === 1
    ? <circle cx={stroke.points[0][0] * 1000} cy={stroke.points[0][1] * height} r={stroke.width * 500} fill={color} opacity={opacity} />
    : <polyline points={stroke.points.map(([x, y]) => `${x * 1000},${y * height}`).join(" ")} fill="none" stroke={color}
      strokeWidth={stroke.width * 1000} strokeLinecap="round" strokeLinejoin="round" opacity={opacity} />;
}

/**
 * `pageMenu`: the page has a menu of its own (the notebook's), which a right click that opens none of the
 * layer's own menu (the 削除 over the writing selected) is left to reach, whichever tool is picked.
 */
export function InkOverlay({ editor, aspectRatio: ratio, inkColor = asPicked, onCapture, pageMenu = false }: { editor: InkEditor; aspectRatio: number; inkColor?: InkColor; onCapture: (box: Bounds) => void; pageMenu?: boolean }) {
  const { strokes, tool, color, width, preferences, selectedIds } = editor;
  const active = useRef<Gesture | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pending = useRef<{ gesture: Gesture; liftedAt: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const live = useRef<SVGPathElement>(null);
  const frame = useRef<number | null>(null);
  const [preview, setPreview] = useState<InkStroke[] | null>(null);
  const [path, setPath] = useState<Point[]>([]);
  const [pointerType, setPointerType] = useState("mouse");
  const [captureBounds, setCaptureBounds] = useState<Bounds | null>(null);
  const [hoverCursorValue, setHoverCursorValue] = useState<string | null>(null);
  const [menu, setMenu] = useState<Point | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; id: number; x: number; y: number } | null>(null);
  const [textDraft, setTextDraft] = useState<{ at: Point; text: string; previous?: InkStroke } | null>(null);
  useOpenEdit(!!textDraft, "書き込みテキスト");
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
  const clearLiveNow = useRef(clearLive);
  clearLiveNow.current = clearLive;
  const cancelActive = () => {
    const g = active.current;
    if (!g) return;
    // Clear first: releasing capture can synchronously dispatch lostpointercapture.
    active.current = null;
    if (svg.current?.hasPointerCapture(g.pointerId)) svg.current.releasePointerCapture(g.pointerId);
    clearLiveNow.current(); setPreview(null); setPath([]);
  };
  const cancelActiveNow = useRef(cancelActive);
  cancelActiveNow.current = cancelActive;
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
    if (SHAPE_KINDS.includes(kindOf(value.gesture.stroke!))) editor.setSelectedIds([value.gesture.stroke!.id]);
    return result;
  };
  useLayoutEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      const g = active.current;
      if (event.key !== "Escape" || !g) return;
      event.preventDefault(); event.stopImmediatePropagation();
      cancelActiveNow.current();
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, []);
  const flushPending = useRef(commitPending);
  flushPending.current = commitPending;
  useLayoutEffect(() => {
    // Commands act on saved ink. A held pointer must not later overwrite their result.
    const beforeCommand = () => { cancelActiveNow.current(); flushPending.current(); };
    const flush = () => { flushPending.current(); };
    editor.beforeCommand.current = beforeCommand;
    const outside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) flushPending.current();
    };
    const hidden = () => { if (document.hidden) flushPending.current(); };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      if (editor.beforeCommand.current === beforeCommand) editor.beforeCommand.current = null;
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
    if (gesture && !["select", "capture"].includes(gesture.mode)
      && (gesture.mode === "draw" ? !SHAPE_KINDS.includes(kindOf(gesture.stroke!)) || gesture.moved : inkChanged(gesture.base, gesture.result)))
      gesture.commit(resultOf(gesture, ratio));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on unmount only: with ratio, a change of it would commit the gesture in progress
  }, []);
  const point = (event: { clientX: number; clientY: number }, clamp = true, rect = root.current!.getBoundingClientRect()): Point => {
    const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
    return clamp ? [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))] : [x, y];
  };
  // Right-click, or a long press with a finger or Pencil, offers 削除 for the selection (or the writing pressed).
  const openMenu = (p: Point): boolean => {
    if (tool !== "region" && tool !== "lasso") return false;
    const ids = pressTarget(strokes, selectedIds, p, ratio);
    if (!ids) { setMenu(null); return false; }
    if (ids !== selectedIds) editor.setSelectedIds(ids);
    setMenu(p);
    return true;
  };
  const openMenuNow = useRef(openMenu);
  openMenuNow.current = openMenu;
  const cancelPress = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };
  const startPress = (event: PointerEvent<SVGSVGElement>) => {
    cancelPress();
    if (event.pointerType === "mouse" || event.button !== 0 || !interactive || (tool !== "region" && tool !== "lasso")) return;
    const p = point(event);
    press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, timer: setTimeout(() => { press.current = null; openMenuNow.current(p); }, LONG_PRESS_MS) };
  };
  const movePress = (event: PointerEvent<SVGSVGElement>) => {
    const waiting = press.current;
    if (waiting && waiting.id === event.pointerId && Math.hypot(event.clientX - waiting.x, event.clientY - waiting.y) > LONG_PRESS_SLOP_PX) cancelPress();
  };
  useEffect(() => {
    // Capture may move to the PDF before the SVG ever receives gotpointercapture,
    // so lostpointercapture alone cannot cancel a two-finger long press.
    const unsubscribe = usePdfTouchOwner.subscribe(({ pane }) => {
      if (pane?.contains(root.current) && press.current) {
        clearTimeout(press.current.timer); press.current = null;
      }
    });
    return () => { unsubscribe(); if (press.current) clearTimeout(press.current.timer); };
  }, []);
  useEffect(() => { if (!selectedIds.length) setMenu(null); }, [selectedIds.length]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("wheel", close, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("wheel", close, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [menu]);
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
    const shapeHandle = (event.target as Element).getAttribute("data-shape-handle");
    const shapeScale = (event.target as Element).getAttribute("data-shape-scale");
    let mode: Gesture["mode"] = "draw";
    let anchor: Point = p, center: Point = p;
    let target: InkStroke | undefined, hit: ShapeHit | undefined, moving: InkStroke | undefined, clickTarget: InkStroke | undefined;
    const tolerance = Math.max(0.01, 10 / rect.width);
    if (tool === "capture") { mode = "capture"; setCaptureBounds(null); }
    else if (tool === "eraser" || event.button === 5) mode = "erase";
    else if (tool === "region" || tool === "lasso") {
      const only = editor.selected.length === 1 && isShape(editor.selected[0]) ? editor.selected[0] : undefined;
      const onShape = only && handle !== "rotate" ? hitShape(only, p, tolerance, ratio) : null;
      if (only && (shapeScale !== null || shapeHandle !== null || onShape && onShape.part !== "body")) {
        mode = "reshape"; target = only; hit = shapeScale !== null ? { part: "rim" }
          : shapeHandle !== null ? { part: "handle", index: Number(shapeHandle) } : onShape!;
      }
      else if (selection && (handle || inBounds(p, selection))) {
        mode = handle === "rotate" ? "rotate" : handle ? "resize" : "move";
        center = [selection.x + selection.width / 2, selection.y + selection.height / 2];
        if (handle && handle !== "rotate") {
          const i = Number(handle);
          anchor = [selection.x + (i === 0 || i === 3 ? selection.width : 0), selection.y + (i < 2 ? selection.height : 0)];
        }
      } else { mode = "select"; editor.setSelectedIds([]); }
    } else if (SHAPE_KINDS.includes(tool)) {
      const picked = shapeToolTarget(base, selectedIds.length === 1 ? selectedIds[0] : undefined, tool as InkKind, p, tolerance, ratio);
      clickTarget = picked.clickTarget;
      if (mayEditSelectedShape(picked, event.altKey, shapeScale !== null || shapeHandle !== null || handle === "rotate") && picked.selected) {
        const box = boundsOf([picked.selected])!;
        if (handle === "rotate" || onRotateHandle(box, p, height)) {
          mode = "rotate"; moving = picked.selected;
          center = [box.x + box.width / 2, box.y + box.height / 2];
        } else if (shapeScale !== null || shapeHandle !== null || picked.hit) {
          const found: ShapeHit = shapeScale !== null ? { part: "rim" }
            : shapeHandle !== null ? { part: "handle", index: Number(shapeHandle) } : picked.hit!;
          if (found.part === "body") { mode = "move"; moving = picked.selected; }
          else { mode = "reshape"; target = picked.selected; hit = found; }
        }
      }
      if (mode === "draw") setHoverCursorValue(null);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: InkStroke = { id: crypto.randomUUID(), color, width, kind: tool as InkKind, points: [p],
      ...(tool === "arrow" ? { arrowHeadLength: 0.025 } : {}) };
    const gesture: Gesture = { pointerId: event.pointerId, pointerType: event.pointerType, end: p, mode, start: p, path: [p], base, result: base,
      selected: moving ? [moving] : editor.selected, center, anchor, moved: false, commit: editor.change, stroke: mode === "draw" ? stroke : undefined, target, hit, clickTarget };
    active.current = gesture;
    if (mode === "draw") {
      live.current?.setAttribute("stroke", inkColor(color));
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
    if (!g.moved && (SHAPE_KINDS.includes(tool) || ["move", "rotate", "resize", "reshape"].includes(g.mode))) return;
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
        const end: Point = kind === "highlighter" && event.shiftKey ? [p[0], g.start[1]]
          : event.shiftKey ? constrainedShapeEnd(kind, g.start, p, ratio) : p;
        g.stroke!.points = shapePoints(kind, g.start, end, ratio);
      }
      paint(g); return;
    } else if (g.mode === "reshape") {
      let end = p;
      const shapeHit = g.hit;
      if (event.shiftKey && shapeHit?.part === "handle" && (kindOf(g.target!) === "line" || kindOf(g.target!) === "arrow")) {
        const opposite = g.target!.points[1 - shapeHit.index], handle = g.target!.points[shapeHit.index];
        const target: Point = [handle[0] + p[0] - g.start[0], handle[1] + p[1] - g.start[1]];
        const snapped = constrainedShapeEnd(kindOf(g.target!), opposite, target, ratio);
        end = [g.start[0] + snapped[0] - handle[0], g.start[1] + snapped[1] - handle[1]];
      }
      const next = reshapeShape(g.target!, g.hit!, g.start, end, ratio, event.shiftKey);
      g.result = g.base.map(s => s.id === next.id ? next : s);
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
    const shapeDraw = g.mode === "draw" && SHAPE_KINDS.includes(kindOf(g.stroke!));
    const shapeHasSize = Math.hypot(g.end[0] - g.start[0], (g.end[1] - g.start[1]) * ratio) > 0.003;
    if (shapeDraw && shapeHasSize && g.pointerType === "pen" && event.type === "pointerup") {
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
    } else if (shapeDraw && !shapeHasSize && event.type === "pointerup") {
      editor.setSelectedIds(g.clickTarget ? [g.clickTarget.id] : []);
    } else if ((g.mode === "draw" && (!shapeDraw || shapeHasSize)) || inkChanged(g.base, g.result)) {
      g.commit(resultOf(g, ratio));
      if (g.mode === "draw" && SHAPE_KINDS.includes(kindOf(g.stroke!))) editor.setSelectedIds([g.stroke!.id]);
    }
    clearLive();
    setPreview(null); setPath([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const hoverAt = (event: PointerEvent<SVGSVGElement>) => {
    if (active.current) return;
    let next: string | null = null;
    if (interactive && SHAPE_KINDS.includes(tool)) {
      const rect = root.current!.getBoundingClientRect(), p = point(event, true, rect), tolerance = Math.max(0.01, 10 / rect.width);
      const picked = shapeToolTarget(strokes, selectedIds.length === 1 ? selectedIds[0] : undefined, tool as InkKind, p, tolerance, ratio);
      const explicitHandle = (event.target as Element).getAttribute("data-shape-handle");
      const explicitScale = (event.target as Element).getAttribute("data-shape-scale");
      const explicitRotate = (event.target as Element).getAttribute("data-ink-handle") === "rotate";
      if (mayEditSelectedShape(picked, event.altKey, explicitScale !== null || explicitHandle !== null || explicitRotate) && picked.selected) {
        const box = boundsOf([picked.selected])!;
        if (explicitRotate || onRotateHandle(box, p, height)) next = "grab";
        else if (explicitScale !== null) next = Number(explicitScale) % 2 ? "nesw-resize" : "nwse-resize";
        else if (explicitHandle !== null) next = shapeHandleCursor(picked.selected, Number(explicitHandle), ratio);
        else if (picked.hit) next = hoverCursor(picked.selected, picked.hit, ratio);
      }
    }
    setHoverCursorValue(now => now === next ? now : next);
  };
  const shown = preview ?? strokes;
  const selection = boundsOf(shown.filter(s => selectedIds.includes(s.id)));
  const selecting = tool === "region" || tool === "lasso";
  const single = selectedIds.length === 1 ? shown.find(s => s.id === selectedIds[0]) : undefined;
  const editing = single && isShape(single) ? single : null;
  const showSelection = selecting || !!(editing && kindOf(editing) === tool);
  const turning = selection ? rotationHandle(selection, height) : null;
  const rubber = path.length ? rectBetween(path[0], path[path.length - 1]) : null;
  return <div ref={root} className="absolute inset-px z-10" style={{ pointerEvents: "none" }}>
    <svg ref={svg} aria-label="PDF書き込みレイヤー" tabIndex={interactive ? 0 : -1} className="w-full h-full outline-none"
      style={{ pointerEvents: interactive ? "auto" : "none", touchAction: interactive ? "none" : "auto",
        cursor: hoverCursorValue && SHAPE_KINDS.includes(tool) ? hoverCursorValue : tool === "pen" || tool === "highlighter" ? pointerType === "pen" ? "none" : "default" : tool === "eraser" ? eraserCursor : selecting ? "default" : "crosshair" }}
      viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none"
      onClick={event => event.stopPropagation()} onContextMenu={event => {
        if (!interactive) return;
        const opened = openMenu(point(event));
        // The page's menu takes a right click that opens none of the layer's own (and prevents the browser's itself).
        if (pageMenu && !opened) return;
        event.preventDefault(); event.stopPropagation();
      }}
      onPointerEnter={event => setPointerType(event.pointerType)}
      onPointerDown={event => { setPointerType(event.pointerType); startPress(event); down(event); }}
      onPointerMove={event => { movePress(event); move(event); hoverAt(event); }} onPointerLeave={() => setHoverCursorValue(null)}
      onPointerUp={event => { cancelPress(); finish(event); }} onPointerCancel={event => { cancelPress(); finish(event); }} onLostPointerCapture={finish}
      onDoubleClick={event => {
        if (!selecting) return;
        const p = point(event), item = [...strokes].reverse().find(s => kindOf(s) === "text" && hitInk(s, p, 0, ratio));
        if (item) setTextDraft({ at: item.points[0], text: item.text ?? "", previous: item });
      }}>
      {editor.visible && <InkLayer strokes={shown} ratio={ratio} inkColor={inkColor} />}
      <path ref={live} data-ink-preview="true" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: "none" }} />
      {tool === "capture" && captureBounds && !path.length && <rect data-image-selection="true"
        x={captureBounds.x * 1000} y={captureBounds.y * height} width={captureBounds.width * 1000} height={captureBounds.height * height}
        stroke="#d97706" fill="#d97706" fillOpacity={0.06} strokeDasharray="8 4" style={{ pointerEvents: "none" }} />}
      {interactive && showSelection && selection && turning && <g data-ink-selection="true">
        <rect x={selection.x * 1000 - 3} y={selection.y * height - 3} width={Math.max(6, selection.width * 1000 + 6)} height={Math.max(6, selection.height * height + 6)}
          stroke="#0284c7" strokeWidth={1.5} strokeDasharray="5 3" fill="#0284c7" fillOpacity={0.04} style={{ cursor: selecting ? "move" : undefined }} />
        {editing ? shapeHandles(editing).map(([x, y], i) => <circle key={i} data-shape-handle={i} aria-label="形を変更"
          cx={x * 1000} cy={y * height} r={7} fill="white" stroke="#0284c7" strokeWidth={2} style={{ cursor: selecting ? hoverCursor(editing, { part: "handle", index: i }, ratio) : undefined }} />)
          : [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y], i) => <circle key={i} data-ink-handle={i} aria-label="サイズ変更"
            cx={(selection.x + x * selection.width) * 1000} cy={(selection.y + y * selection.height) * height} r={7} fill="white" stroke="#0284c7" strokeWidth={2} style={{ cursor: i % 2 ? "nesw-resize" : "nwse-resize" }} />)}
        {editing && kindOf(editing) === "ellipse" && [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y], i) => {
          const px = Math.max(6, Math.min(994, (selection.x + x * selection.width) * 1000 + (x ? 12 : -12)));
          const py = Math.max(6, Math.min(height - 6, (selection.y + y * selection.height) * height + (y ? 12 : -12)));
          return <rect key={i} data-shape-scale={i} aria-label="全体を拡大縮小"
            x={px - 6} y={py - 6} width={12} height={12} rx={2} fill="white" stroke="#0284c7" strokeWidth={2}
            style={{ cursor: selecting ? i % 2 ? "nesw-resize" : "nwse-resize" : undefined }} />;
        })}
        <line x1={turning.point[0] * 1000} y1={turning.edge * height} x2={turning.point[0] * 1000} y2={turning.point[1] * height} stroke="#0284c7" />
        <circle data-ink-handle="rotate" aria-label="回転" cx={turning.point[0] * 1000} cy={turning.point[1] * height} r={8} fill="white" stroke="#0284c7" strokeWidth={2} style={{ cursor: "grab" }} />
      </g>}
      {rubber && (tool === "lasso" ? <polygon points={path.map(([x, y]) => `${x * 1000},${y * height}`).join(" ")} stroke="#0284c7" fill="#0284c7" fillOpacity={0.1} strokeDasharray="5 3" />
        : <rect x={rubber.x * 1000} y={rubber.y * height} width={rubber.width * 1000} height={rubber.height * height} stroke={tool === "capture" ? "#d97706" : "#0284c7"} fill={tool === "capture" ? "#d97706" : "#0284c7"} fillOpacity={0.1} strokeDasharray={tool === "capture" ? "8 4" : "5 3"} />)}
    </svg>
    {menu && selectedIds.length > 0 && <div ref={menuRef} role="menu" aria-label="書き込みのメニュー"
      className="absolute z-30 min-w-32 rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
      style={{ left: `${menu[0] * 100}%`, top: `${menu[1] * 100}%`, pointerEvents: "auto",
        transform: `translate(${menu[0] > 0.75 ? "-100%" : "0"}, ${menu[1] > 0.85 ? "-100%" : "0"})` }}
      onPointerDown={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
      <button role="menuitem" autoFocus className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-destructive outline-hidden hover:bg-destructive/10 focus:bg-destructive/10"
        onClick={() => { setMenu(null); editor.beforeCommand.current?.(); editor.remove(); }}>
        <Trash2 aria-hidden="true" className="size-4" />{selectedIds.length > 1 ? `削除（${selectedIds.length}件）` : "削除"}
      </button>
    </div>}
    {textDraft && <div className="absolute z-20 max-w-full"
      style={{ left: `${Math.min(0.5, textDraft.at[0]) * 100}%`, top: `${Math.min(0.65, textDraft.at[1]) * 100}%` }}>
      <AnnotationTextEditor label="書き込みテキスト" value={textDraft.text} onChange={text => setTextDraft({ ...textDraft, text })} onSave={saveText} onCancel={() => setTextDraft(null)} />
    </div>}
  </div>;
}
