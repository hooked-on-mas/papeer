import type { JobHandlers } from "@/features/jobs/jobHandlers";
import { QK } from "@/lib/queryKeys";
import { reloadCloudInk } from "@/features/reader/inkStore";

export const settingsJobHandlers: JobHandlers = {
  "cloud-upload": {
    refresh: () => { void reloadCloudInk(); return [["cloud-drive"], [QK.inkPages]]; },
    succeeded: (event, { done }) => done(`Google Driveに保存しました（全${event.result.files}ファイル、今回${event.result.uploaded}ファイル転送）。`),
  },
  // A sync records the library in this PC's history (設定 → バックアップ).
  "drive-sync": { refresh: () => [[QK.drive], [QK.history]] },
  check: {
    succeeded: (event, { status }) => status(event.result || "接続を確認しました。"),
  },
};
