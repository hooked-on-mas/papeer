import { create } from "zustand";
import { ApiError } from "@/api/client";
import { showError } from "@/components/errorDialog";
import { closeToast, showToast } from "@/components/toast";
import { isRunning, useStore } from "@/store";
import { requestCancel, startJob } from "@/features/jobs/jobEvents";
import { useConnection } from "@/features/jobs/connection";
import { flushPendingSaves, describeFailure, openEditLabels } from "@/lib/pendingSaves";
import { askConfirm } from "@/components/AppDialogs";
import { flushUiState, suspendUiStateSync } from "@/app/uiStateSync";
import { reloadUnlessClosing } from "@/app/appClosing";
import { setLibraryBusyWaiter } from "@/lib/libraryBusy";
import { openSettings } from "./settingsNavigation";
import { clearsOnReconnect, nextSyncWarning, SYNC_WARNINGS, type SyncWarning } from "./syncWarnings";

/** background: the automatic sync that runs without the waiting screen (it never replaces the library). */
export const useSyncState = create<{ busy: boolean; jobId: string | null; cancelling: boolean; background: boolean }>(
  () => ({ busy: false, jobId: null, cancelling: false, background: false }));

// When the last sync ended, if it ran in the background: a refusal answered just before that is its own too.
let backgroundEndedAt = 0;

// A request the sidecar refused because a background sync held the library is sent again once the sync
// is over (libraryBusy.ts); the user's edit is neither lost nor reported as a failure.
setLibraryBusyWaiter(async () => {
  const start = useSyncState.getState();
  if (!start.busy) return Date.now() - backgroundEndedAt < 3000;
  if (!start.background) return false;
  return new Promise<boolean>(resolve => {
    const unsubscribe = useSyncState.subscribe(state => {
      if (!state.busy) { clearTimeout(timer); unsubscribe(); resolve(true); }
    });
    // The request that starts the sync is refused only for another job (a backup): its id never comes.
    const timer = setTimeout(() => {
      if (!useSyncState.getState().jobId) { unsubscribe(); resolve(false); }
    }, 2000);
  });
});

/** Stop the running sync; the library stays as it was unless the final replacement had already begun. */
export async function cancelSync(): Promise<void> {
  const { jobId, cancelling } = useSyncState.getState();
  if (!jobId || cancelling) return;
  useSyncState.setState({ cancelling: true });
  try {
    await requestCancel(jobId);
  } catch (e) {
    useSyncState.setState({ cancelling: false });
    // 404: the sync has just finished by itself.
    if (!(e instanceof ApiError && e.status === 404)) showError(e, "同期を中止できませんでした");
  }
}

/**
 * Before a sync the user started: taking in another PC's library reloads the page, which would throw
 * away a draft still open in a dialog (a sticky note hidden behind the settings, for example).
 */
export async function confirmOpenEdits(): Promise<boolean> {
  const labels = openEditLabels();
  if (!labels.length) return true;
  return askConfirm("編集中の内容があります",
    `${labels.join("・")}を編集中です。同期で他のPCのデータを取り込むと画面を再読み込みするため、保存していない編集内容は失われます。\n同期を続けますか？`,
    "同期する", true);
}

let shownWarning: SyncWarning | null = null;
// Whether the warning on screen was told while the sidecar could not be reached.
let toldWhileDown = false;

// Once the sidecar is back, a failure told during the drop goes (clearsOnReconnect); the automatic sync
// tells it again if it still fails.
useConnection.subscribe((state, prev) => {
  if (!state.connected || prev.connected) return;
  if (clearsOnReconnect(shownWarning, toldWhileDown)) {
    shownWarning = null;
    closeToast("sync-warning");
  }
  toldWhileDown = false;
});

/**
 * Tell a sync state the user has to act on (syncWarnings.ts) in a toast that stays until closed,
 * once while it lasts; null after a sync that went through, which also closes a stale warning.
 */
