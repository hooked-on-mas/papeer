import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { paperDisplayName, useCollections, usePaper, useReading, type PaperData, type ReadingData } from "@/api/hooks";
import { openPaperFolder } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { onAppEvent } from "@/lib/appEvents";
import { storedStatusLabel } from "@/lib/paperStatus";
import { itemCapabilities } from "@/lib/itemKinds";
import { PaperMetadataForm } from "./PaperMetadataForm";
import { RelatedItems } from "@/features/library/RelatedItems";

function metaLines(paper: PaperData, reading: ReadingData | null | undefined): { text: string; title?: string }[] {
  const caps = itemCapabilities(paper);
  // The translation state is left out for an item that is not translated (a notebook).
  const lines: { text: string; title?: string }[] = [{ text: caps.translate
    ? `${paper.pages ?? "?"} ページ / ${storedStatusLabel(paper.status)}` : `${paper.pages ?? "?"} ページ` }];
  if (!caps.ocr) return lines;
  if (reading?.empty_pages?.length) lines.push({ text: `文字のないページ: ${reading.empty_pages.join(", ")}` });
  const ocr = reading?.ocr_pages ?? [];
  const whole = ocr.filter(entry => entry.reason !== "partial").map(entry => entry.page);
  const partial = ocr.filter(entry => entry.reason === "partial").map(entry => entry.page);
  if (whole.length) lines.push({ text: "要OCR: p." + whole.join(", "), title: "文字化け・画像だけのページは翻訳せず原文のまま表示します" });
  if (partial.length) lines.push({ text: "一部文字化け: p." + partial.join(", "), title: "文字化けした段落は翻訳せず原文のまま表示します" });
  if (reading?.report?.skipped_pages?.length) lines.push({ text: "PDF生成スキップ: p." + reading.report.skipped_pages.join(", ") });
  return lines;
}

/** Kept outside the header so the reader and memo stay mounted, including in focus mode.
 * The requested paper is independent of the open PDF: a library row can be edited without opening it. */
export function PaperDetailsPanel() {
  const [paperId, setPaperId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => onAppEvent("open-paper-details", ({ paperId }) => {
    setPaperId(paperId);
    setOpen(true);
  }), []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent overlayClassName="supports-backdrop-filter:backdrop-blur-none"
        className="left-auto right-0 top-0 h-dvh max-w-full translate-x-0 translate-y-0 rounded-none flex flex-col gap-0 p-0 sm:max-w-[28rem]">
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
          <DialogTitle>論文情報・整理</DialogTitle>
          <DialogDescription className="sr-only">読書状態・タグ・フォルダーと書誌情報を確認・編集できます。</DialogDescription>
        </DialogHeader>
        {paperId && <PaperDetails key={paperId} paperId={paperId} />}
        <div className="shrink-0 flex justify-end border-t p-3">
          <DialogClose render={<Button variant="outline" />}>閉じる</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PaperDetails({ paperId }: { paperId: string }) {
  const { data: paper, isError, refetch } = usePaper(paperId);
  const { data: reading } = useReading(paperId);
  const { data: collections = [] } = useCollections();
  const caps = itemCapabilities(paper);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 space-y-3">
      {isError ? <div role="alert" className="space-y-3">
        <p>論文情報を読み込めませんでした。</p>
        <Button variant="outline" onClick={() => void refetch()}>再試行</Button>
      </div> : !paper ? <p className="text-muted-foreground">読み込み中…</p> : <>
        <p className="text-[0.875rem] font-medium break-words">{paperDisplayName(paper)}</p>
        <div className="text-[0.75rem] text-muted-foreground space-y-0.5">
          {metaLines(paper, reading).map(line => <div key={line.text} title={line.title}>{line.text}</div>)}
        </div>
        <PaperMetadataForm paper={paper} collections={collections} />
        <RelatedItems paperId={paperId} />
        <section className="space-y-2 border-t pt-4">
          <h3 className="text-[0.8125rem] font-semibold">ファイル</h3>
          <div className="text-[0.75rem] text-muted-foreground space-y-0.5 break-words">
            {caps.originalPdf && <div>{paper.original_name ?? "original.pdf"}（原文）</div>}
            {caps.translate && <div>日本語訳：{reading?.has_translated ? (reading.in_progress ? "翻訳途中" : "あり") : "未作成"}</div>}
            {caps.summary && <div>サマリー：{reading?.has_article ? "あり" : "未作成"}</div>}
          </div>
          <Button variant="outline" onClick={() => openPaperFolder(paperId)}>
            <FolderOpen className="w-4 h-4" /> 保存フォルダーを開く
          </Button>
        </section>
      </>}
    </div>
  );
}
