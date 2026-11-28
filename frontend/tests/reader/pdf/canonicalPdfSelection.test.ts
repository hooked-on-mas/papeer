import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectCanonicalPdfText } from '../../../src/features/reader/pdf/canonicalPdfSelection.ts';
import type { Page } from '../../../src/runtime/edits/contracts.ts';
import type { CitationTarget } from '../../../src/runtime/markdown/markdownCitations.ts';
const id = '00000000-0000-4000-8000-000000000001';
const page: Page = { id, backgroundRevision: id, lifecycleVersion: id, annotationVersion: id, widthPt: 600, heightPt: 800,
  annotations: [], background: { kind: 'pdf', resourceId: id, sourceRevision: 'a'.repeat(64), pdfPage: 1 } };
const target: CitationTarget = { libraryId: id, documentId: id, pageId: id, backgroundRevision: id, surface: 'original' };
function geometry(scale: number) {
  const inside = {} as Node, outside = {} as Node;
  const textLayer = { isConnected: true, classList: { contains: (name: string) => name === 'textLayer' },
    contains: (node: Node) => node === inside, getBoundingClientRect: () => ({ left: 10, top: 20, width: 600 * scale, height: 800 * scale }) } as unknown as HTMLElement;
  const range = { collapsed: false, startContainer: inside, endContainer: inside, toString: () => 'hy-\nphen',
    getClientRects: () => [{ left: 10 + 150 * scale, top: 20 + 200 * scale, width: 50 * scale, height: 10 * scale }] } as unknown as Range;
  return { textLayer, range, outside };
}
test('text citation cleans line breaks and yields the same physical anchor at different display scales', () => {
  for (const scale of [.25, 1, 4]) {
    const result = selectCanonicalPdfText({ ...geometry(scale), page, target });
    assert.equal(result?.text, 'hyphen'); assert.deepEqual(result?.target.anchor, { xPt: 150, yPt: 200 });
    assert.notEqual(result?.target, target); assert.equal(target.anchor, undefined);
  }
});
test('foreign endpoint, collapsed selection and stale background cannot produce a citation', () => {
  const input = geometry(1);
  assert.equal(selectCanonicalPdfText({ ...input, range: { ...input.range, endContainer: input.outside } as Range, page, target }), null);
  assert.equal(selectCanonicalPdfText({ ...input, range: { ...input.range, collapsed: true } as Range, page, target }), null);
  assert.equal(selectCanonicalPdfText({ ...input, page, target: { ...target, backgroundRevision: '00000000-0000-4000-8000-000000000002' } }), null);
});
