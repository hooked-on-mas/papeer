import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { QK } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { askConfirm, showMessage } from "@/components/AppDialogs";
import { shell } from "@/shell";
import { isRunning, useStore } from "@/store";
import { requestCancel, startJob } from "@/features/jobs/jobEvents";
import { showError } from "@/components/errorDialog";
import { describeFailure, flushPendingSaves } from "@/lib/pendingSaves";
import { flushUiState, suspendUiStateSync } from "@/app/uiStateSync";
import { reloadUnlessClosing } from "@/app/appClosing";
import { showSaved } from "@/app/savedNotice";
import { describeSideBackup, type SideBackup } from "./conflictSummary";
import { HistorySection } from "./HistorySection";

/** What a restore replaces the library with: a backup ZIP, or a state of this PC's history. */
type RestoreSource = { kind: "zip"; path: string } | { kind: "history"; entryId: string; title: string };

export function BackupSection() {
  const [pending, setPending] = useState(false);
  // Off by default: the current settings and prompts stay. The CLI paths and API URL are this PC's and never restored.
  const [importSettings, setImportSettings] = useState(false);
  const busy = useStore(s => s.activeJobs.some(isRunning));
  const runningJob = useStore(s => s.activeJobs.find(j => isRunning(j) && (j.kind === "backup" || j.kind === "restore"))?.job_id);
  const [cancelling, setCancelling] = useState<string | null>(null);
  // ZIPs an earlier Papeer kept of what a choice between two libraries left out; restored like any backup.
  const sideBackups = useQuery({ queryKey: [QK.sideBackups],
    queryFn: async () => await unwrap(api.GET("/api/drive/side-backups")) as { items: SideBackup[]; limit: number } });
  // A restore stops only before it swaps the folders; after that it runs to the end.
  const cancel = async (jobId: string) => {
    setCancelling(jobId);
    try { await requestCancel(jobId); }
    catch (error) { setCancelling(null); showError(error, "中止できませんでした"); }
  };
  const settingsNote = () => importSettings ? "設定とプロンプトも戻します。" : "設定とプロンプトは現在のものを残します。";
  /** Replace the library, after the user confirmed; the page reloads once it is done. */
  const restore = async (source: RestoreSource) => {
    const message = source.kind === "zip"
      ? `選んだバックアップの状態に戻します。${settingsNote()}今のデータはこのPCの履歴に「戻す前」として残します（戻す前の記録は最新3件まで残ります。過去の時点を試しただけの記録と、履歴にある状態と同じものは数えません）。復元後は画面を読み込み直します。`
      : `${source.title} の状態に戻します。${settingsNote()}今のデータはこのPCの履歴に「戻す前」として残します（戻す前の記録は最新3件まで残ります。過去の時点を試しただけの記録と、履歴にある状態と同じものは数えません）。復元後は画面を読み込み直します。`;
    if (!await askConfirm(source.kind === "zip" ? "ライブラリを復元" : "この時点に戻す", message, "戻す", true)) { setPending(false); return; }
    await flushUiState();
    suspendUiStateSync(true);
    const [path, body] = source.kind === "zip"
      ? ["/api/restore", { path: source.path, import_settings: importSettings }]
      : ["/api/history/restore", { entry_id: source.entryId, import_settings: importSettings }];
    await startJob(path, body, { kind: "restore", paperId: null }, async event => {
      setPending(false);
      if (event.status !== "succeeded") { suspendUiStateSync(false); return; }
      const previous = event.result.previous_path;
      await showMessage("復元しました", (previous ? `復元前のデータは次の場所に残しています：\n${previous}`
        : "復元前のデータは、このPCの履歴に「戻す前」として残しています（この画面の「このPCの履歴から戻す」から戻せます）。")
        + "\n\n画面を読み込み直します。");
      useStore.setState({ uiStateLoaded: false, activePaperId: null, paperPages: {}, currentPage: 1, librarySearch: "", currentCollection: "", selectedFolder: null, expandedCollections: null, moveHistory: [], chatAttachments: [], chatInputs: {} });
      reloadUnlessClosing(() => window.location.reload());
    });
  };
  /** A backup to a file, or a restore: from a file the user picks, a ZIP kept earlier (`chosen`), or the history. */
  const run = async (action: "backup" | "restore", chosen?: RestoreSource) => {
    setPending(true);
    try {
      const failure = await flushPendingSaves();
      if (failure) throw new Error(describeFailure(failure));
      if (action === "restore") {
        const source = chosen ?? await (async (): Promise<RestoreSource | null> => {
          const path = (await shell.openFiles([{ name: "Papeer バックアップ", extensions: ["zip"] }]))[0];
          return path ? { kind: "zip", path } : null;
        })();
        if (!source) { setPending(false); return; }
        await restore(source);
        return;
      }
      const path = await shell.saveFile(`Papeer-${new Date().toISOString().slice(0, 10)}.zip`, [{ name: "Papeer バックアップ", extensions: ["zip"] }]);
      if (!path) { setPending(false); return; }
      await startJob("/api/backup", { path }, { kind: "backup", paperId: null }, async event => {
        setPending(false);
        if (event.status === "succeeded") showSaved("バックアップを保存しました", path);
      });
    } catch (error) { suspendUiStateSync(false); setPending(false); showError(error, "バックアップ・復元を実行できませんでした"); }
  };
  const disabled = pending || busy;
  return <div className="space-y-5">
    <div className="space-y-1">
      <p>論文と読書データをまとめて保存します。</p>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">保存する内容と対象外の設定</summary>
        <p className="mt-1">論文PDF、ペンの書き込み、翻訳結果、メモ、タグ、付箋、チャット、用語辞書、メモテンプレート、設定・プロンプトを保存します。CLIのパスとAPI URLはPCごとの設定のため含めません。</p>
      </details>
    </div>
    <Button disabled={disabled} onClick={() => void run("backup")}>ライブラリ全体をバックアップ</Button>
    <div className="border-t pt-4 space-y-3"><p>バックアップから復元できます。復元前のデータは、このPCの履歴に「戻す前」として残ります。</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={importSettings} disabled={disabled} onChange={e => setImportSettings(e.target.checked)} />
        設定（AIの接続先・モデルなど）とプロンプトも復元する</label>
      <Button variant="outline" disabled={disabled} onClick={() => void run("restore")}>バックアップから復元</Button></div>
    <HistorySection disabled={disabled} onRestore={(entryId, title) => void run("restore", { kind: "history", entryId, title })} />
    {!!sideBackups.data?.items.length && <div className="border-t pt-4 space-y-3"><h3 className="font-medium">以前の退避データ（ZIP）</h3>
      <p>以前のバージョンは、フォルダー同期で選ばなかった側のデータをZIPで残していました（今は「このPCの履歴」に残します）。上の復元と同じ方法で戻せます。不要になったら、下の「以前のデータ」から削除できます。</p>
      <ul className="space-y-2">{sideBackups.data.items.map(item => {
        const { title, detail } = describeSideBackup(item, iso => new Date(iso).toLocaleString());
        return <li key={item.path} className="flex items-center justify-between gap-3 rounded border p-2">
          <div className="min-w-0"><p className="break-all">{title}</p><p className="text-muted-foreground text-xs break-all">{detail}</p></div>
          <Button variant="outline" size="sm" disabled={disabled} aria-label={`${title} を復元`}
            onClick={() => void run("restore", { kind: "zip", path: item.path })}>復元</Button>
        </li>;
      })}</ul>
    </div>}
    {sideBackups.error && <p role="alert" className="text-destructive">以前の退避データの一覧を読み込めませんでした。</p>}
    {disabled && <p className="text-muted-foreground text-xs">処理が終わるまでお待ちください。</p>}
    {runningJob && <Button variant="outline" size="sm" disabled={cancelling === runningJob} onClick={() => void cancel(runningJob)}>
      {cancelling === runningJob ? "中止しています…" : "バックアップ・復元を中止"}</Button>}
  </div>;
}
