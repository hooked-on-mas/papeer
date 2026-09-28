/**
 * How long a status bar message stays before the bar clears it. Kept free of React and the stores
 * so that tests/statusLifetime.test.ts can check the rules.
 *
 * Outcomes ("…を保存しました") fade after a time long enough to read them. News that must not be
 * missed, and warnings that ask the user to act, go to a toast instead (components/toast.ts). A
 * message about work still going on ("終了しています…", "中止しています…") is normally replaced by the
 * outcome; it is cleared after a few minutes all the same, in case no outcome comes (an event lost
 * while the connection to the sidecar was down).
 */

export const STATUS_MIN_MS = 6_000;
export const STATUS_MAX_MS = 20_000;
export const STATUS_IN_PROGRESS_MS = 3 * 60_000;
/** Reading time per character; Japanese reads at roughly 8-10 characters a second. */
const PER_CHARACTER_MS = 120;

/** ms before `message` is cleared, or null for an empty one. */
export function statusLifetime(message: string): number | null {
  const text = message.trim();
  if (!text) return null;
  if (inProgress(text)) return STATUS_IN_PROGRESS_MS;
  return readingTime(text, STATUS_MIN_MS, STATUS_MAX_MS);
}

/** Time to read `text`, within bounds (also used for toasts). */
export function readingTime(text: string, min: number, max: number): number {
  return Math.min(max, Math.max(min, 2_000 + [...text].length * PER_CHARACTER_MS));
}

/** A message about work still going on, which says "…" where the outcome will follow. */
export function inProgress(message: string): boolean {
  return /…|\.\.\./.test(message);
}
