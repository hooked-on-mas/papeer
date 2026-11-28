import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfLinkRect, safePdfExternalUrl } from '../../../src/features/reader/pdf/canonicalPdfLinks.ts';

test('external PDF URLs permit only credential-free http and https', () => {
  assert.equal(safePdfExternalUrl('https://example.org/x'), 'https://example.org/x');
  for (const value of ['javascript:alert(1)', 'file:///x', '//example.org', 'https://user:pass@example.org', 'data:text/html,x']) assert.equal(safePdfExternalUrl(value), null);
});
test('link rectangles transform and clip to page', () => {
  const viewport = { width: 100, height: 200, convertToViewportPoint: (x: number, y: number) => [x, y] };
  assert.deepEqual(pdfLinkRect(viewport, [-10, 50, 30, 250]), { x: 0, y: .25, width: .3, height: .75 });
  assert.equal(pdfLinkRect(viewport, [10, 10, 10, 50]), null);
  assert.equal(pdfLinkRect(viewport, [0, 0, NaN, 4]), null);
});
test('link rectangles follow a rotated viewport', () => {
  const viewport = { width: 200, height: 100, convertToViewportPoint: (x: number, y: number) => [y, 100 - x] };
  assert.deepEqual(pdfLinkRect(viewport, [10, 20, 30, 60]), { x: .1, y: .7, width: .19999999999999998, height: .20000000000000007 });
});
