import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server, CanonicalInkDrawing;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../..', import.meta.url)),
    logLevel: 'error', appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  ({ CanonicalInkDrawing } = await server.ssrLoadModule('/src/features/reader/ink/CanonicalInkDrawing.tsx'));
});
after(async () => { await server?.close(); });
const annotation = geometry => ({ kind: 'ink', id: 'canonical', geometry,
  transform: { x: 10, y: 20, rotationRad: 0, scaleX: 2, scaleY: 3 },
  style: { color: '#123456', widthPt: 4, opacity: .67, highlighter: true } });
const render = ink => renderToStaticMarkup(createElement(CanonicalInkDrawing, { annotation: ink, page: { widthPt: 500, heightPt: 750 } }));

test('canonical text keeps explicit font, whitespace, multiline text, opacity and affine transform', () => {
  const ink = annotation({ kind: 'text', widthPt: 90, heightPt: 50, fontSizePt: 17, fontFamily: 'serif', text: 'a  b\n<script>x</script>' });
  const before = structuredClone(ink), html = render(ink);
  assert.match(html, /matrix\(4 0 0 6 20 40\)/);
  assert.match(html, /opacity="0.67"/);
  assert.match(html, /font-family="serif" font-size="17"/);
  assert.equal((html.match(/<text /g) ?? []).length, 2);
  assert.match(html, /a  b/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.deepEqual(ink, before);
});

test('double arrow renders both actual heads and does not replace their lengths with the preferred length', () => {
  const ink = annotation({ kind: 'arrow', start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, head: 'both', headLengthPt: 10, preferredHeadLengthPt: 40 });
  const html = render(ink);
  assert.match(html, /stroke-width="4"/);
  const points = html.match(/points="([^"]+)"/)[1].split(' ').map(p => p.split(',').map(Number));
  assert.equal(points.length, 8);
  assert.ok(Math.abs(Math.hypot(...points[0]) - 10) < 1e-10);
  assert.ok(Math.abs(Math.hypot(points[5][0] - 100, points[5][1]) - 10) < 1e-10);
});
