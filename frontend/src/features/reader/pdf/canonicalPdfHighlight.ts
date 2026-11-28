import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { Point } from '../../../runtime/edits/contracts.ts';
import { cleanPdfSelection } from '../../../lib/pdfSelection.ts';
import { assertCanonicalPdfResource, type CanonicalPdfAsset, type CanonicalPdfResourceBinding } from './canonicalPdfResource.ts';

export type PdfHighlightMatrix = readonly [number, number, number, number, number, number];
export type PdfHighlightViewport = Readonly<{
  width: number; height: number; rotation: number; scale: number; userUnit: number;
  transform: PdfHighlightMatrix;
}>;
export type PdfHighlightBox = Readonly<{ left: number; top: number; width: number; height: number }>;
export type PdfHighlightQuad = readonly [Readonly<Point>, Readonly<Point>, Readonly<Point>, Readonly<Point>];
export type CanonicalPdfHighlightRefusal = 'stale-render' | 'fonts-pending' | 'item-map-mismatch'
  | 'unsupported-transform' | 'unsupported-text-boundary' | 'layout-mismatch' | 'invalid-selection';

/** Ephemeral render evidence, never a persisted annotation or a commit authority. */
export type CanonicalPdfTextBinding = Readonly<{
  asset: CanonicalPdfAsset;
  renderToken: object;
  pageElement: HTMLElement;
  textLayer: HTMLElement;
  canvas: HTMLCanvasElement;
  textContent: TextContent;
  naturalViewport: PdfHighlightViewport;
  renderViewport: PdfHighlightViewport;
  drawnWidth: number;
  pixelRatio: number;
  isCurrent(): boolean;
}>;

export type CanonicalPdfHighlightCapture = Readonly<{
  source: CanonicalPdfResourceBinding;
  assetUrl: string;
  renderToken: object;
  pageId: string;
  backgroundRevision: string;
  quote: string;
  quads: readonly PdfHighlightQuad[];
  anchor: Readonly<Point>;
  range: Readonly<{ kind: 'unindexed' }>;
  /** Admission-only DOM proof. Like renderToken, never copy this into a draft,
   * journal, annotation, or commit guard after canonical geometry is admitted. */
  admissionEvidence: CanonicalPdfHighlightAdmissionEvidence;
}>;
export type CanonicalPdfHighlightResult = Readonly<{ status: 'ready'; capture: CanonicalPdfHighlightCapture }>
  | Readonly<{ status: 'refused'; reason: CanonicalPdfHighlightRefusal }>;

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const quarterTurn = (value: number) => Number.isFinite(value) && value % 90 === 0;
const close = (left: number, right: number, tolerance = .001) => Math.abs(left - right) <= tolerance;
const boxOf = (element: Element): PdfHighlightBox => {
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
};
const validBox = (box: PdfHighlightBox) => [box.left, box.top].every(Number.isFinite)
  && [box.width, box.height].every(finitePositive);
const normalizedRotation = (rotation: number) => ((rotation % 360) + 360) % 360;

function axisMatrix(matrix: readonly number[]): boolean {
  if (matrix.length !== 6 || !matrix.every(Number.isFinite)) return false;
  const [a, b, c, d] = matrix;
  // Both PDF viewport reflections and their quarter rotations are expected here.
  return (a !== 0 && d !== 0 && b === 0 && c === 0) || (b !== 0 && c !== 0 && a === 0 && d === 0);
}

/** Transform an actual client rect through the rendered PDF viewport to the same
 * natural viewport used by canonical capture. cssWidth/Height are the canvas's
 * actual CSS dimensions; backing-store DPR is deliberately absent from this map.
 * No bounds clamping or arbitrary-angle bounding-box approximation is performed. */
