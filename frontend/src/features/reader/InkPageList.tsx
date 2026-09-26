import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { cachedInkPages, type InkSide } from "./inkStore";
import { useStore } from "@/store";

export function InkPageList({ paperId, onClose }: { paperId: string; onClose: () => void }) {
  const { data = [], error, refetch } = useQuery({ queryKey: ["ink-pages", paperId],
    queryFn: () => apiRequest<{ side: InkSide; page: number; count: number }[]>("GET", `/api/papers/${paperId}/ink-pages`) });
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent).detail.paperId === paperId) void refetch(); };
    window.addEventListener("ink-changed", changed); return () => window.removeEventListener("ink-changed", changed);
  }, [paperId, refetch]);
  const entries = new Map(data.map(item => [`${item.side}:${item.page}`, item]));
  for (const item of cachedInkPages(paperId)) entries.set(`${item.side}:${item.page}`, item);
  const items = [...entries.values()].filter(item => item.count).sort((a, b) => a.page - b.page || a.side.localeCompare(b.side));
  return <div className="border-t mt-1 pt-1 text-xs">
    <div className="flex items-center justify-between"><span>書き込みのあるページ</span><button className="px-2 py-1" onClick={onClose}>閉じる</button></div>
    {error && <button className="text-destructive" onClick={() => void refetch()}>一覧を取得できませんでした。再試行</button>}
    <div className="max-h-28 overflow-auto flex flex-wrap gap-1">
      {!items.length && <p className="p-1">書き込みはまだありません。</p>}
      {items.map(item => <button key={`${item.side}:${item.page}`} className="border rounded px-2 py-1 hover:bg-muted" onClick={() => {
        const store = useStore.getState(); store.setTranslatedOnly(false); store.setCurrentPage(item.page);
        store.setReaderJump({ paperId, page: item.page, side: item.side, text: "", anchor_y: 0 }); onClose();
      }}>p.{item.page} · {item.side === "original" ? "原文" : "日本語訳"} · {item.count}件</button>)}
    </div>
  </div>;
}
