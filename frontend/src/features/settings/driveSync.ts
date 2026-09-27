import { create } from "zustand";
import { ApiError, apiRequest } from "@/api/client";
import { showError } from "@/components/errorDialog";
import { isRunning, useStore } from "@/store";
import { startJob } from "@/features/jobs/jobEvents";
import { flushPendingSaves, describeFailure, openEditLabels } from "@/lib/pendingSaves";
import { askConfirm } from "@/components/AppDialogs";
import { flushUiState, suspendUiStateSync } from "@/app/uiStateSync";
import { reloadUnlessClosing } from "@/app/appClosing";

export const useSyncState = create<{ busy: boolean; jobId: string | null; cancelling: boolean }>(
  () => ({ busy: false, jobId: null, cancelling: false }));

/** Stop the running sync; the library stays as it was unless the final replacement had already begun. */
export async function cancelSync(): Promise<void> {
  const { jobId, cancelling } = useSyncState.getState();
  if (!jobId || cancelling) return;
  useSyncState.setState({ cancelling: true });
  try {
    await apiRequest("POST", `/api/jobs/${jobId}/cancel`);
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

/**
 * confirm: 「このまま同期する」 on a sync that stopped for review (a library that lost many items,
 * or one restored from a backup); the sidecar applies it only if nothing changed since.
 */
export async function syncDrive(choice?: string, heads?: string[], confirm = false): Promise<boolean> {
  if (useSyncState.getState().busy || useStore.getState().activeJobs.some(isRunning)) return false;
  useSyncState.setState({ busy: true });
  let reloading = false;
  try {
    const failure = await flushPendingSaves();
    if (failure) throw new Error(describeFailure(failure));
    await flushUiState();
    suspendUiStateSync(true);
    await new Promise<void>((resolve, reject) => {
      startJob("/api/drive/sync", { choice, expected_heads: heads, confirm }, { kind: "drive-sync", paperId: null }, event => {
        // Stopped on request: not an error (the status line already says so).
        if (event.status === "cancelled") { resolve(); return; }
        if (event.status !== "succeeded") { reject(new Error(event.error || "同期を完了できませんでした。")); return; }
        if (event.result?.status === "conflict") {
          useStore.getState().setStatus("Google Driveとの変更が競合しています。設定 → 保存先・同期で確認してください。");
        } else if (event.result?.status === "review") {
          useStore.getState().setStatus("同期を一時停止しました。データが大きく減っているか、復元した直後です。設定 → 保存先・同期で確認してください。");
        } else if (event.result?.reloaded) {
          reloading = true;
          useStore.setState({ uiStateLoaded: false, activePaperId: null, paperPages: {}, currentPage: 1,
            librarySearch: "", currentCollection: "", selectedFolder: null, expandedCollections: null,
            moveHistory: [], chatAttachments: [], chatInputs: {} });
          // While the app is closing, the close goes on and the next launch opens the new library.
          reloadUnlessClosing(() => window.location.reload());
        } else useStore.getState().setStatus("同期フォルダーに保存しました。PC間の転送状況はGoogle Driveで確認してください。");
        resolve();
      }).then(jobId => {
        // A job that ended at once has already cleared the state (finally below); do not bring its id back.
        if (useSyncState.getState().busy) useSyncState.setState({ jobId });
      }).catch(reject);
    });
  } finally {
    if (!reloading) {
      suspendUiStateSync(false);
      useSyncState.setState({ busy: false, jobId: null, cancelling: false });
    }
  }
  return reloading;
}

