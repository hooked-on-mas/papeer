import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { apiRequest } from "@/api/client";
import { onAppEvent } from "@/lib/appEvents";
import { QK } from "@/lib/queryKeys";
import { navigateTo } from "./navigation";
import { stepSearchResult } from "./searchSteps";
import { keyTarget } from "./pageTurn";

export type SearchResult = { page: number; snippet: string; anchor_y: number };

/**
 * 論文内検索: the field and its results, shown under the reading toolbar while open (the toolbar's
 * search button and Ctrl+F open it), and F3 / Shift+F3, which work while it is closed too.
 */
export function ReaderSearch({ paperId, search, setSearch, ownsKey, open, setOpen }: {
  paperId: string;
  search: { query: string; side: "original" | "translated" };
  setSearch: (value: { query: string; side: "original" | "translated" }) => void;
  /** Whether a key press is the reader's, as the paging keys decide it. */
  ownsKey: (e: KeyboardEvent) => boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [input, setInput] = useState(search.query);
  // The result last shown, -1 before any; Enter, Shift+Enter and F3 move from it.
  const [current, setCurrent] = useState(-1);
  // A step asked for before the results of the query were in.
  const pendingStep = useRef<1 | -1 | 0>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: found } = useQuery({
    queryKey: [QK.paperSearch, paperId, search.query, search.side],
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
    return onAppEvent("open-reader-search", () => {
      setOpen(true);
      // Already open: Ctrl+F goes back to the field.
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const showResult = (index: number, results: SearchResult[]) => {
    const item = results[index];
    if (!item) return;
    setCurrent(index);
    navigateTo({ page: item.page, anchor_y: item.anchor_y, side: search.side });
  };
  useEffect(() => setCurrent(-1), [search.query, search.side, paperId]);
  useEffect(() => {
    if (!pendingStep.current || !found) return;
    const delta = pendingStep.current;
    pendingStep.current = 0;
    showResult(stepSearchResult(-1, found.results.length, delta), found.results);
  }, [found, search.query, search.side]);
  useEffect(() => {
    if (current >= 0) listRef.current?.children[current]?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const step = (delta: 1 | -1) => {
    if (input !== search.query) {
      // Typed faster than the search follows: search now, and step once the results are in.
      if (!input.trim()) return;
      pendingStep.current = delta;
      setSearch({ ...search, query: input });
      return;
    }
    if (!search.query.trim()) {
      setOpen(true);
      return;
    }
    if (!found) {
      pendingStep.current = delta;
      return;
    }
    showResult(stepSearchResult(current, found.results.length, delta), found.results);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  const ownsKeyRef = useRef(ownsKey);
  ownsKeyRef.current = ownsKey;

  // F3 / Shift+F3 move through the results, on the same terms as the paging keys, and from the search
  // field but no other text field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "F3" || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented || !ownsKeyRef.current(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target !== inputRef.current && keyTarget(target) === "editable") return;
      e.preventDefault();
      stepRef.current(e.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const results = found?.results ?? [];
  const iconButton = "rounded p-1 hover:bg-muted disabled:opacity-40 disabled:pointer-events-none";

  if (!open) return null;
  return <div className="border-t bg-background text-[12px] p-2">
    <div className="flex gap-2">
      <input ref={inputRef} aria-label="論文内を検索" autoFocus className="flex-1 rounded border px-2 py-1 bg-background" value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          // Enter also confirms Japanese input; leave that to the IME.
          if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
          if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.preventDefault(); setOpen(false); }
        }}
        placeholder="原文・訳文の語句を検索（Enter で次へ、Shift+Enter で前へ）" />
      <select className="rounded border bg-background px-1" value={search.side} onChange={e => setSearch({ query: input, side: e.target.value as "original" | "translated" })}><option value="original">原文</option><option value="translated">訳文</option></select>
      <button aria-label="前の結果" title="前の結果（Shift+Enter / Shift+F3）" className={iconButton} disabled={!results.length} onClick={() => step(-1)}><ChevronUp className="size-4" /></button>
      <button aria-label="次の結果" title="次の結果（Enter / F3）" className={iconButton} disabled={!results.length} onClick={() => step(1)}><ChevronDown className="size-4" /></button>
      <button aria-label="検索を閉じる" title="閉じる（Esc）" className={iconButton} onClick={() => setOpen(false)}><X className="size-4" /></button>
    </div>
    {search.query && <div className="mt-1 text-muted-foreground">{found
      ? `${current >= 0 && current < results.length ? `${current + 1} / ` : ""}${found.total}件${found.limited ? "以上（先頭200件）" : ""}`
      : "検索中…"}</div>}
    <div ref={listRef} className="max-h-40 overflow-auto mt-1">{results.map((item, i) => (
      <button key={i} aria-current={i === current || undefined}
        className={`block w-full text-left px-2 py-1 hover:bg-muted truncate ${i === current ? "bg-muted font-medium" : ""}`}
        onClick={() => showResult(i, results)}>p.{item.page}　{item.snippet}</button>
    ))}</div>
  </div>;
}
