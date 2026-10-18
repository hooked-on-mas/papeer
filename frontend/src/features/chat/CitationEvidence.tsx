import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { followCitation } from "@/app/actions";
import { QK } from "@/lib/queryKeys";
import { usePaper } from "@/api/hooks";

function Excerpt({ id, page, name }: { id: string; page: number; name: string }) {
  const [open, setOpen] = useState(false);
  const { data, isFetching, isError } = useQuery({ queryKey: [QK.citationExcerpts, id, page],
    queryFn: async () => await unwrap(api.GET("/api/papers/{paper_id}/citation-excerpts", {
      params: { path: { paper_id: id }, query: { page } } })) as { text: string }, enabled: open });
  return <div className={`border rounded p-2 ${open ? "col-span-full" : ""}`}>
    <button className="text-primary hover:underline text-left" aria-expanded={open}
      aria-label={`${name}のp.${page}の原文抜粋を${open ? "閉じる" : "見る"}`}
      onClick={() => setOpen(!open)}>p.{page} の原文抜粋を{open ? "閉じる" : "見る"}</button>
    {open && <>
      {isFetching && <p>読み込み中…</p>}{isError && <p className="text-destructive">原文を取得できませんでした。</p>}
      <p className="max-h-40 overflow-auto whitespace-pre-wrap mt-2 select-text">{data?.text || (!isFetching && !isError ? "このページから文字を抽出できませんでした。" : "")}</p>
      <button className="text-primary mt-2 hover:underline" onClick={() => void followCitation(id, page)}>PDFでページ全体を確認</button>
    </>}
  </div>;
}

function PaperEvidence({ id, pages }: { id: string; pages: number[] }) {
  const { data: paper } = usePaper(id);
  const name = paper?.title || paper?.original_name || "参照論文";
  return <section aria-label={`${name}の参照ページ`} className="space-y-1.5">
    <h4 className="font-medium break-words">{name}</h4>
    <div className="grid grid-cols-1 @min-[22rem]:grid-cols-2 @min-[36rem]:grid-cols-3 gap-2">
      {pages.map(page => <Excerpt key={page} id={id} page={page} name={name} />)}
    </div>
  </section>;
}

export function CitationEvidence({ content }: { content: string }) {
  const links = [...new Set([...content.matchAll(/(?:papeer|paperdesk):\/\/([0-9a-f]{32})\/(\d+)/g)].map(m => `${m[1]}/${m[2]}`))];
  if (!links.length) return null;
  const papers = new Map<string, number[]>();
  for (const link of links) {
    const [id, page] = link.split("/");
    const pages = papers.get(id) ?? [];
    pages.push(Number(page));
    papers.set(id, pages);
  }
  return <details className="@container mt-3 text-xs text-muted-foreground">
    <summary className="cursor-pointer">参照ページの原文を確認（{links.length}箇所）</summary>
    <div className="space-y-3 mt-2">{[...papers].map(([id, pages]) => <PaperEvidence key={id} id={id} pages={pages} />)}</div>
  </details>;
}
