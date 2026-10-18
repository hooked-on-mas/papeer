import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronDown, NotebookPen, Search, StickyNote as StickyIcon, Trash2, X } from "lucide-react";
import { api, unwrap } from "@/api/client";
import type { components } from "@/api/schema";
import { useTagChoices } from "@/api/tagChoices";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useStore } from "@/store";
import {
  filterStickyNotes, isHighlight, noteDraft, stickyColors, stickyNotesMarkdown, stickyQuote, stickyTitle, type StickyFilters, type StickyNote,
} from "./stickyNotes";
import { deleteStickyNote, openStickyNote, refreshStickyNotes, useStickyNotes } from "./stickyNotesStore";
import { highlightColor, highlightFill } from "./highlights";
import { QK } from "@/lib/queryKeys";

/** Today as YYYY-MM-DD, in this PC's time zone. */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Appends the notes, as a list with p.N links, to the end of the paper's memo and shows the memo. */
function exportToMemo(paperId: string, notes: StickyNote[], includeHighlights: boolean) {
  const text = stickyNotesMarkdown(notes, { includeHighlights, date: today() });
  if (!text) return;
  const count = notes.filter(item => includeHighlights || !isHighlight(item)).length;
  const store = useStore.getState();
  // The memo pane adds it at the end once it has loaded (NotesPane).
  store.setNoteInsert({ paperId, text });
  store.setActiveTab("notes");
  store.setStatus(`${count}件をメモの末尾に書き出しました。`);
}

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
  const searchRef = useRef<HTMLInputElement>(null);
  const client = useQueryClient();
  const { data: notes = [], isPending, isError, refetch } = useQuery({
    queryKey: [QK.stickyNotes, "all"], queryFn: async () => await unwrap(api.GET("/api/sticky-notes")) as StickyNote[],
  });
  const visible = filterStickyNotes(notes, paperId ?? "", { ...filters, scope: effectiveScope });
  const scoped = notes.filter(item => effectiveScope === "all" || item.paper_id === paperId);
  const filtering = !!(filters.query || filters.label || filters.side || filters.kind);
  const updateFilters = (values: Partial<typeof filters>) => {
    useStickyNotes.setState({ filters: { ...filters, ...values }, scrollTop: 0 });
    if (listRef.current) listRef.current.scrollTop = 0;
  };
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = useStickyNotes.getState().scrollTop; }, [isPending]);
  const jump = (item: StickyNote) => {
    const store = useStore.getState();
    store.setTranslatedOnly(false);
    store.setActivePaperId(item.paper_id, item.page);
    store.setReaderJump({ paperId: item.paper_id, page: item.page, side: item.side, text: item.quote, anchor_y: item.anchor_y, anchor_x: item.anchor_x });
    useStickyNotes.setState({ selectedId: item.id });
    store.setActiveTab("reader");
  };
  const remove = async (item: StickyNote) => {
    setError("");
    try { if (await deleteStickyNote(item, client)) setMessage("付箋を削除しました。"); }
    catch (e) { setError(e instanceof Error ? e.message : "付箋を削除できませんでした。"); }
  };
  const undo = async () => {
    const item = deleted[deleted.length - 1];
    if (!item || busy) return;
    useStickyNotes.setState({ busy: true }); setError("");
    try {
      // Sent as it was listed: the sidecar takes the fields a new note has and leaves the rest.
      await unwrap(api.POST("/api/papers/{paper_id}/sticky-notes", { params: { path: { paper_id: item.paper_id } },
        body: item as components["schemas"]["BookmarkRequest"] }));
      useStickyNotes.setState(s => ({ deleted: s.deleted.slice(0, -1) }));
      await refreshStickyNotes(client); setMessage("付箋を戻しました。");
    } catch (e) { setError(e instanceof Error ? e.message : "付箋を戻せませんでした。"); }
    finally { useStickyNotes.setState({ busy: false }); }
  };
  return <section aria-label="付箋一覧" className="flex min-h-0 w-full flex-col bg-background">
    <header className="flex items-center gap-2 px-5 pt-4 pb-2">
      <StickyIcon className="size-4 text-amber-600" /><h2 className="text-sm font-semibold">付箋</h2>
      <span className="text-xs text-muted-foreground">残した引用・メモ・ハイライトを探す</span>
      {effectiveScope === "paper" && paperId && <DropdownMenu>
        <DropdownMenuTrigger disabled={!visible.length} className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
          title="この論文の付箋を、ページへのリンク付きでメモの末尾に追記します">
          <NotebookPen className="size-3.5" />メモに書き出す<ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {filtering ? "表示中の付箋をメモの末尾に追記" : "この論文の付箋をメモの末尾に追記"}
          </DropdownMenuLabel>
          <DropdownMenuItem disabled={!visible.length} onClick={() => exportToMemo(paperId, visible, true)}>
            付箋とハイライト（{visible.length}件）
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!visible.some(item => !isHighlight(item))} onClick={() => exportToMemo(paperId, visible, false)}>
            付箋だけ（{visible.filter(item => !isHighlight(item)).length}件）
          </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
    </header>
    <div className="flex flex-wrap items-center gap-2 border-b px-5 pb-3">
      <div className="flex shrink-0 rounded-md bg-muted p-0.5">{(["paper", "all"] as const).map(scope => <button key={scope} disabled={scope === "paper" && !paperId} aria-pressed={effectiveScope === scope}
        className={`flex-1 whitespace-nowrap rounded px-2 py-1 text-xs ${effectiveScope === scope ? "bg-background shadow-sm" : "text-muted-foreground"}`}
        onClick={() => updateFilters({ scope })}>{scope === "paper" ? "この論文" : "すべての論文"}</button>)}</div>
      <div className="relative min-w-48 flex-1"><Search className="absolute left-2 top-2 size-3.5 text-muted-foreground" /><input ref={searchRef} id="sticky-note-search" className={`${field} pl-7 pr-8`} aria-label="付箋を検索" placeholder="引用・メモ・論文名を検索" value={filters.query} onChange={e => updateFilters({ query: e.target.value })} />
        {filters.query && <button type="button" aria-label="付箋の検索語を消す" title="検索語だけを消す" className="absolute right-1 top-1 rounded p-1 hover:bg-muted" onClick={() => { updateFilters({ query: "" }); searchRef.current?.focus(); }}><X className="size-3.5" /></button>}
      </div>
      <div className="flex items-center gap-2">
        <select className={field} aria-label="付箋の分類で絞り込み" value={filters.label} onChange={e => updateFilters({ label: e.target.value })}>
          <option value="">すべての分類</option>{Array.from(new Set([...labels, ...notes.map(n => n.label)])).filter(Boolean).map(label => <option key={label}>{label}</option>)}
        </select>
        <select className={field} aria-label="付箋の原文・訳文" value={filters.side} onChange={e => updateFilters({ side: e.target.value })}><option value="">原文・訳文</option><option value="original">原文</option><option value="translated">訳文</option></select>
        <select className={field} aria-label="付箋・ハイライトで絞り込み" value={filters.kind} onChange={e => updateFilters({ kind: e.target.value as StickyFilters["kind"] })}><option value="">付箋・ハイライト</option><option value="note">付箋だけ</option><option value="highlight">ハイライトだけ</option></select>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="mr-auto" role="status">{filtering ? `${visible.length} / ${scoped.length}件` : `${visible.length}件`}</span>
        {filtering && <button className="underline" onClick={() => updateFilters({ query: "", label: "", side: "", kind: "" })}>条件をクリア</button>}
        <select aria-label="付箋の並び順" className="min-w-0 bg-background" value={filters.sort} onChange={e => updateFilters({ sort: e.target.value as "page" | "newest" })}><option value="page">ページ順</option><option value="newest">追加が新しい順</option></select>
      </div>
    </div>
    {error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>}
    {(message || deleted.length > 0) && <div className="flex items-center gap-2 border-b px-3 py-2 text-xs"><span role="status" className="flex-1">{message}</span>{deleted.length > 0 && <button className="underline" disabled={busy} onClick={() => void undo()}>削除を取り消す</button>}</div>}
    <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-5" onScroll={e => useStickyNotes.setState({ scrollTop: e.currentTarget.scrollTop })}>
      {isPending ? <p className="text-xs text-muted-foreground">付箋を読み込み中…</p> : isError ? <p role="alert" className="text-xs text-destructive">付箋を読み込めませんでした。<button className="ml-2 underline" onClick={() => void refetch()}>再試行</button></p> : <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] items-start gap-3">{visible.map(item => <article key={item.id}
        onKeyDown={e => { if ((e.key === "Delete" || e.key === "Backspace") && e.target instanceof HTMLButtonElement) { e.preventDefault(); void remove(item); } }}
        // A highlight is edged in its colour; a sticky note is coloured by its label.
        className={`rounded-md border p-3 ${isHighlight(item) ? "bg-background" : stickyColors[item.label] ?? stickyColors["重要"]} ${selectedId === item.id ? "ring-2 ring-primary ring-offset-1" : ""}`}
        style={isHighlight(item) ? { borderLeft: `4px solid rgb(${highlightColor(item.color).rgb})` } : undefined}>
        <button className="block w-full space-y-2 text-left" aria-label={`${isHighlight(item) ? "ハイライト" : "付箋"}を開く：p.${item.page} ${stickyTitle(item)} ${item.note || stickyQuote(item.quote) || "位置の付箋"}`} disabled={busy} onClick={() => void openStickyNote(noteDraft(item))}>
          {effectiveScope === "all" && <p className="truncate text-xs opacity-70">{item.paper_title || item.paper_name}</p>}
          <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-semibold">{stickyTitle(item)}</span><span className="ml-auto opacity-70">p.{item.page}・{item.side === "original" ? "原文" : "訳文"}</span></div>
          {stickyQuote(item.quote) && (isHighlight(item)
            ? <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs"><mark className="text-inherit" style={{ backgroundColor: highlightFill(item.color) }}>{stickyQuote(item.quote)}</mark></p>
            : <blockquote className="line-clamp-3 whitespace-pre-wrap break-words border-l-2 border-current/20 pl-2 text-xs opacity-75">{stickyQuote(item.quote)}</blockquote>)}
          {item.note && <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm">{item.note}</p>}
          {!item.note && !stickyQuote(item.quote) && <p className="text-xs opacity-70">この位置に付箋</p>}
        </button>
        <div className="mt-2 flex items-center border-t border-current/10 pt-1"><button className={`${action} inline-flex items-center gap-1`} onClick={() => jump(item)}><ArrowUpRight className="size-3" />貼った場所へ</button><button className={`${action} ml-auto`} disabled={busy} aria-label={`${isHighlight(item) ? "ハイライト" : "付箋"}を削除：p.${item.page} ${stickyTitle(item)}`} onClick={() => void remove(item)}><Trash2 className="size-3.5" /></button></div>
      </article>)}</div>}
      {!isPending && !isError && !visible.length && (scoped.length
        ? <p className="text-xs leading-6 text-muted-foreground">条件に合う付箋はありません。検索語や絞り込みを変更してください。</p>
        : <div className="text-xs leading-6 text-muted-foreground">
          <p>付箋はまだありません。PDFの文章を選んで「付箋」を押すと追加できます。</p>
          <details className="mt-1"><summary className="cursor-pointer">ほかの付け方</summary>
            <p>文章の選択後にハイライトも付けられます。右クリックや書き込みツールの「付箋」からも追加できます。</p>
          </details>
        </div>)}
    </div>
  </section>;
}