export function mapCanonicalPdfHighlightRect({ rect, canvasBox, cssWidth, cssHeight, natural, rendered }: {
  rect: PdfHighlightBox; canvasBox: PdfHighlightBox; cssWidth: number; cssHeight: number;
  natural: PdfHighlightViewport; rendered: PdfHighlightViewport;
}): PdfHighlightQuad | null {
  if (!validBox(rect) || !validBox(canvasBox) || ![cssWidth, cssHeight, natural.width, natural.height,
    rendered.width, rendered.height, natural.scale, rendered.scale, natural.userUnit, rendered.userUnit].every(finitePositive)
    || !quarterTurn(natural.rotation) || !quarterTurn(rendered.rotation)
    || !axisMatrix(natural.transform) || !axisMatrix(rendered.transform)) return null;
  const [a, b, c, d, e, f] = rendered.transform;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) return null;
  const [na, nb, nc, nd, ne, nf] = natural.transform;
  const corners = [[rect.left, rect.top], [rect.left + rect.width, rect.top],
    [rect.left + rect.width, rect.top + rect.height], [rect.left, rect.top + rect.height]];
  const points = corners.map(([clientX, clientY]) => {
    const x = (clientX - canvasBox.left) * cssWidth / canvasBox.width;
    const y = (clientY - canvasBox.top) * cssHeight / canvasBox.height;
    const pdfX = (d * (x - e) - c * (y - f)) / determinant;
    const pdfY = (-b * (x - e) + a * (y - f)) / determinant;
    return Object.freeze({ x: na * pdfX + nc * pdfY + ne, y: nb * pdfX + nd * pdfY + nf });
  });
  if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.y < 0 || point.x > natural.width || point.y > natural.height)) return null;
  return Object.freeze(points) as unknown as PdfHighlightQuad;
}

/** Intl.Segmenter is required; code-point boundaries alone cannot prove grapheme safety. */
export function isCanonicalPdfTextBoundary(text: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) return false;
  }
  type Segmenter = { segment(value: string): Iterable<{ index: number }> };
  const Constructor = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => Segmenter }).Segmenter;
  if (!Constructor) return false;
  if (offset === text.length) return true;
  for (const segment of new Constructor(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (segment.index === offset) return true;
  }
  return false;
}

type MappedItem = { item: TextItem; element: HTMLElement; node: Text; textOffset: number };
type ItemMap = { entries: MappedItem[]; text: string; structure: DomToken[]; endOfContent: HTMLElement };
type DomToken = { kind: 'text'; element: HTMLElement; node: Text } | { kind: 'break'; element: HTMLElement }
  | { kind: 'begin'; id: string; element: HTMLElement } | { kind: 'end'; element: HTMLElement };
export type CanonicalPdfHighlightAdmissionEvidence = Readonly<{
  textContentSnapshot: string;
  entries: readonly Readonly<{ element: HTMLElement; node: Text; text: string; textOffset: number }>[];
  structure: readonly Readonly<DomToken>[];
  endOfContent: HTMLElement;
  selectedNodes: readonly Text[];
}>;

function contentSnapshot(content: TextContent): string {
  return JSON.stringify({ items: content.items, styles: content.styles, lang: content.lang });
}

function sameStructure(left: readonly Readonly<DomToken>[], right: readonly DomToken[]): boolean {
  return left.length === right.length && left.every((token, index) => {
    const other = right[index];
    return token.kind === other.kind && token.element === other.element
      && (token.kind !== 'begin' || other.kind === 'begin' && token.id === other.id)
      && (token.kind !== 'text' || other.kind === 'text' && token.node === other.node);
  });
}

function matchesEvidence(evidence: CanonicalPdfHighlightAdmissionEvidence, mapping: ItemMap, content: TextContent): boolean {
  return evidence.textContentSnapshot === contentSnapshot(content) && evidence.endOfContent === mapping.endOfContent
    && sameStructure(evidence.structure, mapping.structure) && evidence.entries.length === mapping.entries.length
    && evidence.entries.every((entry, index) => {
      const current = mapping.entries[index];
      return entry.element === current.element && entry.node === current.node && entry.text === current.node.data
        && entry.textOffset === current.textOffset;
    });
}

/** react-pdf's onGetTextSuccess normally omits marked-content records while its
 * renderer streams them. Only known wrappers may be flattened in that case. If
 * the caller supplies marked records, their nesting and IDs must match as well. */
