import type { JobHandlers } from "@/features/jobs/jobHandlers";
import { QK } from "@/lib/queryKeys";

export const settingsJobHandlers: JobHandlers = {
  // A sync records the library in this PC's history (設定 → バックアップ).
  "drive-sync": { refresh: () => [[QK.drive], [QK.history]] },
  check: {
    succeeded: (event, { status }) => status(event.result || "接続を確認しました。"),
  },
};
