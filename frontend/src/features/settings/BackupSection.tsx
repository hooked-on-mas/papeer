import { useState } from "react";
import { apiRequest } from "@/api/client";
import { Button } from "@/components/ui/button";
import { askConfirm, showMessage } from "@/components/AppDialogs";
import { shell } from "@/shell";
import { isRunning, useStore } from "@/store";
import { startJob } from "@/features/jobs/jobEvents";
import { showError } from "@/components/errorDialog";
import { describeFailure, flushPendingSaves } from "@/lib/pendingSaves";
import { flushUiState, suspendUiStateSync } from "@/app/uiStateSync";
import { reloadUnlessClosing } from "@/app/appClosing";

export function BackupSection() {
  const [pending, setPending] = useState(false);
  // Off by default: the current settings and prompts stay. The CLI paths and API URL are this PC's and never restored.
  const [importSettings, setImportSettings] = useState(false);
  const busy = useStore(s => s.activeJobs.some(isRunning));
  const runningJob = useStore(s => s.activeJobs.find(j => isRunning(j) && (j.kind === "backup" || j.kind === "restore"))?.job_id);
  const [cancelling, setCancelling] = useState<string | null>(null);
  // A restore stops only before it swaps the folders; after that it runs to the end.
  const cancel = async (jobId: string) => {
    setCancelling(jobId);
    try { await apiRequest("POST", `/api/jobs/${jobId}/cancel`); }
    catch (error) { setCancelling(null); showError(error, "中止できませんでした"); }
  };
  const backup = async (restore: boolean) => {
    setPending(true);
    try {
      const failure = await flushPendingSaves();
      if (failure) throw new Error(describeFailure(failure));
      const path = restore ? (await shell.openFiles([{ name: "Papeer バックアップ", extensions: ["zip"] }]))[0]
        : await shell.saveFile(`Papeer-${new Date().toISOString().slice(0, 10)}.zip`, [{ name: "Papeer バックアップ", extensions: ["zip"] }]);
      if (!path) { setPending(false); return; }
      const settingsNote = importSettings ? "設定とプロンプトもバックアップのものに戻します。" : "設定とプロンプトは現在のものを残します。";
      if (restore && !await askConfirm("ライブラリを復元", `選んだバックアップの状態に戻します。${settingsNote}現在のデータは別フォルダーに残します。復元後は画面を読み込み直します。`, "復元", true)) { setPending(false); return; }
      await flushUiState();
      suspendUiStateSync(true);
      await startJob(restore ? "/api/restore" : "/api/backup", restore ? { path, import_settings: importSettings } : { path }, { kind: restore ? "restore" : "backup", paperId: null }, async event => {
        setPending(false);
        if (event.status !== "succeeded") { suspendUiStateSync(false); return; }
        if (restore) {
          await showMessage("復元しました", `復元前のデータは次の場所に残しています：\n${event.result.previous_path}\n\n画面を読み込み直します。`);
          useStore.setState({ uiStateLoaded: false, activePaperId: null, paperPages: {}, currentPage: 1, librarySearch: "", currentCollection: "", selectedFolder: null, expandedCollections: null, moveHistory: [], chatAttachments: [], chatInputs: {} });
          reloadUnlessClosing(() => window.location.reload());
        } else { suspendUiStateSync(false); useStore.getState().setStatus(`バックアップを保存しました：${path}`); }
      });
    } catch (error) { suspendUiStateSync(false); setPending(false); showError(error, "バックアップ・復元を実行できませんでした"); }
  };
  return <div className="space-y-5">
    <p>論文PDF、ペンの書き込み、翻訳結果、メモ、タグ、付箋、チャット、用語辞書、メモテンプレート、設定・プロンプトをまとめて保存します（CLIのパスとAPI URLはPCごとの設定のため含めません）。</p>
    <Button disabled={pending || busy} onClick={() => void backup(false)}>ライブラリ全体をバックアップ</Button>
    <div className="border-t pt-4 space-y-3"><p>バックアップから復元できます。復元前のデータは自動で別フォルダーに残ります。</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={importSettings} disabled={pending || busy} onChange={e => setImportSettings(e.target.checked)} />
        設定（AIの接続先・モデルなど）とプロンプトも復元する</label>
      <Button variant="outline" disabled={pending || busy} onClick={() => void backup(true)}>バックアップから復元</Button></div>
    {(pending || busy) && <p className="text-muted-foreground text-xs">処理が終わるまでお待ちください。</p>}
    {runningJob && <Button variant="outline" size="sm" disabled={cancelling === runningJob} onClick={() => void cancel(runningJob)}>
      {cancelling === runningJob ? "中止しています…" : "バックアップ・復元を中止"}</Button>}
  </div>;
}
