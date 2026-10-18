import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { showError } from "@/components/errorDialog";
import { isRunning, useStore } from "@/store";
import { flushPendingSaves, openEditLabels } from "@/lib/pendingSaves";
import { isAppClosing } from "@/app/appClosing";
import { useSettingsNavigation } from "./settingsNavigation";
import { startJob, requestCancel } from "@/features/jobs/jobEvents";

type CloudStatus = {
  connected: boolean; connecting: boolean; supported: boolean; auth_error: string | null;
  auto_upload: boolean | null; last_upload: string | null; error: string | null; folder_id: string | null;
};
const status = async () => await unwrap(api.GET("/api/cloud-drive")) as CloudStatus;
let starting = false;

async function upload(force = true) {
  if (starting || isAppClosing()) return;
  starting = true;
  try {
    const failure = await flushPendingSaves();
    if (failure) throw new Error(failure.message);
    await startJob("/api/cloud-drive/upload", { force }, { kind: "cloud-upload", paperId: null });
  } finally { starting = false; }
}

/** Runs while the app is open, including when the settings panel is closed. */
export function CloudDriveHost() {
  const job = useStore(s => s.activeJobs.find(j => j.kind === "cloud-upload" && isRunning(j)));
  useEffect(() => {
    let checking = false;
    const tick = async () => {
      if (checking || starting || isAppClosing() || useSettingsNavigation.getState().open
        || openEditLabels().length || useStore.getState().activeJobs.some(isRunning)) return;
      checking = true;
      try {
        const info = await status();
        if (info.connected && !info.connecting && info.auto_upload && !info.error
          && !useStore.getState().activeJobs.some(isRunning)) await upload(false);
      } catch { /* Offline/startup: next interval retries. Job failures remain visible in settings. */ }
      finally { checking = false; }
    };
    const initial = window.setTimeout(() => void tick(), 30_000);
    const interval = window.setInterval(() => void tick(), 5 * 60_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, []);
  return <Dialog open={!!job}><DialogContent showCloseButton={false}>
    <DialogTitle>Google Driveと同期</DialogTitle>
    <DialogDescription>Webの書き込みを取り込み、PDF・手書き・読書データを保存しています。この処理中は編集を一時停止します。</DialogDescription>
    <p role="status">{job?.message}</p>
    <Button variant="outline" onClick={() => { if (job) void requestCancel(job.job_id).catch(showError); }}>中止</Button>
  </DialogContent></Dialog>;
}

export function CloudDriveSection() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["cloud-drive"], queryFn: status, refetchInterval: 2000 });
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useStore(s => s.activeJobs.some(isRunning)) || pending || !!data?.connecting;
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    try { await action(); }
    catch (e) { showError(e, "Google Driveへの接続・保存を完了できませんでした"); }
    finally { setPending(false); void queryClient.invalidateQueries({ queryKey: ["cloud-drive"] }); }
  };
  return <section className="space-y-3 rounded-lg border p-4">
    <h3 className="font-medium">Google Drive API・Web閲覧</h3>
    <p>原文・翻訳PDF、手書きノート、付箋、メモ、資料、チャットなどをDrive APIで直接保存します。Web版で閲覧・PDFへの書き込みができ、次回同期時にPCへ取り込みます。同期フォルダーは不要です。</p>
    {error && <p role="alert">Google Driveの設定を取得できませんでした。</p>}
    {data?.supported === false && <p>APIへのアップロードはWindows版で設定してください。</p>}
    {data?.supported && !data.connected && <>
      <label className="block">デスクトップ用OAuthクライアントID
        <Input value={clientId} onChange={e => setClientId(e.target.value)} disabled={busy} autoComplete="off" /></label>
      <label className="block">デスクトップ用クライアントシークレット
        <Input type="password" value={secret} onChange={e => setSecret(e.target.value)} disabled={busy} autoComplete="off" /></label>
      <Button disabled={busy || !clientId.trim() || !secret.trim()} onClick={() => void run(async () => {
        await unwrap(api.POST("/api/cloud-drive/connect", { body: { client_id: clientId, client_secret: secret } }));
        setSecret("");
      })}>Googleに接続</Button>
    </>}
    {data?.connecting && <p role="status">ブラウザーでGoogleへの接続を完了してください（3分以内）。</p>}
    {data?.auth_error && <p role="alert" className="text-destructive">{data.auth_error}</p>}
    {data?.connected && <>
      <p>Google Driveに接続済み · 最終保存：{data.last_upload ? new Date(data.last_upload).toLocaleString() : "未保存"}</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={!!data.auto_upload} disabled={busy}
        onChange={e => void run(() => unwrap(api.PUT("/api/cloud-drive", { body: { auto_upload: e.target.checked } })))} />
        アプリ起動中、5分ごとに変更を自動アップロード</label>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void run(upload)}>今すぐアップロード</Button>
        <Button variant="outline" disabled={busy} onClick={() => void run(() => unwrap(api.DELETE("/api/cloud-drive")))}>接続解除</Button>
      </div>
      <p className="text-xs text-muted-foreground">自動アップロードは編集中のダイアログ・設定画面・ほかの処理が閉じた後に行います。接続解除してもDrive内のファイルは残ります。</p>
    </>}
    {data?.error && <p role="alert" className="text-destructive">{data.error}</p>}
  </section>;
}
