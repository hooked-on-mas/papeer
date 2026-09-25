import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, BookOpenText, Search, X } from "lucide-react";
import { apiRequest } from "@/api/client";
import { useStore } from "@/store";
import { showError } from "@/features/jobs/jobEvents";

export type BookmarkData = { id: number; page: number; side: "original" | "translated"; quote: string; label: string; note: string; anchor_y: number };
export type PendingBookmark = { paperId: string; page: number; side: "original" | "translated"; quote: string; anchorY: number };
export type SearchResult = { page: number; snippet: string; anchor_y: number };

export function ReaderExtras({ paperId, mode, setMode, search, setSearch, bookmarkQuote, setBookmarkQuote, onBookmarkJump, onSearchJump }: {
  paperId: string;
  mode: "pdf" | "text";
  setMode: (mode: "pdf" | "text") => void;
  search: { query: string; side: "original" | "translated" };
  setSearch: (value: { query: string; side: "original" | "translated" }) => void;
  bookmarkQuote: PendingBookmark | null;
  setBookmarkQuote: (value: PendingBookmark | null) => void;
  onBookmarkJump: (bookmark: BookmarkData) => void;
  onSearchJump: (result: SearchResult, index: number) => void;
}) {
  const [panel, setPanel] = useState<"search" | "bookmarks" | null>(null);
  const [input, setInput] = useState(search.query);
  const [label, setLabel] = useState("重要");
  const [note, setNote] = useState("");
  const queryClient = useQueryClient();
  const { data: bookmarks = [] } = useQuery({
    queryKey: ["bookmarks", paperId],
    queryFn: () => apiRequest<BookmarkData[]>("GET", `/api/papers/${paperId}/bookmarks`),
  });
  const { data: found } = useQuery({
    queryKey: ["paper-search", paperId, search.query, search.side],
    queryFn: () => apiRequest<{ results: SearchResult[]; total: number; limited: boolean }>(
      "GET", `/api/papers/${paperId}/search?q=${encodeURIComponent(search.query)}&side=${search.side}`),
    enabled: !!search.query.trim(),
  });
  useEffect(() => setInput(search.query), [search.query, paperId]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch({ ...search, query: input }), 250);
    return () => clearTimeout(timer);
  }, [input, search.side, paperId]);
  useEffect(() => {
    const open = () => setPanel("search");
    window.addEventListener("open-reader-search", open);
    return () => window.removeEventListener("open-reader-search", open);
  }, []);
  useEffect(() => { if (bookmarkQuote) setPanel("bookmarks"); }, [bookmarkQuote]);

  const saveBookmark = async () => {
    try {
      await apiRequest("POST", `/api/papers/${paperId}/bookmarks`, {
        page: bookmarkQuote?.page, side: bookmarkQuote?.side, quote: bookmarkQuote?.quote, anchor_y: bookmarkQuote?.anchorY, label, note,
      });
      await queryClient.invalidateQueries({ queryKey: ["bookmarks", paperId] });
      setBookmarkQuote(null);
      setNote("");
      setPanel("bookmarks");
    } catch (error) { showError(error, "しおりを保存できませんでした"); }
  };
  const deleteBookmark = async (id: number) => {
    try {
      await apiRequest("DELETE", `/api/papers/${paperId}/bookmarks/${id}`);
      await queryClient.invalidateQueries({ queryKey: ["bookmarks", paperId] });
    } catch (error) { showError(error, "しおりを削除できませんでした"); }
  };
  return <div className="border-b bg-background text-[12px] shrink-0">
    <div className="flex items-center gap-2 px-3 py-1">
      <button className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-muted" onClick={() => setPanel(panel === "search" ? null : "search")}><Search className="size-3.5" /> 論文内検索</button>
      <button className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-muted" onClick={() => setPanel(panel === "bookmarks" ? null : "bookmarks")}><Bookmark className="size-3.5" /> しおり {bookmarks.length || ""}</button>
      <button className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-muted" onClick={() => setMode(mode === "pdf" ? "text" : "pdf")}><BookOpenText className="size-3.5" /> {mode === "pdf" ? "訳文を本文で読む" : "PDFに戻る"}</button>
    </div>
    {panel === "search" && <div className="border-t p-2">
      <div className="flex gap-2">
        <input aria-label="論文内を検索" autoFocus className="flex-1 rounded border px-2 py-1 bg-background" value={input} onChange={e => setInput(e.target.value)} placeholder="原文・訳文の語句を検索" />
        <select className="rounded border bg-background px-1" value={search.side} onChange={e => setSearch({ query: input, side: e.target.value as "original" | "translated" })}><option value="original">原文</option><option value="translated">訳文</option></select>
        <button aria-label="閉じる" onClick={() => setPanel(null)}><X className="size-4" /></button>
      </div>
      {search.query && <div className="mt-1 text-muted-foreground">{found ? `${found.total}件${found.limited ? "以上（先頭200件）" : ""}` : "検索中…"}</div>}
      <div className="max-h-40 overflow-auto mt-1">{found?.results.map((item, i) => <button key={i} className="block w-full text-left px-2 py-1 hover:bg-muted truncate" onClick={() => { useStore.getState().setCurrentPage(item.page); setMode("pdf"); onSearchJump(item, i); }}>p.{item.page}　{item.snippet}</button>)}</div>
    </div>}
    {panel === "bookmarks" && <div className="border-t p-2 max-h-56 overflow-auto">
      {bookmarkQuote && <div className="border rounded p-2 mb-2 space-y-2">
        <p className="line-clamp-2">{bookmarkQuote.quote}</p>
        <div className="flex gap-2"><select className="border rounded bg-background px-1" value={label} onChange={e => setLabel(e.target.value)}><option>重要</option><option>あとで確認</option></select><input className="flex-1 border rounded bg-background px-2" placeholder="メモ（任意）" value={note} onChange={e => setNote(e.target.value)} /><button className="rounded bg-primary text-primary-foreground px-2" onClick={saveBookmark}>保存</button></div>
      </div>}
      {bookmarks.map(item => <div key={item.id} className="flex items-start gap-2 border-b py-1">
        <button className="min-w-0 flex-1 text-left hover:text-primary" onClick={() => { setMode("pdf"); useStore.getState().setCurrentPage(item.page); setSearch({ query: item.quote.slice(0, 32), side: item.side }); onBookmarkJump(item); }}><span className="font-medium">p.{item.page}・{item.side === "original" ? "原文" : "訳文"}・{item.label}</span><span className="block truncate">{item.quote}</span>{item.note && <span className="block text-muted-foreground truncate">{item.note}</span>}</button>
        <button aria-label="しおりを削除" className="p-1 hover:bg-muted" onClick={() => deleteBookmark(item.id)}><X className="size-3" /></button>
      </div>)}
      {!bookmarks.length && !bookmarkQuote && <p className="text-muted-foreground">PDFの文章を選択して、右クリックから保存できます。</p>}
    </div>}
  </div>;
}

