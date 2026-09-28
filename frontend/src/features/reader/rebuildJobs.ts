import { create } from "zustand";

/**
 * Translation jobs started as 「保存済みの訳文でPDFを作り直す」: every page comes from saved translations
 * and the AI is not called, so the screen says the PDF is being made again rather than 翻訳中 or
 * 翻訳待ち. Known only to the window that started them (after a reload such a job shows as 翻訳中).
 */
export const useRebuildJobs = create<{ ids: readonly string[] }>(() => ({ ids: [] }));

// Ids are never reused; the last few are plenty for the jobs that can still be running.
const KEPT = 20;

export function markRebuildJob(jobId: string): void {
  useRebuildJobs.setState((state) => ({ ids: [...state.ids.filter((id) => id !== jobId), jobId].slice(-KEPT) }));
}

/** Whether the running translation job `jobId` only makes the PDF again. */
export function useRebuilding(jobId: string | undefined): boolean {
  return useRebuildJobs((state) => !!jobId && state.ids.includes(jobId));
}
