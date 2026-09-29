import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aiConfirmText, describeApplied, downloadConfirmText, engineChoices, engineName, neededLanguageData, ocrResultMessage,
  readConfirmText, type LanguageData,
} from "../src/lib/ocrText.ts";

const eng: LanguageData = { lang: "en", label: "英語", file: "eng.traineddata", size: 4113088, url: "https://example/eng", installed: false };
const jpn: LanguageData = { lang: "ja", label: "日本語", file: "jpn.traineddata", size: 2471260, url: "https://example/jpn", installed: true };

test("the engines offered are Tesseract and the system's own OCR, keeping a choice saved on another OS", () => {
  const windows = { name: "windows" as const, label: "Windows の OCR", languages: ["ja" as const] };
  assert.deepEqual(engineChoices({ system: windows, settings: { mode: "ask", engine: "auto", lang: "auto" } }).map(c => c.value),
    ["auto", "tesseract", "windows"]);
  assert.deepEqual(engineChoices({ system: null, settings: { mode: "ask", engine: "vision", lang: "auto" } }).map(c => c.value),
    ["auto", "tesseract", "vision"]);
});

test("a page read by OCR is told with its engines, language and skew", () => {
  assert.equal(engineName("tesseract+windows"), "Tesseract・Windows の OCR");
  assert.equal(engineName("ai"), "AI");
  assert.equal(describeApplied({ page: 3, reason: "image", engine: "windows", lang: "ja", skew: 0 }), "p.3：Windows の OCR・日本語で読みました");
  assert.equal(describeApplied({ page: 4, reason: "garbled", engine: "tesseract", lang: "en", skew: -1.25 }),
    "p.4：Tesseract・英語で読みました（傾き -1.3°を補正）");
});

test("only the language data that nothing reads yet is offered, with its size, source and place", () => {
  assert.deepEqual(neededLanguageData({ missing: ["en"], language_data: [eng, jpn] }), [eng]);
  assert.deepEqual(neededLanguageData({ missing: [], language_data: [eng, jpn] }), []);
  const text = downloadConfirmText([eng], "C:\\data\\tessdata", "OCR で読むには、先に言語データが必要です。");
  assert.match(text, /^OCR で読むには/);
  assert.match(text, /計 4\.1 MB/);
  assert.match(text, /raw\.githubusercontent\.com/);
  assert.match(text, /eng\.traineddata、4\.1 MB/);
  assert.match(text, /C:\\data\\tessdata/);
  assert.match(text, /SHA-256/);
});

test("the confirmations say which translations are made again, and that the AI gets the page's images", () => {
  assert.match(readConfirmText([2, 5], true), /p\.2, p\.5/);
  assert.match(readConfirmText([2], true), /訳し直します/);
  assert.doesNotMatch(readConfirmText([2], false), /訳し直します/);
  const ai = aiConfirmText(3, "Claude Code CLI", false);
  assert.match(ai, /p\.3/);
  assert.match(ai, /Claude Code CLI/);
  assert.match(ai, /画像を接続先のサービスに送信します/);
  assert.match(ai, /利用枠/);
  assert.match(ai, /判断のつかない小さな領域は送ります/);
});

test("the finished job tells the pages read, those that failed and those to translate again", () => {
  assert.equal(ocrResultMessage({ read_pages: [2], failed_pages: {}, retranslate_pages: [], ocr_pages: [] }),
    "p.2 を読みました。 読んだページは翻訳から訳せます。");
  assert.equal(ocrResultMessage({ read_pages: [2, 3], failed_pages: { 5: "言語データがありません" }, retranslate_pages: [2, 4], ocr_pages: [5] }),
    "p.2, p.3 を読みました。 読めなかったページ：p.5（言語データがありません） p.2, p.4 は次の翻訳で訳し直します。");
  assert.match(ocrResultMessage({ read_pages: [], failed_pages: {}, retranslate_pages: [], ocr_pages: [1] }), /読めたページはありませんでした/);
});
