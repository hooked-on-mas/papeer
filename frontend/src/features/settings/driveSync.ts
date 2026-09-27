import { create } from "zustand";
import { isRunning, useStore } from "@/store";
import { startJob } from "@/features/jobs/jobEvents";
import { flushPendingSaves, describeFailure } from "@/lib/pendingSaves";
import { flushUiState, suspendUiStateSync } from "@/app/uiStateSync";

export const useSyncState = create<{ busy: boolean }>(() => ({ busy: false }));

export async function syncDrive(choice?: string, heads?: string[]): Promise<boolean> {
  if (useSyncState.getState().busy || useStore.getState().activeJobs.some(isRunning)) return false;
  useSyncState.setState({ busy: true });
  let reloading = false;
  try {
    const failure = await flushPendingSaves();
    if (failure) throw new Error(describeFailure(failure));
    await flushUiState();
    suspendUiStateSync(true);
    await new Promise<void>((resolve, reject) => {
      startJob("/api/drive/sync", { choice, expected_heads: heads }, { kind: "drive-sync", paperId: null }, event => {
        if (event.status !== "succeeded") { reject(new Error(event.error || "同期を完了できませんでした。")); return; }
        if (event.result?.status === "conflict") {
          useStore.getState().setStatus("Google Driveとの変更が競合しています。設定 → 保存先・同期で確認してください。");
        } else if (event.result?.reloaded) {
          reloading = true;
          useStore.setState({ uiStateLoaded: false, activePaperId: null, paperPages: {}, currentPage: 1,
            librarySearch: "", currentCollection: "", selectedFolder: null, expandedCollections: null,
            moveHistory: [], chatAttachments: [], chatInputs: {} });
          window.location.reload();
        } else useStore.getState().setStatus("同期フォルダーに保存しました。PC間の転送状況はGoogle Driveで確認してください。");
        resolve();
      }).catch(reject);
    });
  } finally {
    if (!reloading) {
      suspendUiStateSync(false);
      useSyncState.setState({ busy: false });
    }
  }
  return reloading;
}

