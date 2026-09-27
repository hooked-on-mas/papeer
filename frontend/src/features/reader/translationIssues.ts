import type { ReadingData } from "@/api/hooks";

/** What translationIssues reads of a paper's reading state. */
export type IssueSource = Pick<ReadingData, "page_count" | "empty_pages" | "translation_required_pages" | "completed_pages"> & {
  preview?: { skipped_pages?: number[] | null; page_errors?: Record<string, string> | null } | null;
  report?: { skipped_pages?: number[] | null; skipped_block_pages?: number[] | null; page_errors?: Record<string, string> | null } | null;
};

/**
 * Pages to check after translating, with what is wrong on each, for the 翻訳の確認・修正 dialog;
 * the reading toolbar shows how many there are.
 */
export function translationIssues(reading: IssueSource | null | undefined): Map<number, Set<string>> {
  const issues = new Map<number, Set<string>>();
  const add = (page: number, message: string) => {
    if (!issues.has(page)) issues.set(page, new Set());
    issues.get(page)!.add(message);
  };
  if (!reading) return issues;
  for (let page = 1; page <= reading.page_count; page++) {
    // Without translation_required_pages every page is to be translated.
    if ((reading.translation_required_pages?.includes(page) ?? true)
        && !reading.completed_pages.includes(page) && !reading.empty_pages.includes(page)) add(page, "未翻訳");
  }
  reading.empty_pages.forEach(page => add(page, "抽出できる文字がありません"));
  reading.report?.skipped_block_pages?.forEach(page => add(page, "翻訳をスキップした段落があります"));
  [...(reading.report?.skipped_pages ?? []), ...(reading.preview?.skipped_pages ?? [])].forEach(page => add(page,
    reading.preview?.page_errors?.[String(page)] ?? reading.report?.page_errors?.[String(page)] ?? "PDF生成をスキップしました"));
  return issues;
}
