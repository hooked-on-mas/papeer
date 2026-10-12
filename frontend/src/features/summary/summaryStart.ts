/**
 * Scope selection and replacement confirmation for the サマリー (app/actions.ts, generateArticle). Every way to it —
 * the pane's button, the その他 menu, the サマリーを開く of a failed job's dialog followed by that
 * button — goes through generateArticle, so the AI is never called over an existing サマリー without
 * this confirmation. Kept free of React and the stores for tests/summaryStart.test.ts.
 */

import { parsePageSelection } from "../../lib/pageSelection.ts";
import type { components } from "../../api/schema";

export type SummaryPlan = components["schemas"]["SummaryPlan"];
export type SummaryChoice = { scope: "chapters" | "custom" | "all"; chapters: number[]; customRange: string };

/** Short documents default to all pages; long ones require an explicit scope choice. */
export function initialSummaryChoice(plan: SummaryPlan): SummaryChoice {
  return { scope: !plan.requires_selection ? "all" : plan.chapters.length ? "chapters" : "custom", chapters: [], customRange: "" };
}

export function summarySelection(plan: SummaryPlan, choice: SummaryChoice): { pages: string; count: number; error: string } {
  if (choice.scope === "all") return { pages: "", count: plan.page_count, error: "" };
  const ranges = choice.scope === "chapters"
    ? [...new Set(choice.chapters)].flatMap((index) => {
      const chapter = plan.chapters[index];
      return chapter ? [`${chapter.start_page}-${chapter.end_page}`] : [];
    }).join(", ") : choice.customRange;
  try {
    if (!ranges.trim()) throw new Error(choice.scope === "chapters" ? "要約する章を選んでください。" : "サマリーの対象ページを入力してください。例: 1, 3-5, 8");
    const pages = parsePageSelection(ranges, plan.page_count);
    return { pages: pages.join(","), count: pages.length, error: "" };
  } catch (error) {
    return { pages: ranges, count: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

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
