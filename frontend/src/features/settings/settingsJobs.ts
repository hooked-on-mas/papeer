import type { JobHandlers } from "@/features/jobs/jobHandlers";

export const settingsJobHandlers: JobHandlers = {
  check: {
    succeeded: (event, { status }) => status(String(event.result ?? "接続を確認しました。")),
  },
};
