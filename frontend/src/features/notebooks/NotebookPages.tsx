import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api, unwrap } from "@/api/client";
import { QK } from "@/lib/queryKeys";
import { onAppEvent } from "@/lib/appEvents";
import { InkDrawing } from "@/features/reader/InkOverlay";
import { notebookDraftInk, type InkStroke } from "@/features/reader/inkStore";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useDraggable, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { ChevronDown, ChevronRight, Copy, FilePlus2, Settings2, Trash2 } from "lucide-react";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { askConfirm } from "@/components/AppDialogs";
import { showError } from "@/components/errorDialog";
import { PaperPreview, PaperSettings } from "./PaperSettings";
import { changeNotebook, useNotebookBusy, type NotebookDocument, type NotebookPage, type NotebookPaper, type NotebookChange } from "./notebooks";

function Thumbnail({ page, number, active, disabled, select, shift, strokes }: { page: NotebookPage; number: number; active: boolean; disabled: boolean; select: () => void; shift: (delta: number) => void; strokes: InkStroke[] }) {
  const drag = useDraggable({ id: page.id, disabled });
  const drop = useDroppable({ id: page.id, disabled });
  const ratio = page.height_mm / page.width_mm;
  return <div ref={drop.setNodeRef} className={drop.isOver ? "rounded outline-2 outline-primary" : ""}>
    <button ref={drag.setNodeRef} {...drag.attributes} {...drag.listeners} disabled={disabled} onClick={select}
      aria-label={`ページ ${number}`} aria-current={active ? "page" : undefined}
      onKeyDown={e => { if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); shift(e.key === "ArrowLeft" ? -1 : 1); } else drag.listeners?.onKeyDown?.(e); }}
      className={`w-16 p-1 rounded shrink-0 text-xs touch-none ${active ? "bg-accent ring-2 ring-primary" : "hover:bg-muted"} ${drag.isDragging ? "opacity-40" : ""}`}>
      <div className="relative mx-auto" style={{ width: Math.min(56, 64/ratio), height: Math.min(64, 56*ratio) }}>
        <PaperPreview paper={page} className="absolute inset-0 w-full h-full" />
        <svg viewBox={`0 0 1000 ${1000*ratio}`} className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">{strokes.map(stroke => <InkDrawing key={stroke.id} stroke={stroke} ratio={ratio} />)}</svg>
      </div><span>{number}</span>
    </button>
  </div>;
}

export function NotebookPages({ id, document }: { id: string; document: NotebookDocument }) {
  const current = useStore(s => s.currentPage);
  const busy = useNotebookBusy(s => s.ids.includes(id));
  const [pagesOpen, setPagesOpen] = useState(false);
  const panelId = useId();
  const [settings, setSettings] = useState<NotebookPaper | null>(null);
  const [, redrawInk] = useState(0);
  useEffect(() => onAppEvent("ink-changed", event => { if (event.paperId === id) redrawInk(value => value+1); }), [id]);
  const { data: savedInk = {} } = useQuery({ queryKey: [QK.inkPages, id, "notebook"],
    queryFn: () => unwrap(api.GET("/api/notebooks/{notebook_id}/ink", { params: { path: { notebook_id: id } } })) });
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: document.pages.length, getScrollElement: () => scroll.current, estimateSize: () => 72, horizontal: true, overscan: 3, enabled: pagesOpen });
  useEffect(() => { if (pagesOpen) virtual.scrollToIndex(current-1, { align: "auto" }); }, [current, virtual, pagesOpen]);
  const page = document.pages[current - 1];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));
  const run = async (change: Omit<NotebookChange, "revision">) => {
    try { await changeNotebook(id, document, change); return true; }
    catch (error) { showError(error, "ページを変更できませんでした。書き込みを保存してから再試行してください"); return false; }
  };
  const reorder = (from: string, to: string) => {
    const order = document.pages.map(item => item.id);
    const source = order.indexOf(from), target = order.indexOf(to);
    if (source < 0 || target < 0 || source === target) return;
    order.splice(target, 0, order.splice(source, 1)[0]);
    void run({ action: "reorder", order });
  };
  return <section aria-label="ノートのページ" aria-busy={busy} className="border-b bg-background shrink-0">
    <div className="flex items-center gap-2 px-2 py-1 text-xs">
      <Button size="sm" variant="ghost" aria-label="ページ一覧" aria-expanded={pagesOpen} aria-controls={panelId} onClick={() => setPagesOpen(open => !open)}>
        {pagesOpen ? <ChevronDown /> : <ChevronRight />}ページ一覧
      </Button>
      {busy && <span className="text-muted-foreground">書き込みを保存してページを変更中…</span>}
    </div>
    <div id={panelId} hidden={!pagesOpen}>
    <div className="flex items-center flex-wrap gap-1 px-2 py-1 text-xs">
      <Button size="sm" variant="ghost" disabled={busy || !page} onClick={() => void run({ action: "insert", page_id: page?.id })}><FilePlus2 className="size-3" />後ろに挿入</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run({ action: "append" })}>末尾に追加</Button>
      <Button size="sm" variant="ghost" disabled={busy || !page} onClick={() => void run({ action: "duplicate", page_id: page?.id })}><Copy className="size-3" />複製</Button>
      <Button size="sm" variant="ghost" disabled={busy || !page} onClick={() => page && setSettings({ size: page.size, orientation: page.orientation, template: page.template, color: page.color })}><Settings2 className="size-3" />用紙を変更</Button>
      <Button size="sm" variant="ghost" disabled={busy || document.pages.length === 1 || !page} onClick={async () => { if (await askConfirm("ページを削除", `p.${current}と、このページの書き込み・付箋を削除します。元に戻せません。`, "削除", true)) void run({ action: "delete", page_id: page?.id }); }}><Trash2 className="size-3" />削除</Button>
    </div>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={event => { if (event.over) reorder(String(event.active.id), String(event.over.id)); }}>
      <div ref={scroll} className="overflow-x-auto px-2 pb-2" aria-label="ページのサムネイル（ドラッグ、またはAltと左右キーで並べ替え）">
        <div className="relative h-22" style={{ width: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map(slot => { const item = document.pages[slot.index], index = slot.index; return <div key={item.id} className="absolute top-0" style={{ left: slot.start }}><Thumbnail page={item} number={index+1} active={current === index+1} disabled={busy}
          strokes={notebookDraftInk(id, item.id) ?? savedInk[item.id]?.strokes as InkStroke[] ?? []}
          select={() => { useStore.getState().setCurrentPage(index+1); setPagesOpen(false); }} shift={delta => { const target = document.pages[index+delta]; if (target) reorder(item.id, target.id); }} /></div>; })}
        </div>
      </div>
    </DndContext>
    </div>
    <Dialog open={!!settings} onOpenChange={open => { if (!open && !busy) setSettings(null); }}>
      <DialogContent><DialogHeader><DialogTitle>p.{current} の用紙を変更</DialogTitle><DialogDescription>書き込みはページ内の同じ比率の位置に保ちます。サイズや向きに合わせて伸縮します。</DialogDescription></DialogHeader>
        {settings && <fieldset disabled={busy}><PaperSettings value={settings} onChange={setSettings} /></fieldset>}
        <Button disabled={busy || !settings} onClick={async () => { if (settings && await run({ action: "paper", page_id: page?.id, spec: settings })) setSettings(null); }}>{busy ? "変更中…" : "変更"}</Button>
      </DialogContent>
    </Dialog>
  </section>;
}
