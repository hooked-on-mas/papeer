import assert from "node:assert/strict";
import { test } from "node:test";
import { paperTranslationStatus, storedStatusLabel } from "../src/lib/paperStatus.ts";
import type { OcrPage, PaperData, ReadingData } from "../src/api/hooks.ts";
import { paperData } from "./support/paperData.ts";

const paper: PaperData = paperData({ id: "paper", title: "Paper", pages: 12, translated_count: 0 });

test("distinguishes untranslated, partial, completed, and incomplete text", () => {
  assert.equal(paperTranslationStatus(paper, false).status, "untranslated");
  const partial = paperTranslationStatus({ ...paper, translated_count: 4, status: "partial" }, false);
  assert.equal(partial.status, "partial");
  assert.equal(partial.count, "4/12ページ");
  assert.equal(paperTranslationStatus({ ...paper, translated_count: 12 }, false).status, "translated");
  assert.equal(paperTranslationStatus({ ...paper, translated_count: 12, status: "partial" }, false).status, "review");
});

test("unfinished previews do not imply a running job, even if all pages are saved", () => {
  const interrupted = { ...paper, translation_in_progress: true, translated_count: 12 };
  assert.equal(paperTranslationStatus(interrupted, false).status, "paused");
  assert.equal(paperTranslationStatus(interrupted, true).status, "translating");
  assert.equal(paperTranslationStatus({ ...paper, status: "incomplete" }, false).status, "failed");
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
  const complete = { ...paper, pages: 13, translated_count: 11, status: "partial" as const,
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

test("a paper whose pages all need OCR says so instead of an unknown page count", () => {
  const scanned = { ...paper, pages: 3, translation_required_count: 0, translation_completed_required_count: 0, translation_ocr_count: 3 };
  const result = paperTranslationStatus(scanned, false);
  assert.equal(result.status, "ocr");
  assert.equal(result.text, "要OCR");
  assert.equal(result.count, "3/3ページ");
  assert.match(result.description, /OCR済みのPDF/);
  const ocr: OcrPage[] = [{ page: 1, reason: "garbled" }, { page: 2, reason: "image" }, { page: 3, reason: "garbled" }];
  const reading = { page_count: 3, completed_pages: [] as number[], translation_required_pages: [] as number[],
    in_progress: false, report: null, ocr_pages: ocr } as ReadingData;
  assert.equal(paperTranslationStatus(scanned, false, reading).status, "ocr");
  // Partly garbled pages are translated: they neither count as OCR pages nor block completion.
  const partial = { ...reading, translation_required_pages: [1, 2, 3], completed_pages: [1, 2, 3],
    ocr_pages: [{ page: 2, reason: "partial" as const }] } as ReadingData;
  assert.equal(paperTranslationStatus(scanned, false, partial).status, "translated");
  const some = paperTranslationStatus({ ...complete(), translation_ocr_count: 2 }, false);
  assert.equal(some.status, "translated");
  assert.match(some.description, /2ページは要OCRのため原文のまま/);
});

function complete(): PaperData {
  return { ...paper, pages: 13, translated_count: 11, translation_required_count: 11,
    translation_completed_required_count: 11, translation_has_issues: false };
}

test("the stored translation state is a code, shown by its label", () => {
  assert.equal(storedStatusLabel("not_translated"), "未翻訳");
  assert.equal(storedStatusLabel("partial"), "一部翻訳済み");
  assert.equal(storedStatusLabel("resumable"), "翻訳途中・再開可");
  assert.equal(storedStatusLabel("incomplete"), "翻訳未完了");
  assert.equal(storedStatusLabel("translated"), "翻訳済み");
  assert.equal(storedStatusLabel(undefined), "");
  // A code this version does not know (a newer Papeer's) is shown as it is rather than hidden.
  assert.equal(storedStatusLabel("archived"), "archived");
  // The stored state alone never makes a paper look finished: the saved pages decide.
  assert.equal(paperTranslationStatus({ ...paper, status: "translated" }, false).status, "untranslated");
  assert.equal(paperTranslationStatus({ ...paper, status: "resumable", translated_count: 3 }, false).status, "partial");
});

test("a run that only makes the PDF again from saved translations is not called 翻訳中", () => {
  const result = paperTranslationStatus({ ...paper, translated_count: 12 }, true, undefined, { rebuilding: true });
  assert.equal(result.status, "translating");
  assert.equal(result.text, "PDF作り直し中");
  assert.equal(paperTranslationStatus({ ...paper, translated_count: 12 }, true).text, "翻訳中");
});
