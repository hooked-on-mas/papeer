import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { followCitation } from "@/app/actions";

function Excerpt({ id, page }: { id: string; page: number }) {
  const [open, setOpen] = useState(false);
  const { data, isFetching, isError } = useQuery({ queryKey: ["citation-excerpts", id, page],
    queryFn: () => apiRequest<{ text: string }>("GET", `/api/papers/${id}/citation-excerpts?page=${page}`), enabled: open });
  return <div className="border rounded p-2">
    <button className="text-primary hover:underline" onClick={() => setOpen(!open)}>p.{page} の原文抜粋を{open ? "閉じる" : "見る"}（{id.slice(0, 8)}）</button>
    {open && <>
      {isFetching && <p>読み込み中…</p>}{isError && <p className="text-destructive">原文を取得できませんでした。</p>}
      <p className="max-h-40 overflow-auto whitespace-pre-wrap mt-2 select-text">{data?.text || (!isFetching && !isError ? "このページから文字を抽出できませんでした。" : "")}</p>
      <button className="text-primary mt-2 hover:underline" onClick={() => void followCitation(id, page)}>PDFでページ全体を確認</button>
    </>}
  </div>;
}

export function CitationEvidence({ content }: { content: string }) {
  const links = [...new Set([...content.matchAll(/paperdesk:\/\/([0-9a-f]{32})\/(\d+)/g)].map(m => `${m[1]}/${m[2]}`))];
  if (!links.length) return null;
  return <details className="mt-3 text-xs text-muted-foreground">
    <summary className="cursor-pointer">参照ページの原文を確認（{links.length}箇所）</summary>
    <div className="space-y-2 mt-2">{links.map(link => { const [id, page] = link.split("/"); return <Excerpt key={link} id={id} page={Number(page)} />; })}</div>
  </details>;
}
