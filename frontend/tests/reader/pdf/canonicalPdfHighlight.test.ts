import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalPdfHighlightCaptureProblem, captureCanonicalPdfHighlight, isCanonicalPdfTextBoundary,
  mapCanonicalPdfHighlightRect, type CanonicalPdfTextBinding, type PdfHighlightBox,
  type PdfHighlightViewport } from '../../../src/features/reader/pdf/canonicalPdfHighlight.ts';
import type { CanonicalPdfAsset } from '../../../src/features/reader/pdf/canonicalPdfResource.ts';

const natural: PdfHighlightViewport = { width: 600, height: 800, scale: 1, rotation: 0, userUnit: 1,
  transform: [1, 0, 0, -1, -100, 1000] };
const pointSet = (quad: readonly { x: number; y: number }[]) => quad.map(point => [point.x, point.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

test('CropBox marker coordinates survive four page rotations and positive client scales without DPR multiplication', () => {
  // Independent known marker: PDF x=250..300, y=790..800, canonical x=150..200/y=200..210.
  const cases: { viewport: PdfHighlightViewport; marker: PdfHighlightBox }[] = [
    { viewport: { ...natural, width: 900, height: 1200, scale: 1.5, transform: [1.5, 0, 0, -1.5, -150, 1500] },
      marker: { left: 225, top: 300, width: 75, height: 15 } },
    { viewport: { ...natural, width: 1200, height: 900, scale: 1.5, rotation: 90, transform: [0, 1.5, 1.5, 0, -300, -150] },
      marker: { left: 885, top: 225, width: 15, height: 75 } },
    { viewport: { ...natural, width: 900, height: 1200, scale: 1.5, rotation: 180, transform: [-1.5, 0, 0, 1.5, 1050, -300] },
      marker: { left: 600, top: 885, width: 75, height: 15 } },
    { viewport: { ...natural, width: 1200, height: 900, scale: 1.5, rotation: 270, transform: [0, -1.5, -1.5, 0, 1500, 1050] },
      marker: { left: 300, top: 600, width: 15, height: 75 } },
  ];
  for (const { viewport, marker } of cases) for (const [scaleX, scaleY] of [[.75, .75], [1, 1], [2, 2], [1.5, .75]]) {
    const quad = mapCanonicalPdfHighlightRect({ natural, rendered: viewport, cssWidth: viewport.width, cssHeight: viewport.height,
      canvasBox: { left: 10, top: 20, width: viewport.width * scaleX, height: viewport.height * scaleY },
      rect: { left: 10 + marker.left * scaleX, top: 20 + marker.top * scaleY, width: marker.width * scaleX, height: marker.height * scaleY } });
    assert.ok(quad);
    assert.deepEqual(pointSet(quad), [[150, 200], [150, 210], [200, 200], [200, 210]]);
    assert.ok(Object.isFrozen(quad));
  }
});

test('out-of-page rectangles and unsupported matrices are refused without clipping or bounding-box repair', () => {
  const input = { natural, rendered: natural, cssWidth: 600, cssHeight: 800,
    canvasBox: { left: 0, top: 0, width: 600, height: 800 }, rect: { left: 10, top: 10, width: 20, height: 10 } };
  assert.equal(mapCanonicalPdfHighlightRect({ ...input, rect: { ...input.rect, left: -1 } }), null);
  assert.equal(mapCanonicalPdfHighlightRect({ ...input, rect: { ...input.rect, width: 0 } }), null);
  assert.equal(mapCanonicalPdfHighlightRect({ ...input, rendered: { ...natural, transform: [1, .1, 0, -1, -100, 1000] } }), null);
  assert.equal(mapCanonicalPdfHighlightRect({ ...input, rendered: { ...natural, rotation: 45 } }), null);
});

test('UTF-16 offsets must be grapheme boundaries, including boundaries spanning text items', () => {
  const text = 'A😀e\u0301👩‍👩‍👧‍👦Z';
  for (const offset of [0, 1, 3, 5, text.indexOf('Z'), text.length]) assert.equal(isCanonicalPdfTextBoundary(text, offset), true);
  for (const offset of [2, 4, 6, 7, 8, -1, .5, text.length + 1]) assert.equal(isCanonicalPdfTextBoundary(text, offset), false);
  assert.equal(isCanonicalPdfTextBoundary('\ud800', 0), false);
  assert.equal(isCanonicalPdfTextBoundary('e' + '\u0301', 1), false);
});

// A small DOM double supplies measured subrange rects, never a font/character-width
// model. These are contract tests; actual browser layout remains a separate spike.
type FakeNode = FakeElement | FakeText;
class FakeDocument {
  fonts = { status: 'loaded' };
  onMeasure: (() => void) | null = null;
  defaultView = { getComputedStyle: (element: FakeElement) => ({ perspective: 'none', rotate: 'none', scale: 'none',
    translate: 'none', offsetPath: 'none', writingMode: 'horizontal-tb', transform: 'none', visibility: 'visible', display: 'block',
    width: '600px', height: '800px', borderLeftWidth: '0px', borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px',
    paddingLeft: '0px', paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', ...element.computed }) };
  createRange() {
    let node: FakeText | null = null;
    return { setStart: (value: FakeText) => { node = value; }, setEnd: () => {},
      getClientRects: () => { this.onMeasure?.(); return node?.rects ?? []; } };
  }
}
class FakeText {
  nodeType = 3;
  parentElement: FakeElement | null = null;
  rects: PdfHighlightBox[] = [{ left: 110, top: 220, width: 30, height: 10 }];
  ownerDocument: FakeDocument;
  data: string;
  constructor(ownerDocument: FakeDocument, data: string) {
    this.ownerDocument = ownerDocument;
    this.data = data;
  }
  get textContent() { return this.data; }
  get length() { return this.data.length; }
}
class FakeElement {
  nodeType = 1;
  isConnected = true;
  parentElement: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  className = '';
  id = '';
  dir = '';
  width = 600;
  height = 800;
  computed: Record<string, string> = {};
  attributes: Record<string, string> = {};
  box: PdfHighlightBox = { left: 10, top: 20, width: 600, height: 800 };
  ownerDocument: FakeDocument;
  tagName: string;
  constructor(ownerDocument: FakeDocument, tagName: string) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get classList() {
    const classes = this.className.split(/\s+/).filter(Boolean);
    return { contains: (value: string) => classes.includes(value), length: classes.length };
  }
  append(...nodes: FakeNode[]) { nodes.forEach(node => { node.parentElement = this; this.childNodes.push(node); }); }
  contains(node: FakeNode): boolean { return node === this || this.childNodes.some(child => child === node || child instanceof FakeElement && child.contains(node)); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  getBoundingClientRect() { return this.box; }
}

function fixture() {
  const document = new FakeDocument(), page = new FakeElement(document, 'DIV'), canvas = new FakeElement(document, 'CANVAS');
  const layer = new FakeElement(document, 'DIV'), span = new FakeElement(document, 'SPAN'), end = new FakeElement(document, 'DIV');
  const node = new FakeText(document, 'Hello');
  layer.className = 'textLayer'; layer.attributes['data-main-rotation'] = '0';
  span.attributes.role = 'presentation'; span.dir = 'ltr'; span.append(node); end.className = 'endOfContent';
  layer.append(span, end); page.append(canvas, layer);
  const id = '00000000-0000-4000-8000-000000000001';
  const asset: CanonicalPdfAsset = { binding: { scope: { accountId: 'test', libraryId: id, epoch: 'test' }, pageId: id, backgroundRevision: id,
      resourceId: id, sourceRevision: 'a'.repeat(64), pdfPage: 1, widthPt: 600, heightPt: 800 }, url: 'blob:verified-pdf',
    metadata: { id, sha256: 'a'.repeat(64), mediaType: 'application/pdf', byteLength: 1, pdfPages: [{ widthPt: 600, heightPt: 800 }] } };
  const binding: CanonicalPdfTextBinding = {
    asset,
    renderToken: {}, pageElement: page as unknown as HTMLElement, textLayer: layer as unknown as HTMLElement,
    canvas: canvas as unknown as HTMLCanvasElement,
    naturalViewport: { ...natural, transform: [1, 0, 0, -1, 0, 800] },
    renderViewport: { ...natural, transform: [1, 0, 0, -1, 0, 800] }, drawnWidth: 600, pixelRatio: 1,
    textContent: { items: [{ str: 'Hello', dir: 'ltr', transform: [10, 0, 0, 10, 100, 590], width: 50, height: 10,
      fontName: 'test', hasEOL: false }], styles: { test: { fontFamily: 'sans-serif', vertical: false, ascent: .8, descent: -.2 } }, lang: null },
    isCurrent: () => current,
  };
  let current = true;
  const range = { collapsed: false, startContainer: node, endContainer: node, startOffset: 1, endOffset: 4,
    toString: () => node.data.slice(1, 4), intersectsNode: (value: FakeNode) => value === node } as unknown as Range;
  return { document, page, canvas, layer, span, end, node, binding, range, stale: () => { current = false; } };
}

test('partial selection captures actual Text-node rects in the canvas content box and creates no index', () => {
  const input = fixture();
  input.page.box = { left: 9, top: 19, width: 602, height: 802 }; // Desktop border must not shift the origin.
  const result = captureCanonicalPdfHighlight(input);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.capture.quote, 'ell');
  assert.deepEqual(result.capture.anchor, { x: 100, y: 200 });
  assert.deepEqual(result.capture.range, { kind: 'unindexed' });
  assert.deepEqual(pointSet(result.capture.quads[0]), [[100, 200], [100, 210], [130, 200], [130, 210]]);
  assert.equal(canonicalPdfHighlightCaptureProblem(result.capture, input.binding), null);
  const fixed = JSON.stringify(result.capture.quads);
  input.stale();
  assert.equal(canonicalPdfHighlightCaptureProblem(result.capture, input.binding), 'stale-render');
  assert.equal(JSON.stringify(result.capture.quads), fixed);
  assert.equal(canonicalPdfHighlightCaptureProblem(result.capture, { ...input.binding, renderToken: {} }), 'stale-render');
});

test('old tuples, fonts pending, item-map mismatches, unsupported item transforms, and UserUnit layout mismatches refuse', () => {
  const stale = fixture(); stale.stale();
  assert.deepEqual(captureCanonicalPdfHighlight(stale), { status: 'refused', reason: 'stale-render' });
  const fonts = fixture(); fonts.document.fonts.status = 'loading';
  assert.deepEqual(captureCanonicalPdfHighlight(fonts), { status: 'refused', reason: 'fonts-pending' });
  const mismatch = fixture(); mismatch.node.data = 'Other';
  assert.deepEqual(captureCanonicalPdfHighlight(mismatch), { status: 'refused', reason: 'item-map-mismatch' });
  const skew = fixture(); skew.span.computed.transform = 'matrix(1, 0.1, 0, 1, 0, 0)';
  assert.deepEqual(captureCanonicalPdfHighlight(skew), { status: 'refused', reason: 'unsupported-transform' });
  const userUnit = fixture(); userUnit.layer.box = { left: 10, top: 20, width: 300, height: 400 };
  assert.deepEqual(captureCanonicalPdfHighlight(userUnit), { status: 'refused', reason: 'layout-mismatch' });
  const changedDuringCapture = fixture(); changedDuringCapture.document.onMeasure = changedDuringCapture.stale;
  assert.deepEqual(captureCanonicalPdfHighlight(changedDuringCapture), { status: 'refused', reason: 'stale-render' });
});

test('surrogate boundaries and multiline item rects cannot produce partial geometry', () => {
  const unicode = fixture(); unicode.node.data = '😀';
  const item = unicode.binding.textContent.items[0];
  if ('str' in item) item.str = '😀';
  const range = { ...unicode.range, startContainer: unicode.node, endContainer: unicode.node,
    startOffset: 1, endOffset: 2, toString: () => '\ude00' } as unknown as Range;
  assert.deepEqual(captureCanonicalPdfHighlight({ ...unicode, range }), { status: 'refused', reason: 'unsupported-text-boundary' });
  const wrapped = fixture(); wrapped.node.rects.push({ left: 110, top: 240, width: 20, height: 10 });
  assert.deepEqual(captureCanonicalPdfHighlight(wrapped), { status: 'refused', reason: 'layout-mismatch' });
});

test('multiple lines/items, empty EOL items and known marked-content wrappers retain all selected quads', () => {
  const input = fixture();
  const br = new FakeElement(input.document, 'BR'); br.attributes.role = 'presentation';
  const wrapper = new FakeElement(input.document, 'SPAN'); wrapper.className = 'markedContent'; wrapper.id = 'mc1';
  const second = new FakeElement(input.document, 'SPAN'); second.attributes.role = 'presentation'; second.dir = 'ltr';
  const node = new FakeText(input.document, 'World'); node.rects = [{ left: 210, top: 320, width: 30, height: 10 }];
  second.append(node); wrapper.append(second);
  input.layer.childNodes = []; input.layer.append(input.span, br, wrapper, input.end);
  const first = input.binding.textContent.items[0];
  assert.ok('str' in first);
  input.binding.textContent.items = [first, { ...first, str: '', hasEOL: true }, { ...first, str: 'World' }];
  const range = { collapsed: false, startContainer: input.node, startOffset: 1, endContainer: node, endOffset: 3,
    intersectsNode: (value: FakeNode) => value === input.node || value === node, toString: () => 'elloWor' } as unknown as Range;
  const result = captureCanonicalPdfHighlight({ ...input, range });
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.equal(result.capture.quads.length, 2);
  // Include explicit markers as well: both callback formats must be validated.
  input.binding.textContent.items = [first, { ...first, str: '', hasEOL: true },
    { type: 'beginMarkedContentProps', id: 'mc1' }, { ...first, str: 'World' }, { type: 'endMarkedContent', id: '' }];
  assert.equal(captureCanonicalPdfHighlight({ ...input, range }).status, 'ready');
  wrapper.id = 'wrong-marker';
  assert.deepEqual(captureCanonicalPdfHighlight({ ...input, range }), { status: 'refused', reason: 'item-map-mismatch' });
  wrapper.id = 'mc1';
  const selectedSecond = input.binding.textContent.items[3];
  assert.ok('str' in selectedSecond);
  selectedSecond.transform = [0, 10, -10, 0, 0, 0];
  assert.deepEqual(captureCanonicalPdfHighlight({ ...input, range }), { status: 'refused', reason: 'unsupported-transform' });
});

test('a selection starting between text items cannot split a grapheme across their DOM nodes', () => {
  const input = fixture(); input.node.data = 'e';
  const first = input.binding.textContent.items[0];
  assert.ok('str' in first); first.str = 'e';
  const second = new FakeElement(input.document, 'SPAN'); second.attributes.role = 'presentation'; second.dir = 'ltr';
  const node = new FakeText(input.document, '\u0301X'); second.append(node);
  input.layer.childNodes = []; input.layer.append(input.span, second, input.end);
  input.binding.textContent.items = [first, { ...first, str: '\u0301X' }];
  const range = { collapsed: false, startContainer: node, startOffset: 0, endContainer: node, endOffset: 1,
    intersectsNode: (value: FakeNode) => value === node, toString: () => '\u0301' } as unknown as Range;
  assert.deepEqual(captureCanonicalPdfHighlight({ ...input, range }), { status: 'refused', reason: 'unsupported-text-boundary' });
});

function readyCapture(input: ReturnType<typeof fixture>) {
  const result = captureCanonicalPdfHighlight(input);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('fixture-capture-refused');
  return result.capture;
}

test('admission rejects the same text-layer element while its content is cleared or rebuilt with equal text', () => {
  const cleared = fixture(), clearedCapture = readyCapture(cleared);
  cleared.layer.childNodes = []; // react-pdf clears innerHTML before its asynchronous text render.
  assert.equal(canonicalPdfHighlightCaptureProblem(clearedCapture, cleared.binding), 'stale-render');
  const replaced = fixture(), replacedCapture = readyCapture(replaced);
  const replacement = new FakeText(replaced.document, replaced.node.data);
  replaced.span.childNodes = []; replaced.span.append(replacement);
  assert.equal(canonicalPdfHighlightCaptureProblem(replacedCapture, replaced.binding), 'stale-render');
  const replacedEnd = fixture(), replacedEndCapture = readyCapture(replacedEnd);
  const newEnd = new FakeElement(replacedEnd.document, 'DIV'); newEnd.className = 'endOfContent';
  replacedEnd.layer.childNodes = []; replacedEnd.layer.append(replacedEnd.span, newEnd);
  assert.equal(canonicalPdfHighlightCaptureProblem(replacedEndCapture, replacedEnd.binding), 'stale-render');
});

test('admission rejects changed node text and PDF item facts while preserving captured canonical geometry', () => {
  const changedText = fixture(), textCapture = readyCapture(changedText);
  const fixedGeometry = JSON.stringify(textCapture.quads);
  changedText.node.data = 'Jello';
  assert.equal(canonicalPdfHighlightCaptureProblem(textCapture, changedText.binding), 'stale-render');
  const firstTextItem = changedText.binding.textContent.items[0];
  assert.ok('str' in firstTextItem); firstTextItem.str = 'Jello'; // Updating both does not revive an old capture.
  assert.equal(canonicalPdfHighlightCaptureProblem(textCapture, changedText.binding), 'stale-render');
  assert.equal(JSON.stringify(textCapture.quads), fixedGeometry);
  const changedItem = fixture(), itemCapture = readyCapture(changedItem);
  const firstItem = changedItem.binding.textContent.items[0];
  assert.ok('str' in firstItem); firstItem.transform = [20, 0, 0, 10, 100, 590];
  assert.equal(canonicalPdfHighlightCaptureProblem(itemCapture, changedItem.binding), 'stale-render');
});

test('common intermediate rotation, skew and reflection wrappers are refused even when canvas/layer bounds coincide', () => {
  for (const transform of ['matrix(0, 1, -1, 0, 0, 0)', 'matrix(1, 0.2, 0, 1, 0, 0)', 'matrix(-1, 0, 0, 1, 0, 0)']) {
    const input = fixture(), capture = readyCapture(input);
    const wrapper = new FakeElement(input.document, 'DIV'); wrapper.computed.transform = transform;
    input.page.childNodes = []; wrapper.append(input.canvas, input.layer); input.page.append(wrapper);
    assert.deepEqual(input.canvas.box, input.layer.box);
    assert.deepEqual(captureCanonicalPdfHighlight(input), { status: 'refused', reason: 'unsupported-transform' });
    assert.equal(canonicalPdfHighlightCaptureProblem(capture, input.binding), 'unsupported-transform');
  }
});
