import { registerJobHandlers } from "@/features/jobs/jobHandlers";
import { chatJobHandlers } from "@/features/chat/chatJobs";
import { translationJobHandlers } from "@/features/reader/translationJobs";
import { settingsJobHandlers } from "@/features/settings/settingsJobs";
import { summaryJobHandlers } from "@/features/summary/summaryJobs";
import { ocrJobHandlers } from "@/features/ocr/ocrActions";
import { libraryJobHandlers } from "./libraryJobs";
import { researchJobHandlers } from "@/features/references/researchJobs";

/** Each feature's reaction to its finished jobs; called once when the app starts. */
export function registerAllJobHandlers(): void {
  registerJobHandlers({
    ...translationJobHandlers,
    ...summaryJobHandlers,
    ...chatJobHandlers,
    ...settingsJobHandlers,
    ...libraryJobHandlers,
    ...researchJobHandlers,
    ...ocrJobHandlers,
  });
}
