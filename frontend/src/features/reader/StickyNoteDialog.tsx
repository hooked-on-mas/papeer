import { openSettings, useSettingsNavigation } from "@/features/settings/settingsNavigation";
import { useEffect, useState } from "react";
import { ApiError } from "@/api/client";
import { useSaveStickyNote } from "@/api/mutations";
import { paperDisplayName, usePaper } from "@/api/hooks";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useStore } from "@/store";
import { useTagChoices } from "@/api/tagChoices";
import { AnnotationTextEditor } from "./AnnotationTextEditor";
import { stickyQuote } from "./stickyNotes";
import { openStickyNote, useStickyNotes } from "./stickyNotesStore";
import { useOpenEdit } from "@/lib/pendingSaves";

/** One small editor shared by PDF markers, selections, and the sticky-notes tab. */
export function StickyNoteDialog() {
  const draft = useStickyNotes(s => s.draft);
  const busy = useStickyNotes(s => s.busy);
  const settingsOpen = useSettingsNavigation(s => s.open);
  // Also while hidden behind the settings: the draft is still there.
  useOpenEdit(!!draft, "付箋");
  const { data: labels = [] } = useTagChoices("sticky");
  const [error, setError] = useState("");
  const saveNote = useSaveStickyNote();
  const { data: paper } = usePaper(draft?.paperId ?? null);
  useEffect(() => setError(""), [draft]);
  // A highlight needs no label ("" is 分類なし); a sticky note always has one.
  const highlight = draft?.kind === "highlight";
  const selectedLabel = draft?.label ?? labels[0] ?? "未分類";
  const choices = Array.from(new Set([...(highlight ? [""] : []), ...labels, selectedLabel]));
  const close = () => { void openStickyNote(null); };
  const save = async () => {
    const { draft: item, busy: saving } = useStickyNotes.getState();
    if (!item || saving) return;
    useStickyNotes.setState({ busy: true }); setError("");
    try {
      const saved = await saveNote.mutateAsync({ paperId: item.paperId, id: item.id, fields:
        { page: item.page, side: item.side, quote: item.quote, anchor_y: item.anchorY, anchor_x: item.anchorX ?? 0, label: item.label ?? labels[0] ?? "未分類", note: item.note ?? "" } });
      useStickyNotes.setState({ draft: null, dirty: false, selectedId: saved.id });
      useStore.getState().setStatus("付箋を保存しました。");
      // Closed already; another save or delete waits until the notes have been loaded again, as before.
      await saveNote.refreshed();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 && e.message === "Not Found"
        ? "起動中のバックエンドが付箋の保存に対応していません。バックエンドを再起動してから、もう一度「確定」を押してください。入力内容は保持しています。"
        : e instanceof Error ? e.message : "付箋を保存できませんでした。");
    }
    finally { useStickyNotes.setState({ busy: false }); }
  };
  return <Dialog open={!!draft && !settingsOpen} onOpenChange={open => { if (!open && !useSettingsNavigation.getState().open) close(); }}>
    <DialogContent className="min-w-0 grid-cols-1 max-h-[85vh] overflow-y-auto sm:max-w-xs gap-3" showCloseButton={false}>
      {draft && <>
        <DialogTitle className="text-sm">{highlight ? "ハイライトのメモ" : draft.id ? "付箋を編集" : "付箋を貼る"}</DialogTitle>
        <DialogDescription className="min-w-0 text-xs">
          <span className="block truncate">{paper ? paperDisplayName(paper) : "論文"}</span>
          p.{draft.page}・{draft.side === "original" ? "原文" : "訳文"}
        </DialogDescription>
        {stickyQuote(draft.quote) && <details className="min-w-0 text-xs">
          <summary className="cursor-pointer text-muted-foreground">引用を確認</summary>
          <blockquote className="mt-2 max-h-28 max-w-full overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] border-l-2 border-amber-400 pl-2">{stickyQuote(draft.quote)}</blockquote>
        </details>}
        <AnnotationTextEditor embedded label="付箋のメモ" value={draft.note ?? ""} allowEmpty maxLength={1000} busy={busy} error={error}
          onChange={note => useStickyNotes.setState({ draft: { ...draft, note }, dirty: true })}
          onSave={() => void save()} onCancel={close} controls={<>
            <select aria-label="付箋の分類" disabled={busy} className="min-w-0 max-w-full rounded border bg-background px-2 py-1" value={`label:${choices.indexOf(selectedLabel)}`}
              onChange={e => { if (e.target.value === "add") openSettings("sticky-labels"); else useStickyNotes.setState({ draft: { ...draft, label: choices[Number(e.target.value.slice(6))] }, dirty: true }); }}>
              {choices.map((label, index) => <option key={label} value={`label:${index}`}>{label || "分類なし"}</option>)}
              <option value="add">＋ 分類を追加…</option>
            </select>
            <span className="ml-auto text-muted-foreground">メモは任意</span>
          </>} />
      </>}
    </DialogContent>
  </Dialog>;
}
