/**
 * Same rules and messages as papeer.layout.page_selection, for feedback while typing; the sidecar reads
 * the pages again. Both are tested against tests/fixtures/page_ranges.json.
 */
import { PY_SPACE, pyStrip } from "./pyWhitespace.ts";

const RANGE = new RegExp(`^${PY_SPACE}*([0-9]+)${PY_SPACE}*(?:-${PY_SPACE}*([0-9]+)${PY_SPACE}*)?$`);

/** The pages that "1, 3-5, 8" names, in order; throws with the sidecar's message otherwise. */
export function parsePageSelection(value: string, pageCount: number): number[] {
  const text = value.normalize("NFKC").replace(/、/g, ",").replace(/[～~–—−]/g, "-");
  if (!pyStrip(text)) throw new Error("翻訳するページを入力してください。例: 1, 3-5, 8");
  const pages = new Set<number>();
  for (const part of text.split(",")) {
    const match = RANGE.exec(part);
    if (!match) throw new Error("ページ番号と範囲をカンマで区切ってください。例: 1, 3-5, 8");
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (!(1 <= first && first <= last && last <= pageCount)) {
      throw new Error(`1～${pageCount}ページの範囲を、小さい番号から指定してください。`);
    }
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}
