import { useEffect, useState } from "react";
import {
  Download, ExternalLink, FileText, FolderOpen, Languages, MoreVertical, PanelLeft, Pencil, ScrollText, Square, Trash2,
} from "lucide-react";
import { useStore, paperBusy } from "../store";
import { runningPaperJob } from "@/features/jobs/jobSelectors";
import { paperDisplayName, usePaper, useReading } from "../api/hooks";
import { PaperStatusBadge } from "../components/ui/PaperStatusBadge";
import { paperTranslationStatus } from "@/lib/paperStatus";
import { TranslationDialog } from "../features/reader/TranslationDialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  deletePaper, exportMarkdown, exportPdf, generateArticle, openPaperFile, openPaperFolder, renamePaperFile, saveOriginal,
} from "./actions";
import { TRANSLATION_JOBS } from "@/features/jobs/jobKinds";
import { cancelJob } from "@/features/jobs/jobEvents";
import { emitAppEvent, onAppEvent } from "@/lib/appEvents";

export function Header() {
  const activePaperId = useStore((s) => s.activePaperId);
  const translateJobId = useStore((s) => runningPaperJob(s.activeJobs, s.activePaperId, TRANSLATION_JOBS)?.job_id);
  const busy = useStore((s) => paperBusy(s.activeJobs, s.activePaperId));
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);

  const { data: paper } = usePaper(activePaperId);
  const { data: reading } = useReading(activePaperId);

  const toggleSidebar = (
    <button
      onClick={() => useStore.getState().setSidebarCollapsed(!sidebarCollapsed)}
      className={`p-1.5 mr-2 rounded-md hover:bg-muted shrink-0 ${sidebarCollapsed ? "text-muted-foreground" : "text-foreground"}`}
      title="左パネルの表示を切り替え（Ctrl+B）"
      aria-label="ライブラリ"
    >
      <PanelLeft className="w-4 h-4" />
    </button>
  );

  if (!activePaperId) {
    return (
      <header className="h-13 border-b flex items-center px-3 shrink-0 bg-background/50">
        {toggleSidebar}
        <div className="flex flex-col">
          <h1 className="text-[0.9375rem] font-semibold">論文を追加して、読み始めよう</h1>
          <span className="text-[0.75rem] text-muted-foreground">PDFを追加 → AI接続を設定 → 翻訳・解説・チャット</span>
        </div>
      </header>
    );
  }

  const translation = paperTranslationStatus(paper, !!translateJobId, reading);
  const { status } = translation;

  const handleCancel = async () => {
    if (translateJobId) {
      await cancelJob(translateJobId);
    }
  };

  const exportBlocked = !reading?.has_translated || !!reading?.in_progress;
  const meta = [
    paper?.first_author,
    paper?.publication_year,
    paper?.collection_name || "未分類",
    `${paper?.pages ?? "?"}ページ`,
  ].filter(Boolean).join(" · ");

  return (
    <header className="h-13 border-b flex items-center pl-3 pr-4 justify-between shrink-0 bg-background/50">
      {toggleSidebar}
      <div className="flex flex-col min-w-0 flex-1 pr-4">
        <h1
          className="text-[0.9375rem] font-semibold truncate cursor-pointer hover:underline"
          title={paper ? `${paperDisplayName(paper)}\nクリックで論文情報・メモを開く` : ""}
          onClick={() => useStore.getState().setActiveTab("notes")}
        >
          {paper ? paperDisplayName(paper) : "読み込み中…"}
        </h1>
        <div className="flex items-center gap-2 text-[0.75rem] text-muted-foreground mt-0.5 min-w-0">
          <span className="truncate" title={meta}>{meta}</span>
          <span className="text-border">|</span>
          <PaperStatusBadge status={status} text={`${translation.text} · ${translation.count}`} description={translation.description} hasSummary={!!paper?.has_article} className="shrink-0" />
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {translateJobId ? (
          <button onClick={handleCancel} className="flex items-center gap-1.5 bg-destructive text-white px-3 py-1.5 rounded-md text-[0.8125rem] font-medium hover:opacity-90 transition-opacity">
            <Square className="w-3.5 h-3.5" /> 中止
          </button>
        ) : (
          <button
            onClick={() => emitAppEvent("open-translate-dialog")}
            disabled={busy}
            title="翻訳するページとモデルを選んで開始します（Ctrl+T）。保存済みの訳文は再利用します。"
            className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-[0.8125rem] font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Languages className="w-4 h-4" />
            {["partial", "paused", "review", "failed"].includes(status) ? "翻訳 / 再開…" : status === "translated" ? "再翻訳…" : "翻訳する…"}
          </button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger className="p-1.5 hover:bg-muted rounded-md text-muted-foreground transition-colors inline-flex items-center gap-1 text-[0.8125rem]" title="その他">
            <MoreVertical className="w-4 h-4" /> その他
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem disabled={busy} onClick={() => generateArticle(activePaperId)}>
              <ScrollText className="w-4 h-4 mr-2" /> サマリー（解説）を作成
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={busy || exportBlocked}>
                <Download className="w-4 h-4 mr-2" /> PDFを書き出す
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                <DropdownMenuItem onClick={() => exportPdf(activePaperId, "translated")}>日本語訳</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportPdf(activePaperId, "interleaved")}>原文と訳文の交互ページ</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportPdf(activePaperId, "bilingual")}>原文と訳文の対訳（左右）</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem disabled={!reading?.has_article} onClick={() => exportMarkdown(activePaperId)}>
              <FileText className="w-4 h-4 mr-2" /> サマリーをMarkdownで保存
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => openPaperFile(activePaperId, "original.pdf")}>
              <ExternalLink className="w-4 h-4 mr-2" /> 原文を外部で開く
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!reading?.has_translated} onClick={() => openPaperFile(activePaperId, "translated.pdf")}>
              <ExternalLink className="w-4 h-4 mr-2" /> 日本語訳を外部で開く
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!reading?.has_translated || busy} onClick={() => openPaperFile(activePaperId, "interleaved.pdf")}>
              <ExternalLink className="w-4 h-4 mr-2" /> 原文・日本語訳（交互）を外部で開く
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => saveOriginal(activePaperId)}>
              <Download className="w-4 h-4 mr-2" /> 原文PDFを名前を付けて保存…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => renamePaperFile(activePaperId)}>
              <Pencil className="w-4 h-4 mr-2" /> ファイル名を変更…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openPaperFolder(activePaperId)}>
              <FolderOpen className="w-4 h-4 mr-2" /> 保存フォルダーを開く
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={busy} className="text-destructive" onClick={() => deletePaper(activePaperId)}>
              <Trash2 className="w-4 h-4 mr-2" /> ライブラリから削除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/** Mounted outside the header, so that Ctrl+T and the reader's buttons also work in focus mode. */
export function TranslationDialogHost() {
  const activePaperId = useStore((s) => s.activePaperId);
  const currentPage = useStore((s) => s.currentPage);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    return onAppEvent("open-translate-dialog", () => { if (useStore.getState().activePaperId) setOpen(true); });
  }, []);
  if (!activePaperId) return null;
  return <TranslationDialog open={open} onOpenChange={setOpen} paperId={activePaperId} currentPage={currentPage} />;
}
