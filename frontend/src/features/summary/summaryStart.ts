/**
 * What to ask before the サマリー is made again (app/actions.ts, generateArticle). Every way to it —
 * the pane's button, the その他 menu, the サマリーを開く of a failed job's dialog followed by that
 * button — goes through generateArticle, so the AI is never called over an existing サマリー without
 * this confirmation. Kept free of React and the stores for tests/summaryStart.test.ts.
 */

export type SummaryQuestion = { title: string; message: string; okLabel: string };

/**
 * The confirmation before asking the AI, or null when there is no サマリー yet (making the first one
 * replaces nothing). `hasSummary` null means it could not be told: ask, to be safe.
 */
export function summaryStartQuestion(hasSummary: boolean | null): SummaryQuestion | null {
  if (hasSummary === false) return null;
  return {
    title: "サマリーを再作成",
    message: "AIでサマリーを作り直します。数分かかり、AIの利用枠を使います。\n"
      + "できあがると今のサマリーは新しいものに置き換わります（途中で失敗・中止したときは今のまま残ります）。",
    okLabel: "再作成する",
  };
}

/** Asked at most once at a time per paper (lib/dialogQueue.ts), so a second click does not queue a second question. */
export function summaryQuestionKey(paperId: string): string {
  return `summary-start:${paperId}`;
}
