import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, Pencil, Plus, Trash2, Upload, ArrowUp, ArrowDown } from "lucide-react";
import { useStore } from "@/store";
import { api, unwrap } from "@/api/client";
import { createMemo, importMemoPaths, memoPath, refreshAttachments, useAttachments, useMemoContent, type Attachment } from "@/api/attachments";
import { importAttachmentFiles } from "@/api/documents";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { showError } from "@/components/errorDialog";
import { askConfirm, askText } from "@/components/AppDialogs";
import { shell } from "@/shell";
import { QK } from "@/lib/queryKeys";
import { NoteTemplates } from "./NoteTemplates";
import { DocumentsPane } from "@/features/documents/DocumentsPane";
import { showMemos, useDocumentState, openDocument } from "@/features/documents/documentState";
import { reorderedAttachments } from "@/features/documents/attachmentOrder";
import { MarkdownEditor } from "./MarkdownEditor";
import { changeMemo, forgetMemo, hydrateMemo, saveMemo, selectMemo, useMemoDrafts, useMemoSelection } from "./memoState";

const button = "inline-flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";
export function NotesPane({ compact = false }: { compact?: boolean }) {
  const owner = useStore(s => s.activePaperId);
  const mode = useDocumentState(s => owner ? s.modes[owner] : undefined);
  const insert = useStore(s => s.noteInsert);
  useEffect(() => { if (owner && insert?.paperId === owner) showMemos(owner); }, [owner, insert]);
  if (!owner) return <div className="p-8 text-sm text-muted-foreground">左のライブラリから論文を選んでください。</div>;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex gap-1 border-b p-2" aria-label="メモと資料の切り替え">
      <button className={button} aria-pressed={mode !== "html"} onClick={() => showMemos(owner)}>メモ</button>
      <button className={button} aria-pressed={mode === "html"} onClick={() => openDocument(owner)}>資料</button>
    </div>
    {mode === "html" ? <DocumentsPane key={owner} owner={owner} /> : <PaperNotes key={owner} owner={owner} compact={compact} />}
  </div>;
}

