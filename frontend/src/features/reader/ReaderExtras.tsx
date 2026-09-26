import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { apiRequest } from "@/api/client";
import { useStore } from "@/store";
import { TranslationReview } from "./TranslationReview";

export type SearchResult = { page: number; snippet: string; anchor_y: number };
export function ReaderExtras({ paperId, search, setSearch, onSearchJump }: {
  paperId: string;
  search: { query: string; side: "original" | "translated" };
  setSearch: (value: { query: string; side: "original" | "translated" }) => void;
  onSearchJump: (result: SearchResult, index: number) => void;
}) {
  const [panel, setPanel] = useState<"search" | null>(null);
  const [input, setInput] = useState(search.query);
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
  return <div className="border-b bg-background text-[12px] shrink-0">
    <div className="flex flex-wrap items-center gap-2 px-3 py-1">
      <TranslationReview paperId={paperId} />
      <button className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-muted" onClick={() => setPanel(panel === "search" ? null : "search")}><Search className="size-3.5" /> 論文内検索</button>
    </div>
    {panel === "search" && <div className="border-t p-2">
      <div className="flex gap-2">
        <input aria-label="論文内を検索" autoFocus className="flex-1 rounded border px-2 py-1 bg-background" value={input} onChange={e => setInput(e.target.value)} placeholder="原文・訳文の語句を検索" />
        <select className="rounded border bg-background px-1" value={search.side} onChange={e => setSearch({ query: input, side: e.target.value as "original" | "translated" })}><option value="original">原文</option><option value="translated">訳文</option></select>
        <button aria-label="閉じる" onClick={() => setPanel(null)}><X className="size-4" /></button>
      </div>
      {search.query && <div className="mt-1 text-muted-foreground">{found ? `${found.total}件${found.limited ? "以上（先頭200件）" : ""}` : "検索中…"}</div>}
      <div className="max-h-40 overflow-auto mt-1">{found?.results.map((item, i) => <button key={i} className="block w-full text-left px-2 py-1 hover:bg-muted truncate" onClick={() => { const store = useStore.getState(); store.setTranslatedOnly(false); store.setCurrentPage(item.page); onSearchJump(item, i); }}>p.{item.page}　{item.snippet}</button>)}</div>
    </div>}
  </div>;
}
