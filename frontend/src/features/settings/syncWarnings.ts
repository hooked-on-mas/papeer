/**
 * Sync states the user has to act on, told in a toast that stays until closed. The automatic sync
 * runs every minute, so each is told once when it begins, not at every run; after a sync that went
 * through (or a different state) it is told again. Kept free of React and the stores so that
 * tests/syncWarnings.test.ts can check the rules.
 */

export type SyncWarning = "conflict" | "review" | "failed";

export const SYNC_WARNINGS: Record<SyncWarning, { title: string; description: string }> = {
  conflict: {
    title: "Google Driveとの変更が競合しています",
    description: "どちらのデータを使うか、設定 → 保存先・同期で確認してください。",
  },
  review: {
    title: "同期を一時停止しました",
    description: "データが大きく減っているか、復元した直後です。設定 → 保存先・同期で確認してください。",
  },
  failed: {
    title: "同期フォルダーを更新できませんでした",
    description: "データはこのPCに保存されています。設定 → 保存先・同期から再試行できます。",
  },
};

/** The state now in effect after a sync ended in `outcome` (null: it went through), and whether to tell it. */
export function nextSyncWarning(shown: SyncWarning | null, outcome: SyncWarning | null): { shown: SyncWarning | null; tell: boolean } {
  return { shown: outcome, tell: outcome !== null && outcome !== shown };
}

/**
 * Whether an error in the automatic sync is told as a failed sync ("failed"): only once the sync was
 * found to be set up and turned on (`syncOn`), and not when the sidecar could not be reached (an ApiError
 * with status 0), which the connection banner already tells. A library without a sync has none to fail.
 */
export function isAutoSyncFailure({ syncOn, status }: { syncOn: boolean; status?: number }): boolean {
  return syncOn && status !== 0;
}

/**
 * Whether the warning on screen goes once the sidecar can be reached again: a failure told while it
 * could not be (a sync cut off by the drop) is the connection's, which the banner told and which is over.
 */
export function clearsOnReconnect(shown: SyncWarning | null, toldWhileDown: boolean): boolean {
  return shown === "failed" && toldWhileDown;
}
