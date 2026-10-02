/**
 * How running and failed jobs are named and ordered in the status bar, the job list and the error
 * notices, and when the "reconnecting" banner shows. Kept free of React and the stores so that
 * tests/jobList.test.ts can check the rules.
 */
import type { Job } from "@/store";
import type { JobFinished } from "./jobHandlers";

const KIND_LABELS: Record<string, string> = {
  translate: "翻訳",
  revision: "段落の再翻訳",
  "revision-draft": "訳文の修正案の作成",
  "glossary-draft": "専門用語の確認",
  "glossary-select": "分野辞書の選択",
  "glossary-split": "辞書の分野分け",
  article: "解説の作成",
  ask: "チャットの回答",
  check: "接続の確認",
  import: "PDFの追加",
  export: "PDFの書き出し",
  interleaved: "交互PDFの作成",
  backup: "バックアップ",
  restore: "復元",
  "drive-sync": "同期",
  ocr: "OCR",
  "ocr-data": "OCRの言語データのダウンロード",
  "paper-discovery": "論文マップの取得",
  "paper-map-groups": "論文グループの説明",
  "reference-research": "参考文献のWeb調査",
  "reference-import": "参考文献のPDF取り込み・サマリー作成",
};

export function jobKindLabel(kind: string | undefined): string {
  return (kind && KIND_LABELS[kind]) || "処理";
}

/** 「『論文』の翻訳を完了できませんでした」, or without a paper 「同期を完了できませんでした」. */
export function failureTitle(kind: string | undefined, paperTitle?: string | null): string {
  const what = jobKindLabel(kind);
  return paperTitle ? `『${paperTitle}』の${what}を完了できませんでした` : `${what}を完了できませんでした`;
}

/** A failure of a paper not on screen; its name may be unknown (the paper was removed meanwhile). */
export function backgroundFailureTitle(kind: string | undefined, paperTitle?: string | null): string {
  return paperTitle ? failureTitle(kind, paperTitle) : `別の論文の${jobKindLabel(kind)}を完了できませんでした`;
}

/** 「翻訳が終わりました」, or for a paper not on screen 「『論文』の翻訳が終わりました」. */
export function doneTitle(kind: string | undefined, paperTitle?: string | null): string {
  const what = jobKindLabel(kind);
  return paperTitle ? `『${paperTitle}』の${what}が終わりました` : `${what}が終わりました`;
}

/**
 * The status after a job whose cancel was asked has ended, replacing 「中止しています…」 whatever the
 * outcome (it may have finished or failed before the cancel took effect; the toast or the error
 * dialog tells that); null while other jobs asked to stop are still running.
 */
export function statusWhenCancelEnds(outcome: JobFinished["status"], othersPending: boolean, error?: string | null): string | null {
  if (othersPending) return null;
  return outcome === "cancelled" ? error || "中止しました。" : "";
}

/** The paper on screen first, then library-wide jobs, then the other papers' jobs, each in starting order. */
export function orderJobs<T extends Pick<Job, "paper_id">>(jobs: readonly T[], activePaperId: string | null): T[] {
  const rank = (job: T) => (activePaperId && job.paper_id === activePaperId ? 0 : !job.paper_id ? 1 : 2);
  return jobs.map((job, index) => ({ job, index }))
    .sort((a, b) => rank(a.job) - rank(b.job) || a.index - b.index)
    .map(({ job }) => job);
}

/** Percent done (0-100), or null while the job does not know its total. */
export function jobPercent(job: Pick<Job, "done" | "total">): number | null {
  if (!job.total || job.total <= 0 || job.done == null) return null;
  return Math.max(0, Math.min(100, (job.done / job.total) * 100));
}

/** 「3 / 12」 for a job that knows its total, else "". */
export function jobCountText(job: Pick<Job, "done" | "total">): string {
  return jobPercent(job) === null ? "" : `${job.done} / ${job.total}`;
}

export type ConnectionState = {
  /** The job event stream is open. */
  connected: boolean;
  /** It was open at least once since the app started. */
  everConnected: boolean;
  /** Date.now() when it closed (or when the first attempt began); null while connected. */
  downSince: number | null;
};

/**
 * A drop shorter than this passes unnoticed; a first connection may take longer while the sidecar starts.
 * The first retry after a drop (QUICK_RECONNECT_MS) comes well within the grace.
 */
export const RECONNECT_GRACE_MS = 2_000;
export const QUICK_RECONNECT_MS = 400;
export const FIRST_CONNECT_GRACE_MS = 8_000;

/**
 * The banner text while the job event stream is down, or null. Not while the app is closing (the
 * sidecar is stopping on purpose). A request that waits for a background sync (library_busy) is a
 * different matter: the stream stays open then, so the banner does not show for it.
 */
export function connectionBanner(state: ConnectionState, now: number, closing = false): string | null {
  if (state.connected || closing || state.downSince === null) return null;
  const down = now - state.downSince;
  if (!state.everConnected) {
    return down >= FIRST_CONNECT_GRACE_MS ? "アプリの処理部（sidecar）の起動を待っています…" : null;
  }
  return down >= RECONNECT_GRACE_MS
    ? "アプリの処理部（sidecar）との接続が切れました。再接続しています…（処理の進み具合は再接続後に更新します）"
    : null;
}

/** When connectionBanner's answer next changes by itself, in ms from now; null if never. */
export function connectionBannerDelay(state: ConnectionState, now: number): number | null {
  if (state.connected || state.downSince === null) return null;
  const grace = state.everConnected ? RECONNECT_GRACE_MS : FIRST_CONNECT_GRACE_MS;
  const left = state.downSince + grace - now;
  return left > 0 ? left : null;
}