export function reportSyncOutcome(outcome: SyncWarning | null): void {
  const next = nextSyncWarning(shownWarning, outcome);
  shownWarning = next.shown;
  if (!outcome) {
    closeToast("sync-warning");
    return;
  }
  if (!next.tell) return;
  toldWhileDown = !useConnection.getState().connected;
  showToast({
    id: "sync-warning",
    ...SYNC_WARNINGS[outcome],
    tone: "error",
    timeout: 0,
    action: { label: "確認する", run: () => openSettings("drive") },
  });
}

/**
 * confirm: 「このまま同期する」 on a sync that stopped for review (a library that lost many items,
 * or one restored from a backup); the sidecar applies it only if nothing changed since.
 * background: the automatic sync, without the waiting screen; the user's requests wait for it. It never
 * takes in another PC's library (the page would reload under the user), and leaves that to a later sync.
 */
export async function syncDrive(choice?: string, heads?: string[], confirm = false, background = false): Promise<boolean> {
  return (await runDriveSync(choice, heads, confirm, background)).reloading;
}

/**
 * syncDrive, also telling how the sync ended: the result's status ("synced", "deferred", "conflict",
 * "review"), "cancelled", or undefined when it did not run.
 */
export async function runDriveSync(choice?: string, heads?: string[], confirm = false, background = false):
    Promise<{ reloading: boolean; status?: string }> {
  if (useSyncState.getState().busy || useStore.getState().activeJobs.some(isRunning)) return { reloading: false };
  useSyncState.setState({ busy: true, background });
  let reloading = false;
  let status: string | undefined;
  try {
    const failure = await flushPendingSaves();
    if (failure) throw new Error(describeFailure(failure));
    await flushUiState();
    suspendUiStateSync(true);
    await new Promise<void>((resolve, reject) => {
      startJob("/api/drive/sync", { choice, expected_heads: heads, confirm, background }, { kind: "drive-sync", paperId: null }, event => {
        // Stopped on request: not an error (the status line already says so).
        if (event.status === "cancelled") { status = "cancelled"; resolve(); return; }
        if (event.status !== "succeeded") { reject(new Error(event.error || "同期を完了できませんでした。")); return; }
        status = event.result.status;
        // A background sync found another PC's library to take in; the caller takes it in with the waiting screen.
        if (status === "deferred") { resolve(); return; }
        if (status === "conflict" || status === "review") {
          reportSyncOutcome(status);
          resolve();
          return;
        }
        reportSyncOutcome(null);
        if (event.result.reloaded) {
          reloading = true;
          useStore.setState({ uiStateLoaded: false, activePaperId: null, paperPages: {}, currentPage: 1,
            librarySearch: "", currentCollection: "", selectedFolder: null, expandedCollections: null,
            moveHistory: [], chatAttachments: [], chatInputs: {} });
          // While the app is closing, the close goes on and the next launch opens the new library.
          reloadUnlessClosing(() => window.location.reload());
        } else if (event.result.not_set_aside?.length) {
          showToast({ title: "選んだデータで同期しました", description: "選ばなかった同期データの一部は退避できませんでした（設定 → 保存先・同期）。", tone: "error" });
        } else if (event.result.set_aside?.length) {
          showToast({ title: "選んだデータで同期しました", description: "選ばなかったデータは退避しています（設定 → バックアップ → 退避データから復元）。", tone: "success" });
        } else if (background) {
          // The automatic sync every minute: the status bar only, which clears itself.
          useStore.getState().setStatus("同期フォルダーに保存しました。PC間の転送状況はGoogle Driveで確認してください。");
        } else {
          showToast({ id: "drive-synced", title: "同期フォルダーに保存しました", description: "PC間の転送状況はGoogle Driveで確認してください。", tone: "success" });
        }
        resolve();
      }).then(jobId => {
        // A job that ended at once has already cleared the state (finally below); do not bring its id back.
        if (useSyncState.getState().busy) useSyncState.setState({ jobId });
      }).catch(reject);
    });
  } finally {
    if (!reloading) {
      suspendUiStateSync(false);
      backgroundEndedAt = background ? Date.now() : 0;
      useSyncState.setState({ busy: false, jobId: null, cancelling: false, background: false });
      // Pages turned during a background sync were not saved meanwhile.
      if (background) void flushUiState();
    }
  }
  return { reloading, status };
}

