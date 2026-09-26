import assert from "node:assert/strict";
import { test } from "node:test";
import { paperTranslationStatus } from "../src/lib/paperStatus.ts";
import type { PaperData, ReadingData } from "../src/api/hooks.ts";

const paper: PaperData = { id: "paper", title: "Paper", pages: 12, translated_count: 0 };

test("distinguishes untranslated, partial, completed, and incomplete text", () => {
  assert.equal(paperTranslationStatus(paper, false).status, "untranslated");
  const partial = paperTranslationStatus({ ...paper, translated_count: 4, status: "一部翻訳済み" }, false);
  assert.equal(partial.status, "partial");
  assert.equal(partial.count, "4/12ページ");
  assert.equal(paperTranslationStatus({ ...paper, translated_count: 12 }, false).status, "translated");
  assert.equal(paperTranslationStatus({ ...paper, translated_count: 12, status: "一部翻訳済み" }, false).status, "review");
});

test("unfinished previews do not imply a running job, even if all pages are saved", () => {
  const interrupted = { ...paper, translation_in_progress: true, translated_count: 12 };
  assert.equal(paperTranslationStatus(interrupted, false).status, "paused");
  assert.equal(paperTranslationStatus(interrupted, true).status, "translating");
  assert.equal(paperTranslationStatus({ ...paper, status: "翻訳未完了" }, false).status, "failed");
});

test("reader uses the current page data instead of stale library counts", () => {
  const reading = { page_count: 12, completed_pages: [1, 2, 3], in_progress: true } as ReadingData;
  const result = paperTranslationStatus({ ...paper, translated_count: 0 }, true, reading);
  assert.equal(result.count, "3/12ページ");
  assert.equal(result.progress, 25);
});

test("unknown page counts never imply completion or NaN progress", () => {
  const result = paperTranslationStatus({ ...paper, pages: 0 }, false);
  assert.equal(result.status, "untranslated");
  assert.equal(result.count, "ページ数不明");
  assert.equal(result.progress, 0);
});

test("library and reader count translation targets rather than preserved reference pages", () => {
  const complete = { ...paper, pages: 13, translated_count: 11, status: "一部翻訳済み",
    translation_required_count: 11, translation_completed_required_count: 11, translation_has_issues: false };
  const reading = { page_count: 13, completed_pages: Array.from({ length: 11 }, (_, i) => i + 1),
    translation_required_pages: Array.from({ length: 11 }, (_, i) => i + 1), in_progress: false, report: null } as ReadingData;
  for (const result of [paperTranslationStatus(complete, false), paperTranslationStatus(complete, false, reading)]) {
    assert.equal(result.status, "translated");
    assert.equal(result.count, "11/11ページ");
    assert.equal(result.progress, 100);
    assert.match(result.description, /翻訳対象11ページ/);
  }
  assert.equal(paperTranslationStatus({ ...complete, translation_completed_required_count: 10 }, false).status, "partial");
  assert.equal(paperTranslationStatus({ ...complete, translation_has_issues: true }, false).status, "review");
  assert.equal(paperTranslationStatus(complete, false, { ...reading, completed_pages: [1, 12, 13] }).completed, 1);
  assert.equal(paperTranslationStatus(complete, false, { ...reading, report: { skipped_blocks: ["body"] } }).status, "review");
});
