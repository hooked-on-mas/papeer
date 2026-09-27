import assert from "node:assert/strict";
import { test } from "node:test";
import { ocrMessage, translationIssues } from "../src/lib/translationIssues.ts";
import type { ReadingData } from "../src/api/hooks.ts";

const reading = (values: Partial<ReadingData>) => ({ page_count: 5, empty_pages: [], completed_pages: [],
  translation_required_pages: [1, 3, 5], in_progress: false, report: null, preview: null, ...values }) as ReadingData;

test("pages needing OCR are listed with their reason instead of as untranslated", () => {
  const issues = translationIssues(reading({
    completed_pages: [1], empty_pages: [4],
    ocr_pages: [{ page: 2, reason: "garbled", garbled_ratio: 0.874 }, { page: 4, reason: "image" }],
  }));
  assert.deepEqual(issues.map(([page]) => page), [2, 3, 4, 5]);
  const byPage = new Map(issues);
  assert.deepEqual(byPage.get(2), ["要OCR：抽出した文字が文字化けしています（約87%）。翻訳対象から外しました"]);
  // The scanned page is not also reported as a page without text.
  assert.deepEqual(byPage.get(4), [ocrMessage({ page: 4, reason: "image" })]);
  assert.match(byPage.get(4)![0], /画像だけ/);
  assert.deepEqual(byPage.get(3), ["未翻訳"]);
});

test("an OCR page is never untranslated, even without the required page list", () => {
  const issues = translationIssues(reading({ translation_required_pages: undefined, completed_pages: [1, 3, 4, 5],
    ocr_pages: [{ page: 2, reason: "garbled" }] }));
  assert.deepEqual(issues, [[2, ["要OCR：抽出した文字が文字化けしています。翻訳対象から外しました"]]]);
});

test("existing issues are kept and a reading without OCR data has none", () => {
  const issues = translationIssues(reading({ completed_pages: [1, 3, 5], empty_pages: [4],
    report: { skipped_block_pages: [3], skipped_pages: [5], page_errors: { "5": "配置に失敗しました" } } }));
  assert.deepEqual(issues, [[3, ["翻訳をスキップした段落があります"]], [4, ["抽出できる文字がありません"]], [5, ["配置に失敗しました"]]]);
  assert.deepEqual(translationIssues(undefined), []);
});

test("a partly garbled page is translated, so it can also be untranslated", () => {
  const issues = new Map(translationIssues(reading({ completed_pages: [1, 5],
    ocr_pages: [{ page: 3, reason: "partial", garbled_ratio: 0.32 }] })));
  assert.deepEqual(issues.get(3), ["未翻訳", "要OCR（一部）：一部の文字が文字化けしています（約32%）。化けた段落は翻訳せず原文のまま表示します"]);
});

test("a partly garbled page without garbled paragraphs asks for a comparison instead", () => {
  const message = ocrMessage({ page: 2, reason: "partial", garbled_ratio: 0.39, garbled_paragraphs: 0 });
  assert.equal(message, "要OCR（一部）：一部の文字が文字化けしています（約39%）。数式・表などに含まれる化けた部分と訳文を原文と照合してください");
  assert.match(ocrMessage({ page: 2, reason: "partial", garbled_paragraphs: 2 }), /化けた段落は翻訳せず/);
});
