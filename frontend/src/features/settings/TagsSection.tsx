import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type TagKind = "paper" | "sticky" | "status";
export const DEFAULT_READING_STATUSES = ["未読", "読書中", "読了", "再読したい"];
export const DEFAULT_STICKY_LABELS = ["重要", "疑問", "あとで確認", "引用", "確認済み"];
const endpoint = (kind: TagKind) => kind === "paper" ? "/api/tags" : kind === "status" ? "/api/reading-statuses" : "/api/sticky-labels";
export function useTagChoices(kind: TagKind) {
  const query = useQuery({ queryKey: [kind === "paper" ? "tags" : kind === "status" ? "reading-statuses" : "sticky-labels"], queryFn: () => apiRequest<string[]>("GET", endpoint(kind)) });
  // Missing data is not an empty saved list. Keep the defaults while loading or offline,
  // but respect an explicitly saved empty list when every choice was deleted.
  const defaults = kind === "status" ? DEFAULT_READING_STATUSES : kind === "sticky" ? DEFAULT_STICKY_LABELS : undefined;
  return { ...query, data: query.data ?? defaults };
}

export function TagManager({ kind }: { kind: TagKind }) {
  const { data: names = [], isPending, isError } = useTagChoices(kind);
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const mutate = async (remove?: string) => {
    setBusy(true); setError("");
    try {
      const value = remove ?? name.trim();
      await apiRequest(remove === undefined ? "POST" : "DELETE", `${endpoint(kind)}${remove === undefined ? "" : `?name=${encodeURIComponent(remove)}`}`, remove === undefined ? { name: value } : undefined);
      await Promise.all(["tags", "sticky-labels", "reading-statuses", "papers", "library-search"].map(key => client.invalidateQueries({ queryKey: [key] })));
      setDeleting(null);
      if (remove === undefined) setName("");
    } catch (e) { setError(e instanceof Error ? e.message : "保存できませんでした。"); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{kind === "paper" ? "削除すると、すべての論文からこのタグが外れます。論文とメモは残ります。" : kind === "status" ? "削除すると選択肢から外れます。既存の論文に付いている読書状態は残ります。" : "削除すると選択肢から外れます。作成済みの付箋と分類は残ります。"}</p>
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (name.trim() && !busy) void mutate(); }}>
      <Input aria-label={kind === "paper" ? "新しいタグ名" : kind === "status" ? "新しい読書状態名" : "新しい付箋の分類名"} placeholder={kind === "paper" ? "タグ名を入力" : kind === "status" ? "読書状態を入力" : "分類名を入力"} value={name} maxLength={kind === "sticky" ? 40 : 80} disabled={busy} onChange={e => setName(e.target.value)} />
      <Button type="submit" disabled={busy || !name.trim() || names.includes(name.trim())}>追加</Button>
    </form>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {isPending ? <p className="text-xs">読み込み中…</p> : isError ? <p role="alert" className="text-xs text-destructive">一覧を読み込めませんでした。アプリ更新後はバックエンドを再起動してください。</p> : <div className="max-h-60 overflow-y-auto divide-y">
      {names.map(item => <div key={item} className="flex flex-wrap items-center gap-2 py-2">
        <span className="min-w-0 flex-1 break-all text-sm">{item}</span>
        {deleting === item ? <>
          <span className="w-full text-xs">「{item}」を削除しますか？</span>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void mutate(item)}>削除する</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setDeleting(null)}>戻る</Button>
        </> : <Button size="sm" variant="ghost" disabled={busy} aria-label={`「${item}」を削除`} onClick={() => setDeleting(item)}>削除</Button>}
      </div>)}
      {!names.length && <p className="py-3 text-xs text-muted-foreground">まだ登録されていません。</p>}
    </div>}
  </div>;
}
