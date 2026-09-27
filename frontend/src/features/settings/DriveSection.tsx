import { useEffect, useState } from "react";
import { apiRequest } from "@/api/client";
import { cancelSync, syncDrive, useSyncState } from "./driveSync";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { askConfirm } from "@/components/AppDialogs";
import { showError } from "@/components/errorDialog";
import { shell, joinPath } from "@/shell";
import { isRunning, useStore } from "@/store";
import { openSettings, useSettingsNavigation } from "./settingsNavigation";

type Revision = { id: string; device: string; created: string };
type DriveStatus = {
  connected: boolean; folder: string; auto_sync: boolean; last_sync: string | null;
  error: string | null; conflicts: Revision[]; previous_path: string | null;
};
const DIALOG_KEYS = new Set(["Tab", "Enter", " ", "Escape"]);

/** Mounted once: flush editors before every sync and block new edits until it finishes. */
export function DriveSyncHost() {
  const busy = useSyncState(s => s.busy);
  const jobId = useSyncState(s => s.jobId);
  const cancelling = useSyncState(s => s.cancelling);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!busy) return;
    const block = (event: KeyboardEvent) => {
      // Dialogs stay usable from the keyboard: the 中止 button, and the confirmation when closing the app.
      if (DIALOG_KEYS.has(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey
          && event.target instanceof Element && event.target.closest('[data-slot="dialog-content"]')) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, [busy]);
  useEffect(() => {
    const tick = async () => {
      if (!useStore.getState().uiStateLoaded || useSettingsNavigation.getState().open
          || useSyncState.getState().busy || useStore.getState().activeJobs.some(isRunning)) return;
      try {
        const state = await apiRequest<DriveStatus>("GET", "/api/drive");
        if (!state.connected || !state.auto_sync || state.conflicts.length || state.error) return;
        await syncDrive();
        await queryClient.invalidateQueries({ queryKey: ["drive"] });
      } catch {
        useStore.getState().setStatus("同期フォルダーを更新できませんでした。データはこのPCに保存されています。設定から再試行できます。");
      }
    };
    const initial = setTimeout(() => void tick(), 5000);
    const interval = setInterval(() => void tick(), 60_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [queryClient]);
  return <Dialog open={busy}><DialogContent showCloseButton={false}>
    <DialogTitle>同期フォルダーを更新中</DialogTitle>
    <DialogDescription>{cancelling ? "中止しています…" : "完了までお待ちください…"}</DialogDescription>
    <DialogFooter>
      <Button variant="outline" disabled={!jobId || cancelling} onClick={() => void cancelSync()}>中止</Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}

export function DriveSection() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["drive"], queryFn: () => apiRequest<DriveStatus>("GET", "/api/drive"), refetchInterval: 3000 });
  const [pending, setPending] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const jobsBusy = useStore(s => s.activeJobs.some(isRunning));
  const syncing = useSyncState(s => s.busy);
  const busy = pending || jobsBusy || syncing;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["drive"] });
  const chooseFolder = async () => {
    try {
      const parent = await shell.openFolder();
      if (parent) setFolder(joinPath(parent, "Papeer-sync"));
    } catch (e) { showError(e, "フォルダーを選択できませんでした"); }
  };
  const connectFolder = async () => {
    setPending(true);
    try {
      await apiRequest("POST", "/api/drive/folder", { path: folder ?? data?.folder ?? "" });
      await refresh();
      await syncDrive();
    } catch (e) { showError(e, "保存先を設定できませんでした"); }
    finally { setPending(false); void refresh(); }
  };
  const sync = async (choice?: string) => {
    if (choice && !await askConfirm("同期するデータを選択", "選んだライブラリ全体を使います。項目ごとの自動結合は行いません。このPCのデータを置き換える場合、元のデータは別フォルダーに残します。", "このデータを使う")) return;
    try { await syncDrive(choice, data?.conflicts.map(item => item.id)); }
    catch (e) { showError(e, "同期できませんでした"); }
    finally { void refresh(); }
  };
  const disconnect = async () => {
    if (!await askConfirm("ローカル保存に戻す", "同期フォルダーへの保存を停止します。このPCと同期フォルダーの保存済みデータは残ります。", "フォルダー同期を停止")) return;
    try { await apiRequest("DELETE", "/api/drive"); await refresh(); }
    catch (e) { showError(e, "フォルダー同期を停止できませんでした"); }
  };
  if (error) return <p role="alert">同期設定を読み込めませんでした。</p>;
  if (!data) return <p>読み込み中…</p>;
  return <div className="space-y-4 text-sm">
    <p className="font-medium">保存先：{data.connected ? "同期フォルダー ＋ このPC" : "このPC（ローカル）"}</p>
    <p>PDF、書き込み、付箋、サマリー、翻訳、メモ、チャット、タグ、辞書、テンプレート、設定をまとめて同期します。オフライン中もこのPCに保存します。</p>
    <p>PC版Google Driveの同期フォルダーを指定してください。アプリ内でのGoogleログインや認証設定は不要です。</p>
    <div className="space-y-2">
      <label htmlFor="sync-folder">同期データの保存先</label>
      <div className="flex gap-2"><Input id="sync-folder" value={folder ?? data.folder} disabled={busy}
        placeholder="G:\マイドライブ\Papeer-sync" onChange={e => setFolder(e.target.value)} />
        <Button variant="outline" disabled={busy} onClick={() => void chooseFolder()}>フォルダーを選択</Button></div>
      <p className="text-xs text-muted-foreground">フォルダー選択では、選んだ場所の中に Papeer-sync を作成します。パスを直接入力することもできます。</p>
      <Button disabled={busy || !(folder ?? data.folder).trim()} onClick={() => void connectFolder()}>保存先を設定して同期</Button>
    </div>
    {data.connected && <>
      <label className="flex items-center gap-2"><input type="checkbox" checked={data.auto_sync} disabled={busy}
        onChange={e => { void apiRequest("PUT", "/api/drive", { auto_sync: e.target.checked }).then(refresh).catch(e => showError(e, "同期設定を保存できませんでした")); }} />
        起動後と1分ごとに自動同期する（処理中・設定画面を開いている間は待機）</label>
      <p>最終フォルダー同期：{data.last_sync ? new Date(data.last_sync).toLocaleString() : "まだ同期していません"}</p>
      {data.error && <p role="alert" className="text-destructive">{data.error}</p>}
      <div className="flex gap-2"><Button disabled={busy} onClick={() => void sync()}>今すぐ同期</Button>
        <Button variant="outline" disabled={busy} onClick={() => void disconnect()}>ローカル保存に戻す</Button></div>
      {!!data.conflicts.length && <div className="space-y-2 rounded border p-3">
        <p>使用するライブラリを選んでください。初回接続時も、既存のデータを確認してから取り込みます。</p>
        <Button variant="outline" disabled={busy} onClick={() => void sync("local")}>このPCのデータを使う</Button>
        {data.conflicts.map(item => <div key={item.id}><Button variant="outline" disabled={busy} onClick={() => void sync(item.id)}>
          {item.device} — {new Date(item.created).toLocaleString()} のデータを使う
        </Button></div>)}
      </div>}
      {data.previous_path && <p className="break-all text-xs">取り込み前のデータ：{data.previous_path}</p>}
    </>}
    <p className="text-xs text-muted-foreground">PC間の転送はPC版Google Driveが行います。「今すぐ同期」の後、Google Drive側の同期完了も確認してから別PCに移ってください。別PCでは同じ同期フォルダーを指定します。変更時はライブラリ全体を保存し、履歴の分だけ容量を使います。</p>
    <Button variant="outline" onClick={() => openSettings("backup")}>バックアップ・復元を開く</Button>
  </div>;
}