function mapTextItems(layer: HTMLElement, content: TextContent): ItemMap | null {
  const tokens: DomToken[] = [];
  let valid = true, endOfContent: HTMLElement | null = null;
  const walk = (parent: HTMLElement) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType !== 1) { valid = false; return; }
      const element = child as HTMLElement;
      if (element.tagName === 'DIV' && element.className === 'endOfContent' && parent === layer
        && !element.childNodes.length && child === layer.lastChild && !endOfContent) { endOfContent = element; continue; }
      if (element.tagName === 'SPAN' && element.classList.contains('markedContent')
        && element.classList.length === 1 && element.getAttribute('role') === null) {
        tokens.push({ kind: 'begin', id: element.id, element }); walk(element); tokens.push({ kind: 'end', element }); continue;
      }
      if (element.tagName === 'BR' && element.getAttribute('role') === 'presentation' && !element.childNodes.length) {
        tokens.push({ kind: 'break', element }); continue;
      }
      if (element.tagName !== 'SPAN' || element.getAttribute('role') !== 'presentation' || element.childNodes.length !== 1
        || element.firstChild?.nodeType !== 3 || !element.firstChild.textContent) { valid = false; return; }
      tokens.push({ kind: 'text', element, node: element.firstChild as Text });
    }
  };
  walk(layer);
  if (!valid || !endOfContent) return null;
  const withMarkers = content.items.some(item => !('str' in item));
  const actual = withMarkers ? tokens : tokens.filter(token => token.kind !== 'begin' && token.kind !== 'end');
  const entries: MappedItem[] = [];
  let cursor = 0, depth = 0, text = '';
  for (const item of content.items) {
    if (!('str' in item)) {
      const token = actual[cursor++];
      if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
        if (token?.kind !== 'begin' || token.id !== (item.id || '')) return null;
        depth++;
      } else if (item.type === 'endMarkedContent') {
        if (token?.kind !== 'end' || --depth < 0) return null;
      } else return null;
      continue;
    }
    if (item.str !== '') {
      const token = actual[cursor++];
      if (token?.kind !== 'text' || token.node.data !== item.str || token.element.dir !== item.dir) return null;
      entries.push({ item, element: token.element, node: token.node, textOffset: text.length });
      text += item.str;
    }
    if (item.hasEOL) {
      if (actual[cursor++]?.kind !== 'break') return null;
      text += '\n';
    }
  }
  return cursor === actual.length && depth === 0 ? { entries, text, structure: tokens, endOfContent } : null;
}

function supportedItem(item: TextItem, content: TextContent): boolean {
  const matrix: unknown[] = item.transform;
  return item.dir === 'ltr' && content.styles[item.fontName]?.vertical === false
    && matrix.length === 6 && matrix.every(value => typeof value === 'number' && Number.isFinite(value))
    && Number(matrix[0]) > 0 && Number(matrix[3]) > 0 && matrix[1] === 0 && matrix[2] === 0
    && Number.isFinite(item.width) && item.width >= 0 && Number.isFinite(item.height) && item.height > 0
    // An LTR item can still contain bidi runs or controls; the first slice refuses them.
    && !/[\r\n\u0590-\u08ff\u200e\u200f\u202a-\u202e\u2066-\u2069\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1eeff}]/u.test(item.str);
}

/** Only the text layer itself may have PDF.js's known quarter-turn rotation.
 * Ancestors and items may have positive scale/translate, never skew/reflection. */
function supportedCss(element: HTMLElement, layerRotation: number | null): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  if (style.perspective !== 'none' || (style.rotate && style.rotate !== 'none')
    || (style.offsetPath && style.offsetPath !== 'none') || style.writingMode !== 'horizontal-tb') return false;
  if (style.scale && style.scale !== 'none') {
    const scales = style.scale.trim().split(/\s+/).map(Number);
    if (!scales.length || scales.length > 2 || !scales.every(finitePositive)) return false;
  }
  if (style.translate && style.translate !== 'none' && style.translate.trim().split(/\s+/).length > 2) return false;
  if (style.transform === 'none') return layerRotation === null || normalizedRotation(layerRotation) === 0;
  // Computed matrices are used only to establish supported axes, never font layout.
  const match = /^matrix\(([^)]+)\)$/.exec(style.transform);
  if (!match) return false;
  const values = match[1].split(',').map(Number);
  if (values.length !== 6 || !values.every(Number.isFinite)) return false;
  const [a, b, c, d] = values, epsilon = 1e-8;
  if (layerRotation === null || normalizedRotation(layerRotation) === 0)
    return a > 0 && d > 0 && Math.abs(b) <= epsilon && Math.abs(c) <= epsilon;
  switch (normalizedRotation(layerRotation)) {
    case 90: return Math.abs(a) <= epsilon && Math.abs(d) <= epsilon && b > 0 && c < 0;
    case 180: return a < 0 && d < 0 && Math.abs(b) <= epsilon && Math.abs(c) <= epsilon;
    case 270: return Math.abs(a) <= epsilon && Math.abs(d) <= epsilon && b < 0 && c > 0;
    default: return false;
  }
}

