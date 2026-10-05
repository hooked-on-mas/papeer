import { useId, useRef, useState } from "react";
import { useTagChoiceMutation } from "@/api/mutations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTagChoices, type TagKind } from "@/api/tagChoices";
import { pyStrip } from "@/lib/pyWhitespace";

export function TagManager({ kind }: { kind: TagKind }) {
  const { data: names = [], isPending, isError } = useTagChoices(kind);
  const change = useTagChoiceMutation(kind);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const duplicate = !!pyStrip(name) && names.includes(pyStrip(name));
  const duplicateId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const nameLimit = kind === "sticky" ? 40 : 80;
  const mutate = async (remove?: string) => {
    setBusy(true); setError(""); setMessage("");
    try {
      // Settles once what the change makes stale has been loaded again (useTagChoiceMutation).
      await change.mutateAsync(remove === undefined ? { name: pyStrip(name) } : { remove });
      setDeleting(null);
      if (remove === undefined) { setName(""); setMessage(`「${pyStrip(name)}」を追加しました。`); }
    } catch (e) { setError(e instanceof Error ? e.message : "保存できませんでした。"); }
    finally { setBusy(false); if (remove === undefined) requestAnimationFrame(() => inputRef.current?.focus()); }
  };
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{kind === "paper" ? "削除すると、すべての論文からこのタグが外れます。論文とメモは残ります。" : kind === "status" ? "削除すると選択肢から外れます。既存の論文に付いている読書状態は残ります。" : "削除すると選択肢から外れます。作成済みの付箋と分類は残ります。"}</p>
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (pyStrip(name) && !busy && !duplicate) void mutate(); }}>
      <Input ref={inputRef} aria-label={kind === "paper" ? "新しいタグ名" : kind === "status" ? "新しい読書状態名" : "新しい付箋の分類名"} aria-describedby={duplicate ? duplicateId : undefined} placeholder={kind === "paper" ? "タグ名を入力" : kind === "status" ? "読書状態を入力" : "分類名を入力"} value={name} maxLength={nameLimit} disabled={busy} onChange={e => { setName(e.target.value.slice(0, nameLimit)); setMessage(""); }} />
      <Button type="submit" disabled={busy || !pyStrip(name) || duplicate}>追加</Button>
    </form>
    {duplicate && <p id={duplicateId} role="status" className="text-xs text-muted-foreground">この名前は登録済みです。</p>}
    {name.length >= nameLimit - 8 && <p role="status" className="text-xs text-muted-foreground">名前は{nameLimit}文字まで（{name.length}/{nameLimit}文字）。</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    {isPending ? <p className="text-xs">読み込み中…</p> : isError ? <p role="alert" className="text-xs text-destructive">一覧を読み込めませんでした。アプリ更新後はバックエンドを再起動してください。</p> : <div className="divide-y">
      {names.map(item => <div key={item} className="flex flex-wrap items-center gap-2 py-2">
        <span className="min-w-0 flex-1 break-all text-sm">{item}</span>
        {deleting === item ? <>
          <span className="w-full text-xs">「{item}」を削除しますか？</span>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void mutate(item)}>削除する</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setDeleting(null)}>削除をやめる</Button>
        </> : <Button size="sm" variant="ghost" disabled={busy} aria-label={`「${item}」を削除`} onClick={() => setDeleting(item)}>削除</Button>}
      </div>)}
      {!names.length && <p className="py-3 text-xs text-muted-foreground">まだ登録されていません。</p>}
    </div>}
  </div>;
}
