import { useEffect, useState } from "react";
import { api, ApiError, unwrap } from "@/api/client";
import { invalidate } from "@/api/mutations";
import { QK } from "@/lib/queryKeys";
import { cancelSync, confirmOpenEdits, migrateDrive, reportSyncOutcome, runDriveSync, syncDrive, useSyncState } from "./driveSync";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { askConfirm } from "@/components/AppDialogs";
import { showError } from "@/components/errorDialog";
import { showToast } from "@/components/toast";
import { shell, joinPath } from "@/shell";
import { isRunning, useStore } from "@/store";
import { openSettings, useSettingsNavigation } from "./settingsNavigation";
import { openEditLabels } from "@/lib/pendingSaves";
import { isAppClosing } from "@/app/appClosing";
import { PublishSchedule } from "./autoSyncSchedule";
import { describeDifference, type Counts } from "./conflictSummary";
import { fetchDriveFormat, fetchDriveStatus, fetchSyncCheck, removeOldSyncData, type DriveFormat, type DriveStatus, type SyncReview, type SyncWaiting } from "./driveApi";
import { isAutoSyncFailure } from "./syncWarnings";
import { VersionNoticeSetting } from "./VersionNoticeHost";
import { formatSize } from "./historyApi";
import { oldDataConfirmText, revisionNote } from "./syncFolderText";
import { PLATFORM, syncClientNames } from "@/lib/platform";

const client = syncClientNames();

const COUNT_LABELS: [keyof Counts, string][] = [["papers", "論文"], ["notes", "メモ"], ["stickies", "付箋"], ["ink", "書き込み（ページ）"]];
// Told once per launch; the settings keep showing it.
let missingLibraryShown = false;
let reviewShown = false;
// 「あとで」 on the move to the new format: asked again at the next launch.
let migrationLater = false;

/** A stopped sync waits for an answer in the settings; say so once per launch, not only in the status line. */
async function tellReview(review: SyncReview): Promise<void> {
  if (reviewShown || useSettingsNavigation.getState().open) return;
  reviewShown = true;
  if (await askConfirm("同期を一時停止しています", `${review.message}\n設定 → 保存先・同期で件数を確認し、同期するかどうかを選んでください。`,
    "保存先・同期を開く")) openSettings("drive");
}
const DIALOG_KEYS = new Set(["Tab", "Enter", " ", "Escape"]);

/**
 * Mounted once: runs the automatic sync, flushes editors before every sync, and blocks new edits until
 * a sync with the waiting screen finishes. The background one leaves the app usable (see syncDrive).
 */
