import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, NotebookPen, Pencil } from "lucide-react";
import { useStore } from "@/store";
import { invalidate, patchPaper } from "@/api/mutations";
import { usePaper, type PaperData } from "@/api/hooks";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { showError } from "@/components/errorDialog";
import { NoteTemplates } from "./NoteTemplates";
import { registerPendingSaves } from "@/lib/pendingSaves";
import { QK } from "@/lib/queryKeys";

/** Memo saves of the open panes, flushed before closing or backing up. */
const pendingNoteSaves = new Set<() => Promise<void>>();
registerPendingSaves(async () => {
  const results = await Promise.allSettled([...pendingNoteSaves].map((save) => save()));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}, "メモを保存できませんでした。内容を確認してください。");

/** `compact` shortens the header hint in the reader's side panel. */
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

function PaperNotes({ paperId, compact }: { paperId: string; compact: boolean }) {
  const queryClient = useQueryClient();
  const { data: paper } = usePaper(paperId);

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
      <div className="flex-1 flex flex-col min-w-0">
        {/* Never wrapped a character at a time in a narrow pane (a small window, a large 文字の大きさ): the
            hint is cut short first, then the buttons go to a second line, then the button keeps its icon only. */}
        <div className="@container min-h-11 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-1.5 border-b shrink-0">
          <h3 className="min-w-0 flex-[1_1_3.5rem] text-[0.8125rem] font-semibold flex items-center gap-2 whitespace-nowrap">
            <NotebookPen className="w-4 h-4 shrink-0 text-muted-foreground" />
            <span className="shrink-0">メモ</span>
            {!compact && <span className="min-w-0 truncate font-normal text-muted-foreground text-[0.75rem]" title="Markdownで記入できます。入力後に自動保存します。">
              Markdownで記入できます。入力後に自動保存します。</span>}
          </h3>
          <div className="ml-auto min-w-0 flex items-center gap-3 whitespace-nowrap">
            <span className="min-w-0 truncate text-[0.75rem] text-muted-foreground">
              {noteState === "saving" ? "保存中…" : noteState === "dirty" ? "未保存" : "自動保存済み ✓"}
            </span>
            <button
              onClick={() => setPreview(!preview)}
              title={preview ? "編集" : "プレビュー"}
              className="shrink-0 flex items-center gap-1 h-7 px-2 rounded border text-[0.75rem] hover:bg-muted"
            >
              {preview ? <Pencil className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              <span className="@max-[14rem]:sr-only">{preview ? "編集" : "プレビュー"}</span>
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