function PaperNotes({ owner, compact }: { owner: string; compact: boolean }) {
  const client = useQueryClient();
  const { data, isError, refetch } = useAttachments(owner);
  const memos = data?.filter(item => item.format === "md") ?? [];
  const selected = useMemoSelection(s => s.selected[owner]);
  const current = memos.find(item => item.id === selected) ?? memos[0];
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const insert = useStore(s => s.noteInsert);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await action(); } catch (error) { showError(error, "メモを更新できませんでした"); }
    finally { setBusy(false); }
  };
  const add = async () => {
    if (current) await saveMemo(current.id);
    const row = await createMemo(owner);
    hydrateMemo(row); selectMemo(owner, row.id);
    await refreshAttachments(client);
  };
  // A quote needs a destination even when the paper has no memos yet. StrictMode shares this guard.
  useEffect(() => {
    if (!data || current || !insert || insert.paperId !== owner || creating.current) return;
    creating.current = true;
    void add().catch(error => showError(error, "引用先のメモを作れませんでした")).finally(() => { creating.current = false; });
    // The operation belongs to the loaded empty list and handoff, not render-local callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, current?.id, insert, owner]);
  const rename = async () => {
    if (!current) return;
    const title = await askText("メモの名前を変更", "名前", current.title);
    if (title === null) return;
    await saveMemo(current.id);
    await unwrap(api.PATCH("/api/papers/{paper_id}/attachments/{attachment_id}", { params: { path: memoPath(owner, current.id) }, body: { title } }));
    await refreshAttachments(client);
  };
  const remove = async () => {
    if (!current || !await askConfirm("メモを削除", `「${current.title}」を削除します。`, "削除する", true)) return;
    await saveMemo(current.id);
    await unwrap(api.DELETE("/api/papers/{paper_id}/attachments/{attachment_id}", { params: { path: memoPath(owner, current.id) } }));
    forgetMemo(current.id);
    client.removeQueries({ queryKey: [QK.memo, owner, current.id] });
    selectMemo(owner, memos.find(item => item.id !== current.id)?.id ?? "");
    await refreshAttachments(client);
  };
  const reorder = async (direction: number) => {
    if (!current) return;
    const ids = reorderedAttachments(data ?? [], current.id, direction);
    await unwrap(api.PUT("/api/papers/{paper_id}/attachments/order", { params: { path: { paper_id: owner } }, body: { ids } }));
    await refreshAttachments(client);
  };
  const importPaths = async () => {
    const paths = await shell.openFiles([{ name: "Markdown メモ", extensions: ["md"] }]);
    if (!paths.length) return;
    const rows = await importMemoPaths(owner, paths, client);
    if (rows[0]) selectMemo(owner, rows[0].id);
  };
  return <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background" data-memo-owner={owner} aria-busy={busy}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); } }}
    onDrop={event => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation();
      const files = Array.from(event.dataTransfer.files);
      void run(async () => {
        const rows = await importAttachmentFiles(owner, files, client);
        if (rows[0]?.format === "html") openDocument(owner, rows[0].id);
        else if (rows[0]) selectMemo(owner, rows[0].id);
      });
    }}>
    <div className="flex flex-wrap items-center gap-1.5 border-b p-2">
      <span className="text-sm font-semibold">メモ{memos.length ? ` (${memos.length})` : ""}</span>
      <button className={button} disabled={busy || !data} onClick={() => void run(add)}><Plus className="size-3" />新規メモ</button>
      <button className={button} disabled={busy || !data} onClick={() => void run(importPaths)}><Upload className="size-3" />.md を取り込む</button>
      {!compact && <span className="text-xs text-muted-foreground">入力後に自動保存します。</span>}
      {!!memos.length && <div className="flex w-full min-w-0 flex-wrap items-center gap-1">
        <select aria-label="メモを選択" className="min-w-0 flex-1 rounded border bg-background p-1 text-sm" value={current?.id ?? ""} disabled={busy}
          onChange={e => { const id = e.target.value; void run(async () => { if (current) await saveMemo(current.id); selectMemo(owner, id); }); }}>
          {memos.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <button className={button} disabled={busy} aria-label="メモの名前を変更" onClick={() => void run(rename)}><Pencil className="size-3" /></button>
        <button className={button} disabled={busy || current?.id === memos[0]?.id} aria-label="メモを前へ" onClick={() => void run(() => reorder(-1))}><ArrowUp className="size-3" /></button>
        <button className={button} disabled={busy || current?.id === memos[memos.length - 1]?.id} aria-label="メモを後ろへ" onClick={() => void run(() => reorder(1))}><ArrowDown className="size-3" /></button>
        <button className={button} disabled={busy} aria-label="メモを削除" onClick={() => void run(remove)}><Trash2 className="size-3" /></button>
      </div>}
    </div>
    {busy && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">メモを更新中…</p>}
    <div className="flex min-h-0 flex-1 flex-col" inert={busy}>
    {isError ? <div role="alert" className="p-3 text-sm">メモを読み込めませんでした。<button onClick={() => void refetch()}>再読み込み</button></div>
      : current ? <MemoEditor key={current.id} memo={current} />
        : <p className="p-4 text-sm text-muted-foreground">{data ? "「新規メモ」で書き始めるか、.md ファイルを取り込んでください。" : "メモを読み込み中…"}</p>}
    </div>
  </div>;
}

function MemoEditor({ memo }: { memo: Attachment }) {
  const { data, isError, refetch } = useMemoContent(memo.owner_id, memo.id);
  const draft = useMemoDrafts(s => s.drafts[memo.id]);
  const insert = useStore(s => s.noteInsert);
  const [preview, setPreview] = useState(false);
  const dirty = !!draft && draft.text !== draft.saved;
  const text = draft?.text;
  useEffect(() => { if (data) hydrateMemo(data); }, [data]);
  useEffect(() => {
    const handoff = useStore.getState().noteInsert;
    if (!draft || !handoff || handoff.paperId !== memo.owner_id) return;
    useStore.getState().setNoteInsert(null);
    changeMemo(memo.id, `${draft.text.trimEnd()}${draft.text.trim() ? "\n\n" : ""}${handoff.text}\n\n`);
    setPreview(false);
  }, [draft, insert, memo.id, memo.owner_id]);
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => void saveMemo(memo.id).catch(() => undefined), 600);
    return () => clearTimeout(timer);
  }, [dirty, text, memo.id]);
  useEffect(() => () => { void saveMemo(memo.id).catch(() => undefined); }, [memo.id]);
  if (isError && !draft) return <div role="alert" className="p-3">メモを読み込めませんでした。<button onClick={() => void refetch()}>再読み込み</button></div>;
  if (!draft) return <p className="p-3 text-sm">メモを読み込み中…</p>;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center justify-between gap-2 px-3 py-1 text-xs text-muted-foreground">
      <span role="status">{draft.saving ? "保存中…" : draft.text !== draft.saved ? "未保存" : "自動保存済み ✓"}</span>
      <button className={button} onClick={() => setPreview(!preview)}>{preview ? <Pencil className="size-3" /> : <Eye className="size-3" />}{preview ? "編集" : "プレビュー"}</button>
    </div>
    {draft.error && <div role="alert" className="px-3 text-xs text-destructive">{draft.error}<button className={button} onClick={() => void saveMemo(memo.id).catch(() => undefined)}>保存を再試行</button></div>}
    <NoteTemplates note={draft.text} onInsert={content => { changeMemo(memo.id, `${draft.text.trimEnd()}${draft.text.trim() ? "\n\n" : ""}${content}\n`); setPreview(false); }} />
    <div className="flex min-h-0 flex-1 flex-col p-2">
      {preview && <div className="min-h-0 flex-1 overflow-auto rounded-lg border p-3"><MarkdownRenderer content={draft.text} paperId={memo.owner_id} /></div>}
      <MarkdownEditor value={draft.text} visible={!preview} onChange={text => changeMemo(memo.id, text)} onBlur={() => void saveMemo(memo.id).catch(() => undefined)} />
    </div>
  </div>;
}
