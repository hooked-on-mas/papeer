import { newNotebook, moveNotebook } from "@/features/notebooks/NotebookDialogs";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen, Download, ExternalLink, FileText, FolderOpen, Languages, MoreVertical, PanelLeft, Pencil, ScrollText, Square, Trash2,
} from "lucide-react";
import { useStore, paperBusy } from "../store";
import { useNotebook } from "@/features/notebooks/notebooks";
import { RelatedItems } from "@/features/library/RelatedItems";
import { openPaper } from "@/features/library/selectionStore";
import { useInkPdfExport } from "@/features/reader/inkControls";
import { paperBusyFor, runningPaperJob } from "@/features/jobs/jobSelectors";
import { paperDisplayName, useItemCapabilities, usePaper, useReading, type PaperData } from "../api/hooks";
import { activeItemCapabilities } from "@/features/reader/navigation";
import { itemCapabilities } from "@/lib/itemKinds";
import { PaperStatusBadge } from "../components/ui/PaperStatusBadge";
import { paperTranslationStatus } from "@/lib/paperStatus";
import { TranslationDialog } from "../features/reader/TranslationDialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  deletePaper, exportMarkdown, exportPdf, generateArticle, openPaperFile, openPaperFolder, renamePaperFile, renamePaperTo, saveOriginal,
} from "./actions";
import { TRANSLATION_JOBS } from "@/features/jobs/jobKinds";
import { cancelJob } from "@/features/jobs/jobEvents";
import { emitAppEvent, onAppEvent } from "@/lib/appEvents";
import { useRebuilding } from "@/features/reader/rebuildJobs";
import { withShortcutLabels } from "@/lib/platform";
import { isImeKey } from "@/lib/imeKeys";

/**
 * A notebook's name in the header: pressing it (or F2) turns it into a field to rename it in place;
 * Enter or leaving the field keeps the name, Esc leaves it as it was.
 */
function NotebookTitle({ paper }: { paper: PaperData }) {
  const [text, setText] = useState<string | null>(null);
  const cancelled = useRef(false);
  const current = paper.original_name || paper.title;
  const start = () => { cancelled.current = false; setText(current); };
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => onAppEvent("edit-item-title", () => startRef.current()), []);
  // Another notebook doesn't inherit the field being edited.
  useEffect(() => setText(null), [paper.id]);
  const commit = () => {
    const name = text?.trim();
    setText(null);
    if (name && name !== current) void renamePaperTo(paper.id, name, { notebook: true });
  };
  if (text === null) {
    return (
      <h1 className="text-[0.9375rem] font-semibold truncate" title={paperDisplayName(paper)}>
        <button type="button" className="max-w-full truncate rounded px-1 -mx-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          title={withShortcutLabels("クリックして名前を変更（F2）")} onClick={start}>
          {paper.title || paperDisplayName(paper)}
        </button>
      </h1>
    );
  }
  return (
    <h1 className="text-[0.9375rem] font-semibold">
      <input autoFocus aria-label="ノート名" value={text} onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (isImeKey(e.nativeEvent)) return;
          if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
          if (e.key === "Escape") { e.preventDefault(); cancelled.current = true; setText(null); }
        }}
        onBlur={() => { if (cancelled.current) cancelled.current = false; else commit(); }}
        className="w-full max-w-lg rounded border bg-background px-1 py-0 font-semibold focus:ring-2 focus:ring-ring focus:outline-none" />
    </h1>
  );
}

