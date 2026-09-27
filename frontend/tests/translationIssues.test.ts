import assert from "node:assert/strict";
import { test } from "node:test";
import { translationIssues, type IssueSource } from "../src/features/reader/translationIssues.ts";

const base: IssueSource = { page_count: 3, empty_pages: [], completed_pages: [1, 2, 3], preview: null, report: null };

/** The issues as plain data, pages in order. */
function listed(reading: IssueSource | null | undefined): [number, string[]][] {
  return [...translationIssues(reading)].sort(([a], [b]) => a - b).map(([page, messages]) => [page, [...messages]]);
}

test("nothing to check before the paper has loaded, or once every page is translated", () => {
  assert.deepEqual(listed(null), []);
  assert.deepEqual(listed(undefined), []);
  assert.deepEqual(listed(base), []);
});

test("pages still to translate are listed, and without translation_required_pages every page counts", () => {
  assert.deepEqual(listed({ ...base, completed_pages: [2] }), [[1, ["未翻訳"]], [3, ["未翻訳"]]]);
  // Page 3 was not asked for.
  assert.deepEqual(listed({ ...base, completed_pages: [2], translation_required_pages: [1, 2] }), [[1, ["未翻訳"]]]);
});

test("pages without extractable text are listed as such, not as untranslated", () => {
  assert.deepEqual(listed({ ...base, completed_pages: [1, 3], empty_pages: [2] }), [[2, ["抽出できる文字がありません"]]]);
});

test("skipped paragraphs and skipped pages are listed, with the page's own error when there is one", () => {
  const reading: IssueSource = {
    ...base,
    report: { skipped_block_pages: [1], skipped_pages: [2], page_errors: { "2": "レイアウトを再現できませんでした" } },
    preview: { skipped_pages: [3] },
  };
  assert.deepEqual(listed(reading), [
    [1, ["翻訳をスキップした段落があります"]],
    [2, ["レイアウトを再現できませんでした"]],
    [3, ["PDF生成をスキップしました"]],
  ]);
});

test("a page with several problems is listed once, each message once", () => {
  const reading: IssueSource = {
    ...base, completed_pages: [2, 3],
    report: { skipped_block_pages: [1, 1], skipped_pages: [1] }, preview: { skipped_pages: [1] },
  };
  assert.deepEqual(listed(reading), [[1, ["未翻訳", "翻訳をスキップした段落があります", "PDF生成をスキップしました"]]]);
});