export function DriveSyncHost() {
  const busy = useSyncState(s => s.busy);
  const background = useSyncState(s => s.background);
  const jobId = useSyncState(s => s.jobId);
  const cancelling = useSyncState(s => s.cancelling);
  const migrating = useSyncState(s => s.migrating);
  const queryClient = useQueryClient();
  const blocking = busy && !background;
  // A sync going on with a migration left to go on gives it up too when stopped (folder_sync.abandon_migration).
  const moving = migrating || !!queryClient.getQueryData<DriveStatus>([QK.drive])?.migration_pending;
  useEffect(() => {
    if (!blocking) return;
    const block = (event: KeyboardEvent) => {
      // Dialogs stay usable from the keyboard: the 中止 button, and the confirmation when closing the app.
      if (DIALOG_KEYS.has(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey
          && event.target instanceof Element && event.target.closest('[data-slot="dialog-content"]')) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, [blocking]);
  useEffect(() => {
    const schedule = new PublishSchedule();
    // While the app is closing, its own last sync runs (AppShell); one started here would get in its way.
    const idle = () => useStore.getState().uiStateLoaded && !useSyncState.getState().busy && !isAppClosing()
      && !useStore.getState().activeJobs.some(isRunning);
    const tick = async () => {
      if (!idle()) return;
      // Whether the sync was found to be set up and on: until then, there is no sync to fail.
      let syncOn = false;
      try {
        const state = await fetchDriveStatus();
        if (state.library_missing) {
          if (!missingLibraryShown && !useSettingsNavigation.getState().open) {
            missingLibraryShown = true;
            if (await askConfirm("データフォルダーが見つかりません",
              "このPCで同期していたライブラリのデータフォルダーが見つかりません。空のライブラリを作って同期すると、他のPCのデータまで失われるため、同期と編集を止めています。\n"
              + "フォルダーを移動・削除した場合は元の場所に戻してください。新しいライブラリとして始める場合は、設定 → 保存先・同期から選べます。",
              "保存先・同期を開く")) openSettings("drive");
          }
          return;
        }
        // A review waits for the user's answer, like a conflict or an error.
        if (state.connected && state.review) { await tellReview(state.review); return; }
        // Waiting for another PC's data goes on by itself (the check starts a sync once something arrived);
        // after a day, the user is told.
        if (state.connected && state.waiting?.overdue) reportSyncOutcome("waiting");
        if (!state.connected || !state.auto_sync || state.conflicts.length || state.error) return;
        syncOn = true;
        // Cheap, and the library stays usable meanwhile: a sync (which holds it) runs only when there is
        // something to do. Hashing every file each minute is what this avoids (drive_sync.check).
        const check = await fetchSyncCheck();
        // Taking in another PC's library reloads the page: a sync that may do so waits while the settings
        // or a dialog holding a draft is open, and runs with the waiting screen (autoSyncSchedule.ts).
        const editing = () => useSettingsNavigation.getState().open || openEditLabels().length > 0;
        const mode = schedule.next(check, Date.now(), editing());
        if (!mode || !idle()) return;
        schedule.synced();
        const result = await runDriveSync(undefined, undefined, false, mode === "background");
        if (result.reloading) return;
        if (schedule.afterBackground(result.status, editing()) && idle()) {
          // Another PC's library arrived: take it in now rather than a minute later, before more edits here.
          if (await syncDrive()) return; // Reloading.
        }
        await invalidate({ kind: "drive" }, queryClient);
        const after = await fetchDriveStatus();
        if (after.review) await tellReview(after.review);
      } catch (e) {
        // Told once while the automatic sync keeps failing, not every minute; not when the sidecar could
        // not be reached, which the connection banner tells (isAutoSyncFailure).
        if (isAutoSyncFailure({ syncOn, status: e instanceof ApiError ? e.status : undefined })) reportSyncOutcome("failed");
      }
    };
    const initial = setTimeout(() => void tick(), 5000);
    const interval = setInterval(() => void tick(), 60_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [queryClient]);
  return <Dialog open={blocking}><DialogContent showCloseButton={false}>
    <DialogTitle>同期フォルダーを更新中</DialogTitle>
    <DialogDescription>{cancelling ? "中止しています…" : "完了までお待ちください…"}</DialogDescription>
    {moving && !cancelling && <p className="text-xs text-muted-foreground">中止すると、同期の形式の移行もやめます（保存先・同期から、もう一度始められます）。</p>}
    <DialogFooter>
      <Button variant="outline" disabled={!jobId || cancelling} onClick={() => void cancelSync()}>中止</Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}

export function DriveSection() {
  const queryClient = useQueryClient();
  const { data, error } = useQuery({ queryKey: [QK.drive], queryFn: fetchDriveStatus, refetchInterval: 3000 });
  // Reads the sync folder's list of old revisions: fetched when the settings open and after each change, not every 3 s.
  const { data: format } = useQuery({ queryKey: [QK.drive, "format"], queryFn: fetchDriveFormat, enabled: !!data?.connected });
  const [later, setLater] = useState(migrationLater);
  const [pending, setPending] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const jobsBusy = useStore(s => s.activeJobs.some(isRunning));
  const syncing = useSyncState(s => s.busy);
  const busy = pending || jobsBusy || syncing;
  const refresh = () => invalidate({ kind: "drive" }, queryClient);
  const chooseFolder = async () => {
    try {
      const parent = await shell.openFolder();
      if (parent) setFolder(joinPath(parent, "Papeer-sync"));
    } catch (e) { showError(e, "フォルダーを選択できませんでした"); }
  };
  const connectFolder = async () => {
    if (!await confirmOpenEdits()) return;
    setPending(true);
    try {
      await unwrap(api.POST("/api/drive/folder", { body: { path: folder ?? data?.folder ?? "" } }));
      await refresh();
      await syncDrive();
    } catch (e) { showError(e, "保存先を設定できませんでした"); }
    finally { setPending(false); void refresh(); }
  };
  const sync = async (choice?: string, confirm = false, heads = data?.conflicts.map(item => item.id)) => {
    if (choice && !await askConfirm("同期するデータを選択",
      "選んだライブラリ全体を使います。項目ごとの自動結合は行いません。選ばなかった側のデータはこのPCの履歴に退避し、設定 → バックアップの「このPCの履歴から戻す」で戻せます。",
      "このデータを使う")) return;
    if (!await confirmOpenEdits()) return;
    try { await syncDrive(choice, heads, confirm); }
    catch (e) { showError(e, "同期できませんでした"); }
    finally { void refresh(); }
  };
  const skipReview = async () => {
    try {
      await unwrap(api.DELETE("/api/drive/review"));
      showToast({ title: "同期しませんでした", description: "自動同期を停止しています。確認後に「今すぐ同期」または自動同期を有効にしてください。", tone: "error", timeout: 0 });
    } catch (e) { showError(e, "同期設定を保存できませんでした"); }
    finally { void refresh(); }
  };
  const startNewLibrary = async () => {
    if (!await askConfirm("新しいライブラリとして始める",
      "空のライブラリを作ります。前回の同期の記録はこのPCから消えるため、次の同期では同期フォルダーのデータを使うか選べます（空のライブラリで上書きはしません）。\n元のデータフォルダーを戻せる場合は、先に戻してください。",
      "新しいライブラリとして始める", true)) return;
    setPending(true);
    try {
      await unwrap(api.POST("/api/drive/new-library"));
      await queryClient.invalidateQueries();
      if (data?.connected) await syncDrive();
    } catch (e) { showError(e, "新しいライブラリを作成できませんでした"); }
    finally { setPending(false); void refresh(); }
  };
  const migrate = async () => {
    if (!await confirmOpenEdits()) return;
    migrationLater = false;
    setLater(false);
    try { await migrateDrive(); }
    catch (e) { showError(e, "同期の形式を移せませんでした"); }
    finally { void refresh(); }
  };
  const removeOldData = async (info: DriveFormat) => {
    if (!await askConfirm("古い形式の同期データを削除", oldDataConfirmText(info, PLATFORM !== "linux"), "削除する", true)) return;
    setPending(true);
    try {
      const result = await removeOldSyncData(info.removable.ids);
      showToast({ title: "古い形式の同期データを削除しました",
        description: `${result.removed}個（${formatSize(result.size)}）を削除しました。`
          + (result.failed ? `${result.failed}個は削除できませんでした。もう一度「削除」を押してください。` : ""),
        tone: result.failed ? "error" : "success" });
    } catch (e) { showError(e, "古い形式の同期データを削除できませんでした"); }
    finally { setPending(false); void refresh(); }
  };
  const disconnect = async () => {
    if (!await askConfirm("ローカル保存に戻す", "同期フォルダーへの保存を停止します。このPCと同期フォルダーの保存済みデータは残ります。", "フォルダー同期を停止")) return;
    try { await unwrap(api.DELETE("/api/drive")); await refresh(); }
    catch (e) { showError(e, "フォルダー同期を停止できませんでした"); }
  };
  if (error) return <p role="alert">同期設定を読み込めませんでした。</p>;
  if (!data) return <p>読み込み中…</p>;
  return <div className="space-y-4 text-sm">
    {data.library_missing && <div role="alert" className="space-y-2 rounded border border-destructive p-3">
      <p className="font-medium text-destructive">データフォルダーが見つかりません</p>
      <p>このPCで同期していたライブラリのフォルダーがありません。空のライブラリで同期フォルダーを上書きしないよう、同期と編集を止めています。移動・削除した場合は元の場所に戻してください（戻すとそのまま使えます）。</p>
      <Button variant="outline" disabled={busy} onClick={() => void startNewLibrary()}>新しいライブラリとして始める</Button>
    </div>}
    <p className="font-medium">保存先：{data.connected ? "同期フォルダー ＋ このPC" : "このPC（ローカル）"}</p>
    <p>論文と読書データをまとめて同期します。オフライン中もこのPCに保存します。</p>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">同期する内容</summary><p className="mt-1">PDF、書き込み、付箋、サマリー、翻訳、メモ、チャット、タグ、辞書、テンプレート、設定をまとめて同期します。</p></details>
    <p>{PLATFORM === "linux"
      ? "PC間で同期されるこのPCのフォルダー（Syncthing・Dropbox などの同期ソフトが同期するもの。ネットワーク上のドライブとして開いたものは使えません）を指定してください。アプリ内でのログインや認証設定は不要です。"
      : "PC版Google Driveの同期フォルダーを指定してください。アプリ内でのGoogleログインや認証設定は不要です。"}</p>
    <div className="space-y-2">
      <label htmlFor="sync-folder">同期データの保存先</label>
      <div className="flex gap-2"><Input id="sync-folder" value={folder ?? data.folder} disabled={busy}
        placeholder={client.folderExample} onChange={e => setFolder(e.target.value)} />
        <Button variant="outline" disabled={busy} onClick={() => void chooseFolder()}>フォルダーを選択</Button></div>
      <p className="text-xs text-muted-foreground">フォルダー選択では、選んだ場所の中に Papeer-sync を作成します。パスを直接入力することもできます。</p>
      <Button disabled={busy || !(folder ?? data.folder).trim()} onClick={() => void connectFolder()}>保存先を設定して同期</Button>
    </div>
    {data.connected && <>
      <label className="flex items-center gap-2"><input type="checkbox" checked={data.auto_sync} disabled={busy}
        onChange={e => { void unwrap(api.PUT("/api/drive", { body: { auto_sync: e.target.checked } })).then(refresh).catch(e => showError(e, "同期設定を保存できませんでした")); }} />
        変更を自動で同期する（起動後と1分ごとに確認。編集が続いている間は最長5分まとめ、処理中は待機。他のPCのデータの取り込みは、設定画面や編集中のダイアログを閉じてから）</label>
      <p>最終フォルダー同期：{data.last_sync ? new Date(data.last_sync).toLocaleString() : "まだ同期していません"}</p>
      {data.error && <p role="alert" className="text-destructive">{data.error}</p>}
      {data.restored && !data.review && <p className="text-amber-700 dark:text-amber-400">要確認：バックアップから復元しました。次の同期で、同期フォルダーに保存してよいか確認します。</p>}
      {data.waiting && <WaitingPanel waiting={data.waiting} busy={busy} onGoOn={() => void sync("local", false, data.waiting?.heads)} />}
      <MigrationPanel status={data} format={format} busy={busy} later={later}
        onMigrate={() => void migrate()} onLater={() => { migrationLater = true; setLater(true); }} />
      {data.review && <ReviewPanel review={data.review} busy={busy}
        onSync={() => void sync(undefined, true)} onSkip={() => void skipReview()}
        onChoose={choice => void sync(choice, false, data.review?.heads)} />}
      <div className="flex gap-2"><Button disabled={busy} onClick={() => void sync()}>今すぐ同期</Button>
        <Button variant="outline" disabled={busy} onClick={() => void disconnect()}>ローカル保存に戻す</Button></div>
      {!!data.conflicts.length && <div className="space-y-3 rounded border p-3">
        <p>使用するライブラリを選んでください。初回接続時も、既存のデータを確認してから取り込みます。選ばなかった側のデータはこのPCの履歴に退避し、設定 → バックアップの「このPCの履歴から戻す」で戻せます。</p>
        <Button variant="outline" disabled={busy} onClick={() => void sync("local")}>このPCのデータを使う</Button>
        {data.conflicts.map(item => <div key={item.id} className="space-y-1">
          <Button variant="outline" disabled={busy} onClick={() => void sync(item.id)}>
            {item.device} — {new Date(item.created).toLocaleString()}{revisionNote(item)} のデータを使う
          </Button>
          {item.diff !== undefined && <ul aria-label="このPCとの違い" className="list-disc space-y-0.5 pl-5 text-xs break-all">
            {describeDifference(item.diff).map(line => <li key={line}>{line}</li>)}
          </ul>}
        </div>)}
      </div>}
      {!!data.not_set_aside?.length && <div role="alert" className="text-amber-700 dark:text-amber-400">
        <p>選ばなかった次の同期データは、読み取れないか破損していたため、このPCの履歴に退避できませんでした（同期フォルダーの履歴には残っています）。</p>
        <ul className="list-disc pl-5">{data.not_set_aside.map(item =>
          <li key={item.id}>{item.device} — {new Date(item.created).toLocaleString()}</li>)}</ul>
      </div>}
      {data.previous_path && <p className="break-all text-xs">取り込み前のデータ（このPCの履歴で確かめられなかったため、フォルダーに残しています）：{data.previous_path}</p>}
      {format?.format === 2 && !!format.revisions.count && <OldSyncData format={format} busy={busy} onRemove={() => void removeOldData(format)} />}
    </>}
    <VersionNoticeSetting />
    <details open={data.connected} className="text-xs text-muted-foreground"><summary className="cursor-pointer">別のPCで使うときの注意</summary><p className="mt-1">PC間の転送は{client.app}が行います。「今すぐ同期」の後、{client.service}側の同期完了も確認してから別PCに移ってください。別PCでは同じ同期フォルダーを指定します。{format?.format === 1
      ? "以前の形式では、変更のたびにライブラリ全体を保存し、履歴の分だけ容量を使います。"
      : "同期フォルダーには変わったファイルだけを保存し、以前の状態はこのPCの履歴に残します。"}</p></details>
    <Button variant="outline" onClick={() => openSettings("backup")}>バックアップ・復元を開く</Button>
  </div>;
}

/** onChoose goes back to normal sync without losing anything, through the usual choice of a whole library. */
function ReviewPanel({ review, busy, onSync, onSkip, onChoose }: {
  review: SyncReview; busy: boolean; onSync: () => void; onSkip: () => void; onChoose: (choice: string) => void;
}) {
  const count = (counts: Counts | null, key: keyof Counts) => counts?.[key] ?? "—";
  return <div role="alert" className="space-y-2 rounded border border-amber-500 p-3">
    <p className="font-medium">要確認：同期を一時停止しています</p>
    <p>{review.message}</p>
    <table className="text-xs">
      <thead><tr><th className="pr-4 text-left font-normal text-muted-foreground" />
        <th className="pr-4 text-right font-normal">{review.before_label}</th><th className="pr-4" />
        <th className="text-right font-normal">{review.after_label}</th></tr></thead>
      <tbody>{COUNT_LABELS.map(([key, label]) => {
        const before = count(review.before, key), after = count(review.after, key);
        return <tr key={key} className={typeof before === "number" && typeof after === "number" && after < before ? "font-medium" : ""}>
          <td className="pr-4">{label}</td><td className="pr-4 text-right">{before}</td><td className="pr-4">→</td><td className="text-right">{after}</td>
        </tr>;
      })}</tbody>
    </table>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy} onClick={onSync}>このまま同期する</Button>
      {review.reason === "remote_shrunk"
        ? <Button variant="outline" disabled={busy} onClick={() => onChoose("local")}>このPCのデータを使う</Button>
        : review.heads.length === 1 && <Button variant="outline" disabled={busy} onClick={() => onChoose(review.heads[0])}>同期フォルダーのデータに戻す</Button>}
      <Button variant="outline" disabled={busy} onClick={onSkip}>同期しない（自動同期を停止）</Button>
    </div>
  </div>;
}

/** What the sync waits for, and going on with this PC's library without waiting (its choice "local"). */
function WaitingPanel({ waiting, busy, onGoOn }: { waiting: SyncWaiting; busy: boolean; onGoOn: () => void }) {
  return <div role="status" className={`space-y-2 rounded border p-3 ${waiting.overdue ? "border-amber-500" : ""}`}>
    <p className="font-medium">同期データの到着を待っています</p>
    <p>{waiting.message}</p>
    <p className="text-xs text-muted-foreground">届くと自動で同期します。待っている間、このPCの変更は同期フォルダーに保存しません（このPCには保存されています）。</p>
    <Button variant="outline" disabled={busy} onClick={onGoOn}>このPCのデータで続ける</Button>
  </div>;
}

/**
 * The move to the new format (folder_sync.migrate): offered while the sync folder is in the first format and
 * holds its data (an empty one starts in the new format without asking); told while one goes on.
 */
function MigrationPanel({ status, format, busy, later, onMigrate, onLater }: {
  status: Pick<DriveStatus, "migration_pending">; format: DriveFormat | undefined; busy: boolean; later: boolean;
  onMigrate: () => void; onLater: () => void;
}) {
  if (status.migration_pending) {
    return <p role="status" className="text-amber-700 dark:text-amber-400">移行の途中です（次の同期で続けます）。</p>;
  }
  if (format?.format !== 1 || !format.revisions.count) return null;
  if (later) {
    return <div className="flex flex-wrap items-center gap-2">
      <span>同期の形式：以前の形式</span>
      <Button variant="outline" disabled={busy} onClick={onMigrate}>新しい形式に移す</Button>
    </div>;
  }
  return <div role="region" aria-label="同期の形式の移行" className="space-y-2 rounded border border-primary/50 p-3">
    <p className="font-medium">新しい同期の形式に移せます</p>
    <p>新しい同期の形式に移すと、{client.service}の使用量が減り、履歴はこのPCに残ります。</p>
    <p className="text-xs text-muted-foreground">ほかのPCもPapeerを更新してください。更新するまで、そのPCでは同期できません。初回はライブラリ全体を新しい形式で保存するため、時間がかかります。以前の形式のデータは、移した後に削除できます。</p>
    <div className="flex gap-2">
      <Button disabled={busy} onClick={onMigrate}>移す</Button>
      <Button variant="outline" disabled={busy} onClick={onLater}>あとで</Button>
    </div>
  </div>;
}

/** In the new format: the first format's data left in the sync folder, removed after confirming (at any time). */
function OldSyncData({ format, busy, onRemove }: { format: DriveFormat; busy: boolean; onRemove: () => void }) {
  return <div className={`space-y-2 rounded border p-3 ${format.ready ? "border-primary/50" : ""}`}>
    <p>古い形式の同期データ：{format.revisions.count}個・{formatSize(format.revisions.size)}</p>
    {format.ready
      ? <p role="status">すべてのPCが新しい形式で同期しました。古い形式の同期データは同期に使わないため、削除して容量を空けられます。</p>
      : <p className="text-xs text-muted-foreground">同期には使いません。ほかのPCが新しい形式で同期してから削除することをおすすめします。</p>}
    <Button variant="outline" disabled={busy || !format.removable.count} onClick={onRemove}>削除する…</Button>
  </div>;
}
