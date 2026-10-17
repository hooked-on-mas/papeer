import { useState } from "react";
import { BookOpen, Download, ExternalLink, Globe, Loader2, MessageSquare, ScrollText, Square } from "lucide-react";
import { useCollections, usePaper } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { showError } from "@/components/errorDialog";
import { startJob, requestCancel } from "@/features/jobs/jobEvents";
import { paperBusyFor, runningPaperJob } from "@/features/jobs/jobSelectors";
import { generateArticle } from "@/app/actions";
import { shell } from "@/shell";
import { paperBusy, useStore } from "@/store";
import type { Reference } from "./graph";
import { useResearch, useWebSearchCapability, type ResearchRecord } from "./researchHooks";
import { openReferencePaper } from "./researchNavigation";
import { useAutoResearch } from "./autoResearch";
import { openSettings } from "@/features/settings/settingsNavigation";
import { ResearchFailureNotice } from "./ResearchFailureNotice";

const BASIS = { abstract: "抄録に基づく概要 · 本文は未確認", full_text: "公開本文に基づく概要", metadata: "書誌情報のみ確認", unresolved: "文献を特定できませんでした。候補は原文で確認してください。" };

export function ResearchDetails({ sourcePaperId, reference, recordKey, registeredPaperId, showInformationSettings = true }: {
  sourcePaperId: string; reference?: Reference; recordKey?: string; registeredPaperId?: string | null; showInformationSettings?: boolean;
}) {
  const key = recordKey ?? reference?.research_key ?? "";
  const { data: records = [], error: loadError } = useResearch(sourcePaperId);
  const record = records.find(r => r.key === key);
  const { data: source } = usePaper(sourcePaperId);
  const targetId = record?.paper_id ?? (registeredPaperId === sourcePaperId ? null : registeredPaperId) ?? null;
  const { data: target } = usePaper(targetId);
  const { data: collections = [] } = useCollections();
  const { data: capability } = useWebSearchCapability();
  const informationEnabled = capability?.reference_research_enabled === true;
  const canResearch = informationEnabled && (capability?.reference_lookup === true || capability?.reference_web_search === true);
  const [pdfIndex, setPdfIndex] = useState(0);
  const [folder, setFolder] = useState<string | null>(null);
  const [withSummary, setWithSummary] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const automatic = useAutoResearch(s => s.active);
  const job = useStore(s => runningPaperJob(s.activeJobs.filter(job =>
    !automatic.some(item => item.jobId === job.job_id && item.key !== key)), sourcePaperId, ["reference-research", "reference-import"]));
  const busy = useStore(s => paperBusy(s.activeJobs, sourcePaperId, ["paper-discovery"]) || paperBusy(s.activeJobs, targetId, ["paper-discovery"]));
  const summaryBusy = useStore(s => paperBusyFor(s.activeJobs, targetId, "article"));
  const disabled = busy || submitting;
  const collection = folder ?? source?.collection_name ?? "";
  const hasSummary = target?.has_article || record?.has_summary;
  const researched = !!record && (!!record.summary || record.sources.length > 0);
  const doi = record?.doi || reference?.doi;
  const arxiv = record?.arxiv_id || reference?.arxiv_id;
  const title = record?.title || reference?.title || record?.raw || reference?.raw || "";
  const scholarUrl = `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`;
  const links = [...new Map([
    ...(doi ? [{ label: "DOI", url: `https://doi.org/${encodeURIComponent(doi).replace(/%2F/gi, "/")}` }] : []),
    ...(arxiv ? [{ label: "arXiv", url: `https://arxiv.org/abs/${encodeURIComponent(arxiv).replace(/%2F/gi, "/")}` }] : []),
    ...(reference?.url && !doi && !arxiv && /^https?:\/\//i.test(reference.url) ? [{ label: "文献リンク", url: reference.url }] : []),
    ...(title ? [{ label: "Google Scholarでタイトルを検索", url: scholarUrl }] : []),
  ].map(link => [link.url, link])).values()];
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
  const importPdf = async () => {
    await run(`/api/papers/${sourcePaperId}/reference-import/${key}`, {
      pdf_index: targetId ? null : selectedPdfIndex, collection,
      create_summary: withSummary,
    }, "reference-import");
  };
  const importLocalPdf = async () => {
    try {
      const paths = await shell.openFiles([{ name: "PDF", extensions: ["pdf"] }]);
      if (!paths.length) return;
      if (paths.length !== 1) throw new Error("この文献のPDFを1件選んでください。");
      await run(`/api/papers/${sourcePaperId}/reference-import/${key}`, {
        local_path: paths[0], collection, create_summary: withSummary,
      }, "reference-import");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const chat = () => {
    const store = useStore.getState();
    store.setActivePaperId(sourcePaperId);
    store.setChatDraft({ paperId: sourcePaperId, text: targetId
      ? `この${reference ? "参考文献" : "論文"}と、今読んでいる論文の手法・結果・限界を比較してください。`
      : `この${reference ? "参考文献" : "論文"}と、今読んでいる論文の関係を教えてください。`,
      researchKeys: record ? [key] : [], paperIds: targetId ? [...new Set([sourcePaperId, targetId])] : undefined });
    store.openSidePanel("chat");
  };
  const researchButton = (reference || record) && (canResearch || showInformationSettings) && <Button size="sm" variant={!researched && !targetId ? "default" : "ghost"}
    className="h-auto min-h-9 whitespace-normal text-left" disabled={disabled || !canResearch}
    onClick={() => void run(`/api/papers/${sourcePaperId}/reference-research`, reference ? { reference_id: reference.id } : { research_key: key }, "reference-research")}>
    <Globe /> {researched || record?.last_failure ? "情報を再取得" : "内容・入手先を取得"}
  </Button>;
  const openLink = (url: string) => void shell.openUrl(url).catch(e => showError(e, "文献のリンクを開けませんでした"));
  return <section className="space-y-4 min-w-0" aria-label="文献の内容・入手先・PDF取り込み">
    {(record?.first_author || record?.publication_year || record?.venue) && <p className="text-xs text-muted-foreground break-words">{[record.first_author, record.publication_year, record.venue].filter(Boolean).join(" · ")}</p>}
    {loadError && <p role="alert" className="text-xs text-destructive">調査結果を読み込めませんでした：{loadError.message}</p>}
    {targetId && <div className="space-y-3">
      <Button className="w-full" onClick={() => openReferencePaper(sourcePaperId, targetId)}><BookOpen />論文を開く</Button>
      <div className="flex flex-wrap gap-2">
        {hasSummary ? <Button size="sm" variant="outline" onClick={() => openReferencePaper(sourcePaperId, targetId, true)}><ScrollText />サマリーを見る</Button>
          : <Button size="sm" variant="outline" disabled={summaryBusy || submitting || record?.needs_ocr} onClick={() => void generateArticle(targetId)}><ScrollText />サマリーを作成</Button>}
        <Button size="sm" variant="outline" onClick={chat}><MessageSquare />元の論文と比較する</Button>
      </div>
      {record?.needs_ocr && <p className="text-xs text-muted-foreground">文字の読み取りが必要です。PDFを開き、OCRで本文を読み取ってください。</p>}
      {record?.summary_error && <p className="text-xs text-destructive" role="alert">{record.summary_error}</p>}
    </div>}
    {!researched && !targetId && <div className="rounded-lg bg-muted/50 p-4 space-y-3">
      <p className="text-sm leading-relaxed">{canResearch ? "概要と公開PDFの入手先を調べます。" : "文献リンクから内容やPDFを確認できます。"}</p>
      {researchButton}
    </div>}
    {showInformationSettings && (reference || record) && capability && !canResearch && <p className="text-xs text-muted-foreground leading-relaxed">
      {!informationEnabled ? "設定の「論文情報の取得にAIを使う」をONにすると、自動取得と情報の再取得を利用できます。"
        : "情報取得の接続を確認できません。接続後に再度お試しください。"}
      <button className="ml-1 text-primary underline" onClick={() => openSettings("connection")}>設定を開く</button>
    </p>}
    {job && <div className="flex flex-wrap items-center gap-2 text-xs rounded-lg bg-muted p-2" role="status"><Loader2 className="size-3.5 animate-spin" /><span>{job.kind === "reference-import" ? "PDFを取り込んでいます…" : "文献の情報を集めています…"}</span><Button size="sm" variant="ghost" onClick={() => void requestCancel(job.job_id).catch(e => showError(e, "中止できませんでした"))}><Square />中止</Button></div>}
    {record?.last_failure && <ResearchFailureNotice failure={record.last_failure} openLink={openLink} />}
    {error && <details className="text-xs text-destructive" role="alert"><summary className="cursor-pointer">処理を完了できませんでした · 詳細</summary><p className="mt-2 whitespace-pre-wrap break-words">{error}</p></details>}
    {!targetId && researched && record && <div className="rounded-xl border bg-primary/5 p-3 space-y-3">
      {!!record.pdfs.length ? <>
        <Button className="w-full h-auto min-h-10 whitespace-normal" disabled={disabled} onClick={() => void importPdf()}><Download />{withSummary ? "PDF取り込み・サマリー作成" : "PDFを取り込む"}</Button>
        <p className="text-xs text-muted-foreground">{record.pdfs[selectedPdfIndex]?.version} · {collection || "未分類"}に保存</p>
      </> : <div className="flex flex-wrap gap-2">
        {title && <Button size="sm" variant="outline" onClick={() => openLink(scholarUrl)}><ExternalLink />Google Scholarで開く</Button>}
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void importLocalPdf()}><Download />保存したPDFを取り込む</Button>
      </div>}
      <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">取り込み設定</summary><div className="space-y-3 pt-3">
        {record.pdfs.length > 1 && <label className="block">取り込むPDF<select className="block w-full min-w-0 border rounded bg-background p-1.5 mt-1" value={selectedPdfIndex} disabled={disabled} onChange={e => setPdfIndex(Number(e.target.value))}>{record.pdfs.map((pdf, i) => <option key={pdf.url} value={i}>{pdf.version} · {pdf.title}</option>)}</select></label>}
        <label className="block">保存先<select className="block w-full border rounded bg-background p-1.5 mt-1" value={collection} disabled={disabled} onChange={e => setFolder(e.target.value)}><option value="">未分類</option>{[...new Set([...collections, ...(collection ? [collection] : [])])].filter(Boolean).map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        <label className="flex gap-2 items-center"><input type="checkbox" checked={withSummary} disabled={disabled} onChange={e => setWithSummary(e.target.checked)} />取り込み後にサマリーを作成（AIの利用枠を使用）</label>
      </div></details>
    </div>}
    {links.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs" aria-label="文献リンク">{links.filter(link => link.label !== "文献リンク" || (!doi && !arxiv)).map(link => <a key={link.url} href={link.url} title={link.url} className="inline-flex items-center gap-1 text-primary hover:underline" onClick={event => { event.preventDefault(); openLink(link.url); }}><ExternalLink className="size-3" />{link.label === "Google Scholarでタイトルを検索" ? "Google Scholar" : link.label}</a>)}</div>}
    {record && researched && <>
      {record.summary && <div className="space-y-2"><h4 className="text-sm font-medium">この論文の概要</h4><MarkdownRenderer content={record.summary} className="text-sm leading-relaxed break-words" paperId={sourcePaperId} /><p className="text-xs text-muted-foreground">{BASIS[record.basis]}</p></div>}
      {record.abstract && <details className="text-sm rounded-lg bg-muted/30 p-3" open={!record.summary}><summary className="cursor-pointer text-xs font-medium">抄録（原文）</summary><p className="mt-3 whitespace-pre-wrap leading-relaxed break-words">{record.abstract}</p></details>}
      <details className="text-xs"><summary className="cursor-pointer">出典・入手先 {record.sources.length}件</summary>
        <ul className="space-y-2 mt-2">{record.sources.map((item, i) => <li key={`${item.url}:${i}`}><button className="text-primary hover:underline text-left break-all" onClick={() => void shell.openUrl(item.url).catch(e => showError(e, "出典を開けませんでした"))}>［Web {i + 1}］{item.title} ↗</button></li>)}</ul>
      </details>
    </>}
    {(researched || targetId) && (researchButton || record && !targetId) && <div className="flex flex-wrap gap-2 border-t pt-3">
      {researchButton}
      {record && !targetId && <Button size="sm" variant="ghost" onClick={chat}><MessageSquare />この文献についてチャット</Button>}
    </div>}
    {record && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">取得状況・詳細</summary><div className="space-y-3 pt-3 break-words">{record.checked_at && <p>最終取得：{new Date(record.checked_at).toLocaleString()}</p>}{record.diagnostics?.map((note, index) => <MarkdownRenderer key={index} content={note} className="text-xs break-words" paperId={sourcePaperId} />)}</div></details>}
  </section>;
}

export function ResearchCard({ sourcePaperId, record }: { sourcePaperId: string; record: ResearchRecord }) {
  return <details className="rounded-lg border p-3 mt-3 text-sm">
    <summary className="cursor-pointer break-words">{record.title} · 内容・入手先・PDF</summary>
    <div className="mt-3"><ResearchDetails sourcePaperId={sourcePaperId} recordKey={record.key} /></div>
  </details>;
}
