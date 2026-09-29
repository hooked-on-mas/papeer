/**
 * The words the screen uses about OCR (papeer/core/ocr.py): engines, languages, what a page was read with,
 * and the confirmations before reading pages, sending page images to the AI and downloading language data.
 * Kept free of React so that tests/ocrText.test.ts can check them.
 */
import type { components } from "../api/schema";

export type OcrStatus = components["schemas"]["OcrStatus"];
export type OcrSettings = components["schemas"]["OcrSettings"];
export type LanguageData = components["schemas"]["LanguageData"];
export type OcrApplied = components["schemas"]["OcrApplied"];
export type OcrResult = components["schemas"]["OcrResult"];

export const MODE_CHOICES: { value: OcrSettings["mode"]; label: string; hint: string }[] = [
  { value: "ask", label: "要OCRのページがあるときに聞く", hint: "論文を追加したときに、スキャンなどで文字を読み取れないページがあれば、OCR で読むかを確かめます。" },
  { value: "auto", label: "追加するときに OCR で読む", hint: "確かめずに、追加する処理の中で読みます（1 ページに数秒かかります）。" },
  { value: "off", label: "使わない", hint: "要OCRのページは原文のまま表示します。「翻訳の確認・修正」から論文ごとに読むことはできます。" },
];

export const LANG_CHOICES: { value: OcrSettings["lang"]; label: string }[] = [
  { value: "auto", label: "自動（論文の文字から判断）" },
  { value: "en", label: "英語" },
  { value: "ja", label: "日本語" },
];

const ENGINE_LABELS: Record<string, string> = {
  auto: "自動", tesseract: "Tesseract", windows: "Windows の OCR", vision: "macOS の Vision", ai: "AI",
};

export const LANG_LABELS: Record<string, string> = { en: "英語", ja: "日本語" };

/** The engines the settings offer here: Tesseract everywhere, the system's own OCR where there is one. */
export function engineChoices(status: Pick<OcrStatus, "system" | "settings">): { value: OcrSettings["engine"]; label: string }[] {
  const names: OcrSettings["engine"][] = ["auto", "tesseract"];
  if (status.system) names.push(status.system.name);
  // A choice saved on another OS stays shown, so that the select tells the truth.
  if (!names.includes(status.settings.engine)) names.push(status.settings.engine);
  return names.map(value => ({ value, label: value === "auto" ? "自動（日本語はシステムの OCR、英語は Tesseract）" : ENGINE_LABELS[value] }));
}

/** "tesseract+windows" → 「Tesseract・Windows の OCR」. */
export function engineName(engine: string): string {
  return engine.split("+").filter(Boolean).map(name => ENGINE_LABELS[name] ?? name).join("・") || "不明";
}

/** 「p.3：Tesseract・英語で読みました（傾き 0.4°）」 */
export function describeApplied(entry: OcrApplied): string {
  const skew = Math.abs(entry.skew) >= 0.05 ? `（傾き ${entry.skew.toFixed(1)}°を補正）` : "";
  return `p.${entry.page}：${engineName(entry.engine)}・${LANG_LABELS[entry.lang] ?? entry.lang}で読みました${skew}`;
}

/** Bytes as MB with one decimal (the language data is a few MB). */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

export function pageList(pages: number[]): string {
  return pages.map(page => `p.${page}`).join(", ");
}

/** The language data to download before reading: the languages the settings may need that nothing reads yet. */
export function neededLanguageData(status: Pick<OcrStatus, "missing" | "language_data">): LanguageData[] {
  return status.language_data.filter(entry => status.missing.includes(entry.lang) && !entry.installed);
}

/** The confirmation before downloading: what, how large, from where and to where. */
export function downloadConfirmText(entries: LanguageData[], directory: string, reason?: string): string {
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const files = entries.map(entry => `・${entry.label}（${entry.file}、${formatMegabytes(entry.size)}）`).join("\n");
  return [reason, `次の OCR の言語データ（計 ${formatMegabytes(total)}）を GitHub（raw.githubusercontent.com の tesseract-ocr/tessdata_fast）からダウンロードします。`,
    files, `保存先：${directory}（このPCだけに置き、同期・バックアップはしません）。ダウンロードしたあと、内容が正しいかを SHA-256 で確かめます。`]
    .filter(Boolean).join("\n");
}

/** The confirmation before reading a paper's pages by OCR and extracting it again. */
export function readConfirmText(pages: number[], translated: boolean): string {
  return [`要OCRのページ（${pageList(pages)}）を、このPCの OCR で読み、論文の文字の抽出をやり直します。読めたページは翻訳できるようになります。`,
    translated
      ? "読んだページと、段落が続く前後のページは、保存している訳文が使えなくなり、次の翻訳で訳し直します（利用枠を使います）。ほかのページの訳文はそのまま使います。"
      : "",
    "読んだ結果は論文と一緒に保存し、ほかのPCでもそのまま使います。1 ページに数秒かかります。途中で中止できます。"]
    .filter(Boolean).join("\n");
}

/** The confirmation before sending a page's images to the AI connection. */
export function aiConfirmText(page: number, provider: string, translated: boolean): string {
  return [`p.${page} を本文の領域ごとに画像にして、今の AI 接続（${provider}）に送り、文字を読み取ってもらいます。`,
    "ページの画像を接続先のサービスに送信します。接続先の利用枠（API の場合は料金）を使います。図は送らず、数式は原文の画像のまま残します（数式か本文か判断のつかない小さな領域は送ります）。",
    translated ? "このページと、段落が続く前後のページは、保存している訳文が使えなくなり、次の翻訳で訳し直します。" : ""]
    .filter(Boolean).join("\n");
}

/** What the finished OCR job tells: pages read, pages that failed and why, pages to translate again. */
export function ocrResultMessage(result: Pick<OcrResult, "read_pages" | "failed_pages" | "retranslate_pages" | "ocr_pages">): string {
  const parts: string[] = [];
  parts.push(result.read_pages.length ? `${pageList(result.read_pages)} を読みました。` : "読めたページはありませんでした。");
  const failed = Object.entries(result.failed_pages);
  if (failed.length) parts.push(`読めなかったページ：${failed.map(([page, reason]) => `p.${page}（${reason}）`).join("、")}`);
  if (result.retranslate_pages.length) parts.push(`${pageList(result.retranslate_pages)} は次の翻訳で訳し直します。`);
  else if (result.read_pages.length) parts.push("読んだページは翻訳から訳せます。");
  return parts.join(" ");
}
