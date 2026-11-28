/**
 * A selection in a PDF page's text layer, as offsets into the text of its spans run together.
 * The text layer holds the same text at any zoom, so the offsets select the same passage later.
 */

/** Offset of a boundary point within `layer`'s text, clamped to the layer. */
function offsetIn(layer: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(layer);
  const position = range.comparePoint(node, offset);
  if (position < 0) return 0;
  if (position > 0) return range.toString().length;
  range.setEnd(node, offset);
  return range.toString().length;
}

/** Offsets of `range` within the text layer it starts or ends in, and the text they cover. */
export function textLayerOffsets(range: Range): { start: number; end: number; raw: string } | null {
  const layerOf = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".textLayer");
  const layer = layerOf(range.startContainer) ?? layerOf(range.endContainer);
  if (!layer) return null;
  const start = offsetIn(layer, range.startContainer, range.startOffset);
  const end = offsetIn(layer, range.endContainer, range.endOffset);
  if (end <= start) return null;
  return { start, end, raw: (layer.textContent ?? "").slice(start, end) };
}

/** Text node and offset at `offset` into `layer`'s text. */
function pointAt(layer: HTMLElement, offset: number, atEnd: boolean): [Node, number] | null {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    // An end on a node boundary stays in the earlier node, a start moves to the later one.
    if (atEnd ? offset <= at + length : offset < at + length) return [node, offset - at];
    at += length;
  }
  return null;
}

/**
 * Selects the passage again, found by its offsets or, when the page's text has changed
 * (a new translation), by its text. Returns false when it is no longer on the page.
 */
export function selectInTextLayer(layer: HTMLElement, passage: { start?: number | null; end?: number | null; raw?: string }): boolean {
  const text = layer.textContent ?? "";
  let { start, end } = passage;
  const raw = passage.raw ?? "";
  if (start == null || end == null || (raw && text.slice(start, end) !== raw)) {
    start = raw ? text.indexOf(raw) : -1;
    end = start + raw.length;
  }
  if (start < 0 || end <= start || end > text.length) return false;
  const from = pointAt(layer, start, false);
  const to = pointAt(layer, end, true);
  const selection = window.getSelection();
  if (!from || !to || !selection) return false;
  const range = document.createRange();
  range.setStart(...from);
  range.setEnd(...to);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}
