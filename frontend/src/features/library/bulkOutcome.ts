/**
 * Running one action on several papers, one request after another (the sidecar has no bulk API), and
 * telling the user how it went: how many were done, how many were already so, and which failed and why.
 * Pure apart from the steps it is handed, so that it can be tested; app/bulkActions.ts supplies them.
 *
 * A failure does not stop the others, since each paper's request stands alone; except one that would
 * fail every request after it too (the sidecar not answering, the library held by a sync that did not
 * let go: see libraryBusy.ts, whose waiting and sending again applies to each request), after which the
 * rest are not sent and are reported as not done. The user may stop it too (`signal`): the papers not
 * yet sent are then reported as not done, without an error, since the user asked.
 */

/** What a step did to its paper: changed it, or found it already as asked. Failing, it throws. */
export type BulkStep = "done" | "unchanged";

export type BulkOutcome<T> = {
  done: T[];
  unchanged: T[];
  failed: { item: T; error: unknown }[];
  /** Left unsent after a failure that stops them all, or after the user stopped the action. */
  notRun: T[];
  /** That failure, when there was one. */
  stoppedBy: unknown;
  /** Whether the user stopped the action. */
  cancelled: boolean;
};

export type BulkOptions = {
  /** Whether a failure stops the rest. */
  stopsAll?: (error: unknown) => boolean;
  /** Told how many have run before each step. */
  progress?: (ran: number, total: number) => void;
  /** Aborted when the user stops the action; the step running then finishes, and no other starts. */
  signal?: AbortSignal;
};

/** Runs `step` on each item in turn. */
export async function runBulk<T>(items: readonly T[], step: (item: T) => Promise<BulkStep>,
  { stopsAll = () => false, progress, signal }: BulkOptions = {}): Promise<BulkOutcome<T>> {
  const outcome: BulkOutcome<T> = { done: [], unchanged: [], failed: [], notRun: [], stoppedBy: undefined, cancelled: false };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (signal?.aborted) {
      outcome.cancelled = true;
      outcome.notRun = items.slice(index);
      break;
    }
    progress?.(index, items.length);
    try {
      outcome[(await step(item)) === "unchanged" ? "unchanged" : "done"].push(item);
    } catch (error) {
      outcome.failed.push({ item, error });
      if (stopsAll(error)) {
        outcome.stoppedBy = error;
        outcome.notRun = items.slice(index + 1);
        break;
      }
    }
  }
  return outcome;
}

/**
 * How an action is worded: `done(n)` says that n papers were done, and `unchanged(n)` that n were already
 * so (sentences, with their "。"); `failed(n)` that n could not be (without it; also the error dialog's title).
 */
export type BulkWording = {
  done: (count: number) => string;
  unchanged?: (count: number) => string;
  failed: (count: number) => string;
};

export type BulkReport = {
  /** For the status bar. */
  status: string;
  /** For the error dialog when any failed or were not run: which, and why. */
  error: { title: string; message: string } | null;
};

/** The failed papers listed by name in the error dialog; more are counted. */
export const LISTED_FAILURES = 10;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim() || "不明なエラー";

/**
 * What to tell the user once `outcome` is known: in the status bar, how many were done, already so,
 * and not done; and, when any failed or were not run after a failure, an error dialog with each failed
 * paper's name (`name`) and reason, then how many were not run and why. Papers left when the user
 * stopped the action are counted in the status bar only.
 */
export function bulkReport<T>(outcome: BulkOutcome<T>, name: (item: T) => string, wording: BulkWording): BulkReport {
  const { done, unchanged, failed, cancelled } = outcome;
  const notRun = cancelled ? [] : outcome.notRun;
  const missed = failed.length + notRun.length;
  const parts: string[] = [];
  if (done.length) parts.push(wording.done(done.length));
  if (unchanged.length) parts.push(wording.unchanged?.(unchanged.length) ?? `${unchanged.length}件は変更ありませんでした。`);
  if (missed) parts.push(`${wording.failed(missed)}。`);
  if (cancelled) parts.push(outcome.notRun.length ? `中止したため、残りの${outcome.notRun.length}件は処理していません。` : "中止しました。");
  const status = parts.join("");
  if (!missed) return { status, error: null };
  const lines = failed.slice(0, LISTED_FAILURES).map(({ item, error }) => `・「${name(item)}」：${errorText(error)}`);
  if (failed.length > LISTED_FAILURES) lines.push(`ほか${failed.length - LISTED_FAILURES}件`);
  if (notRun.length) {
    if (lines.length) lines.push("");
    lines.push(`残りの${notRun.length}件は、次の理由で処理していません：${errorText(outcome.stoppedBy)}`);
  }
  const total = done.length + unchanged.length + missed + (cancelled ? outcome.notRun.length : 0);
  const completed = done.length + unchanged.length;
  const head = completed ? [`${total}件のうち${completed}件は完了しました。`, ""] : [];
  return { status, error: { title: wording.failed(missed), message: [...head, ...lines].join("\n") } };
}