export function Header() {
  const activePaperId = useStore((s) => s.activePaperId);
  const uiStateLoaded = useStore((s) => s.uiStateLoaded);
  const translateJobId = useStore((s) => runningPaperJob(s.activeJobs, s.activePaperId, TRANSLATION_JOBS)?.job_id);
  const busy = useStore((s) => paperBusy(s.activeJobs, s.activePaperId));
  const workBusy = useStore((s) => paperBusyFor(s.activeJobs, s.activePaperId, "article"));
  // The translation dialog opens while the AI checks the paper's terms, showing that check as it goes on.
  const translateBlocked = useStore((s) => paperBusyFor(s.activeJobs, s.activePaperId, "translate", ["glossary-draft", "glossary-select", "glossary-split"]));
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const rebuilding = useRebuilding(translateJobId);

  const { data: paper } = usePaper(activePaperId);
  const { data: owner } = usePaper(paper?.parent_id ?? null);
  const { data: reading } = useReading(activePaperId);
  // What the open item can do: the controls of what it cannot (a notebook is not translated) are not offered.
  const caps = itemCapabilities(paper);
  const { data: notebook } = useNotebook(activePaperId, caps.notebook);
  const { exporting: exportingInk, exportPdf: exportInkPdf } = useInkPdfExport();

  const toggleSidebar = (
    <button
      onClick={() => useStore.getState().setSidebarCollapsed(!sidebarCollapsed)}
      className={`p-1.5 mr-2 rounded-md hover:bg-muted shrink-0 ${sidebarCollapsed ? "text-muted-foreground" : "text-foreground"}`}
      title={withShortcutLabels("左パネルの表示を切り替え（Ctrl+B）")}
      aria-label="ライブラリ"
    >
      <PanelLeft className="w-4 h-4" />
    </button>
  );

  if (!activePaperId) {
    return (
      <header className="h-13 border-b flex items-center px-3 shrink-0 bg-background/50">
        {toggleSidebar}
        {!uiStateLoaded ? (
          <div aria-hidden="true" className="flex flex-col gap-1.5">
            <div className="h-4 w-48 rounded bg-muted" />
            <div className="h-3 w-64 max-w-full rounded bg-muted/60" />
          </div>
        ) : (
          <div className="flex flex-col">
            <h1 className="text-[0.9375rem] font-semibold">論文を選んで、読み始めよう</h1>
          </div>
        )}
      </header>
    );
  }

  const translation = paperTranslationStatus(paper, !!translateJobId, reading, { rebuilding });
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
    paper?.parent_id ? `持ち主：${owner?.title ?? "読み込み中…"}` : paper?.collection_name || "未分類",
  ].filter(Boolean).join(" · ");
  // A notebook's line says what it is and where, and how long: 「ノート · フォルダー · nページ」, or whose it is.
  // (No date of its last change: the API doesn't give one.)
  const pageText = `${notebook?.pages.length ?? paper?.pages ?? 0}ページ`;

  return (
    <header className="h-13 border-b flex items-center pl-3 pr-4 justify-between shrink-0 bg-background/50">
      {toggleSidebar}
      <div className="flex flex-col min-w-0 flex-1 pr-4">
        {paper && caps.notebook ? <NotebookTitle paper={paper} /> : <h1
          className="text-[0.9375rem] font-semibold truncate"
          title={paper ? paperDisplayName(paper) : ""}
        >
          {paper ? (paper.title || paperDisplayName(paper)) : "読み込み中…"}
        </h1>}
        <div className="flex items-center gap-2 text-[0.75rem] text-muted-foreground mt-0.5 min-w-0">
          {paper && caps.notebook ? (
            <span className="truncate" data-notebook-meta="">
              {paper.parent_id ? <>
                {owner ? <button type="button" className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  title="持ち主の論文を開く" onClick={() => openPaper(owner.id, owner.collection_name)}>{owner.title || paperDisplayName(owner)}</button> : "読み込み中…"}
                の専用ノート
              </> : `ノート · ${paper.collection_name || "未分類"}`} · {pageText}
            </span>
          ) : <span className="truncate" title={meta}>{meta}</span>}
          {translation.applicable && <>
            <span className="text-border">|</span>
            <PaperStatusBadge status={status} text={`${translation.text} · ${translation.count}`} description={translation.description} hasSummary={!!paper?.has_article} className="shrink-0" />
          </>}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {caps.linkNotebook && <RelatedItems key={activePaperId} paperId={activePaperId} variant="popover" />}
        <button
          onClick={() => emitAppEvent("open-paper-details", { paperId: activePaperId })}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[0.8125rem] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          <FileText className="w-4 h-4" /> {caps.notebook ? "情報・整理" : "論文情報・整理"}
        </button>
        {!caps.translate ? null : translateJobId ? (
          <button onClick={handleCancel} className="flex items-center gap-1.5 bg-destructive text-white px-3 py-1.5 rounded-md text-[0.8125rem] font-medium hover:opacity-90 transition-opacity">
            <Square className="w-3.5 h-3.5" /> 中止
          </button>
        ) : (
          <button
            onClick={() => emitAppEvent("open-translate-dialog")}
            disabled={translateBlocked}
            title={withShortcutLabels("翻訳するページとモデルを選んで開始します（Ctrl+T）。保存済みの訳文は再利用します。")}
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
            {caps.notebook && <DropdownMenuItem onClick={() => emitAppEvent("edit-item-title")}>
              <Pencil className="w-4 h-4 mr-2" /> 名前を変更…
            </DropdownMenuItem>}
            {paper && caps.notebook && <DropdownMenuItem onClick={() => moveNotebook(paper)}>持ち主を変更・独立させる…</DropdownMenuItem>}
            {paper && !paper.parent_id && <DropdownMenuItem onClick={() => newNotebook({ owner: paper })}>専用ノートを作る…</DropdownMenuItem>}
            {caps.notebook && <DropdownMenuItem disabled={exportingInk || !notebook} onClick={() => void exportInkPdf(activePaperId, "original")}>
              <Download className="w-4 h-4 mr-2" /> {exportingInk ? "出力中…" : "書き込み付きPDFとして保存…"}
            </DropdownMenuItem>}
            {caps.translate && <DropdownMenuItem onClick={() => emitAppEvent("open-glossary-dialog")}>
              <BookOpen className="w-4 h-4 mr-2" /> 訳語・辞書
            </DropdownMenuItem>}
            {caps.summary && <DropdownMenuItem disabled={workBusy} onClick={() => generateArticle(activePaperId)}>
              <ScrollText className="w-4 h-4 mr-2" /> サマリー（解説）を作成
            </DropdownMenuItem>}
            {caps.translate && <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={workBusy || exportBlocked}>
                <Download className="w-4 h-4 mr-2" /> PDFを書き出す
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-60">
                <DropdownMenuItem onClick={() => exportPdf(activePaperId, "translated")}>日本語訳</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportPdf(activePaperId, "interleaved")}>原文と訳文の交互ページ</DropdownMenuItem>
                <DropdownMenuItem onClick={() => exportPdf(activePaperId, "bilingual")}>原文と訳文の対訳（左右）</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>}
            {caps.summary && <DropdownMenuItem disabled={!reading?.has_article} onClick={() => exportMarkdown(activePaperId)}>
              <FileText className="w-4 h-4 mr-2" /> サマリーをMarkdownで保存
            </DropdownMenuItem>}
            {(caps.translate || caps.summary || caps.originalPdf) && <DropdownMenuSeparator />}
            {caps.originalPdf && <DropdownMenuItem onClick={() => openPaperFile(activePaperId, "original.pdf")}>
              <ExternalLink className="w-4 h-4 mr-2" /> 原文を外部で開く
            </DropdownMenuItem>}
            {caps.translate && <>
              <DropdownMenuItem disabled={!reading?.has_translated} onClick={() => openPaperFile(activePaperId, "translated.pdf")}>
                <ExternalLink className="w-4 h-4 mr-2" /> 日本語訳を外部で開く
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!reading?.has_translated || workBusy} onClick={() => openPaperFile(activePaperId, "interleaved.pdf")}>
                <ExternalLink className="w-4 h-4 mr-2" /> 原文・日本語訳（交互）を外部で開く
              </DropdownMenuItem>
            </>}
            {caps.originalPdf && <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => saveOriginal(activePaperId)}>
                <Download className="w-4 h-4 mr-2" /> 原文PDFを名前を付けて保存…
              </DropdownMenuItem>
            </>}
            {caps.rename && !caps.notebook && <DropdownMenuItem onClick={() => renamePaperFile(activePaperId)}>
              <Pencil className="w-4 h-4 mr-2" /> ファイル名を変更…
            </DropdownMenuItem>}
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
  const [initialTab, setInitialTab] = useState<"translation" | "terms" | "dictionary">("translation");
  const translatable = useItemCapabilities(activePaperId).translate;
  useEffect(() => {
    if (!translatable) setOpen(false);
  }, [translatable]);
  // Ctrl+T and the reader's buttons open it for any open item: not for one that is not translated. Asked
  // when the event comes, of the item open then: a failure notice's 再開 opens another paper and emits
  // this in the same tick, before this component has rendered with it.
  useEffect(() => {
    const translation = onAppEvent("open-translate-dialog", () => {
      if (useStore.getState().activePaperId && activeItemCapabilities().translate) { setInitialTab("translation"); setOpen(true); }
    });
    const dictionary = onAppEvent("open-glossary-dialog", () => {
      if (useStore.getState().activePaperId && activeItemCapabilities().translate) { setInitialTab("terms"); setOpen(true); }
    });
    return () => { translation(); dictionary(); };
  }, []);
  if (!activePaperId || !translatable) return null;
  return <TranslationDialog open={open} onOpenChange={setOpen} paperId={activePaperId} currentPage={currentPage} initialTab={initialTab} />;
}
