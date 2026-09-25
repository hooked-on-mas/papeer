const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

/**
 * Text selected in a PDF text layer breaks at every visual line.
 * Rejoin the lines: a word split by a line-end hyphen closes up (keeping the hyphen before a capital
 * or digit, as in Monte-Carlo), Japanese joins without a space, anything else with one.
 */
export function cleanPdfSelection(text: string): string {
  return text
    .replace(/(\p{L})-[ \t]*\r?\n\s*(?=\p{Ll})/gu, "$1")
    .replace(/(\p{L})-[ \t]*\r?\n\s*(?=\S)/gu, "$1-")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/(.)\n(?=(.))/gu, (_, before: string, after: string) =>
      before + (CJK.test(before) && CJK.test(after) ? "" : " "))
    .replace(/[ \t ]+/g, " ")
    .trim();
}

/** Non-space characters in comparable form (NFKC undoes ligatures), each mapped to its span in `text`. */
function comparable(text: string): { chars: string; starts: number[]; ends: number[] } {
  let chars = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    for (const c of char.normalize("NFKC")) {
      if (/\s/.test(c)) continue;
      chars += c;
      for (let k = 0; k < c.length; k++) {
        starts.push(offset);
        ends.push(offset + char.length);
      }
    }
    offset += char.length;
  }
  return { chars, starts, ends };
}

const ANCHOR = 6;
const MAX_GAP = 300;
/** Near the end of the selection, a short anchor only bridges something the size of inline math. */
const MAX_SHORT_GAP = 40;

/**
 * Follow `selection` through `text` from `start`. Text missing from the selection (the math) is
 * skipped by jumping to the next anchor; selection characters with no place in `text` are dropped.
 */
function align(selection: string, text: string, start: number): { end: number; dropped: number } {
  let i = 0;
  let j = start;
  const runs: string[] = [];
  let run = "";
  while (i < selection.length) {
    if (text[j] === selection[i]) {
      i++;
      j++;
    } else {
      const anchor = selection.slice(i, i + ANCHOR);
      const found = text.indexOf(anchor, j);
      if (found !== -1 && found - j <= (anchor.length === ANCHOR ? MAX_GAP : MAX_SHORT_GAP)) {
        j = found;
      } else {
        run += selection[i++];
        continue;
      }
    }
    if (run) runs.push(run);
    run = "";
  }
  if (run) runs.push(run);
  // Newer translated PDFs also carry the math as invisible text after its paragraph;
  // dropped runs found in and just before the passage are that math out of order, not a mismatch.
  const passage = text.slice(Math.max(0, start - MAX_GAP), j);
  return { end: j, dropped: runs.reduce((sum, r) => sum + (passage.includes(r) ? 0 : r.length), 0) };
}

/**
 * The translated PDF draws inline math as images, so a selection there reads
 * "上記の情報をもとに、 の場合に…". Find the selection in the page's translated `blocks`
 * (math as text) and return that passage instead, or null when it cannot be placed reliably.
 */
export function restoreFormulas(selection: string, blocks: string[]): string | null {
  const wanted = comparable(selection).chars;
  if (wanted.length < 2 || !blocks.length) return null;
  const source = blocks.join("\n\n");
  const text = comparable(source);
  let best: { start: number; end: number; dropped: number } | null = null;
  // Leading characters may sit right before math, so try later starting points as well.
  for (let skip = 0; skip < Math.min(4, wanted.length - 1) && !best; skip++) {
    const rest = wanted.slice(skip);
    const head = rest.slice(0, ANCHOR);
    for (let at = text.chars.indexOf(head); at !== -1; at = text.chars.indexOf(head, at + 1)) {
      const result = align(rest, text.chars, at);
      const dropped = result.dropped + skip;
      if (!best || dropped < best.dropped || (dropped === best.dropped && result.end - at < best.end - best.start)) {
        best = { start: at, end: result.end, dropped };
      }
    }
  }
  if (!best || best.end <= best.start || best.dropped > Math.max(2, wanted.length * 0.15)) return null;
  return cleanPdfSelection(source.slice(text.starts[best.start], text.ends[best.end - 1]));
}

/** Markdown blockquote of the selection, with the page it came from. */
export function quoteForNote(text: string, source: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n") + `\n>\n> — ${source}`;
}
