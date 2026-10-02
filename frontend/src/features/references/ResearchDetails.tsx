import { useState } from "react";
import { BookOpen, Download, ExternalLink, Globe, Loader2, MessageSquare, ScrollText, Square } from "lucide-react";
import { useCollections, usePaper } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { showError } from "@/components/errorDialog";
import { startJob, requestCancel } from "@/features/jobs/jobEvents";
import { runningPaperJob } from "@/features/jobs/jobSelectors";
import { shell } from "@/shell";
import { paperBusy, useStore } from "@/store";
import type { Reference } from "./graph";
import { useResearch, useWebSearchCapability, type ResearchRecord } from "./researchHooks";
import { openReferencePaper } from "./researchNavigation";
import { useAutoResearch } from "./autoResearch";

const BASIS = { abstract: "抄録に基づく概要 · 本文は未確認", full_text: "公開本文に基づく概要", metadata: "書誌情報のみ確認", unresolved: "文献を特定できませんでした。候補は原文で確認してください。" };

export function ResearchDetails({ sourcePaperId, reference, recordKey, registeredPaperId }: {
  sourcePaperId: string; reference?: Reference; recordKey?: string; registeredPaperId?: string | null;
}) {
  const key = recordKey ?? reference?.research_key ?? "";
  const { data: records = [], error: loadError } = useResearch(sourcePaperId);
  const record = records.find(r => r.key === key);
  const { data: source } = usePaper(sourcePaperId);
  const targetId = record?.paper_id ?? (registeredPaperId === sourcePaperId ? null : registeredPaperId) ?? null;
  const { data: target } = usePaper(targetId);
  const { data: collections = [] } = useCollections();
  const { data: capability } = useWebSearchCapability();
  const [pdfIndex, setPdfIndex] = useState(0);
  const [folder, setFolder] = useState<string | null>(null);
  const [withSummary, setWithSummary] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const automatic = useAutoResearch(s => s.active);
  const job = useStore(s => runningPaperJob(s.activeJobs.filter(job =>
    !automatic.some(item => item.jobId === job.job_id && item.key !== key)), sourcePaperId, ["reference-research", "reference-import"]));
  const busy = useStore(s => paperBusy(s.activeJobs, sourcePaperId) || paperBusy(s.activeJobs, targetId));
  const disabled = busy || submitting;
  const collection = folder ?? source?.collection_name ?? "";
  const hasSummary = target?.has_article || record?.has_summary;
  const researched = !!record && (!!record.summary || record.sources.length > 0);
  const selectedPdfIndex = Math.min(pdfIndex, Math.max(0, (record?.pdfs.length ?? 1) - 1));
  const run = async (path: string, body: unknown, kind: "reference-research" | "reference-import") => {
    setSubmitting(true); setError("");
    try {
      await startJob(path, body, { kind, paperId: sourcePaperId }, event => {
        if (event.status === "failed") setError(event.error || "処理を完了できませんでした。");
      });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSubmitting(false); }
  };
  const importPdf = async (summaryOnly = false) => {
    await run(`/api/papers/${sourcePaperId}/reference-import/${key}`, {
      pdf_index: targetId ? null : selectedPdfIndex, collection,
      create_summary: summaryOnly || withSummary,
    }, "reference-import");
  };
  const chat = () => {
    const store = useStore.getState();
    store.setActivePaperId(sourcePaperId);
    store.setChatDraft({ paperId: sourcePaperId, text: targetId
      ? "この参考文献と、今読んでいる論文の手法・結果・限界を比較してください。"
      : "この参考文献と、今読んでいる論文の関係を教えてください。",
      researchKeys: record ? [key] : [], paperIds: targetId ? [...new Set([sourcePaperId, targetId])] : undefined });
    store.openSidePanel("chat");
  };
  const researchButton = (reference || record) && <Button size="sm" variant={!researched && !targetId ? "default" : "ghost"}
    className="h-auto min-h-9 whitespace-normal text-left" disabled={disabled || !capability?.web_search}
    onClick={() => void run(`/api/papers/${sourcePaperId}/reference-research`, reference ? { reference_id: reference.id } : { research_key: key }, "reference-research")}>
    <Globe /> {researched ? "Webで再検索" : "内容・入手先をWebで調べる"}
  </Button>;
  return <section className="space-y-5 min-w-0" aria-label="参考文献の内容・入手先・PDF取り込み">
    {loadError && <p role="alert" className="text-xs text-destructive">調査結果を読み込めませんでした：{loadError.message}</p>}
    {targetId && <div className="space-y-3">
      <Button className="w-full" onClick={() => openReferencePaper(sourcePaperId, targetId)}><BookOpen />PDFを読む</Button>
      <div className="flex flex-wrap gap-2">
        {hasSummary ? <Button size="sm" variant="outline" onClick={() => openReferencePaper(sourcePaperId, targetId, true)}><ScrollText />サマリーを見る</Button>
          : <Button size="sm" variant="outline" disabled={disabled || record?.needs_ocr} onClick={() => void importPdf(true)}><ScrollText />サマリーを作成</Button>}
        <Button size="sm" variant="outline" onClick={chat}><MessageSquare />元の論文と比較する</Button>
      </div>
      {record?.needs_ocr && <p className="text-xs text-muted-foreground">文字の読み取りが必要です。PDFを開き、OCRで本文を読み取ってください。</p>}
      {record?.summary_error && <p className="text-xs text-destructive" role="alert">{record.summary_error}</p>}
    </div>}
    {!researched && !targetId && <div className="rounded-lg bg-muted/50 p-4 space-y-3">
      <p className="text-sm leading-relaxed">{capability?.web_search === false ? "公開元で文献の内容やPDFの入手先を確認できます。" : "まずは文献の内容と、公開PDFの入手先を調べましょう。"}</p>
      {capability?.web_search === false && reference?.url
        ? <Button size="sm" onClick={() => void shell.openUrl(reference.url).catch(e => showError(e, "文献のリンクを開けませんでした"))}><ExternalLink />外部で探す</Button>
        : researchButton}
    </div>}
    {(reference || record) && capability && !capability.web_search && <p className="text-xs text-muted-foreground">この接続先はWeb検索に対応していません。設定のAI接続を変更してください。</p>}
    {job && <div className="flex flex-wrap items-center gap-2 text-xs rounded-lg bg-muted p-3" role="status"><Loader2 className="size-3.5 animate-spin" /><span>{job.message}</span><Button size="sm" variant="outline" onClick={() => void requestCancel(job.job_id).catch(e => showError(e, "中止できませんでした"))}><Square />中止</Button></div>}
    {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    {record && researched && <>
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">Webで調べた概要</h4>
        {record.checked_at && <span className="text-xs text-muted-foreground">確認：{new Date(record.checked_at).toLocaleDateString()}</span>}</div>
      <MarkdownRenderer content={record.summary} className="text-sm" paperId={sourcePaperId} />
      <p className="text-xs text-muted-foreground">{BASIS[record.basis]}</p>
      <details className="text-xs"><summary className="cursor-pointer">出典・入手先 {record.sources.length}件</summary>
        <ul className="space-y-2 mt-2">{record.sources.map((item, i) => <li key={`${item.url}:${i}`}><button className="text-primary hover:underline text-left break-all" onClick={() => void shell.openUrl(item.url).catch(e => showError(e, "出典を開けませんでした"))}>［Web {i + 1}］{item.title} ↗</button></li>)}</ul>
      </details>
    </>}
    {!targetId && (researched || !!record?.pdfs.length) && <div className="rounded-lg border p-4 space-y-3">
      <h4 className="text-sm font-medium">PDFをライブラリに追加</h4>
      {!targetId && !!record?.pdfs.length && <>
        {!!record?.pdfs.length && <label className="block text-xs">取り込むPDF
          <select className="block w-full border rounded bg-background p-1.5 mt-1" value={selectedPdfIndex} disabled={disabled} onChange={e => setPdfIndex(Number(e.target.value))}>
            {record.pdfs.map((pdf, i) => <option key={`${pdf.url}:${i}`} value={i}>{pdf.title} · {pdf.version}</option>)}
          </select>
        </label>}
        <label className="block text-xs">保存先
          <select className="block w-full border rounded bg-background p-1.5 mt-1" value={collection} disabled={disabled} onChange={e => setFolder(e.target.value)}>
            <option value="">未分類</option>{[...new Set([...collections, ...(collection ? [collection] : [])])].filter(Boolean).map(name => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="flex gap-2 items-center text-xs"><input type="checkbox" checked={withSummary} disabled={disabled} onChange={e => setWithSummary(e.target.checked)} />取り込み後にサマリーを作成（AIの利用枠を使用）</label>
        <div className="flex flex-wrap gap-2">
          {!!record?.pdfs.length && <Button size="sm" className="h-auto min-h-9 whitespace-normal" disabled={disabled} onClick={() => void importPdf()}><Download />{withSummary ? "PDF取り込み・サマリー作成" : "PDFを取り込む"}</Button>}
        </div>
      </>}
      {!targetId && !record?.pdfs.length && <p className="text-xs text-muted-foreground">{researched
        ? "直接取得できる公開PDFは見つかりませんでした。出典・入手先から公開元を確認してください。"
        : "内容・入手先をWebで調べると、公開PDFの候補を確認して取り込めます。"}</p>}
    </div>}
    {(researched || targetId) && <div className="flex flex-wrap gap-2 border-t pt-3">
      {researchButton}
      {record && !targetId && <Button size="sm" variant="ghost" onClick={chat}><MessageSquare />この文献についてチャット</Button>}
    </div>}
  </section>;
}

export function ResearchCard({ sourcePaperId, record }: { sourcePaperId: string; record: ResearchRecord }) {
  return <details className="rounded-lg border p-3 mt-3 text-sm">
    <summary className="cursor-pointer break-words">{record.title} · 内容・入手先・PDF</summary>
    <div className="mt-3"><ResearchDetails sourcePaperId={sourcePaperId} recordKey={record.key} /></div>
  </details>;
}