function bindingProblem(binding: CanonicalPdfTextBinding): CanonicalPdfHighlightRefusal | null {
  if (!binding.isCurrent() || !binding.pageElement.isConnected || !binding.textLayer.isConnected || !binding.canvas.isConnected
    || !binding.pageElement.contains(binding.textLayer) || !binding.pageElement.contains(binding.canvas)
    || binding.pageElement.ownerDocument !== binding.textLayer.ownerDocument) return 'stale-render';
  const fonts = binding.textLayer.ownerDocument.fonts;
  if (!fonts || fonts.status !== 'loaded') return 'fonts-pending';
  const { asset, naturalViewport: natural, renderViewport: rendered } = binding;
  const source = asset.binding, metadata = asset.metadata;
  try { assertCanonicalPdfResource(source, metadata, metadata.byteLength); }
  catch { return 'layout-mismatch'; }
  if (!asset.url || !close(natural.width, source.widthPt) || !close(natural.height, source.heightPt)
    || !finitePositive(binding.pixelRatio) || !close(rendered.width, binding.drawnWidth)) return 'layout-mismatch';
  if (!quarterTurn(natural.rotation) || !quarterTurn(rendered.rotation)
    || !axisMatrix(natural.transform) || !axisMatrix(rendered.transform)) return 'unsupported-transform';
  const layerRotation = binding.textLayer.getAttribute('data-main-rotation');
  if (!binding.textLayer.classList.contains('textLayer') || layerRotation === null || !quarterTurn(Number(layerRotation))
    || normalizedRotation(Number(layerRotation)) !== normalizedRotation(rendered.rotation)) return 'layout-mismatch';
  for (let element: HTMLElement | null = binding.pageElement; element; element = element.parentElement) {
    if (!supportedCss(element, null)) return 'unsupported-transform';
  }
  if (!supportedCss(binding.canvas, null) || !supportedCss(binding.textLayer, rendered.rotation)) return 'unsupported-transform';
  // contains() also admits intermediate wrappers. Check every one so identical
  // rotated/skewed/reflected canvas+layer bounds cannot conceal information loss.
  for (const child of [binding.canvas, binding.textLayer]) {
    for (let element = child.parentElement; element && element !== binding.pageElement; element = element.parentElement) {
      if (!supportedCss(element, null)) return 'unsupported-transform';
    }
  }
  return null;
}

type Layout = { canvasBox: PdfHighlightBox; textBox: PdfHighlightBox; cssWidth: number; cssHeight: number };
function measuredLayout(binding: CanonicalPdfTextBinding): Layout | null {
  const view = binding.canvas.ownerDocument.defaultView;
  if (!view) return null;
  const canvasStyle = view.getComputedStyle(binding.canvas), textStyle = view.getComputedStyle(binding.textLayer);
  if (canvasStyle.visibility !== 'visible' || textStyle.visibility !== 'visible'
    || canvasStyle.display === 'none' || textStyle.display === 'none') return null;
  for (const style of [canvasStyle, textStyle]) {
    if (![style.borderLeftWidth, style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth,
      style.paddingLeft, style.paddingTop, style.paddingRight, style.paddingBottom].every(value => parseFloat(value) === 0)) return null;
  }
  const cssWidth = parseFloat(canvasStyle.width), cssHeight = parseFloat(canvasStyle.height);
  const canvasBox = boxOf(binding.canvas), textBox = boxOf(binding.textLayer), viewport = binding.renderViewport;
  if (!validBox(canvasBox) || !validBox(textBox) || ![cssWidth, cssHeight].every(finitePositive)
    || !close(cssWidth, Math.floor(viewport.width), .01) || !close(cssHeight, Math.floor(viewport.height), .01)
    || !close(binding.canvas.width, Math.floor(viewport.width * binding.pixelRatio), 1)
    || !close(binding.canvas.height, Math.floor(viewport.height * binding.pixelRatio), 1)) return null;
  const scaleX = canvasBox.width / cssWidth, scaleY = canvasBox.height / cssHeight;
  // The actual layer must coincide with the canvas, including on UserUnit PDFs.
  // The renderer corrects the scale before publication; never repair a mismatch here.
  if (!close(canvasBox.left, textBox.left, .05 * scaleX) || !close(canvasBox.top, textBox.top, .05 * scaleY)
    || !close(canvasBox.width, textBox.width, 1.05 * scaleX) || !close(canvasBox.height, textBox.height, 1.05 * scaleY)) return null;
  return { canvasBox, textBox, cssWidth, cssHeight };
}

