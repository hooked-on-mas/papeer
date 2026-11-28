/** DOM-only quote/copy map. Deliberately independent of highlight item geometry,
 * horizontal transforms, PDF font metrics, and item/span correspondence. */
export type PdfCaretEntry = Readonly<{ node: Text; text: string; start: number }>;
export type PdfCaretMap = Readonly<{ layer: HTMLElement; entries: readonly PdfCaretEntry[]; text: string;
  boundaries: readonly number[]; breaks: readonly Element[] }>;
type Segment = { index: number; segment: string; isWordLike?: boolean };
type Segmenter = { segment(text: string): Iterable<Segment> };
function segments(text: string, granularity: 'grapheme' | 'word'): Segment[] | null {
  const Constructor = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter }).Segmenter;
  if (!Constructor) return null;
  // Lone surrogates cannot be a safe UTF-16 caret map.
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) return null;
  }
  return Array.from(new Constructor(undefined, { granularity }).segment(text));
}
export function mapPdfCaretText(layer: HTMLElement): PdfCaretMap | null {
  if (!layer.isConnected || !layer.classList.contains('textLayer')) return null;
  const entries: PdfCaretEntry[] = [];
  const breaks: Element[] = [];
  let text = '', pendingBreaks = 0;
  const walker = layer.ownerDocument.createTreeWalker(layer, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    if (next.nodeType === 1) {
      const element = next as Element;
      if (element.tagName === 'BR' && !element.closest('.endOfContent, script, style')) { breaks.push(element); if (text) pendingBreaks++; }
      continue;
    }
    const node = next as Text;
    if (!node.length || node.parentElement?.closest('.endOfContent, script, style')) continue;
    // A real DOM <br> separates words; it supplies no estimated glyph/caret.
    if (pendingBreaks) { text += '\n'.repeat(pendingBreaks); pendingBreaks = 0; }
    entries.push({ node, text: node.data, start: text.length }); text += node.data;
  }
  const graphemes = segments(text, 'grapheme');
  if (!entries.length || !graphemes) return null;
  const representable = (offset: number) => entries.some(entry => offset >= entry.start && offset <= entry.start + entry.text.length);
  return { layer, entries, text, breaks, boundaries: [...graphemes.map(segment => segment.index), text.length].filter(representable) };
}
export function isCurrentPdfCaretMap(map: PdfCaretMap): boolean {
  const current = mapPdfCaretText(map.layer);
  return !!current && current.text === map.text && current.entries.length === map.entries.length
    && current.entries.every((entry, index) => entry.node === map.entries[index].node && entry.text === map.entries[index].text)
    && current.breaks.length === map.breaks.length && current.breaks.every((element, index) => element === map.breaks[index]);
}
export function pdfCaretAtOffset(map: PdfCaretMap, offset: number): { node: Text; offset: number } | null {
  if (!map.boundaries.includes(offset)) return null;
  const entry = map.entries.find(candidate => offset >= candidate.start && offset < candidate.start + candidate.text.length)
    ?? map.entries.find(candidate => offset === candidate.start + candidate.text.length);
  return entry ? { node: entry.node, offset: offset - entry.start } : null;
}
export function pdfCaretFromPoint(map: PdfCaretMap, x: number, y: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !isCurrentPdfCaretMap(map)) return null;
  type CaretDocument = Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const document = map.layer.ownerDocument as CaretDocument;
  let node: Node | null = null, offset = -1;
  try {
    const position = document.caretPositionFromPoint?.(x, y);
    if (position) { node = position.offsetNode; offset = position.offset; }
    else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (range) { node = range.startContainer; offset = range.startOffset; }
    }
  } catch { return null; }
  // Never substitute another page, an element offset, or an estimated glyph position.
  if (!node || node.nodeType !== 3 || !map.layer.contains(node) || !Number.isSafeInteger(offset)) return null;
  const entry = map.entries.find(candidate => candidate.node === node);
  if (!entry || offset < 0 || offset > entry.text.length || entry.node.data !== entry.text) return null;
  const absolute = entry.start + offset;
  return map.boundaries.reduce((best, boundary) => Math.abs(boundary - absolute) < Math.abs(best - absolute) ? boundary : best, 0);
}
export function pdfCaretRange(map: PdfCaretMap, anchor: number, focus: number): Range | null {
  const start = pdfCaretAtOffset(map, Math.min(anchor, focus)), end = pdfCaretAtOffset(map, Math.max(anchor, focus));
  if (!start || !end || !isCurrentPdfCaretMap(map)) return null;
  try {
    const range = map.layer.ownerDocument.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    return range;
  } catch { return null; }
}
export function pdfWordAt(map: PdfCaretMap, offset: number): readonly [number, number] | null {
  if (!map.boundaries.includes(offset)) return null;
  const words = segments(map.text, 'word');
  const word = words?.find(segment => segment.isWordLike && offset >= segment.index && offset < segment.index + segment.segment.length);
  if (word && map.boundaries.includes(word.index) && map.boundaries.includes(word.index + word.segment.length))
    return [word.index, word.index + word.segment.length];
  const index = map.boundaries.indexOf(offset);
  return index < map.boundaries.length - 1 ? [offset, map.boundaries[index + 1]]
    : index > 0 ? [map.boundaries[index - 1], offset] : null;
}
export function movePdfCaret(map: PdfCaretMap, offset: number, key: string): number | null {
  const index = map.boundaries.indexOf(offset);
  if (index < 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return map.text.length;
  if (key === 'ArrowLeft') return map.boundaries[Math.max(0, index - 1)];
  if (key === 'ArrowRight') return map.boundaries[Math.min(map.boundaries.length - 1, index + 1)];
  return null;
}
/** Explicit clear only. Invalidation callers pass no focus request; a stale
 * binding or another active control must never be focused back into the PDF. */
export function restorePdfSelectionBodyFocus({ layer, current, ownsHandle }: {
  layer: HTMLElement; current: boolean; ownsHandle(target: Element | null): boolean;
}): boolean {
  if (!current || !layer.isConnected || !ownsHandle(layer.ownerDocument.activeElement)) return false;
  layer.focus({ preventScroll: true });
  return layer.ownerDocument.activeElement === layer;
}
