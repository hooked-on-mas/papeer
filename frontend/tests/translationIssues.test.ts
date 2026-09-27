import assert from "node:assert/strict";
import { test } from "node:test";
import { ocrMessage, readabilityMessage, shorteningHint, translationIssues, visibleLength } from "../src/lib/translationIssues.ts";
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

test("shrunk paragraphs are listed with the smallest size on each page", () => {
  const issues = new Map(translationIssues(reading({ completed_pages: [1, 3, 5], report: { readability_warnings: [
    { page: 3, font_size: 7.4 }, { page: 3, font_size: 6.26 }, { page: 5 }] } })));
  assert.deepEqual(issues.get(3), [readabilityMessage(6.26)]);
  assert.match(issues.get(3)![0], /6\.3ptまで縮小/);
  assert.match(issues.get(5)![0], /文字を縮小した段落/);
});

test("the shortening target shares a warning's excess among the paragraphs it came from", () => {
  const math = "[[PD_MATH_p1b2_0]]";
  const first = { id: "p1b2_0", pages: [1, 2], text: "あ".repeat(300) + math };
  const part = { id: "p1b2_1", pages: [2], text: "い".repeat(100) };
  const other = { id: "p1b3_0", pages: [1], text: "う".repeat(50) };
  assert.equal(visibleLength(first.text + " \n"), 300);
  // p.2 shows the end of the first block (a flow) and overflows by 80 characters.
  const warnings = [{ page: 2, font_size: 6.5, chars: 400, char_budget: 320, source_blocks: ["p1b2"] }];
  assert.deepEqual(shorteningHint(warnings, first, [first, part, other]), { fontSize: 6.5, chars: 300, target: 240, tooSmall: false });
  assert.deepEqual(shorteningHint(warnings, part, [first, part, other]), { fontSize: 6.5, chars: 100, target: 80, tooSmall: false });
  assert.equal(shorteningHint(warnings, other, [first, part, other]), null);
  // Within the rough estimate yet too small: 10% shorter. An old report has no estimate.
  assert.equal(shorteningHint([{ page: 1, font_size: 7, chars: 50, char_budget: 60, source_blocks: ["p1b3"] }], other, [other])?.target, 45);
  assert.deepEqual(shorteningHint([{ page: 1, block: "p1b3", font_size: 7 }], other, [other]), { fontSize: 7, chars: 50, target: null, tooSmall: false });
});

test("a box too small for any readable length asks for no length", () => {
  const other = { id: "p1b3_0", pages: [1], text: "う".repeat(50) };
  const hint = (char_budget: number | null, chars = 50) =>
    shorteningHint([{ page: 1, font_size: 4.6, chars, char_budget, source_blocks: ["p1b3"] }], other, [other]);
  assert.deepEqual(hint(null), { fontSize: 4.6, chars: 50, target: null, tooSmall: true });
  assert.deepEqual(hint(0), { fontSize: 4.6, chars: 50, target: null, tooSmall: true });
  // An excess as long as the paragraph leaves no length to ask for either.
  assert.deepEqual(hint(1, 60), { fontSize: 4.6, chars: 50, target: null, tooSmall: true });
});
