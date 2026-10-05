import { openSettings } from "@/features/settings/settingsNavigation";
import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, FileText, LayoutTemplate, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { api, unwrap } from "@/api/client";
import { useDeleteNoteTemplate, useSaveNoteTemplate, type NoteTemplate as Template } from "@/api/mutations";
import { askConfirm } from "@/components/AppDialogs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MarkdownRenderer } from "@/components/ui/MarkdownRenderer";
import { showError } from "@/components/errorDialog";
import { useOpenEdit } from "@/lib/pendingSaves";
import { pyStrip } from "@/lib/pyWhitespace";
import { QK } from "@/lib/queryKeys";

type Draft = { originalName: string | null; name: string; content: string; initialName: string; initialContent: string };

export type TemplateLeaveGuard = { beforeLeave: () => Promise<boolean> };

export function NoteTemplates({ note, onInsert, embedded = false, leaveRef }: { note: string; onInsert: (content: string) => void; embedded?: boolean; leaveRef?: Ref<TemplateLeaveGuard> }) {
  const { data: templates = [], isPending, isError, refetch } = useQuery({
    queryKey: [QK.noteTemplates], queryFn: async () => await unwrap(api.GET("/api/note-templates")) as Template[],
  });
  const saveTemplate = useSaveNoteTemplate();
  const deleteTemplate = useDeleteNoteTemplate();
  const [mode, setMode] = useState<"use" | "manage" | null>(embedded ? "manage" : null);
  // Embedded in the settings, which automatic sync waits for anyway.
  useOpenEdit(!embedded && mode !== null, "メモのテンプレート");
  const [selected, setSelected] = useState("読書メモ");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [inserted, setInserted] = useState("");
  const confirming = useRef(false);
  const nameId = useId();
  const contentId = useId();
  const current = templates.find(item => item.name === selected);
  const dirty = !!draft && (draft.name !== draft.initialName || draft.content !== draft.initialContent);
  const duplicate = !!draft && !draft.originalName && templates.some(item => item.name === pyStrip(draft.name));

  useEffect(() => {
    if (templates.length && !current) setSelected(templates[0].name);
  }, [templates, current]);

  const discardDraft = async () => {
    if (busy || confirming.current) return false;
    if (dirty) {
      confirming.current = true;
      const discard = await askConfirm("テンプレートの変更を破棄", "保存していないテンプレートの変更があります。", "破棄する", true);
      confirming.current = false;
      if (!discard) return false;
    }
    setDraft(null);
    return true;
  };

  useImperativeHandle(leaveRef, () => ({ beforeLeave: discardDraft }));

  const open = (next: "use" | "manage") => {
    setMode(next);
    setDraft(null);
    setNotice("");
  };

  const beginDraft = (kind: "blank" | "note" | "copy" | "edit") => {
    if (busy) return;
    const originalName = kind === "edit" && current && !current.builtin ? current.name : null;
    let name = originalName ?? "";
    if (kind === "copy" && current) {
      const copyName = (suffix: string) => `${current.name.slice(0, 80 - suffix.length)}${suffix}`;
      name = copyName("のコピー");
      let suffix = 2;
      while (templates.some(item => item.name === name)) name = copyName(`のコピー ${suffix++}`);
    }
    const content = kind === "note" ? note : kind === "blank" ? "" : current?.content ?? "";
    setDraft({ originalName, name, content, initialName: name, initialContent: content });
    setNotice("");
  };

  const save = async () => {
    if (!draft || busy || duplicate || !pyStrip(draft.name) || !pyStrip(draft.content)) return;
    const saved: Template = { name: pyStrip(draft.name), content: draft.content, builtin: false };
    setBusy(true);
    try {
      // Shown in the list at once, which is then loaded again (useSaveNoteTemplate).
      await saveTemplate.mutateAsync(saved);
      setSelected(saved.name);
      setDraft(null);
      setNotice(`「${saved.name}」を保存しました。他の論文でも使えます。`);
    } catch (error) { showError(error, "テンプレートを保存できませんでした"); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!current || current.builtin || busy) return;
    setBusy(true);
    try {
      if (!await askConfirm("テンプレートを削除", `「${current.name}」を削除しますか？ 挿入済みのメモはそのまま残ります。`, "削除", true)) return;
      await deleteTemplate.mutateAsync(current.name);
      setNotice(`「${current.name}」を削除しました。`);
    } catch (error) { showError(error, "テンプレートを削除できませんでした"); }
    finally { setBusy(false); }
  };

  const insert = () => {
    if (!current || busy) return;
    onInsert(current.content);
    setInserted(`「${current.name}」をメモの末尾に追加しました。`);
    setMode(null);
  };

  const title = draft ? draft.originalName ? "テンプレートを編集" : "新しいテンプレートを作成"
    : mode === "manage" ? "テンプレートを管理" : "テンプレートを使う";
  const description = draft ? "繰り返し使いたい見出しや記入欄を保存します。"
    : mode === "manage" ? "自分用のテンプレートを作成・編集できます。保存したテンプレートは、すべての論文で使えます。"
    : "内容を確認して、読書メモの末尾に追加できます。";

  const content = <>
        <header className="shrink-0 border-b px-5 py-4 pr-12">
          {embedded ? <h3 className="text-sm font-semibold">{title}</h3> : <DialogTitle>{title}</DialogTitle>}
          {!embedded && <DialogDescription className="mt-2 text-xs leading-relaxed">{description}</DialogDescription>}
        </header>

        {draft ? <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <Button variant="ghost" size="sm" className="self-start -ml-2" disabled={busy} onClick={() => void discardDraft()}><ArrowLeft /> 一覧に戻る</Button>
          <div className="space-y-1.5">
            <label htmlFor={nameId} className="text-sm font-medium">テンプレート名</label>
            <Input id={nameId} autoFocus={!draft.originalName} readOnly={!!draft.originalName} disabled={busy} maxLength={80}
              placeholder="例：実験論文を読むとき" value={draft.name} aria-invalid={duplicate || undefined}
              onChange={e => setDraft({ ...draft, name: e.target.value })} />
            {duplicate && <p className="text-xs text-destructive" role="alert">同じ名前のテンプレートがあります。別の名前を付けてください。</p>}
          </div>
          <div className="flex min-h-40 flex-1 flex-col gap-1.5">
            <label htmlFor={contentId} className="text-sm font-medium">メモに挿入する内容</label>
            <textarea id={contentId} autoFocus={!!draft.originalName} disabled={busy} maxLength={50000}
              className="min-h-40 flex-1 resize-none rounded-md border bg-background p-3 text-sm leading-relaxed font-mono focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder={"## 研究の目的\n\n## 手法と結果\n\n## 自分に使えそうな点"}
              value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} />
            <p className="text-xs text-muted-foreground">「## 見出し」のように書くと、Markdownの見出しになります。</p>
          </div>
        </div> : <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav aria-label="保存済みテンプレート" className="max-h-44 shrink-0 overflow-y-auto border-b bg-muted/20 p-3 sm:max-h-none sm:w-44 sm:border-b-0 sm:border-r">
            {mode === "manage" && <div className="mb-3 space-y-1.5 border-b pb-3">
              <Button className="w-full justify-start" size="sm" disabled={busy || isPending || isError} onClick={() => beginDraft("blank")}><Plus /> 新しく作る</Button>
              <Button className="w-full justify-start" variant="outline" size="sm" disabled={busy || isPending || isError || !pyStrip(note)} onClick={() => beginDraft("note")}><FileText /> 今のメモから作る</Button>
            </div>}
            {isPending && <p className="p-2 text-xs text-muted-foreground">テンプレートを読み込み中…</p>}
            {isError && <div className="space-y-2 p-2 text-xs"><p className="text-destructive">テンプレートを読み込めませんでした。</p><Button size="sm" variant="outline" onClick={() => void refetch()}>再読み込み</Button></div>}
            {!isError && templates.map(template => <button key={template.name} disabled={busy} aria-pressed={selected === template.name}
              title={`${template.name}（${template.builtin ? "標準テンプレート" : "自分のテンプレート"}）`}
              className={`mb-1 flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === template.name ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
              onClick={() => { setSelected(template.name); setNotice(""); }}>
              <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1"><span className="block break-words font-medium">{template.name}</span>{mode === "manage" && <span className="mt-0.5 block text-[0.75rem] text-muted-foreground">{template.builtin ? "標準テンプレート" : "自分のテンプレート"}</span>}</span>
              {selected === template.name && <Check className="mt-0.5 size-4 shrink-0 text-primary" />}
            </button>)}
          </nav>
          <section aria-label="テンプレートのプレビュー" className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
            {current && !isError ? <>
              <div className="mb-2 shrink-0"><h3 className="break-words text-sm font-semibold">{current.name}</h3></div>
              <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background p-3"><MarkdownRenderer content={current.content} /></div>
              {mode === "manage" && <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
                {current.builtin ? <Button variant="outline" size="sm" disabled={busy} onClick={() => beginDraft("copy")}><Copy /> コピーして自分用に編集</Button> : <>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => beginDraft("edit")}><Pencil /> 編集</Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => beginDraft("copy")}><Copy /> 複製</Button>
                  <Button variant="ghost" size="sm" className="ml-auto text-destructive" disabled={busy} onClick={() => void remove()}><Trash2 /> 削除</Button>
                </>}
              </div>}
            </> : <p className="text-sm text-muted-foreground">テンプレートを選ぶと、ここで内容を確認できます。</p>}
          </section>
        </div>}

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-muted/20 px-5 py-3">
          <p className="mr-auto min-w-0 text-xs text-muted-foreground" role="status">{draft ? dirty ? "未保存の変更があります" : "" : notice}</p>
          {draft ? <>
            <Button variant="outline" disabled={busy} onClick={() => void discardDraft()}>キャンセル</Button>
            <Button disabled={busy || duplicate || !pyStrip(draft.name) || !pyStrip(draft.content) || (!!draft.originalName && !dirty)} onClick={() => void save()}>{busy ? "保存中…" : draft.originalName ? "変更を保存" : "テンプレートを保存"}</Button>
          </> : mode === "use" ? <>
            <Button variant="ghost" onClick={() => { setMode(null); openSettings("note-templates", note); }}><Settings2 /> 作成・編集する</Button>
            <Button disabled={busy || !current || isError} onClick={insert}>この内容をメモに追加</Button>
          </> : null}
        </footer>
  </>;

  if (embedded) return <div className="flex h-full min-h-[420px] flex-col overflow-hidden rounded-lg border">{content}</div>;

  return <>
    <div className="shrink-0 border-b px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" title="見出しのひな形を選んで、読書メモに追加します" onClick={() => open("use")}><LayoutTemplate /> テンプレートを使う</Button>
        <Button variant="ghost" size="sm" onClick={() => openSettings("note-templates", note)}><Settings2 /> テンプレートを管理</Button>
      </div>
      {inserted && <p className="mt-1.5 text-muted-foreground" role="status">{inserted}</p>}
    </div>

    <Dialog open={mode !== null} onOpenChange={async next => {
      if (!next && await discardDraft()) setMode(null);
    }}>
      <DialogContent showCloseButton={!busy} className="flex h-[min(640px,85vh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {content}
      </DialogContent>
    </Dialog>
  </>;
}
