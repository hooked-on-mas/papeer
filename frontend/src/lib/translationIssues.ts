import type { OcrPage, ReadabilityWarning, ReadingData } from "../api/hooks";

/** Why a page needs OCR, as the translation review lists it. */
export function ocrMessage(entry: OcrPage): string {
  if (entry.reason === "image") return "要OCR：文字のない画像だけのページです（スキャンの可能性）。翻訳対象から外しました";
  const ratio = entry.garbled_ratio === undefined ? "" : `（約${Math.round(entry.garbled_ratio * 100)}%）`;
  if (entry.reason === "partial") return `要OCR（一部）：一部の文字が文字化けしています${ratio}。${entry.garbled_paragraphs === 0
    ? "数式・表などに含まれる化けた部分と訳文を原文と照合してください" : "化けた段落は翻訳せず原文のまま表示します"}`;
  return `要OCR：抽出した文字が文字化けしています${ratio}。翻訳対象から外しました`;
}

/** Pages kept entirely as the original (a partly garbled page is still translated). */
export function wholeOcrPages(reading: Pick<ReadingData, "ocr_pages"> | null | undefined): number[] {
  return (reading?.ocr_pages ?? []).filter(entry => entry.reason !== "partial").map(entry => entry.page);
}

/** The "要確認箇所" of the translation review, by page in page order. */
export function translationIssues(reading: ReadingData | null | undefined): [number, string[]][] {
  const issues = new Map<number, Set<string>>();
  if (!reading) return [];
  const add = (page: number, message: string) => {
    if (!issues.has(page)) issues.set(page, new Set());
    issues.get(page)!.add(message);
  };
  const ocr = new Map((reading.ocr_pages ?? []).map(entry => [entry.page, entry]));
  const whole = new Set(wholeOcrPages(reading));
  for (let page = 1; page <= reading.page_count; page++) {
    if ((reading.translation_required_pages?.includes(page) ?? true) && !whole.has(page)
        && !reading.completed_pages.includes(page) && !reading.empty_pages.includes(page)) add(page, "未翻訳");
  }
  ocr.forEach((entry, page) => add(page, ocrMessage(entry)));
  // A scanned page has no text either; its OCR message already says so.
  reading.empty_pages.forEach(page => { if (!whole.has(page)) add(page, "抽出できる文字がありません"); });
  reading.report?.skipped_block_pages?.forEach(page => add(page, "翻訳をスキップした段落があります"));
  readabilityPages(reading).forEach((size, page) => add(page, readabilityMessage(size)));
  [...(reading.report?.skipped_pages ?? []), ...(reading.preview?.skipped_pages ?? [])].forEach(page => add(page,
    reading.preview?.page_errors?.[String(page)] ?? reading.report?.page_errors?.[String(page)] ?? "PDF生成をスキップしました"));
  return [...issues].sort(([a], [b]) => a - b).map(([page, messages]) => [page, [...messages]]);
}

/** Pages with a paragraph typeset below the readable size, with the smallest size on each. */
export function readabilityPages(reading: Pick<ReadingData, "report"> | null | undefined): Map<number, number> {
  const pages = new Map<number, number>();
  for (const warning of reading?.report?.readability_warnings ?? []) {
    pages.set(warning.page, Math.min(pages.get(warning.page) ?? Infinity, warning.font_size ?? Infinity));
  }
  return pages;
}

export function readabilityMessage(size: number): string {
  const shrunk = Number.isFinite(size) ? `${size.toFixed(1)}ptまで` : "";
  return `枠に収まらず文字を${shrunk}縮小した段落があります（「翻訳を修正」で短い訳の修正案を作れます）`;
}

type ParagraphText = { id: string; pages: number[]; text: string };

const MATH_MARKER = /\[\[PD_MATH_[A-Za-z0-9_]+\]\]/g;

/** Characters as the typesetting's length estimate counts them: without math markers and spaces. */
export function visibleLength(text: string): number {
  return text.replace(MATH_MARKER, "").replace(/\s/g, "").length;
}

const blockOf = (paragraphId: string) => paragraphId.slice(0, paragraphId.lastIndexOf("_"));

/** How short a translation of this paragraph should be to fit its box at a readable size.
 *
 * Each warning's excess (typeset characters over its estimate) is shared among the paragraphs its
 * text came from by their length: a paragraph continued on another page, or a block translated in
 * several parts. null when the paragraph was typeset at a readable size. target is null for a report
 * written before the estimate, and when tooSmall: a box where no shorter translation is readable. */
export function shorteningHint(warnings: ReadabilityWarning[] | undefined, paragraph: ParagraphText,
  paragraphs: ParagraphText[]): { fontSize: number; chars: number; target: number | null; tooSmall: boolean } | null {
  const block = blockOf(paragraph.id);
  const chars = visibleLength(paragraph.text);
  let fontSize = Infinity, excess = 0, estimated = false, found = false, tooSmall = false;
  for (const warning of warnings ?? []) {
    const sources = warning.source_blocks ?? (warning.block ? [warning.block] : []);
    if (!sources.includes(block) || !paragraph.pages.includes(warning.page)) continue;
    found = true;
    fontSize = Math.min(fontSize, warning.font_size ?? Infinity);
    if (warning.chars === undefined || warning.char_budget === undefined) continue;
    if (warning.char_budget === null || warning.char_budget <= 0) { tooSmall = true; continue; }
    estimated = true;
    const sharing = paragraphs.filter(other => sources.includes(blockOf(other.id)));
    const total = sharing.reduce((sum, other) => sum + visibleLength(other.text), 0);
    excess += Math.max(0, warning.chars - warning.char_budget) * (total ? chars / total : 1);
  }
  if (!found) return null;
  // The estimate is rough: when the text is already within it yet still too small, ask for 10% less.
  const target = Math.floor(excess > 0 ? chars - excess : chars * .9);
  if (target < 1) tooSmall = true;
  return { fontSize, chars, target: estimated && !tooSmall ? target : null, tooSmall };
}
