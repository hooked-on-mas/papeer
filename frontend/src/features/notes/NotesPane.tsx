import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, FolderOpen, NotebookPen, Pencil } from "lucide-react";
import { useStore } from "@/store";
import { invalidate, patchPaper } from "@/api/mutations";
import { useCollections, usePaper, useReading, type PaperData, type ReadingData } from "@/api/hooks";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { openPaperFolder } from "@/app/actions";
import { showError } from "@/components/errorDialog";
import { ReadingOrganization } from "./ReadingOrganization";
import { PaperMetadataForm } from "./PaperMetadataForm";
import { NoteTemplates } from "./NoteTemplates";
import { registerPendingSaves } from "@/lib/pendingSaves";
import { storedStatusLabel } from "@/lib/paperStatus";
import { QK } from "@/lib/queryKeys";

/** Memo saves of the open panes, flushed before closing or backing up. */
const pendingNoteSaves = new Set<() => Promise<void>>();
registerPendingSaves(async () => {
  const results = await Promise.allSettled([...pendingNoteSaves].map((save) => save()));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}, "メモを保存できませんでした。内容を確認してください。");

/** `compact` shows only the memo, for the side panel in focus mode. */
export function NotesPane({ compact = false }: { compact?: boolean }) {
  const activePaperId = useStore((state) => state.activePaperId);
  if (!activePaperId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 h-full">
        <p className="text-[0.9375rem] font-medium mb-1 text-foreground">論文が選択されていません</p>
        <p className="text-[0.8125rem]">左のライブラリから論文を選ぶか、PDF を追加してください</p>
      </div>
    );
  }
  // Keyed so switching papers saves the old memo and never writes it into the new paper.
  return <PaperNotes key={activePaperId} paperId={activePaperId} compact={compact} />;
}

function metaLines(paper: PaperData, reading: ReadingData | null | undefined): { text: string; title?: string }[] {
  const lines: { text: string; title?: string }[] = [{ text: `${paper.pages ?? "?"} ページ / ${storedStatusLabel(paper.status)}` }];
  if (reading?.empty_pages?.length) lines.push({ text: `文字のないページ: ${reading.empty_pages.join(", ")}` });
  const ocr = reading?.ocr_pages ?? [];
  const whole = ocr.filter(entry => entry.reason !== "partial").map(entry => entry.page);
  const partial = ocr.filter(entry => entry.reason === "partial").map(entry => entry.page);
  if (whole.length) lines.push({ text: "要OCR: p." + whole.join(", "), title: "文字化け・画像だけのページは翻訳せず原文のまま表示します" });
  if (partial.length) lines.push({ text: "一部文字化け: p." + partial.join(", "), title: "文字化けした段落は翻訳せず原文のまま表示します" });
  const report = reading?.report;
  if (report?.skipped_pages?.length) lines.push({ text: "PDF生成スキップ: p." + report.skipped_pages.join(", ") });
  return lines;
}

