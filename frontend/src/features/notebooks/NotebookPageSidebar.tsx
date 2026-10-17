import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { ChevronRight, Plus } from "lucide-react";
import { api, unwrap } from "@/api/client";
import { QK } from "@/lib/queryKeys";
import { onAppEvent } from "@/lib/appEvents";
import { useStore } from "@/store";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { InkDrawing } from "@/features/reader/InkOverlay";
import { notebookDraftInk, type InkStroke } from "@/features/reader/inkStore";
import { PaperPreview } from "./PaperSettings";
import { NotebookPageMenuItems, useMouseOnlyMenu } from "./NotebookPageMenu";
import { rowHeight, SIDEBAR_WIDTH, tabPosition, TAB_WIDTH, thumbnailSize, type SidebarPlacement } from "./pageSidebar";
import { usePageActions } from "./useNotebookPageActions";
import { useNotebookBusy, type NotebookDocument, type NotebookPage } from "./notebooks";

/** How long the pointer may be off an opened tab before it folds again, so that a quick slip does not close it. */
const LEAVE_MS = 250;

function Thumbnail({ page, number, active, strokes, select, onMenuOpen, onFocusChange }: {
  page: NotebookPage; number: number; active: boolean; strokes: InkStroke[]; select: () => void; onMenuOpen: (open: boolean) => void;
  /** The thumbnail took the focus (true), or lost it (false). */
  onFocusChange: (focused: boolean) => void;
}) {
  const actions = usePageActions();
  const { busy } = actions;
  const drag = useDraggable({ id: page.id, disabled: busy });
  const drop = useDroppable({ id: page.id, disabled: busy });
  const mouse = useMouseOnlyMenu();
  const ratio = page.height_mm / page.width_mm;
  const size = thumbnailSize(ratio);
  return <ContextMenu disabled={busy} onOpenChange={(open, details) => { if (mouse.allows(open, details)) onMenuOpen(open); }}>
    <ContextMenuTrigger ref={drop.setNodeRef} onPointerDownCapture={mouse.remember}
      className={`flex justify-center rounded ${drop.isOver ? "outline-2 outline-primary" : ""}`}>
      <button ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners} disabled={busy} onClick={select}
        aria-label={`ページ ${number}`} aria-current={active ? "page" : undefined} data-page-id={page.id}
        onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)}
        title="クリックで移動、ドラッグまたはAltと上下キーで並べ替え、右クリックでページの操作"
        onKeyDown={(e) => {
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); void actions.shift(page.id, e.key === "ArrowUp" ? -1 : 1); }
          else drag.listeners?.onKeyDown?.(e);
        }}
        className={`flex flex-col items-center gap-0.5 rounded p-1 text-xs touch-none focus-visible:outline-2 focus-visible:outline-ring ${active ? "bg-accent ring-2 ring-primary" : "hover:bg-muted"} ${drag.isDragging ? "opacity-40" : ""}`}>
        <span className="relative block" style={{ width: size.width, height: size.height }}>
          <PaperPreview paper={page} className="absolute inset-0 h-full w-full" />
          <svg viewBox={`0 0 1000 ${1000 * ratio}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
            {strokes.map((stroke) => <InkDrawing key={stroke.id} stroke={stroke} ratio={ratio} />)}
          </svg>
        </span>
        <span className="tabular-nums text-muted-foreground">{number}</span>
      </button>
    </ContextMenuTrigger>
    <ContextMenuContent className="w-64">
      <ContextMenuItem onClick={select}><ChevronRight /> このページへ移動</ContextMenuItem>
      <ContextMenuSeparator />
      <NotebookPageMenuItems pageId={page.id} />
    </ContextMenuContent>
  </ContextMenu>;
}

/**
 * The notebook's pages as a column of thumbnails (written-on, the current one framed), with 「＋ ページを
 * 追加」 at its foot. In the room beside the paper (`placement` "margin") it is always there; without room
 * it is a thin tab at the view's left edge that opens over the paper when the mouse is put on it, or it is
 * pressed (or tapped), and folds again on choosing a page, on writing, or on a press anywhere else. It is
 * laid over the view, never beside the paper, so that it does not take room from what is written on.
 */
export function NotebookPageSidebar({ paperId, notebook, placement }: { paperId: string; notebook: NotebookDocument; placement: SidebarPlacement }) {
  const actions = usePageActions();
  const { busy } = actions;
  const current = useStore((s) => s.currentPage);
  const count = notebook.pages.length;
  const [open, setOpen] = useState(false);
  const shown = placement === "margin" || open;
  const root = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  // Opened by a press, so it stays until something else is done; opened by the mouse alone, it folds as the mouse leaves.
  const pinned = useRef(false);
  const menuOpen = useRef(false);
  const dragging = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusOnOpen = useRef(false);
  // The thumbnail the keyboard is on: the buttons are disabled while a change is under way, which takes the
  // focus off the one being moved, so that the next Alt+↑↓ would have nothing to act on; it is put back after.
  const focusedPage = useRef<string | null>(null);

  useEffect(() => { if (placement === "margin") { setOpen(false); pinned.current = false; } }, [placement]);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const fold = () => { clearTimeout(leaveTimer.current); pinned.current = false; setOpen(false); };

  // A press anywhere else, which includes starting to write, and Escape fold the opened tab.
  useEffect(() => {
    if (placement !== "tab" || !open) return;
    const outside = (event: PointerEvent) => {
      if (menuOpen.current || (event.target instanceof Node && root.current?.contains(event.target))) return;
      fold();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !menuOpen.current) fold(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [placement, open]);

  // The drawings on the thumbnails: the saved writing, with the drafts not saved yet laid over it.
  const [, redrawInk] = useState(0);
  useEffect(() => onAppEvent("ink-changed", (event) => { if (event.paperId === paperId) redrawInk((value) => value + 1); }), [paperId]);
  const { data: savedInk = {} } = useQuery({
    queryKey: [QK.inkPages, paperId, "notebook"], enabled: shown,
    queryFn: () => unwrap(api.GET("/api/notebooks/{notebook_id}/ink", { params: { path: { notebook_id: paperId } } })),
  });

  const virtual = useVirtualizer({
    count, getScrollElement: () => scroll.current, overscan: 4, enabled: shown,
    estimateSize: (index) => { const page = notebook.pages[index]; return rowHeight(page ? page.height_mm / page.width_mm : Math.SQRT2); },
  });
  // The rows are sized from the pages' shapes, which the virtualizer reads again only when told to: a page
  // moved or given another paper would otherwise leave rows of the old heights overlapping.
  const shapes = notebook.pages.map((item) => `${item.id}:${item.width_mm}x${item.height_mm}`).join(",");
  useEffect(() => { virtual.measure(); }, [shapes, virtual]);
  useEffect(() => { if (shown) virtual.scrollToIndex(current - 1, { align: "auto" }); }, [current, virtual, shown]);
  // Pressing the tab with the keyboard puts the focus on the current page's thumbnail.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[aria-current=page]")?.focus());
  }, [open]);

  useEffect(() => {
    if (busy || !focusedPage.current) return;
    const id = focusedPage.current;
    if (document.activeElement && document.activeElement !== document.body) return;
    root.current?.querySelector<HTMLElement>(`[data-page-id="${id}"]`)?.focus({ preventScroll: true });
  }, [busy, shapes]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));
  const choose = (number: number) => { useStore.getState().setCurrentPage(number); if (placement === "tab") fold(); };

  const mouseEnter = (event: React.PointerEvent) => {
    clearTimeout(leaveTimer.current);
    // Only the mouse opens it by being put there: a pen that is writing, or a finger, opens it by pressing.
    if (placement === "tab" && !open && event.pointerType === "mouse" && event.buttons === 0) { pinned.current = false; setOpen(true); }
  };
  const mouseLeave = (event: React.PointerEvent) => {
    if (placement !== "tab" || !open || pinned.current || event.pointerType !== "mouse") return;
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => { if (!menuOpen.current && !dragging.current) fold(); }, LEAVE_MS);
  };

  if (!shown) {
    const place = tabPosition(current, count);
    return <section ref={root} aria-label="ノートのページ" aria-busy={busy} onPointerEnter={mouseEnter}
      className="absolute inset-y-0 left-0 z-20" style={{ width: TAB_WIDTH }}>
      <button aria-label="ページ一覧を開く" title={`ページ一覧を開く（${current} / ${count}）`} disabled={busy}
        onClick={() => { pinned.current = true; focusOnOpen.current = true; setOpen(true); }}
        className="group relative block h-full w-full cursor-pointer bg-transparent outline-none hover:bg-foreground/5 focus-visible:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className="absolute left-1/2 top-1.5 size-3.5 -translate-x-1/2 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
        <span aria-hidden="true" className="absolute inset-y-8 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-border" />
        <span aria-hidden="true" className="absolute left-1/2 h-3 w-1.5 -translate-x-1/2 rounded-full bg-primary"
          style={{ top: `calc(2rem + (100% - 4rem - 0.75rem) * ${place})` }} />
      </button>
    </section>;
  }

  const overlaid = placement === "tab";
  return <section ref={root} aria-label="ノートのページ" aria-busy={busy} onPointerEnter={mouseEnter} onPointerLeave={mouseLeave}
    // The writing tool takes Escape from the page (it puts the tool down); from here it folds the opened tab.
    onKeyDown={(event) => { if (event.key === "Escape" && placement === "tab" && !menuOpen.current) { event.stopPropagation(); fold(); } }}
    className={`absolute z-20 flex flex-col ${overlaid ? "inset-y-0 left-0 border-r bg-background/95 shadow-[4px_0_14px_rgba(0,0,0,0.2)] backdrop-blur-sm" : "inset-y-2 left-2"}`}
    style={{ width: SIDEBAR_WIDTH }}>
    <DndContext sensors={sensors} collisionDetection={closestCenter}
      onDragStart={() => { dragging.current = true; }}
      onDragCancel={() => { dragging.current = false; }}
      onDragEnd={(event) => { dragging.current = false; if (event.over) void actions.reorder(String(event.active.id), String(event.over.id)); }}>
      <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:thin]"
        aria-label="ページのサムネイル（ドラッグ、またはAltと上下キーで並べ替え）">
        <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map((slot) => {
            const item = notebook.pages[slot.index];
            if (!item) return null;
            return <div key={item.id} className="absolute left-0 w-full px-1 pt-1" style={{ top: slot.start, height: slot.size }}>
              <Thumbnail page={item} number={slot.index + 1} active={current === slot.index + 1}
                strokes={notebookDraftInk(paperId, item.id) ?? savedInk[item.id]?.strokes as InkStroke[] ?? []}
                select={() => choose(slot.index + 1)}
                onFocusChange={(focused) => {
                  // Losing the focus to a disabled button (busy) is not the user's moving away.
                  if (focused) focusedPage.current = item.id;
                  else if (!useNotebookBusy.getState().ids.includes(paperId)) focusedPage.current = null;
                }}
                onMenuOpen={(isOpen) => { if (isOpen) menuOpen.current = true; else setTimeout(() => { menuOpen.current = false; }, 0); }} />
            </div>;
          })}
        </div>
      </div>
    </DndContext>
    <button disabled={busy} onClick={() => void actions.append()} title="末尾にページを追加して、そこへ移動します"
      className="m-1 flex shrink-0 items-center justify-center gap-1 rounded border border-dashed px-1 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring">
      <Plus className="size-3.5" aria-hidden="true" />ページを追加
    </button>
  </section>;
}