export function TranslationTextView({ paperId, currentPage, onPage }: { paperId: string; currentPage: number; onPage: (page: number) => void }) {
  const [fontSize, setFontSize] = useState(16);
  const [lineHeight, setLineHeight] = useState(1.8);
  const { data: blocks = [], isLoading } = useQuery({
    queryKey: ["translation-document", paperId],
    queryFn: () => apiRequest<{ page: number; id: string; text: string }[]>("GET", `/api/papers/${paperId}/translation-document`),
  });
  return <div className="h-full overflow-auto bg-background">
    <div className="sticky top-0 bg-background border-b px-4 py-2 flex gap-3 text-xs z-10">
      <label>文字 <input aria-label="文字サイズ" type="range" min="12" max="28" value={fontSize} onChange={e => setFontSize(Number(e.target.value))} /></label>
      <label>行間 <input aria-label="行間" type="range" min="1.3" max="2.4" step="0.1" value={lineHeight} onChange={e => setLineHeight(Number(e.target.value))} /></label>
    </div>
    <div className="max-w-3xl mx-auto p-6" style={{ fontSize, lineHeight }}>
      {isLoading && <p>訳文を読み込み中…</p>}
      {!isLoading && !blocks.length && <p>翻訳済みの本文はまだありません。</p>}
      {blocks.map((block, index) => <div key={`${block.page}-${block.id}-${index}`} className={`mb-5 rounded px-3 py-1 ${currentPage === block.page ? "border-l-2 border-primary" : ""}`}>
        {(index === 0 || blocks[index - 1].page !== block.page) && <h3 className="text-sm font-semibold text-muted-foreground mt-5 mb-3">p.{block.page}</h3>}
        <p className="whitespace-pre-wrap">{block.text}</p>
        <button className="text-xs text-primary mt-1 hover:underline" onClick={() => onPage(block.page)}>原文 p.{block.page} を見る</button>
      </div>)}
    </div>
  </div>;
}