function sameLayout(left: Layout, right: Layout): boolean {
  return left.cssWidth === right.cssWidth && left.cssHeight === right.cssHeight
    && (['left', 'top', 'width', 'height'] as const).every(key => close(left.canvasBox[key], right.canvasBox[key], .001)
      && close(left.textBox[key], right.textBox[key], .001));
}

function sameSource(left: CanonicalPdfResourceBinding, right: CanonicalPdfResourceBinding): boolean {
  return left.scope.accountId === right.scope.accountId && left.scope.libraryId === right.scope.libraryId && left.scope.epoch === right.scope.epoch
    && left.pageId === right.pageId && left.backgroundRevision === right.backgroundRevision && left.resourceId === right.resourceId
    && left.sourceRevision === right.sourceRevision && left.pdfPage === right.pdfPage
    && left.widthPt === right.widthPt && left.heightPt === right.heightPt;
}

/** Recheck only between capture and draft admission. Once admitted, the session
 * owns the fixed geometry; resize/font changes must not become commit guards. */
export function canonicalPdfHighlightCaptureProblem(capture: CanonicalPdfHighlightCapture,
  binding: CanonicalPdfTextBinding): CanonicalPdfHighlightRefusal | null {
  try {
    if (capture.renderToken !== binding.renderToken || capture.assetUrl !== binding.asset.url
      || !sameSource(capture.source, binding.asset.binding)) return 'stale-render';
    const problem = bindingProblem(binding);
    if (problem) return problem;
    const mapping = mapTextItems(binding.textLayer, binding.textContent);
    if (!mapping || !matchesEvidence(capture.admissionEvidence, mapping, binding.textContent)) return 'stale-render';
    for (const node of capture.admissionEvidence.selectedNodes) {
      const entry = mapping.entries.find(current => current.node === node);
      if (!entry || !supportedItem(entry.item, binding.textContent)) return 'stale-render';
      for (let element: HTMLElement | null = entry.element; element && element !== binding.textLayer; element = element.parentElement) {
        if (!supportedCss(element, null)) return 'unsupported-transform';
      }
    }
    return measuredLayout(binding) ? null : 'layout-mismatch';
  } catch {
    return 'stale-render';
  }
}

/** Captures displayed DOM selection regions, not recovered PDF glyph outlines.
 * All selected items must succeed; this function never returns partial geometry. */