function PaperNotes({ paperId, compact }: { paperId: string; compact: boolean }) {
  const queryClient = useQueryClient();
  const { data: paper } = usePaper(paperId);
  const { data: reading } = useReading(paperId);
  const { data: collections = [] } = useCollections();

  const [note, setNote] = useState<string | null>(null);
  const [noteState, setNoteState] = useState<"saved" | "saving" | "dirty">("saved");
  const [preview, setPreview] = useState(false);
  const savedNote = useRef<string | null>(null);
  const latestNote = useRef<string | null>(null);
  const savingNote = useRef<Promise<void>>(Promise.resolve());
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const noteInsert = useStore((state) => state.noteInsert);

  useEffect(() => {
    if (paper && note === null) {
      // From the cache rather than this render: a pane closing in the same commit (entering or
      // leaving focus mode) has just put its unsaved text there.
      const text = queryClient.getQueryData<PaperData | null>([QK.papers, paperId])?.note ?? paper.note ?? "";
      setNote(text);
      savedNote.current = text;
      latestNote.current = text;
    }
  }, [paper, note, paperId, queryClient]);

  // A quote from the reader's context menu goes at the end, once the memo has loaded.
  useEffect(() => {
    // Read from the store so a StrictMode rerun cannot add the quote twice.
    const insert = useStore.getState().noteInsert;
    if (!insert || note === null) return;
    useStore.getState().setNoteInsert(null);
    if (insert.paperId !== paperId) return;
    const current = note.trimEnd();
    setNote(`${current ? current + "\n\n" : ""}${insert.text}\n\n`);
    setPreview(false);
    requestAnimationFrame(() => {
      const el = noteRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollTop = el.scrollHeight;
    });
  }, [noteInsert, note, paperId]);

  const saveNote = useRef(() => {
    const task = savingNote.current.catch(() => undefined).then(async () => {
      const text = latestNote.current;
      if (text === null || text === savedNote.current) return;
      setNoteState("saving");
      // Update the cache first so reopening the tab mid-save shows the new text.
      queryClient.setQueryData<PaperData | null>([QK.papers, paperId], (old) => old ? { ...old, note: text } : old);
      try {
        await patchPaper(paperId, { note: text });
        void invalidate({ kind: "note" }, queryClient);
        savedNote.current = text;
        if (latestNote.current === text) setNoteState("saved");
      } catch (error) {
        setNoteState("dirty");
        showError(error, "メモを保存できませんでした");
        throw error;
      }
    });
    savingNote.current = task;
    return task;
  }).current;

  useEffect(() => {
    if (note === null) return;
    latestNote.current = note;
    if (note === savedNote.current) return;
    setNoteState("dirty");
    const timer = setTimeout(() => void saveNote().catch(() => undefined), 600);
    return () => clearTimeout(timer);
  }, [note, saveNote]);

  useEffect(() => {
    pendingNoteSaves.add(saveNote);
    return () => {
      pendingNoteSaves.delete(saveNote);
      // Synchronously, so that a pane opening in the same commit starts from this text.
      const text = latestNote.current;
      if (text !== null && text !== savedNote.current) {
        queryClient.setQueryData<PaperData | null>([QK.papers, paperId], (old) => old ? { ...old, note: text } : old);
      }
      void saveNote().catch(() => undefined);
    };
  }, [saveNote, paperId, queryClient]);

  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      {!compact && <div className="w-[21.25rem] shrink-0 border-r overflow-y-auto p-4 space-y-5">
        {paper && <ReadingOrganization paper={paper} />}
        <section className="space-y-3 border-t pt-4">
          <h3 className="text-[0.8125rem] font-semibold">論文情報 <span className="font-normal text-muted-foreground text-[0.75rem]">入力後に自動保存します。</span></h3>
          {paper && (
            <div className="text-[0.75rem] text-muted-foreground space-y-0.5">
              {metaLines(paper, reading).map((line) => (
                <div key={line.text} title={line.title}>{line.text}</div>
              ))}
            </div>
          )}
          {paper && <PaperMetadataForm paper={paper} collections={collections} />}
        </section>

        <section className="space-y-2 border-t pt-4">
          <h3 className="text-[0.8125rem] font-semibold">ファイル</h3>
          <div className="text-[0.75rem] text-muted-foreground space-y-0.5">
            <div>{paper?.original_name ?? "original.pdf"}（原文）</div>
            <div>日本語訳：{reading?.has_translated ? (reading.in_progress ? "翻訳途中" : "あり") : "未作成"}</div>
            <div>サマリー：{reading?.has_article ? "あり" : "未作成"}</div>
          </div>
          <button
            onClick={() => openPaperFolder(paperId)}
            className="flex items-center gap-1.5 h-8 px-3 rounded-md border text-[0.8125rem] hover:bg-muted"
          >
            <FolderOpen className="w-4 h-4" /> 保存フォルダーを開く
          </button>
        </section>
      </div>}

      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-11 flex items-center justify-between px-4 border-b shrink-0">
          <h3 className="text-[0.8125rem] font-semibold flex items-center gap-2">
            <NotebookPen className="w-4 h-4 text-muted-foreground" />
            メモ
            {!compact && <span className="font-normal text-muted-foreground text-[0.75rem]">Markdownで記入できます。入力後に自動保存します。</span>}
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-[0.75rem] text-muted-foreground">
              {noteState === "saving" ? "保存中…" : noteState === "dirty" ? "未保存" : "自動保存済み ✓"}
            </span>
            <button
              onClick={() => setPreview(!preview)}
              className="flex items-center gap-1 h-7 px-2 rounded border text-[0.75rem] hover:bg-muted"
            >
              {preview ? <><Pencil className="w-3.5 h-3.5" /> 編集</> : <><Eye className="w-3.5 h-3.5" /> プレビュー</>}
            </button>
          </div>
        </div>
        {note !== null && <NoteTemplates note={note} onInsert={content => { setNote(current => `${current?.trimEnd() ?? ""}${current?.trim() ? "\n\n" : ""}${content}\n`); setPreview(false); }} />}
        <div className="flex-1 p-4 flex flex-col min-h-0">
          {preview ? (
            <div className="flex-1 overflow-y-auto border rounded-lg p-4">
              <MarkdownRenderer content={note ?? ""} paperId={paperId} />
            </div>
          ) : (
            <textarea
              ref={noteRef}
              value={note ?? ""}
              disabled={note === null}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => void saveNote().catch(() => undefined)}
              placeholder="論文に関するメモを自由に記述できます…"
              className="flex-1 w-full p-4 text-[0.875rem] leading-relaxed resize-none border rounded-lg focus:outline-none focus:ring-1 focus:ring-ring bg-transparent font-mono"
            />
          )}
        </div>
      </div>
    </div>
  );
}
