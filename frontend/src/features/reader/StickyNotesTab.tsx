import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Search, StickyNote as StickyIcon, Trash2 } from "lucide-react";
import { apiRequest } from "@/api/client";
import { useTagChoices } from "@/api/tagChoices";
import { useStore } from "@/store";
import { filterStickyNotes, noteDraft, stickyColors, stickyQuote, type StickyNote } from "./stickyNotes";
import { openStickyNote, useStickyNotes } from "./stickyNotesStore";
import { QK } from "@/lib/queryKeys";

const field = "w-full rounded-md border bg-background px-2 py-1.5 text-xs";
const action = "rounded px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40";

export function StickyNotesTab() {
  const { data: labels = [] } = useTagChoices("sticky");
  const paperId = useStore(s => s.activePaperId);
  const { filters, selectedId, busy, deleted } = useStickyNotes();
  const effectiveScope = paperId ? filters.scope : "all";
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const { data: notes = [], isPending, isError, refetch } = useQuery({
    queryKey: [QK.stickyNotes, "all"], queryFn: () => apiRequest<StickyNote[]>("GET", "/api/sticky-notes"),
  });
  const visible = filterStickyNotes(notes, paperId ?? "", { ...filters, scope: effectiveScope });
  const scoped = notes.filter(item => effectiveScope === "all" || item.paper_id === paperId);
  const updateFilters = (values: Partial<typeof filters>) => {
    useStickyNotes.setState({ filters: { ...filters, ...values }, scrollTop: 0 });
    if (listRef.current) listRef.current.scrollTop = 0;
  };
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = useStickyNotes.getState().scrollTop; }, [isPending]);
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: [QK.stickyNotes] }), client.invalidateQueries({ queryKey: [QK.librarySearch] }),
  ]);
  const jump = (item: StickyNote) => {
    const store = useStore.getState();
    store.setTranslatedOnly(false);
    store.setActivePaperId(item.paper_id, item.page);
    store.setReaderJump({ paperId: item.paper_id, page: item.page, side: item.side, text: item.quote, anchor_y: item.anchor_y, anchor_x: item.anchor_x });
    useStickyNotes.setState({ selectedId: item.id });
    store.setActiveTab("reader");
  };
  const remove = async (item: StickyNote) => {
    const state = useStickyNotes.getState();
    if (state.busy) return;
    useStickyNotes.setState({ busy: true }); setError("");
    try {
      await apiRequest("DELETE", `/api/papers/${item.paper_id}/sticky-notes/${item.id}`);
      useStickyNotes.setState(s => ({ deleted: [...s.deleted, item], ...(s.draft?.id === item.id ? { draft: null, dirty: false } : {}) }));
      await refresh(); setMessage("付箋を削除しました。");
    } catch (e) { setError(e instanceof Error ? e.message : "付箋を削除できませんでした。"); }
    finally { useStickyNotes.setState({ busy: false }); }
  };
  const undo = async () => {
    const item = deleted[deleted.length - 1];
    if (!item || busy) return;
    useStickyNotes.setState({ busy: true }); setError("");
    try {
      await apiRequest("POST", `/api/papers/${item.paper_id}/sticky-notes`, item);
      useStickyNotes.setState(s => ({ deleted: s.deleted.slice(0, -1) }));
      await refresh(); setMessage("付箋を戻しました。");
    } catch (e) { setError(e instanceof Error ? e.message : "付箋を戻せませんでした。"); }
    finally { useStickyNotes.setState({ busy: false }); }
  };
  return <section aria-label="付箋一覧" className="flex min-h-0 w-full flex-col bg-background">
    <header className="flex items-center gap-2 px-5 pt-4 pb-2">
      <StickyIcon className="size-4 text-amber-600" /><h2 className="text-sm font-semibold">付箋</h2>
      <span className="text-xs text-muted-foreground">残した引用・メモを探す</span>
    </header>
    <div className="flex flex-wrap items-center gap-2 border-b px-5 pb-3">
      <div className="flex shrink-0 rounded-md bg-muted p-0.5">{(["paper", "all"] as const).map(scope => <button key={scope} disabled={scope === "paper" && !paperId} aria-pressed={effectiveScope === scope}
        className={`flex-1 rounded px-2 py-1 text-xs ${effectiveScope === scope ? "bg-background shadow-sm" : "text-muted-foreground"}`}
        onClick={() => updateFilters({ scope })}>{scope === "paper" ? "この論文" : "すべての論文"}</button>)}</div>
      <div className="relative min-w-48 flex-1"><Search className="absolute left-2 top-2 size-3.5 text-muted-foreground" /><input id="sticky-note-search" className={`${field} pl-7`} aria-label="付箋を検索" placeholder="引用・メモ・論文名を検索" value={filters.query} onChange={e => updateFilters({ query: e.target.value })} /></div>
      <div className="flex items-center gap-2">
        <select className={field} aria-label="付箋の分類で絞り込み" value={filters.label} onChange={e => updateFilters({ label: e.target.value })}>
          <option value="">すべての分類</option>{Array.from(new Set([...labels, ...notes.map(n => n.label)])).map(label => <option key={label}>{label}</option>)}
        </select>
        <select className={field} aria-label="付箋の原文・訳文" value={filters.side} onChange={e => updateFilters({ side: e.target.value })}><option value="">原文・訳文</option><option value="original">原文</option><option value="translated">訳文</option></select>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="mr-auto">{visible.length} / {scoped.length}件</span>
        {(filters.query || filters.label || filters.side) && <button className="underline" onClick={() => updateFilters({ query: "", label: "", side: "" })}>条件をクリア</button>}
        <select aria-label="付箋の並び順" className="min-w-0 bg-background" value={filters.sort} onChange={e => updateFilters({ sort: e.target.value as "page" | "newest" })}><option value="page">ページ順</option><option value="newest">追加が新しい順</option></select>
      </div>
    </div>
    {error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>}
    {(message || deleted.length > 0) && <div className="flex items-center gap-2 border-b px-3 py-2 text-xs"><span role="status" className="flex-1">{message}</span>{deleted.length > 0 && <button className="underline" disabled={busy} onClick={() => void undo()}>削除を取り消す</button>}</div>}
    <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-5" onScroll={e => useStickyNotes.setState({ scrollTop: e.currentTarget.scrollTop })}>
      {isPending ? <p className="text-xs text-muted-foreground">付箋を読み込み中…</p> : isError ? <p role="alert" className="text-xs text-destructive">付箋を読み込めませんでした。<button className="ml-2 underline" onClick={() => void refetch()}>再試行</button></p> : <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] items-start gap-3">{visible.map(item => <article key={item.id}
        className={`rounded-md border p-3 ${stickyColors[item.label] ?? stickyColors["重要"]} ${selectedId === item.id ? "ring-2 ring-primary ring-offset-1" : ""}`}>
        <button className="block w-full space-y-2 text-left" aria-label={`付箋を開く：p.${item.page} ${item.label} ${item.note || stickyQuote(item.quote) || "位置の付箋"}`} disabled={busy} onClick={() => void openStickyNote(noteDraft(item))}>
          {effectiveScope === "all" && <p className="truncate text-xs opacity-70">{item.paper_title || item.paper_name}</p>}
          <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-semibold">{item.label}</span><span className="ml-auto opacity-70">p.{item.page}・{item.side === "original" ? "原文" : "訳文"}</span></div>
          {stickyQuote(item.quote) && <blockquote className="line-clamp-3 whitespace-pre-wrap break-words border-l-2 border-current/20 pl-2 text-xs opacity-75">{stickyQuote(item.quote)}</blockquote>}
          {item.note && <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm">{item.note}</p>}
          {!item.note && !stickyQuote(item.quote) && <p className="text-xs opacity-70">この位置に付箋</p>}
        </button>
        <div className="mt-2 flex items-center border-t border-current/10 pt-1"><button className={`${action} inline-flex items-center gap-1`} onClick={() => jump(item)}><ArrowUpRight className="size-3" />貼った場所へ</button><button className={`${action} ml-auto`} disabled={busy} aria-label={`付箋を削除：p.${item.page} ${item.label}`} onClick={() => void remove(item)}><Trash2 className="size-3.5" /></button></div>
      </article>)}</div>}
      {!isPending && !isError && !visible.length && <p className="text-xs leading-6 text-muted-foreground">{scoped.length ? "条件に合う付箋はありません。検索語や絞り込みを変更してください。" : "気になる箇所に付箋を貼ってみましょう。PDF上部の「付箋を貼る」で場所を選ぶか、文章を選択して右クリックすると引用を残せます。"}</p>}
    </div>
  </section>;
}
