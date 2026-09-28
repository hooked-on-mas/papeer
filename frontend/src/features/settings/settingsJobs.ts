import type { JobHandlers } from "@/features/jobs/jobHandlers";
import { QK } from "@/lib/queryKeys";

export const settingsJobHandlers: JobHandlers = {
  "drive-sync": { refresh: () => [[QK.drive]] },
  check: {
    succeeded: (event, { status }) => status(event.result || "接続を確認しました。"),
  },
};
