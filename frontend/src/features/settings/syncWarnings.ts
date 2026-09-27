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
