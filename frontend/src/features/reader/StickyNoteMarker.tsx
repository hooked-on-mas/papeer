import { useRef, useState, type PointerEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { StickyNote as StickyIcon } from "lucide-react";
import { apiRequest } from "@/api/client";
import { showError } from "@/components/errorDialog";
import { noteDraft, stickyColors, stickyQuote, type StickyNote } from "./stickyNotes";
import { deleteStickyNote, openStickyNote, useStickyNotes } from "./stickyNotesStore";
import { useStore } from "@/store";
import { QK } from "@/lib/queryKeys";

type Position = { anchor_x: number; anchor_y: number };
export function StickyNoteMarker({ item, movable }: { item: StickyNote; movable: boolean }) {
  const client = useQueryClient();
  const selected = useStickyNotes(s => s.selectedId === item.id);
  const [position, setPosition] = useState<Position | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const drag = useRef<{ id: number; x: number; y: number; width: number; height: number;
    start: Position; maxX: number; maxY: number; moved: boolean; next: Position } | null>(null);
  const save = async (next: Position) => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setPosition(next);
    try {
      const saved = await apiRequest<StickyNote>("PATCH", `/api/papers/${item.paper_id}/sticky-notes/${item.id}`,
        { label: item.label, note: item.note, ...next });
      client.setQueriesData<StickyNote[]>({ queryKey: [QK.stickyNotes] }, notes => notes?.map(note => note.id === saved.id ? { ...note, ...saved } : note));
      await client.invalidateQueries({ queryKey: [QK.stickyNotes] });
    } catch (error) { showError(error, "付箋を移動できませんでした"); }
    finally { busy.current = false; setSaving(false); setPosition(null); }
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const g = drag.current;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.x, dy = event.clientY - g.y;
    g.moved ||= Math.hypot(dx, dy) > 3;
    if (!g.moved) return;
    g.next = { anchor_x: Math.max(0, Math.min(g.maxX, g.start.anchor_x + dx / g.width)),
      anchor_y: Math.max(0, Math.min(g.maxY, g.start.anchor_y + dy / g.height)) };
    setPosition(g.next);
  };
  const finish = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const g = drag.current;
    if (!g || g.id !== event.pointerId) return;
    if (!cancel) move(event);
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel && g.moved) void save(g.next);
    else setPosition(null);
  };
  const current = position ?? item;
  const excerpt = item.note.trim() || stickyQuote(item.quote).trim();
  // In rem like its text, so that the marker grows with the UI size (lib/uiScale.ts) instead of cutting it off.
  const markerHeight = excerpt ? "4.5rem" : "2rem";
  return <button data-sticky-note aria-label={`付箋：${item.label} ${item.note || stickyQuote(item.quote)}`} aria-pressed={selected}
    aria-busy={saving} title={`${item.label}${excerpt ? `：${excerpt}` : ""}\nドラッグで移動・ダブルクリックで編集・Deleteで削除`}
    className={`absolute z-20 overflow-hidden rounded border px-2 py-1.5 text-left shadow-sm select-none ${stickyColors[item.label] ?? stickyColors["重要"]} ${selected ? "ring-2 ring-primary ring-offset-1" : ""}`}
    style={{ width: "min(10rem, 100%)", height: markerHeight,
      top: `max(0px, min(calc(100% - ${markerHeight}), ${current.anchor_y * 100}%))`, left: `max(0px, min(calc(100% - 10rem), ${(current.anchor_x ?? 0) * 100}%))`,
      touchAction: movable ? "none" : "auto", cursor: movable ? (position ? "grabbing" : "grab") : "pointer" }}
    onClick={event => { event.stopPropagation(); useStickyNotes.setState({ selectedId: item.id }); }}
    onDoubleClick={event => { event.stopPropagation(); if (!busy.current) void openStickyNote(noteDraft(item)); }}
    onPointerDown={event => {
      event.stopPropagation();
      if (event.button !== 0 || !movable || busy.current) return;
      const rect = event.currentTarget.parentElement!.getBoundingClientRect();
      const marker = event.currentTarget.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      event.preventDefault(); event.currentTarget.focus();
      useStickyNotes.setState({ selectedId: item.id });
      const start = { anchor_x: (marker.left - rect.left) / rect.width, anchor_y: (marker.top - rect.top) / rect.height };
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, height: rect.height,
        start, next: start, moved: false, maxX: Math.max(0, 1 - marker.width / rect.width), maxY: Math.max(0, 1 - marker.height / rect.height) };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); if (!busy.current) void openStickyNote(noteDraft(item)); }
      if (event.key === "Escape") { drag.current = null; setPosition(null); useStickyNotes.setState({ selectedId: null }); }
      if ((event.key === "Delete" || event.key === "Backspace") && !drag.current && !busy.current) {
        event.preventDefault();
        deleteStickyNote(item, client).then(ok => { if (ok) useStore.getState().setStatus("付箋を削除しました。付箋タブの「削除を取り消す」で戻せます。"); },
          error => showError(error, "付箋を削除できませんでした"));
      }
    }}>
    <span className="flex items-center gap-1 text-[0.75rem] font-semibold leading-4">
      <StickyIcon aria-hidden="true" className="size-3 shrink-0" /><span className="truncate">{item.label}</span>
    </span>
    {excerpt && <span className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs font-normal leading-4 [overflow-wrap:anywhere]">{excerpt}</span>}
  </button>;
}
