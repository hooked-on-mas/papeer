import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapPdfCaretText, isCurrentPdfCaretMap, movePdfCaret, pdfCaretAtOffset, pdfCaretFromPoint, pdfWordAt,
  restorePdfSelectionBodyFocus } from '../../../src/features/reader/pdf/canonicalPdfCaret.ts';

/** Minimal DOM facts only. These unit cases do not claim real browser caret/rect QA. */
function fixture(parts: string[]) {
  const nodes = parts.map(data => ({ data, length: data.length, nodeType: 3, parentElement: { closest: () => null } } as unknown as Text));
  let point: { offsetNode: Node; offset: number } | null = { offsetNode: nodes[0], offset: 0 };
  let fallback: { startContainer: Node; startOffset: number } | null = null;
  let fallbackCalls = 0;
  const document = {
    createTreeWalker() { let index = 0; return { nextNode: () => nodes[index++] ?? null }; },
    caretPositionFromPoint: () => point,
    caretRangeFromPoint() { fallbackCalls++; return fallback; },
  };
  const layer = { isConnected: true, classList: { contains: (name: string) => name === 'textLayer' }, ownerDocument: document,
    contains: (node: Node) => nodes.includes(node as Text),
    getBoundingClientRect() { throw new Error('quote caret mapping must not query glyph/layout geometry'); },
  } as unknown as HTMLElement;
  return { layer, nodes, setPoint: (value: typeof point) => { point = value; }, setFallback: (value: typeof fallback) => { fallback = value; },
    fallbackCalls: () => fallbackCalls };
}
test('grapheme boundaries cross real Text nodes without geometry/item assumptions', () => {
  const input = fixture(['A', 'e', '\u0301', '👩‍👩‍👧‍👦', '文']);
  const map = mapPdfCaretText(input.layer)!;
  assert.equal(map.text, 'Aé👩‍👩‍👧‍👦文');
  assert.deepEqual(map.boundaries, [0, 1, 3, 14, 15]);
  assert.equal(pdfCaretAtOffset(map, 2), null);
  assert.equal(movePdfCaret(map, 3, 'ArrowRight'), 14);
  assert.equal(movePdfCaret(map, 14, 'ArrowLeft'), 3);
  assert.equal(movePdfCaret(map, 3, 'Home'), 0); assert.equal(movePdfCaret(map, 3, 'End'), 15);
});
test('actual UTF-16 caret is snapped to Intl boundaries, never a character count ratio', () => {
  const input = fixture(['Aé文']), map = mapPdfCaretText(input.layer)!;
  input.setPoint({ offsetNode: input.nodes[0], offset: 2 });
  assert.equal(pdfCaretFromPoint(map, 12, 34), 1);
  assert.equal(input.fallbackCalls(), 0);
});
test('existing caretRangeFromPoint fallback is accepted only for current in-layer Text', () => {
  const input = fixture(['選択']), map = mapPdfCaretText(input.layer)!;
  input.setPoint(null); input.setFallback({ startContainer: input.nodes[0], startOffset: 1 });
  assert.equal(pdfCaretFromPoint(map, 0, 0), 1);
  assert.equal(input.fallbackCalls(), 1);
  input.setFallback({ startContainer: { nodeType: 3 } as Node, startOffset: 1 });
  assert.equal(pdfCaretFromPoint(map, 0, 0), null);
});
test('foreign page, element offset, invalid UTF-16 and changed Text reject instead of estimating', () => {
  const input = fixture(['hello']), map = mapPdfCaretText(input.layer)!;
  input.setPoint({ offsetNode: { nodeType: 3 } as Node, offset: 1 }); assert.equal(pdfCaretFromPoint(map, 0, 0), null);
  input.setPoint({ offsetNode: { nodeType: 1 } as Node, offset: 1 }); assert.equal(pdfCaretFromPoint(map, 0, 0), null);
  input.setPoint({ offsetNode: input.nodes[0], offset: 99 }); assert.equal(pdfCaretFromPoint(map, 0, 0), null);
  input.nodes[0].data = 'world'; assert.equal(isCurrentPdfCaretMap(map), false);
  assert.equal(pdfCaretFromPoint(map, 0, 0), null);
  assert.equal(mapPdfCaretText(fixture(['\ud800']).layer), null);
});
test('long press selects a word or one complete grapheme at punctuation/end', () => {
  const input = fixture(['hello 👩‍👩‍👧‍👦!']), map = mapPdfCaretText(input.layer)!;
  assert.deepEqual(pdfWordAt(map, 2), [0, 5]);
  assert.deepEqual(pdfWordAt(map, 6), [6, 17]);
  assert.deepEqual(pdfWordAt(map, 18), [17, 18]);
});
test('real DOM BR separates words without inventing a glyph location', () => {
  const input = fixture(['hello', 'world']);
  const br = { nodeType: 1, tagName: 'BR', closest: () => null } as unknown as Element;
  const tokens: Node[] = [input.nodes[0], br, input.nodes[1]];
  const document = input.layer.ownerDocument as unknown as { createTreeWalker(): { nextNode(): Node | null } };
  document.createTreeWalker = () => { let index = 0; return { nextNode: () => tokens[index++] ?? null }; };
  const map = mapPdfCaretText(input.layer)!;
  assert.equal(map.text, 'hello\nworld');
  assert.deepEqual(pdfWordAt(map, 3), [0, 5]);
  assert.deepEqual(pdfWordAt(map, 6), [6, 11]);
  assert.deepEqual(pdfCaretAtOffset(map, 5), { node: input.nodes[0], offset: 5 });
  assert.deepEqual(pdfCaretAtOffset(map, 6), { node: input.nodes[1], offset: 0 });
});
test('explicit clear restores a current own handle to text body before the handle is removed', () => {
  const handle = {} as Element;
  const document = { activeElement: handle };
  let calls = 0, removed = false;
  const layer = { isConnected: true, ownerDocument: document,
    focus(options: FocusOptions) {
      calls++; assert.equal(removed, false); assert.deepEqual(options, { preventScroll: true }); document.activeElement = layer;
    },
  } as unknown as HTMLElement;
  assert.equal(restorePdfSelectionBodyFocus({ layer, current: true, ownsHandle: target => target === handle }), true);
  removed = true;
  assert.equal(calls, 1); assert.equal(document.activeElement, layer);
});
test('stale token, detached layer and unrelated/form/toolbar focus never receive focus restoration', () => {
  const handle = {} as Element, unrelated = {} as Element;
  for (const input of [
    { current: false, connected: true, active: handle },
    { current: true, connected: false, active: handle },
    { current: true, connected: true, active: unrelated },
  ]) {
    let calls = 0;
    const layer = { isConnected: input.connected, ownerDocument: { activeElement: input.active }, focus() { calls++; } } as unknown as HTMLElement;
    assert.equal(restorePdfSelectionBodyFocus({ layer, current: input.current, ownsHandle: target => target === handle }), false);
    assert.equal(calls, 0);
  }
});
