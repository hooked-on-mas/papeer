import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPdfTextMatches, PDF_SEARCH_PAGE_LIMIT } from '../../../src/features/reader/pdf/pdfTextSearch.ts';

test('search returns original UTF-16 offsets for normalized graphemes and expansions', () => {
  assert.deepEqual(findPdfTextMatches('😀 Cafe\u0301 Ａ ﬃ', 'CAFÉ').matches, [{ start: 3, end: 8 }]);
  assert.deepEqual(findPdfTextMatches('😀 Cafe\u0301 Ａ ﬃ', 'ffi').matches, [{ start: 11, end: 12 }]);
});
test('search reports truncated matches and refuses excessive page text', () => {
  assert.deepEqual(findPdfTextMatches('a a a', 'a', 2), { matches: [{ start: 0, end: 1 }, { start: 2, end: 3 }], limited: true });
  assert.throws(() => findPdfTextMatches('x'.repeat(PDF_SEARCH_PAGE_LIMIT + 1), 'x'), /too-large/);
});

test('incremental search stops stale asynchronous results after cancellation', async () => {
  const { searchPdfPages } = await import('../../../src/features/reader/pdf/pdfTextSearch.ts');
  const controller = new AbortController();
  let finish: (value: { text: string; anchors: [] }) => void = () => {};
  async function* pages() { yield { id: 'p', backgroundRevision: 'r', text: () => new Promise<{ text: string; anchors: [] }>(resolve => { finish = resolve; }) }; }
  const pending = searchPdfPages(pages(), 'a', controller.signal);
  await Promise.resolve(); controller.abort(); finish({ text: 'a', anchors: [] });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('incremental hits preserve page identity and match the text item anchor', async () => {
  const { searchPdfPages } = await import('../../../src/features/reader/pdf/pdfTextSearch.ts');
  async function* pages() { yield { id: 'p', backgroundRevision: 'r', text: async () => ({ text: 'one two', anchors: [{ start: 4, end: 7, x: .1, y: .7, width: .2, height: .05 }] }) }; }
  assert.deepEqual(await searchPdfPages(pages(), 'two', new AbortController().signal),
    { hits: [{ pageId: 'p', backgroundRevision: 'r', start: 4, end: 7, y: .7, rects: [{ x: .1, y: .7, width: .2, height: .05 }] }], limited: false });
});
