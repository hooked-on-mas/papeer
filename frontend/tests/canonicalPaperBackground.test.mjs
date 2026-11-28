import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { pageWidthFor } from '../src/features/reader/zoomLevels.ts';

let server, CanonicalPaperBackground;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error',
    appType: 'custom', server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  ({ CanonicalPaperBackground } = await server.ssrLoadModule('/src/features/notebooks/CanonicalPaperBackground.tsx'));
});
after(async () => { await server?.close(); });
const mm = 72 / 25.4;
const page = (template, color = 'white') => ({ widthPt: 210 * mm, heightPt: 297 * mm, background: { kind: 'paper', spec: { template, color } } });
const render = (template, color) => renderToStaticMarkup(createElement(CanonicalPaperBackground, { page: page(template, color) }));
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]+)"/g)].map(match => [match[1], match[2]]));
const pattern = (html, name) => attributes([...html.matchAll(/<pattern [^>]+>/g)].map(match => match[0]).find(tag => tag.includes(`-${name}"`)) ?? '');
const area = (html, name) => attributes([...html.matchAll(/<rect [^>]+>/g)].map(match => match[0]).find(tag => tag.includes(`-${name})`)) ?? '');
const near = (actual, expected) => assert.ok(Math.abs(Number(actual) - expected) < 1e-8, `${actual} != ${expected}`);
test('all paper templates use point dimensions and physical notebook line spacing', () => {
  for (const template of ['blank', 'ruled7', 'ruled6', 'ruled5', 'grid5', 'grid10', 'dot5', 'cornell']) {
    const html = render(template);
    assert.ok(html.includes(`viewBox="0 0 ${210 * mm} ${297 * mm}"`));
    assert.match(html, /stroke-width="0.35"/);
    if (template === 'blank') assert.doesNotMatch(html, /<pattern|<line|<circle/);
    const ruled = template.startsWith('ruled') || template === 'cornell';
    if (ruled || template.startsWith('grid')) {
      const step = (template === 'cornell' ? 7 : template === 'grid10' ? 10 : template.startsWith('ruled') ? Number(template.at(-1)) : 5) * mm;
      const first = 15 * mm + (ruled ? step : 0), bottom = (template === 'cornell' ? 262 : 282) * mm;
      // Independently enumerate normal A4 physical line centers, then compare the painted extent.
      let last = first;
      for (let y = first; y < bottom; y += step) last = y;
      const rows = pattern(html, 'rows'), painted = area(html, 'rows');
      near(rows.height, step); near(Number(rows.y) + step / 2, first);
      near(painted.x, 15 * mm); near(painted.width, 180 * mm);
      near(painted.y, first - .175); near(Number(painted.y) + Number(painted.height), last + .175);
      if (!ruled) {
        const columns = pattern(html, 'columns');
        near(columns.width, step); near(Number(columns.x) + step / 2, 15 * mm);
        near(area(html, 'columns').height, 267 * mm);
      }
    }
  }
});
test('huge finite paper dimensions keep every template constant in markup size', () => {
  for (const template of ['blank', 'ruled7', 'ruled6', 'ruled5', 'grid5', 'grid10', 'dot5', 'cornell']) {
    const html = renderToStaticMarkup(createElement(CanonicalPaperBackground, { page: { ...page(template), widthPt: 1e7, heightPt: 1e7 } }));
    assert.ok(html.length < 2500, `${template}: ${html.length}`);
    assert.ok((html.match(/<line /g) ?? []).length <= 3);
    assert.ok((html.match(/<pattern /g) ?? []).length <= 2);
    if (template === 'blank') assert.doesNotMatch(html, /<pattern/);
    else {
      const step = (template === 'grid10' ? 10 : template === 'ruled7' || template === 'cornell' ? 7 : template === 'ruled6' ? 6 : 5) * mm;
      const tile = pattern(html, template === 'dot5' ? 'dots' : 'rows');
      near(tile.height, step);
      near(Number(tile.y) + step / 2, 15 * mm + (template.startsWith('ruled') || template === 'cornell' ? step : 0));
    }
  }
});
test('a line centered exactly on the trailing margin is excluded without clipping the previous stroke', () => {
  const custom = { ...page('grid5'), widthPt: 40 * mm, heightPt: 40 * mm };
  const html = renderToStaticMarkup(createElement(CanonicalPaperBackground, { page: custom }));
  const rows = area(html, 'rows'), columns = area(html, 'columns');
  near(Number(rows.y) + Number(rows.height), 20 * mm + .175);
  near(Number(columns.x) + Number(columns.width), 20 * mm + .175);
});
test('Cornell preserves cue-column and summary geometry and all paper colors', () => {
  const html = render('cornell', 'dark');
  assert.ok(html.includes(`x1="${210 * mm * .28}"`));
  assert.ok(html.includes(`y1="${297 * mm - 35 * mm}"`));
  assert.match(html, /rgb\(12% 14% 17%\)/);
  assert.match(html, /rgb\(35% 39% 45%\)/);
  assert.match(render('blank', 'cream'), /rgb\(100% 97% 88%\)/);
  assert.match(render('blank'), /rgb\(100% 100% 100%\)/);
});
test('dot patterns retain physical radius and unique instance references', () => {
  const html = renderToStaticMarkup(createElement(Fragment, null,
    createElement(CanonicalPaperBackground, { page: page('dot5') }), createElement(CanonicalPaperBackground, { page: page('dot5', 'dark') })));
  const ids = [...html.matchAll(/<pattern id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.ok(html.includes(`url(#${id})`));
  assert.match(html, /r="0.45"/);
});
test('portrait, landscape, and resized paper fit respects actual aspect and 400 percent maximum', () => {
  for (const ratio of [297 / 210, 210 / 297, 320 / 180]) for (const width of [320, 900]) {
    const fit = pageWidthFor(0, width, 600, ratio);
    assert.ok(fit <= width && fit * ratio <= 600);
    assert.equal(pageWidthFor(.1, width, 600, ratio), fit);
    assert.equal(pageWidthFor(20, width, 600, ratio), width * 4);
  }
});