export function captureCanonicalPdfHighlight({ range, binding }: {
  range: Range; binding: CanonicalPdfTextBinding;
}): CanonicalPdfHighlightResult {
  const refused = (reason: CanonicalPdfHighlightRefusal): CanonicalPdfHighlightResult => ({ status: 'refused', reason });
  try {
    const problem = bindingProblem(binding);
    if (problem) return refused(problem);
    const layer = binding.textLayer;
    if (range.collapsed || !layer.contains(range.startContainer) || !layer.contains(range.endContainer)
      || range.startContainer.ownerDocument !== layer.ownerDocument || range.endContainer.ownerDocument !== layer.ownerDocument)
      return refused('invalid-selection');
    const quote = cleanPdfSelection(range.toString());
    if (!quote) return refused('invalid-selection');
    const mapping = mapTextItems(layer, binding.textContent);
    if (!mapping) return refused('item-map-mismatch');
    const textContentSnapshot = contentSnapshot(binding.textContent);
    const layout = measuredLayout(binding);
    if (!layout) return refused('layout-mismatch');
    const quads: PdfHighlightQuad[] = [];
    const selectedNodes: Text[] = [];
    let selectionStart: number | null = null, selectionEnd = 0;
    for (const entry of mapping.entries) {
      if (!range.intersectsNode(entry.node)) continue;
      const start = range.startContainer === entry.node ? range.startOffset : 0;
      const end = range.endContainer === entry.node ? range.endOffset : entry.node.length;
      if (start === end) continue;
      if (start < 0 || end > entry.node.length || start > end) return refused('invalid-selection');
      if (!supportedItem(entry.item, binding.textContent)) return refused('unsupported-transform');
      for (let element: HTMLElement | null = entry.element; element && element !== layer; element = element.parentElement) {
        if (!supportedCss(element, null)) return refused('unsupported-transform');
      }
      if (selectionStart === null) selectionStart = entry.textOffset + start;
      selectionEnd = entry.textOffset + end;
      const subrange = layer.ownerDocument.createRange();
      subrange.setStart(entry.node, start); subrange.setEnd(entry.node, end);
      const rects = Array.from(subrange.getClientRects());
      // A supported item is one non-wrapping horizontal line. Zero/multiple rects
      // cannot be replaced by a parent border rect or a character-width estimate.
      if (rects.length !== 1) return refused('layout-mismatch');
      const rect = rects[0];
      const quad = mapCanonicalPdfHighlightRect({ rect, ...layout, natural: binding.naturalViewport, rendered: binding.renderViewport });
      if (!quad) return refused('layout-mismatch');
      quads.push(quad);
      selectedNodes.push(entry.node);
    }
    if (selectionStart === null || !quads.length) return refused('invalid-selection');
    if (!isCanonicalPdfTextBoundary(mapping.text, selectionStart) || !isCanonicalPdfTextBoundary(mapping.text, selectionEnd))
      return refused('unsupported-text-boundary');
    const finalProblem = bindingProblem(binding);
    if (finalProblem) return refused(finalProblem);
    const finalLayout = measuredLayout(binding);
    const finalMapping = mapTextItems(layer, binding.textContent);
    if (!finalLayout || !sameLayout(layout, finalLayout)) return refused('stale-render');
    if (!finalMapping || finalMapping.text !== mapping.text || finalMapping.entries.length !== mapping.entries.length
      || finalMapping.entries.some((entry, index) => entry.node !== mapping.entries[index].node)
      || finalMapping.endOfContent !== mapping.endOfContent || !sameStructure(mapping.structure, finalMapping.structure)
      || textContentSnapshot !== contentSnapshot(binding.textContent)) return refused('item-map-mismatch');
    const source = Object.freeze({ ...binding.asset.binding, scope: Object.freeze({ ...binding.asset.binding.scope }) });
    const first = quads[0];
    const anchor = Object.freeze({ x: Math.min(...first.map(point => point.x)), y: Math.min(...first.map(point => point.y)) });
    const admissionEvidence: CanonicalPdfHighlightAdmissionEvidence = Object.freeze({ textContentSnapshot,
      entries: Object.freeze(mapping.entries.map(entry => Object.freeze({ element: entry.element, node: entry.node,
        text: entry.node.data, textOffset: entry.textOffset }))),
      structure: Object.freeze(mapping.structure.map(token => Object.freeze({ ...token }))),
      endOfContent: mapping.endOfContent, selectedNodes: Object.freeze(selectedNodes) });
    const capture: CanonicalPdfHighlightCapture = Object.freeze({ source, assetUrl: binding.asset.url, renderToken: binding.renderToken,
      pageId: source.pageId, backgroundRevision: source.backgroundRevision, quote, quads: Object.freeze(quads), anchor,
      range: Object.freeze({ kind: 'unindexed' as const }), admissionEvidence });
    return { status: 'ready', capture };
  } catch {
    return refused('invalid-selection');
  }
}
