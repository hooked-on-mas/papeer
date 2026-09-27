import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { useReading } from "@/api/hooks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { askConfirm } from "@/components/AppDialogs";
import { startJob } from "@/features/jobs/jobEvents";
import { showError } from "@/components/errorDialog";
import { paperBusy, useStore } from "@/store";
import { jumpToPage } from "./navigation";
import { onAppEvent, type AppEvents } from "@/lib/appEvents";
import { paragraphOfSelection } from "@/lib/pdfSelection";
import { QK } from "@/lib/queryKeys";
import { useOpenEdit } from "@/lib/pendingSaves";

type Paragraph = { id: string; page: number; pages: number[]; source: string; text: string };
type Revision = { id: string; unit_id: string; before: string; after: string; created_at: string };

export function TranslationReview({ paperId }: { paperId: string }) {
  return <PaperReview key={paperId} paperId={paperId} />;
}

function PaperReview({ paperId }: { paperId: string }) {
  const client = useQueryClient();
  const { data: reading } = useReading(paperId);
  const currentPage = useStore(s => s.currentPage);
  const busy = useStore(s => paperBusy(s.activeJobs, paperId));
  const [open, setOpen] = useState(false);
  useOpenEdit(open, "訳文の修正");
  const [tab, setTab] = useState<"issues" | "edit">("issues");
  const [selected, setSelected] = useState<Paragraph | null>(null);
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState("自然な日本語にしてください。");
  const [pending, setPending] = useState(false);
  // Text selected in the PDF, waiting for the paragraphs to load so that its paragraph can be opened.
  const [target, setTarget] = useState<AppEvents["open-paragraph-editor"] | null>(null);
  const [unmatched, setUnmatched] = useState(false);
  const dirty = !!selected && text !== selected.text;
  const issues = new Map<number, Set<string>>();
  const add = (page: number, message: string) => { if (!issues.has(page)) issues.set(page, new Set()); issues.get(page)!.add(message); };
  if (reading) {
    for (let page = 1; page <= reading.page_count; page++) {
      if ((reading.translation_required_pages?.includes(page) ?? true)
          && !reading.completed_pages.includes(page) && !reading.empty_pages.includes(page)) add(page, "未翻訳");
    }
    reading.empty_pages.forEach(page => add(page, "抽出できる文字がありません"));
    reading.report?.skipped_block_pages?.forEach(page => add(page, "翻訳をスキップした段落があります"));
    [...(reading.report?.skipped_pages ?? []), ...(reading.preview?.skipped_pages ?? [])].forEach(page => add(page,
      reading.preview?.page_errors?.[String(page)] ?? reading.report?.page_errors?.[String(page)] ?? "PDF生成をスキップしました"));
  }
  // The issues tab only appears when there is something to check.
  const view = issues.size ? tab : "edit";
  const { data: paragraphs = [], isFetching, isError } = useQuery({ queryKey: [QK.paragraphs, paperId],
    queryFn: () => apiRequest<Paragraph[]>("GET", `/api/papers/${paperId}/paragraphs`), enabled: open && view === "edit" });
  const { data: history = [] } = useQuery({ queryKey: [QK.revisions, paperId],
    queryFn: () => apiRequest<Revision[]>("GET", `/api/papers/${paperId}/revisions`), enabled: open && view === "edit" });
  useEffect(() => {
    return onAppEvent("open-paragraph-editor", selection => { setOpen(true); setTab("edit"); setTarget(selection); setUnmatched(false); });
  }, []);
  useEffect(() => {
    if (!target || isFetching) return;
    setTarget(null);
    if (isError) return;
    const candidates = paragraphs.filter(p => p.pages.includes(target.page));
    const index = paragraphOfSelection(target.text, candidates.map(p => target.side === "translated" ? p.text : p.source));
    if (index < 0) { setUnmatched(true); return; }
    setSelected(candidates[index]); setText(candidates[index].text);
  }, [target, isFetching, isError, paragraphs]);
  const pageParagraphs = paragraphs.filter(p => p.pages.includes(currentPage));
  const choose = async (paragraph: Paragraph) => {
    if (dirty && !await askConfirm("修正案を破棄", "保存していない修正案を破棄しますか？", "破棄")) return;
    setSelected(paragraph); setText(paragraph.text); setUnmatched(false);
  };
  const run = async (draft: boolean, value = text) => {
    if (!selected || pending || busy) return;
    setPending(true);
    try {
      await startJob(`/api/papers/${paperId}/${draft ? "revision-draft" : "revision"}`,
        { unit_id: selected.id, text: value, instruction, expected_text: selected.text },
        { kind: draft ? "revision-draft" : "revision", paperId }, event => {
          setPending(false);
          if (event.status !== "succeeded") return;
          if (draft) setText(event.result.text);
          else {
            setSelected(null); setText("");
            client.invalidateQueries({ queryKey: [QK.paragraphs, paperId] });
            client.invalidateQueries({ queryKey: [QK.revisions, paperId] });
          }
        });
    } catch (error) { setPending(false); showError(error, "翻訳の修正を実行できませんでした"); }
  };
  return <>
    <button className="rounded px-2 py-1 hover:bg-muted" onClick={() => { setOpen(true); setTab("issues"); }}>翻訳の確認・修正{issues.size ? ` (${issues.size})` : ""}</button>
    <Dialog open={open} onOpenChange={async next => {
      if (!next && (pending || busy)) return;
      if (!next && dirty && !await askConfirm("修正案を破棄", "保存していない修正案を破棄しますか？", "破棄")) return;
      if (!next) { setSelected(null); setText(""); setTarget(null); setUnmatched(false); }
      setOpen(next);
    }}>
      <DialogContent className="sm:max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogTitle>{issues.size ? "翻訳の確認・修正" : "翻訳を修正"}</DialogTitle>
        <DialogDescription>{issues.size ? "要確認箇所へ移動したり、訳文を修正してPDFに反映できます。" : "訳文を段落ごとに修正してPDFに反映できます。"}</DialogDescription>
        {!!issues.size && <div className="flex gap-2"><Button variant={view === "issues" ? "default" : "outline"} onClick={() => setTab("issues")}>要確認箇所</Button>
          <Button variant={view === "edit" ? "default" : "outline"} onClick={() => setTab("edit")}>翻訳を修正</Button></div>}
        {view === "issues" ? <div className="space-y-2 text-sm">
          {[...issues].sort(([a], [b]) => a - b).map(([page, messages]) => <button key={page} className="block w-full text-left border rounded p-3 hover:bg-muted"
            onClick={() => { jumpToPage(page); setOpen(false); }}>p.{page} — {[...messages].join(" / ")}</button>)}
          {!!reading?.report?.skipped_blocks?.length && <p className="text-destructive">翻訳をスキップした段落が{reading.report.skipped_blocks.length}箇所あります。原文と照合してください。</p>}
        </div> : <div className="space-y-3 text-sm">
          {isFetching && <p>段落を読み込み中…</p>}{isError && <p className="text-destructive">段落を読み込めませんでした。</p>}
          {!isFetching && !paragraphs.length && <p>修正できる翻訳済み段落はありません。翻訳後、または辞書変更後の再翻訳後に利用できます。</p>}
          {!!paragraphs.length && <p className="font-medium">p.{currentPage} の訳文 — 直したい段落を選んでください</p>}
          {unmatched && !!pageParagraphs.length && <p className="text-muted-foreground">選択した文章の段落を特定できませんでした。一覧から選んでください。</p>}
          {!isFetching && !!paragraphs.length && !pageParagraphs.length && <p className="text-muted-foreground">このページには修正できる訳文がありません。</p>}
          {!!pageParagraphs.length && <div className="max-h-32 overflow-auto border rounded">{pageParagraphs.map(p => <button key={p.id}
            disabled={pending || busy} className={`block w-full text-left p-2 border-b hover:bg-muted ${selected?.id === p.id ? "bg-muted" : ""}`}
            onClick={() => void choose(p)}>p.{p.pages.join(", ")}　{p.text.slice(0, 160)}</button>)}</div>}
          {!!paragraphs.length && <p className="text-xs text-muted-foreground">別のページを直すときは、PDFでそのページを表示してください。</p>}
          {selected && <>
            <p className="text-xs text-muted-foreground">数式の目印は残してください。修正案は「採用してPDFに反映」を押すまで保存されません。</p>
            <details><summary className="cursor-pointer">原文を見る</summary><p className="whitespace-pre-wrap border rounded p-3 mt-2">{selected.source}</p></details>
            <div className="grid grid-cols-2 gap-3">
              <div><p className="font-medium mb-1">変更前</p><div className="border rounded p-3 h-48 overflow-auto whitespace-pre-wrap">{selected.text}</div></div>
              <label className="font-medium">修正案<textarea aria-label="訳文の修正案" disabled={pending || busy} className="mt-1 border rounded bg-background p-3 w-full h-48 font-normal" value={text} onChange={e => setText(e.target.value)} /></label>
            </div>
            <div className="flex flex-wrap gap-2"><input aria-label="再翻訳の指示" className="flex-1 min-w-48 border rounded bg-background px-2" value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="例：直訳寄りにしてください" />
              <Button variant="outline" disabled={pending || busy} onClick={() => void run(true)}>AIで修正案を作る</Button>
              <Button disabled={pending || busy || !text.trim() || !dirty} onClick={() => void run(false)}>{pending ? "処理中…" : "採用してPDFに反映"}</Button></div>
            {history.filter(h => h.unit_id === selected.id && h.after === selected.text).slice(-1).map(h => <Button key={h.id} variant="outline" disabled={pending || busy}
              onClick={async () => { if (await askConfirm("修正を取り消す", "この段落を前の訳文に戻し、PDFへ反映します。", "元に戻す")) void run(false, h.before); }}>前の訳文に戻す（{h.created_at}）</Button>)}
          </>}
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
