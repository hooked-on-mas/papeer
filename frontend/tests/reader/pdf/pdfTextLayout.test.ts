import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import { createPdfTextLayoutState, fitCanonicalPdfTextLayer, fitPdfTextLayer } from '../../../src/features/reader/pdf/pdfTextLayout.ts';

class Style {
  values = new Map<string, string>(); writes = 0;
  getPropertyValue(name: string) { return this.values.get(name) ?? ''; }
  setProperty(name: string, value: string) { this.values.set(name, value); this.writes++; }
}
function sample(minimum = '1') {
  const layerStyle = new Style(), spanStyle = new Style();
  layerStyle.values.set('--min-font-size', minimum); spanStyle.values.set('--font-height', '20px'); spanStyle.values.set('--scale-x', '1');
  const span = { style: spanStyle, offsetWidth: 120 };
  const layer = { style: layerStyle, querySelectorAll: () => [span] };
  const content = { items: [{ str: 'text', width: 120, height: 20, fontName: 'f' }], styles: { f: { vertical: false } } } as unknown as TextContent;
  return { layer: layer as unknown as HTMLElement, span, layerStyle, spanStyle, content };
}

test('canonical scale includes UserUnit before fitting and remains idempotent', () => {
  const state = createPdfTextLayoutState(), x = sample();
  fitCanonicalPdfTextLayer(state, x.layer, x.content, 600, { width: 750, userUnit: 1.25 });
  assert.equal(x.layerStyle.getPropertyValue('--total-scale-factor'), '1');
  assert.equal(x.layerStyle.getPropertyValue('--min-font-size'), '1');
  assert.equal(x.spanStyle.getPropertyValue('--scale-x'), '1');
  const writes = x.layerStyle.writes + x.spanStyle.writes;
  fitCanonicalPdfTextLayer(state, x.layer, x.content, 600, { width: 750, userUnit: 1.25 });
  assert.equal(x.layerStyle.writes + x.spanStyle.writes, writes);
  fitCanonicalPdfTextLayer(state, x.layer, x.content, 600, { width: 750, userUnit: 0 });
  assert.equal(x.layerStyle.writes + x.spanStyle.writes, writes);
});

test('fit uses native minimum, expands low scales and refits idempotently', () => {
  const state = createPdfTextLayoutState(), x = sample();
  fitPdfTextLayer(state, x.layer, x.content, .5);
  assert.equal(x.layerStyle.getPropertyValue('--min-font-size'), '2');
  assert.equal(x.spanStyle.getPropertyValue('--font-height'), '20px');
  assert.equal(x.spanStyle.getPropertyValue('--scale-x'), '1');
  const writes = x.layerStyle.writes + x.spanStyle.writes;
  fitPdfTextLayer(state, x.layer, x.content, .5);
  assert.equal(x.layerStyle.writes + x.spanStyle.writes, writes);
  x.span.offsetWidth = 100;
  fitPdfTextLayer(state, x.layer, x.content, .5);
  assert.equal(x.spanStyle.getPropertyValue('--scale-x'), '1.2');
  fitPdfTextLayer(state, x.layer, x.content, 2);
  assert.equal(x.layerStyle.getPropertyValue('--min-font-size'), '1');
  assert.equal(x.spanStyle.getPropertyValue('--scale-x'), '2.4');
  fitPdfTextLayer(state, x.layer, x.content, .5);
  assert.equal(x.layerStyle.getPropertyValue('--min-font-size'), '2');
  assert.equal(x.spanStyle.getPropertyValue('--font-height'), '20px');
});

test('native minimum, invalid scale and new layer remain independent', () => {
  const state = createPdfTextLayoutState(), first = sample('3'), second = sample('1.5');
  fitPdfTextLayer(state, first.layer, first.content, .5);
  assert.equal(first.layerStyle.getPropertyValue('--min-font-size'), '3');
  const writes = first.layerStyle.writes + first.spanStyle.writes;
  for (const invalid of [0, -1, NaN, Infinity]) fitPdfTextLayer(state, first.layer, first.content, invalid);
  assert.equal(first.layerStyle.writes + first.spanStyle.writes, writes);
  fitPdfTextLayer(state, second.layer, second.content, 2);
  assert.equal(second.layerStyle.getPropertyValue('--min-font-size'), '1.5');
  assert.equal(second.spanStyle.getPropertyValue('--font-height'), '20px');
  assert.equal(state.native?.minimum, 1.5);
});
