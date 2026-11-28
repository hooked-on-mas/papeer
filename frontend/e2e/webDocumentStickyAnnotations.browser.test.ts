import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import type { Page as BrowserPage } from 'playwright-core';
import type { ContentPublication, DocumentEditBatch, DocumentSnapshot, EditBatch, EditRecord, LibraryEditBatch, Page, PageAnnotation, PageEditBatch, ResourceMetadata, StickyNote } from '../src/runtime/edits/contracts.ts';
import type { RepositoryState } from '../src/runtime/edits/ports.ts';
import type { DocumentEditState } from '../src/features/reader/edit/DocumentEditSession.ts';
import type { ScopeLeaveResult } from '../src/features/reader/DocumentEditSessions.ts';
import type { AnnotationBrowserState } from '../src/features/library/annotations/AnnotationBrowserSession.ts';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { applyBatch } from '../src/runtime/edits/editModel.ts';
import { pageExpectation } from '../src/runtime/edits/documentPages.ts';
import { deleteLibraryItems } from '../src/features/library/canonicalLibraryOperations.ts';
import { openComposition, sync as deliver } from './support/documentComposition.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';

// Exercise the production bindings, pointer admission and form facade. The only
// window calls observe state, control real port timing or the actual host lifecycle.
const metadata = (JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8')) as {
  resource: { metadata: ResourceMetadata };
}).resource.metadata;
type Observed = { state: RepositoryState; document?: DocumentEditState; pending: unknown[];
  replication: { running: boolean }; leave: ScopeLeaveResult };
const observe = async (page: BrowserPage, id: string): Promise<Observed> => {
  await page.waitForFunction(() => typeof (window as unknown as { compositionObservedEvidence?: unknown }).compositionObservedEvidence === 'function');
  return page.evaluate(id => (window as unknown as { compositionObservedEvidence(id: string): Promise<Observed> }).compositionObservedEvidence(id), id);
};
// Same single actual repository read as the fixture's Node proxy, on the authoring host.
// No refresh/pending/leave observation, delivery, receipt injection or direct writer.
const readOn = (page: BrowserPage, id: string): Promise<RepositoryState> => page.evaluate(id =>
  (window as unknown as { compositionRepository(method: 'read', args: [string]): Promise<RepositoryState> })
    .compositionRepository('read', [id]), id);
const form = (page: BrowserPage) => page.getByRole('region', { name: '注釈を編集', exact: true });
const browser = (page: BrowserPage) => page.getByRole('region', { name: '付箋・ハイライト一覧', exact: true });
const placement = (page: BrowserPage) => page.getByLabel('注釈の配置と選択', { exact: true });
const allPages = (document: DocumentSnapshot) => [...document.pages, ...(document.translation?.pages ?? []), ...document.deletedPages];
// Peer import/upload acknowledgments may advance during ordinary sync. Preserve
// every canonical field and every receipt identity/durability/count while
// excluding only those two changing delivery-state fields.
const canonicalState = ({ receipts, ...state }: RepositoryState) => ({ ...state,
  receipts: receipts.map(({ id, targetId, durable }) => ({ id, targetId, durable })).sort((left, right) => left.id.localeCompare(right.id)) });
const pageById = (document: DocumentSnapshot, id: string) => {
  const value = allPages(document).find(value => value.id === id); assert.ok(value); return value;
};
function annotationById<T extends PageAnnotation['kind']>(document: DocumentSnapshot, id: string, kind: T): Extract<PageAnnotation, { kind: T }> {
  const value = allPages(document).flatMap(page => page.annotations).find(value => value.id === id);
  assert.ok(value?.kind === kind); return value as Extract<PageAnnotation, { kind: T }>;
}
async function idle(page: BrowserPage, id: string) {
  return waitForSnapshot(() => observe(page, id), durableIdle);
}
function durableIdle(value: Observed): boolean {
  const state = value.document, document = state?.document;
  return !!state?.ready && state.phase === 'idle' && !state.inputActive && !!document
    && isDeepStrictEqual(new EditGraph(value.state.checkpoint).snapshot(document.version), document);
}
async function changed(page: BrowserPage, id: string, before: Observed) {
  const after = await waitForSnapshot(() => observe(page, id), value => durableIdle(value)
    && value.document!.document!.version !== before.document!.document!.version && value.state.history.length === before.state.history.length + 1);
  assert.equal(after.state.history.length, before.state.history.length + 1, 'a form confirmation creates exactly one durable history record');
  return after.document!.document!;
}
// Keep every unrelated property, including geometry, timestamps, quote, null
// colors and collection identity in the comparison; normalize only the two
// versions that any successful page batch is required to advance.
function assertOnlyAnnotation(before: DocumentSnapshot, after: DocumentSnapshot, pageId: string, annotationId: string) {
  const normalized = structuredClone(after); normalized.version = before.version;
  const oldPage = pageById(before, pageId), newPage = pageById(normalized, pageId);
  newPage.annotationVersion = oldPage.annotationVersion;
  newPage.annotations = newPage.annotations.filter(value => value.id !== annotationId);
  const expected = structuredClone(before);
  pageById(expected, pageId).annotations = oldPage.annotations.filter(value => value.id !== annotationId);
  assert.deepEqual(normalized, expected, 'the entire document outside the selected annotation stays exact');
}
function mixed(page: Page): Page {
  page.annotations = [
    { kind: 'ink', id: crypto.randomUUID(), geometry: { kind: 'arrow', start: { x: 0, y: 0 }, end: { x: 85, y: 25 },
      head: 'both', headLengthPt: 12, preferredHeadLengthPt: 17 },
      transform: { x: 35, y: 80, rotationRad: .17, scaleX: 1.3, scaleY: .7 },
      style: { color: '#345678', widthPt: 3.25, opacity: .61, highlighter: false } },
    { kind: 'sticky', id: crypto.randomUUID(), text: 'Existing null color sticky', anchor: { x: 170, y: 190 }, color: null,
      quote: 'Exact source quote\nsecond line', metadata: { label: 'preserved-label', createdAt: '2026-10-27T01:02:03.000123Z' } },
    { kind: 'highlight', id: crypto.randomUUID(), backgroundRevision: page.backgroundRevision, range: { kind: 'indexed', start: 7, end: 31 },
      quote: 'Exact highlighted quote', text: 'Existing highlight comment', anchor: { x: 70, y: 290 }, color: '#facc15',
      quads: [[{ x: 60, y: 260 }, { x: 200, y: 260 }, { x: 200, y: 275 }, { x: 60, y: 275 }]],
      metadata: { label: 'highlight-label', createdAt: null } },
  ]; return page;
}
function pdfPage(physical: number): Page {
  const version = crypto.randomUUID();
  return mixed({ id: crypto.randomUUID(), backgroundRevision: version, lifecycleVersion: version, annotationVersion: version,
    ...metadata.pdfPages![physical - 1], background: { kind: 'pdf', resourceId: metadata.id, sourceRevision: metadata.sha256, pdfPage: physical }, annotations: [] });
}
function pdfDocument(): DocumentSnapshot {
  const original = pdfPage(1), translated = pdfPage(2);
  return { kind: 'document', id: crypto.randomUUID(), version: crypto.randomUUID(), pages: [original, pdfPage(3)], deletedPages: [],
    translation: { revision: crypto.randomUUID(), pages: [translated], bindings: [{
      original: { pageId: original.id, backgroundRevision: original.backgroundRevision },
      candidates: [{ pageId: translated.id, backgroundRevision: translated.backgroundRevision }],
    }] } };
}
function paperDocument(): DocumentSnapshot {
  const version = crypto.randomUUID();
  return { kind: 'document', id: crypto.randomUUID(), version: crypto.randomUUID(), pages: [mixed({ id: crypto.randomUUID(),
    backgroundRevision: version, lifecycleVersion: version, annotationVersion: version, widthPt: 595, heightPt: 842,
    background: { kind: 'paper', spec: { template: 'grid5', color: 'cream' } }, annotations: [] })], deletedPages: [] };
}
async function openItem(page: BrowserPage, title: string, id: string) {
  const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.locator(`[data-content-document="${id}"]`).waitFor(); await idle(page, id);
}
type AnnotationPaintTuple = { documentId: string; surface: string; pageId: string; backgroundRevision: string;
  kind: 'paper' | 'pdf'; physicalPage: number | null; widthPt: number; heightPt: number };
const readAnnotationPaint = (page: BrowserPage, expected: Partial<AnnotationPaintTuple> | null, placing: boolean) => page.evaluate(({ expected, placing }) => {
  const rootId = document.querySelector('[data-content-document]')?.getAttribute('data-content-document');
  const active = document.querySelector('[data-reader-surface][data-active-surface="true"]');
  const surface = active?.getAttribute('data-reader-surface');
  const canonical = active?.querySelector('[data-canonical-page], [data-paper-page]');
  const pageId = canonical?.getAttribute('data-canonical-page') ?? canonical?.getAttribute('data-paper-page');
  const host = (window as unknown as { compositionBootstrapStatus?: () => { state: { phase: string; locked: boolean } } }).compositionBootstrapStatus?.();
  const hostReady = host?.state.phase === 'ready' && host.state.locked === false;
  const navigation = hostReady ? (window as unknown as { compositionNavigationEvidence?: () => { documentId: string | null; document?: DocumentEditState } }).compositionNavigationEvidence?.() : undefined;
  const model = navigation?.document?.document;
  const collection = surface === 'translated' ? model?.translation?.pages : model?.pages;
  const source = collection?.find(value => value.id === pageId);
  const tuple: AnnotationPaintTuple | null = rootId && surface && pageId && source && model?.id === rootId && navigation?.documentId === rootId
    ? { documentId: rootId, surface, pageId, backgroundRevision: source.backgroundRevision, kind: source.background.kind,
      physicalPage: source.background.kind === 'pdf' ? source.background.pdfPage : null, widthPt: source.widthPt, heightPt: source.heightPt } : null;
  const layer = canonical?.querySelector<HTMLElement>('[data-annotation-layer]');
  const actualSurface = canonical?.matches('[data-paper-page]') ? canonical : canonical?.querySelector('[data-pdf-surface]');
  const layerBox = layer?.getBoundingClientRect(), surfaceBox = actualSurface?.getBoundingClientRect();
  const box = layerBox ? { x: layerBox.x, y: layerBox.y, width: layerBox.width, height: layerBox.height } : null;
  const marker = canonical?.querySelector('[data-pdf-scroller][data-rendered]');
  const physical = canonical?.querySelector('.react-pdf__Page');
  const canvas = physical?.querySelector<HTMLCanvasElement>('.react-pdf__Page__canvas');
  const canvasBox = canvas?.getBoundingClientRect();
  const pointerEvents = layer ? getComputedStyle(layer).pointerEvents : null;
  const mode = [...document.querySelectorAll('button')].some(value => ['付箋を貼る', '注釈の位置を変更'].includes(value.textContent?.trim() ?? '') && value.getAttribute('aria-pressed') === 'true');
  const reasons: string[] = [];
  if (!hostReady) reasons.push('host-admission-pending');
  if (!tuple) reasons.push('active-canonical-model-unavailable');
  if (tuple && expected && Object.entries(expected).some(([key, value]) => tuple[key as keyof AnnotationPaintTuple] !== value)) reasons.push('active-tuple-mismatch');
  if (!layer?.isConnected || layer.closest('[data-reader-surface]') !== active || layer.closest('[data-canonical-page], [data-paper-page]') !== canonical) reasons.push('current-layer-disconnected');
  if (!box || !surfaceBox || box.width <= 0 || box.height <= 0 || Math.abs(box.x - surfaceBox.x) > 1 || Math.abs(box.y - surfaceBox.y) > 1
    || Math.abs(box.width - surfaceBox.width) > 1 || Math.abs(box.height - surfaceBox.height) > 1) reasons.push('current-layer-dimensions');
  if (tuple && surfaceBox && Math.abs(surfaceBox.height / surfaceBox.width - tuple.heightPt / tuple.widthPt) > .002) reasons.push('canonical-page-ratio');
  if (tuple?.kind === 'pdf') {
    if (canonical?.getAttribute('data-background-revision') !== tuple.backgroundRevision) reasons.push('background-mismatch');
    if (marker?.getAttribute('data-rendered') !== 'true') reasons.push('current-raster-pending');
    if (physical?.getAttribute('data-page-number') !== String(tuple.physicalPage)) reasons.push('physical-page-mismatch');
    if (!canvas?.isConnected || canvas.width <= 0 || canvas.height <= 0 || !canvasBox || !surfaceBox
      || Math.abs(canvasBox.width - surfaceBox.width) > 1 || Math.abs(canvasBox.height - surfaceBox.height) > 1) reasons.push('current-canvas-dimensions');
  } else if (tuple && canonical?.getAttribute('data-paper-page') !== tuple.pageId) reasons.push('paper-page-mismatch');
  if (placing && (!mode || pointerEvents !== 'auto')) reasons.push('placement-input-unavailable');
  return { tuple, ready: reasons.length === 0, reasons, box, pointerEvents, mode,
    rendered: marker?.getAttribute('data-rendered'), physicalPage: physical?.getAttribute('data-page-number'),
    canvas: canvas ? { width: canvas.width, height: canvas.height, cssWidth: canvasBox?.width, cssHeight: canvasBox?.height } : null };
}, { expected, placing });
async function rendered(page: BrowserPage, target: Page) {
  await waitForSnapshot(async () => {
    // Candidate/banner layout must reach ResizeObserver before an earlier
    // raster marker can qualify. Animation frames share this same 25s budget.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    return readAnnotationPaint(page, { pageId: target.id, backgroundRevision: target.backgroundRevision,
      kind: target.background.kind, physicalPage: target.background.kind === 'pdf' ? target.background.pdfPage : null,
      widthPt: target.widthPt, heightPt: target.heightPt }, false);
  }, value => value.ready);
}
async function point(page: BrowserPage, x: number, y: number) {
  const captured = await readAnnotationPaint(page, null, false); assert.ok(captured.tuple, 'pointer input requires one current active canonical tuple');
  const tuple = captured.tuple;
  await placement(page).scrollIntoViewIfNeeded();
  // A form/status row changes the available fit-page height. Wait for that
  // real layout and raster transition before computing pointer coordinates.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  let previous: Awaited<ReturnType<typeof readAnnotationPaint>>['box'] = null;
  const painted = await waitForSnapshot(() => readAnnotationPaint(page, tuple, true), current => {
    const stable = current.ready && !!current.box && !!previous && isDeepStrictEqual(current.box, previous);
    previous = current.ready ? current.box : null; return stable;
  }); const box = painted.box; assert.ok(box);
  // Both engines receive the same integer CSS-pixel location. WebKit floors
  // fractional mouse coordinates before dispatching the actual PointerEvent.
  const requested = { x: box.x + box.width * x, y: box.y + box.height * y };
  return { x: Math.round(requested.x), y: Math.round(requested.y), requested };
}
type AnnotationPointerSample = { name: string; clientX: number; clientY: number; pointerId: number; pointerType: string;
  bounds: { x: number; y: number; width: number; height: number } };
async function annotationPointerEvidence(page: BrowserPage) {
  await page.waitForFunction(() => typeof (window as unknown as { compositionAnnotationPointerEvidence?: unknown }).compositionAnnotationPointerEvidence === 'function');
  return page.evaluate(() => (window as unknown as { compositionAnnotationPointerEvidence(): AnnotationPointerSample[] }).compositionAnnotationPointerEvidence());
}
const annotationGeometry = (page: BrowserPage) => placement(page).evaluate(layer => {
  const canonical = layer.closest('[data-canonical-page], [data-paper-page]');
  const surface = layer.closest('[data-pdf-surface], .ink-page');
  const box = layer.getBoundingClientRect(), outer = canonical?.getBoundingClientRect();
  return { layer: box.toJSON(), canonical: outer?.toJSON() ?? null, surface: surface?.getBoundingClientRect().toJSON() ?? null,
    canonicalPageId: canonical?.getAttribute('data-canonical-page') ?? canonical?.getAttribute('data-paper-page'),
    inset: outer ? { left: box.left - outer.left, top: box.top - outer.top, right: outer.right - box.right, bottom: outer.bottom - box.bottom } : null,
    devicePixelRatio, visualViewportScale: visualViewport?.scale ?? null };
});
type ReadonlyProbeEvent = { sequence: number; name: string; clientX: number; clientY: number; pointerId: number; pointerType: string;
  annotationLayer: boolean; bounds: AnnotationPointerSample['bounds'] | null; target: unknown; state: unknown };
type ReadonlyProbeDump = { label: string; baselineLength: number; baseline: AnnotationPointerSample[]; before: unknown; after: unknown; events: ReadonlyProbeEvent[] };
async function beginReadonlyAnnotationProbe(page: BrowserPage, label: string, expected: Page) {
  const token = await page.evaluate(({ label, expected }) => {
    const holder = window as unknown as {
      compositionAnnotationPointerEvidence?: () => AnnotationPointerSample[];
      compositionNavigationEvidence?: () => { documentId: string | null; document?: DocumentEditState };
      stickyReadonlyProbes?: Record<string, { collect(): ReadonlyProbeDump; dispose(): void }>;
    };
    const identity = (element: Element | null) => !element ? null : ({ tag: element.tagName, id: element.id,
      label: element.getAttribute('aria-label'), class: element.getAttribute('class'),
      data: Object.fromEntries(element.getAttributeNames().filter(name => name.startsWith('data-')).map(name => [name, element.getAttribute(name)])) });
    const rect = (element: Element | null) => element?.getBoundingClientRect().toJSON() ?? null;
    const sample = () => {
      const active = document.querySelector('[data-reader-surface][data-active-surface="true"]');
      const layer = active?.querySelector('[data-annotation-layer]') ?? document.querySelector('[data-annotation-layer]');
      const canonical = layer?.closest('[data-canonical-page], [data-paper-page]') ?? active?.querySelector('[data-canonical-page], [data-paper-page]') ?? null;
      const navigation = holder.compositionNavigationEvidence?.(), state = navigation?.document;
      const actualPageId = canonical?.getAttribute('data-canonical-page') ?? canonical?.getAttribute('data-paper-page');
      const modelPage = [...(state?.document?.pages ?? []), ...(state?.document?.translation?.pages ?? [])].find(value => value.id === actualPageId);
      const button = (text: string) => {
        const value = [...document.querySelectorAll('button')].find(value => value.textContent?.trim() === text);
        return value ? { disabled: value.disabled, pressed: value.getAttribute('aria-pressed') } : null;
      };
      const markers = [...(active ?? document).querySelectorAll('[data-rendered]')].map(value => ({ identity: identity(value), bounds: rect(value) }));
      return { expected, documentId: document.querySelector('[data-content-document]')?.getAttribute('data-content-document'),
        active: identity(active), canonical: identity(canonical), canonicalBounds: rect(canonical), markers,
        physicalPages: [...(canonical ?? active ?? document).querySelectorAll('.react-pdf__Page')].map(value => ({ identity: identity(value), bounds: rect(value) })),
        canvases: [...(canonical ?? active ?? document).querySelectorAll('canvas')].map(value => ({ identity: identity(value), width: value.width, height: value.height,
          hidden: value.hidden, bounds: rect(value), display: getComputedStyle(value).display, visibility: getComputedStyle(value).visibility })),
        layer: { identity: identity(layer ?? null), bounds: rect(layer ?? null), connected: layer?.isConnected ?? false,
          pointerEvents: layer ? getComputedStyle(layer).pointerEvents : null, display: layer ? getComputedStyle(layer).display : null,
          visibility: layer ? getComputedStyle(layer).visibility : null,
          renderedAncestor: identity(layer?.closest('[data-rendered]') ?? null),
          markerButtons: [...(layer?.querySelectorAll('button') ?? [])].map(value => ({ identity: identity(value), disabled: value.disabled })) },
        modes: { place: button('付箋を貼る'), selectAnnotation: button('注釈を選択'), read: button('読む'), move: button('注釈の位置を変更') },
        publicCore: { observedDocumentId: navigation?.documentId, snapshotDocumentId: state?.document?.id,
          ready: state?.ready, phase: state?.phase, inputActive: state?.inputActive, selectedVersion: state?.selectedVersion,
          heads: state?.heads, surface: state?.surfaces[expected.pageId], actualSurface: actualPageId ? state?.surfaces[actualPageId] : undefined,
          actualPage: modelPage ? { id: modelPage.id, backgroundRevision: modelPage.backgroundRevision, background: modelPage.background,
            widthPt: modelPage.widthPt, heightPt: modelPage.heightPt, annotationVersion: modelPage.annotationVersion, lifecycleVersion: modelPage.lifecycleVersion } : null,
          canUndo: state?.canUndo, canRedo: state?.canRedo },
        candidateButtons: [...document.querySelectorAll('button')].filter(value => value.textContent?.trim() === 'この注釈を編集').map(value => ({ identity: identity(value), disabled: value.disabled })),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(value => value.textContent),
        devicePixelRatio, visualViewportScale: visualViewport?.scale ?? null };
    };
    const baseline = holder.compositionAnnotationPointerEvidence?.() ?? [], before = sample(), events: ReadonlyProbeEvent[] = [];
    let sequence = 0;
    const capture = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null, layer = target?.closest('[data-annotation-layer]') ?? null;
      events.push({ sequence: ++sequence, name: event.type, clientX: event.clientX, clientY: event.clientY,
        pointerId: event.pointerId, pointerType: event.pointerType, annotationLayer: !!layer,
        bounds: layer ? layer.getBoundingClientRect().toJSON() : null, target: identity(target), state: sample() });
    };
    for (const name of ['pointerdown', 'pointerup', 'pointercancel']) window.addEventListener(name, capture as EventListener, { capture: true, passive: true });
    const token = crypto.randomUUID();
    (holder.stickyReadonlyProbes ??= {})[token] = { collect: () => ({ label, baselineLength: baseline.length, baseline, before, after: sample(), events: [...events] }),
      dispose: () => { for (const name of ['pointerdown', 'pointerup', 'pointercancel']) window.removeEventListener(name, capture as EventListener, true); } };
    return token;
  }, { label, expected: { pageId: expected.id, backgroundRevision: expected.backgroundRevision,
    physicalPage: expected.background.kind === 'pdf' ? expected.background.pdfPage : null } });
  const collect = () => page.evaluate(token => (window as unknown as { stickyReadonlyProbes: Record<string, { collect(): ReadonlyProbeDump }> }).stickyReadonlyProbes[token].collect(), token);
  const stop = () => page.evaluate(token => {
    const holder = window as unknown as { stickyReadonlyProbes: Record<string, { dispose(): void }> };
    holder.stickyReadonlyProbes[token]?.dispose(); delete holder.stickyReadonlyProbes[token];
  }, token);
  return { collect, stop };
}
async function clickCandidateWithReadonlyProbe(page: BrowserPage, target: Page, label: string) {
  await rendered(page, target);
  const probe = await beginReadonlyAnnotationProbe(page, label, target);
  try {
    await page.getByRole('button', { name: 'この注釈を編集', exact: true }).click();
    console.error('sticky-readonly-candidate-click', JSON.stringify(await probe.collect()));
    try { await form(page).waitFor(); }
    catch (error) { console.error('sticky-readonly-candidate-refusal', JSON.stringify(await probe.collect())); throw error; }
  } finally { await probe.stop(); }
}
async function currentBrowserRow(page: BrowserPage, document: DocumentSnapshot, text: string) {
  const annotation = allPages(document).flatMap(value => value.annotations).find(value => value.kind === 'sticky' && value.text === text); assert.ok(annotation);
  await waitForSnapshot(() => page.evaluate(() => (window as unknown as {
    compositionAnnotationBrowserEvidence(): AnnotationBrowserState | undefined;
  }).compositionAnnotationBrowserEvidence()), value => !!value && !value.loading && value.rows.length === 1
    && value.rows[0].documentId === document.id && value.rows[0].sourceVersions.includes(document.version)
    && isDeepStrictEqual(value.rows[0].annotation, annotation) && !value.staleIds.includes(document.id));
}
async function place(page: BrowserPage, x = .55, y = .35) {
  const tool = page.getByRole('button', { name: '付箋を貼る', exact: true });
  if (await tool.getAttribute('aria-pressed') !== 'true') await tool.click();
  const at = await point(page, x, y); await page.mouse.click(at.x, at.y); await form(page).waitFor();
}
async function edit(page: BrowserPage, annotation: StickyNote) {
  const tool = page.getByRole('button', { name: '注釈を選択', exact: true });
  if (await tool.getAttribute('aria-pressed') !== 'true') await tool.click();
  await page.locator(`button[data-annotation-id="${annotation.id}"]`).click();
  await form(page).waitFor();
}
async function confirm(page: BrowserPage, id: string, before: Observed) {
  await form(page).getByRole('button', { name: '確定', exact: true }).click();
  return changed(page, id, before);
}
async function historyAction(page: BrowserPage, id: string, name: '元に戻す' | 'やり直す') {
  const before = await observe(page, id); await page.getByRole('button', { name, exact: true }).click();
  return changed(page, id, before);
}
async function synchronize(page: BrowserPage, id: string) {
  await idle(page, id); await waitForSnapshot(() => observe(page, id), value => !value.replication.running);
  await page.getByRole('button', { name: '同期', exact: true }).click();
  await deliver(page);
  return waitForSnapshot(() => observe(page, id), value => !value.replication.running && value.pending.length === 0 && durableIdle(value));
}
async function pull(page: BrowserPage, id: string, batchId: string) {
  await waitForSnapshot(() => observe(page, id), value => !value.replication.running);
  await page.getByRole('button', { name: '同期', exact: true }).click();
  await deliver(page);
  return waitForSnapshot(() => observe(page, id), value => !value.replication.running && value.state.heads.includes(batchId));
}

function remoteChange(document: DocumentSnapshot, pageId: string, libraryId: string, kind: 'payload' | 'background'): EditBatch {
  const page = pageById(document, pageId), id = crypto.randomUUID();
  if (kind === 'payload') {
    const sticky = page.annotations.find(value => value.kind === 'sticky'); assert.ok(sticky?.kind === 'sticky');
    const batch: PageEditBatch = { kind: 'page', id, libraryId, targetId: document.id, parents: [document.version], expected: pageExpectation(page),
      changes: [{ type: 'update', annotation: { ...sticky, text: `${sticky.text} remote` } }] }; return batch;
  }
  // A real background replacement updates every retained highlight's binding.
  const replacement = { ...structuredClone(page), backgroundRevision: id,
    annotations: page.annotations.map(value => value.kind === 'highlight' ? { ...value, backgroundRevision: id } : structuredClone(value)) };
  if (replacement.background.kind === 'paper') replacement.background.spec.template = 'dot5';
  else {
    assert.equal(replacement.background.resourceId, metadata.id);
    assert.equal(replacement.background.sourceRevision, metadata.sha256);
    replacement.background.pdfPage = replacement.background.pdfPage === 2 ? 4 : 2;
    const descriptor = metadata.pdfPages![replacement.background.pdfPage - 1]; assert.ok(descriptor);
    replacement.widthPt = descriptor.widthPt; replacement.heightPt = descriptor.heightPt;
  }
  const batch: DocumentEditBatch = { kind: 'document', id, libraryId, targetId: document.id, parents: [document.version],
    changes: [{ type: 'replace', expected: pageExpectation(page), page: replacement }] }; return batch;
}
async function cancelMultipleContacts(page: BrowserPage, id: string, engine: 'chromium' | 'webkit') {
  const before = await idle(page, id), at = await point(page, .6, .3);
  const retained = async () => {
    const snapshot = await waitForSnapshot(async () => ({ value: await observe(page, id),
      forms: await form(page).count(), previews: await page.locator('[data-annotation-preview]').count() }),
    value => value.value.document!.inputActive && value.forms === 0 && value.previews === 0);
    const value = snapshot.value;
    assert.equal(value.document!.inputActive, true); assert.equal(value.leave.status, 'refused');
    assert.deepEqual(canonicalState(value.state), canonicalState(before.state), 'multiple contacts create neither annotations nor history');
  };
  if (engine === 'chromium') {
    // Real Chromium device touch events include implicit pointer capture.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    const first = { id: 1, x: at.x, y: at.y }, second = { id: 2, x: at.x + 30, y: at.y + 30 };
    let released = false;
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
      await waitForSnapshot(() => observe(page, id), value => value.document!.inputActive);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] }); await retained();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [second] }); await retained();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); released = true;
    } finally {
      if (!released) await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await cdp.detach();
    }
  } else {
    // WebKit contract coverage: a real captured mouse contact plus a synthetic
    // second touch. This does not establish real touch implicit-capture behavior.
    await page.mouse.move(at.x, at.y); await page.mouse.down();
    try {
      await waitForSnapshot(() => observe(page, id), value => value.document!.inputActive);
      await placement(page).dispatchEvent('pointerdown', { pointerId: 707, pointerType: 'touch', isPrimary: false, button: 0, buttons: 1, clientX: at.x + 30, clientY: at.y + 30 });
      await retained(); await page.mouse.up(); await retained();
      await placement(page).dispatchEvent('pointercancel', { pointerId: 707, pointerType: 'touch', isPrimary: false, button: 0, buttons: 0 });
    } finally { await page.mouse.up(); }
  }
  const after = await idle(page, id); assert.deepEqual(canonicalState(after.state), canonicalState(before.state), 'the last contact releases the guard without saving');
}

async function syntheticLifecycleReentry(page: BrowserPage, id: string, target: Page, text: string) {
  const before = await idle(page, id);
  assert.equal(await form(page).count(), 0); assert.equal(await page.getByRole('button', { name: 'この注釈を編集', exact: true }).count(), 0);
  // Deliberately exercise only the synthetic persisted lifecycle path. This is
  // separate from real BFCache history navigation and keeps the same page tuple.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await rendered(page, target);
  const toggle = browser(page).getByRole('button', { name: /^付箋・ハイライト一覧/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await browser(page).getByLabel('対象', { exact: true }).selectOption('current');
  await browser(page).getByLabel('検索', { exact: true }).fill(text);
  await currentBrowserRow(page, before.document!.document!, text);
  await browser(page).locator('li').getByRole('button', { name: '場所へ移動', exact: true }).click();
  await page.getByRole('button', { name: 'この注釈を編集', exact: true }).waitFor();
  await clickCandidateWithReadonlyProbe(page, target, 'synthetic-lifecycle-candidate');
  assert.equal(await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).inputValue(), text);
  await form(page).getByRole('button', { name: 'キャンセル', exact: true }).click(); const after = await idle(page, id);
  assert.deepEqual(canonicalState(after.state), canonicalState(before.state), 'synthetic same-page restoration and candidate cancellation perform no write');
}

type AnnotationLocationTiming = { id: string; captured: boolean; completed: boolean; released: boolean;
  ambientRefreshStarts: number; guardedGeneration: number | null; ambientGenerations: number[] };
async function annotationLocationTiming(page: BrowserPage) {
  await page.waitForFunction(() => typeof (window as unknown as { compositionAnnotationLocationTiming?: unknown }).compositionAnnotationLocationTiming === 'function');
  return page.evaluate(() => (window as unknown as { compositionAnnotationLocationTiming(): AnnotationLocationTiming | null }).compositionAnnotationLocationTiming());
}
async function controlledAnnotationLanding(page: BrowserPage, id: string, target: Page, text: string,
  witness: { batch: EditBatch; expected: DocumentSnapshot; publish(): Promise<void>; acknowledged(peerId: string): boolean }) {
  let baselineLastSample: Record<string, unknown> | null = null;
  let baselineReadStarts = 0, baselineReadCompletes = 0;
  let before: Observed;
  let baselinePhase: 'scope-setup' | 'local-document' = 'scope-setup';
  try {
    // Separate bounded setup, not a cold-performance assertion or a synchronization action.
    await waitForSnapshot(async () => {
      baselineReadStarts++; const value = await observe(page, id); baselineReadCompletes++; return value;
    }, value => {
      baselineLastSample = { capturedEpochMs: Date.now(), baselinePhase,
        documentReady: value.document?.ready, phase: value.document?.phase, inputActive: value.document?.inputActive,
        version: value.document?.document?.version, heads: value.state.heads.slice(0, 8), headCount: value.state.heads.length,
        pendingCount: value.pending.length, running: value.replication.running,
        error: (value.replication as { error?: string }).error?.slice(0, 256) };
      return value.pending.length === 0 && !value.replication.running;
    }, 120_000);
    baselinePhase = 'local-document';
    before = await idle(page, id);
  } catch (error) {
    console.error('sticky-controlled-baseline-error', JSON.stringify({ phase: baselinePhase, lastSample: baselineLastSample,
      readCountsScopeSetupOnly: true,
      readStarts: baselineReadStarts, readCompletes: baselineReadCompletes,
      error: error instanceof Error ? { name: error.name.slice(0, 80), message: error.message.slice(0, 256) } : { name: typeof error } }));
    let baselineDiagnosticTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const diagnostic = await Promise.race([page.evaluate(() => {
        const value = (window as unknown as { compositionStartupEvidence?: () => {
          controlledSync?: unknown; nativeTransport?: { originEpochMs?: number; failures?: unknown[];
            health?: unknown[]; replication?: unknown[]; replicationDropped?: number } } }).compositionStartupEvidence?.();
        return { capturedEpochMs: Date.now(), current: value?.controlledSync, transport: value?.nativeTransport && {
          originEpochMs: value.nativeTransport.originEpochMs, failures: value.nativeTransport.failures?.slice(-8),
          health: value.nativeTransport.health?.slice(-8), replication: value.nativeTransport.replication?.slice(-32),
          replicationDropped: value.nativeTransport.replicationDropped } };
      }), new Promise<never>((_, reject) => { baselineDiagnosticTimer = setTimeout(() => reject(new Error('baseline diagnostic timeout')), 2000); })]);
      console.error('sticky-controlled-baseline-state', JSON.stringify(diagnostic));
    } catch (diagnosticError) { console.error('sticky-controlled-baseline-state-unavailable', String(diagnosticError).slice(0, 256)); }
    finally { if (baselineDiagnosticTimer !== undefined) clearTimeout(baselineDiagnosticTimer); }
    throw error;
  }
  const toggle = browser(page).getByRole('button', { name: /^付箋・ハイライト一覧/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await browser(page).getByLabel('対象', { exact: true }).selectOption('current');
  await browser(page).getByLabel('検索', { exact: true }).fill(text);
  await currentBrowserRow(page, before.document!.document!, text);
  await page.evaluate(id => (window as unknown as { compositionHoldAnnotationLocationRead(id: string): void }).compositionHoldAnnotationLocationRead(id), id);
  let received: EditRecord | undefined, acknowledged = false;
  const observationErrors: string[] = [];
  let lastWitnessSample: Record<string, unknown> | null = null;
  const peerId = await page.evaluate(() => {
    const holder=window as unknown as { compositionAdmittedPeer():string; compositionStartupEvidence?:()=>{controlledSync?:unknown;nativeTransport?:{recent?:{sequence:number}[];replicationDropped?:number;originEpochMs?:number}};
      __stickySyncBefore?:unknown;__stickySyncCleanup?:()=>void };
    holder.__stickySyncCleanup?.();holder.__stickySyncBefore=undefined;
    const capture=(event:Event)=>{const target=event.target instanceof Element?event.target.closest('button'):null;if(target?.textContent?.trim()!=='\u540c\u671f')return;
      try{const value=holder.compositionStartupEvidence?.();holder.__stickySyncBefore={state:value?.controlledSync,transportSequence:(()=>{const entries=value?.nativeTransport?.recent??[];return entries[entries.length-1]?.sequence??0;})(),replicationDropped:value?.nativeTransport?.replicationDropped??0,transportOriginEpochMs:value?.nativeTransport?.originEpochMs};}catch(error){holder.__stickySyncBefore={error:String(error).slice(0,256)};}
      window.removeEventListener('pointerdown',capture,true);};
    window.addEventListener('pointerdown',capture,{capture:true,passive:true});holder.__stickySyncCleanup=()=>window.removeEventListener('pointerdown',capture,true);
    return holder.compositionAdmittedPeer();
  });
  try {
    await browser(page).locator('li').getByRole('button', { name: '場所へ移動', exact: true }).click();
    const held = await waitForSnapshot(() => annotationLocationTiming(page), value => !!value?.captured && value.completed && !value.released);
    assert.equal(held!.id, id); assert.ok(Number.isInteger(held!.guardedGeneration));
    assert.equal(await form(page).count(), 0);
    // Change a different canonical document through ordinary immutable upload.
    // The current landing's exact head and annotation payload stay unchanged.
    await witness.publish();
    await page.getByRole('button', { name: '同期', exact: true }).click();
    try { await waitForSnapshot(async () => {
      const source = await page.evaluate(targetId => (window as unknown as {
        compositionWitnessEvidence(id:string):Promise<{state:RepositoryState;replication:{running:boolean;suspended:boolean;error:string}}>;
      }).compositionWitnessEvidence(targetId), witness.batch.targetId);
      const batch = source.state.checkpoint.batches.find(value => value.id === witness.batch.id);
      const receipt = source.state.receipts.find(value => value.id === witness.batch.id && value.targetId === witness.batch.targetId);
      received = batch ? { batch } : undefined;
      try { acknowledged = !!receipt?.durable && receipt.importedBy.includes(peerId) && witness.acknowledged(peerId); }
      catch (error) { observationErrors.push(String(error)); throw error; }
      lastWitnessSample = { peerId, targetId:witness.batch.targetId, witnessId:witness.batch.id, batchPresent:!!batch, receiptPresent:!!receipt, durable:receipt?.durable===true, importedByPeer:receipt?.importedBy.includes(peerId)===true, acknowledged, running:source.replication.running, headMatches:source.state.heads.includes(witness.batch.id), snapshotMatches:null };
      return { witness: source, received, acknowledged };
    }, value => {
      const eligible=!!value.received && value.acknowledged && !value.witness.replication.running && value.witness.state.heads.includes(witness.batch.id);
      const snapshotMatches=eligible ? isDeepStrictEqual(new EditGraph(value.witness.state.checkpoint).snapshot(witness.batch.id), witness.expected) : null;
      lastWitnessSample={...lastWitnessSample,snapshotMatches};
      return eligible && snapshotMatches===true;
    }); } catch (error) {
      console.error('sticky-controlled-witness-error', JSON.stringify({ lastSample:lastWitnessSample, error:error instanceof Error ? {name:error.name.slice(0,80),message:error.message.slice(0,256)} : {name:typeof error} }));
      let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const syncState=await Promise.race([page.evaluate(()=>{
          const holder=window as unknown as {__stickySyncBefore?:{transportSequence?:number;replicationDropped?:number};compositionStartupEvidence?:()=>{controlledSync?:unknown;nativeTransport?:{recent?:{sequence:number}[];failures?:{sequence:number}[];dropped?:number;failureDropped?:number;replication?:{sequence:number}[];replicationDropped?:number;originEpochMs?:number}}};
          const value=holder.compositionStartupEvidence?.(),after=holder.__stickySyncBefore?.transportSequence??0;
          return {before:holder.__stickySyncBefore,current:value?.controlledSync,transport:value?.nativeTransport&&{originEpochMs:value.nativeTransport.originEpochMs,recent:value.nativeTransport.recent?.filter(entry=>entry.sequence>after).slice(-32),failures:value.nativeTransport.failures?.filter(entry=>entry.sequence>after).slice(-16),dropped:value.nativeTransport.dropped,failureDropped:value.nativeTransport.failureDropped,replication:value.nativeTransport.replication?.filter(entry=>entry.sequence>after),replicationDropped:value.nativeTransport.replicationDropped,replicationDroppedDelta:(value.nativeTransport.replicationDropped??0)-(holder.__stickySyncBefore?.replicationDropped??0)}};
        }),new Promise<never>((_,reject)=>{diagnosticTimer=setTimeout(()=>reject(new Error('controlled Sync diagnostic timeout')),2000);})]);
        console.error('sticky-controlled-sync-state',JSON.stringify(syncState));
      } catch(diagnosticError){console.error('sticky-controlled-sync-state-unavailable',String(diagnosticError).slice(0,256));}
      finally{if(diagnosticTimer!==undefined)clearTimeout(diagnosticTimer);}
      throw error;
    }
    assert.deepEqual(received, { batch: witness.batch }, 'ordinary pull receives the complete immutable witness record');
    assert.deepEqual(observationErrors, []);
    const stillHeld = await annotationLocationTiming(page); assert.ok(stillHeld?.captured && stillHeld.completed && !stillHeld.released);
    assert.equal(stillHeld.ambientRefreshStarts, 0, 'immutable synchronization must not start an unguarded model refresh during annotation landing');
    assert.deepEqual(stillHeld.ambientGenerations, []); assert.equal(stillHeld.guardedGeneration, held!.guardedGeneration);
    assert.deepEqual(canonicalState((await observe(page, id)).state), canonicalState(before.state));
    await page.evaluate(() => (window as unknown as { compositionReleaseAnnotationLocationRead(): void }).compositionReleaseAnnotationLocationRead());
    await page.getByRole('button', { name: 'この注釈を編集', exact: true }).waitFor();
    await clickCandidateWithReadonlyProbe(page, target, 'controlled-landing-candidate');
    assert.equal(await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).inputValue(), text);
    await form(page).getByRole('button', { name: 'キャンセル', exact: true }).click(); const after = await idle(page, id);
    assert.deepEqual(canonicalState(after.state), canonicalState(before.state), 'controlled landing, synchronization and cancellation preserve the complete current document and history');
  } finally {
    await page.evaluate(() => { const holder=window as unknown as {__stickySyncCleanup?:()=>void;__stickySyncBefore?:unknown;compositionReleaseAnnotationLocationRead():void};holder.__stickySyncCleanup?.();delete holder.__stickySyncCleanup;delete holder.__stickySyncBefore;holder.compositionReleaseAnnotationLocationRead(); });
  }
}

for (const engine of ['chromium', 'webkit'] as const) for (const authoringHost of [0, 1] as const)
test(`production sticky drafts, exact edits, common history and fixed retry (${engine}, ${authoringHost === 0 ? 'native' : 'web'})`, { timeout: 1_020_000 }, async t => {
  const caseStarted = performance.now();
  const stage = (message: string) => t.diagnostic(`${message} (${((performance.now() - caseStarted) / 1000).toFixed(2)}s elapsed)`);
  const pdfs: DocumentSnapshot[] = [], papers: DocumentSnapshot[] = [], gesturePapers: DocumentSnapshot[] = [], preflightPapers: DocumentSnapshot[] = [];
  const seed = (publication: ContentPublication) => {
    const document = pdfDocument(); publication.content = document; pdfs.push(structuredClone(document));
    const item = publication.libraryBatch.changes.find(change => change.type === 'put-item'); assert.ok(item?.type === 'put-item'); item.item.id = document.id;
  };
  const additionalPublications = (initial: ContentPublication) => {
    const base = initial.libraryBatch.changes.find(change => change.type === 'put-item'); assert.ok(base?.type === 'put-item');
    let parent = initial.libraryBatch.id; const publications: ContentPublication[] = [];
    const secondPdf = pdfDocument(); pdfs.push(structuredClone(secondPdf));
    papers.push(paperDocument(), paperDocument()); gesturePapers.push(paperDocument(), paperDocument()); preflightPapers.push(paperDocument(), paperDocument());
    for (const [index, content] of [secondPdf, ...papers, ...gesturePapers, ...preflightPapers].entries()) {
      const id = crypto.randomUUID(), paper = index > 0;
      const item = { ...structuredClone(base.item), id: content.id, position: index + 1,
        kind: paper ? 'notebook' as const : 'pdf' as const,
        title: index > 4 ? `Sticky preflight paper ${index - 5}` : index > 2 ? `Sticky gesture paper ${index - 3}` : paper ? `Sticky paper ${index - 1}` : 'Sticky second PDF' };
      if (paper) delete item.resourceId;
      publications.push({ libraryBatch: { ...structuredClone(initial.libraryBatch), id, parents: [parent], changes: [{ type: 'put-item', item }] }, content }); parent = id;
    }
    return { publications, initialDocumentId: pdfs[0].id };
  };
  const setup = await openComposition(t, engine, seed, { additionalPublications });
  const { pages, repository, reloadContent, finish } = setup;
  const publishRemote = async (page: BrowserPage, batch: EditBatch) => {
    assert.ok(pages.includes(page));
    const response = await setup.publishThirdPeerRecord({ batch });
    assert.equal(response.status, 200);
  };
  try {
    {
      // Each case authors on its designated host and retains the other actual
      // production peer for ordinary replication and full-snapshot assertions.
      const host = authoringHost, page = pages[host];
      const pdf = pdfs[host], paper = papers[host], title = host ? 'Sticky second PDF' : 'Canonical PDF composition';
      stage(`${host ? 'Web IndexedDB' : 'Native HTTP/SQLite'}: pointer draft, guards and exact payload edits`);
      await reloadContent(page, pdf.id); await page.locator(`[data-content-document="${pdf.id}"]`).waitFor(); await idle(page, pdf.id);
      await page.getByLabel('倍率', { exact: true }).selectOption('0');
      await rendered(page, pdf.pages[0]);

      // A real pointer cancellation cannot create a draft, annotation or history.
      const cancelled = await observe(page, pdf.id);
      await page.getByRole('button', { name: '付箋を貼る', exact: true }).click();
      const at = await point(page, .65, .3); await page.mouse.move(at.x, at.y); await page.mouse.down();
      await placement(page).dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true }); await page.mouse.up();
      assert.equal(await form(page).count(), 0);
      assert.deepEqual(canonicalState((await observe(page, pdf.id)).state), canonicalState(cancelled.state));
      stage(`${host ? 'Web' : 'Native'}: ${engine === 'chromium' ? 'actual CDP touch' : 'synthetic second-pointer contract'} placement exclusion`);
      await cancelMultipleContacts(page, pdf.id, engine);

      await place(page); await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).fill(`Draft retained ${host}`);
      const draft = await observe(page, pdf.id); assert.equal(draft.document!.inputActive, true); assert.equal(draft.leave.status, 'refused');
      assert.equal(await page.getByRole('button', { name: '次のページ', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '訳文', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '元に戻す', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '文字', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'ペン', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: '右側で編集', exact: true }).click();
      assert.equal(await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).inputValue(), `Draft retained ${host}`);
      await page.evaluate(() => (window as unknown as { compositionUnmount(): void }).compositionUnmount());
      const unmounted = await observe(page, pdf.id); assert.equal(unmounted.document!.inputActive, true); assert.equal(unmounted.leave.status, 'refused');
      assert.deepEqual(canonicalState(unmounted.state), canonicalState(draft.state), 'unmount finalizers never save an unfinished form');
      await page.evaluate(() => (window as unknown as { compositionRemount(): Promise<void> }).compositionRemount());
      await form(page).waitFor(); assert.equal(await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).inputValue(), `Draft retained ${host}`);
      await page.getByRole('button', { name: '中央で編集', exact: true }).click();
      await form(page).getByRole('button', { name: 'キャンセル', exact: true }).click(); await idle(page, pdf.id);
      assert.deepEqual(canonicalState((await observe(page, pdf.id)).state), canonicalState(cancelled.state), 'cancel after owner reacquisition leaves durable state exact');

      await page.getByRole('button', { name: '文字', exact: true }).click();
      const inkLayer = page.getByLabel('PDF書き込みレイヤー', { exact: true }), inkBox = await inkLayer.boundingBox(); assert.ok(inkBox);
      await page.mouse.click(inkBox.x + inkBox.width * .7, inkBox.y + inkBox.height * .2);
      const inkDraft = page.getByRole('textbox', { name: '書き込みテキスト', exact: true }); await inkDraft.fill('Ink owns input');
      assert.equal(await page.getByRole('button', { name: '付箋を貼る', exact: true }).isDisabled(), true);
      assert.equal(await form(page).count(), 0); await inkDraft.press('Escape'); await idle(page, pdf.id);
      assert.deepEqual(canonicalState((await observe(page, pdf.id)).state), canonicalState(cancelled.state), 'an unfinished Ink draft cannot become a sticky draft');

      // Each surface creates through pointer coordinates; no editor/session setters.
      for (const target of [pdf.pages[0], pdf.translation!.pages[0], paper.pages[0]]) {
        const isPaper = target.background.kind === 'paper', id = isPaper ? paper.id : pdf.id;
        stage(`${host ? 'Web' : 'Native'}: sticky CRUD (${isPaper ? 'paper' : target.id === pdf.pages[0].id ? 'original PDF' : 'translated PDF'})`);
        if (isPaper) await openItem(page, `Sticky paper ${host}`, paper.id);
        else if (target.id === pdf.translation!.pages[0].id) await page.getByRole('button', { name: '訳文', exact: true }).click();
        await page.getByLabel('倍率', { exact: true }).selectOption('0'); await rendered(page, target);
        const before = await observe(page, id); await place(page, .65, .4);
        const text = `Created ${host} ${target.id}`;
        await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).fill(text);
        await form(page).getByRole('textbox', { name: '注釈の分類', exact: true }).fill('created-label');
        const after = await confirm(page, id, before);
        const created = pageById(after, target.id).annotations.find(value => value.kind === 'sticky' && value.text === text);
        assert.ok(created?.kind === 'sticky'); assert.equal(created.metadata.label, 'created-label'); assert.ok(created.metadata.createdAt);
        assert.ok(Math.abs(created.anchor.x - target.widthPt * .65) < 2 && Math.abs(created.anchor.y - target.heightPt * .4) < 2);
        assertOnlyAnnotation(before.document!.document!, after, target.id, created.id);
        const undone = await historyAction(page, id, '元に戻す');
        assert.deepEqual(pageById(undone, target.id).annotations, pageById(before.document!.document!, target.id).annotations);
        const redone = await historyAction(page, id, 'やり直す');
        assert.deepEqual(annotationById(redone, created.id, 'sticky'), created);

        const existing = target.annotations.find(value => value.kind === 'sticky'); assert.ok(existing?.kind === 'sticky');
        const editBefore = await observe(page, id); await edit(page, existing);
        assert.equal(await form(page).getByLabel('注釈の色', { exact: true }).inputValue(), '');
        await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).fill(`Edited body ${host} ${target.id}`);
        const edited = await confirm(page, id, editBefore), updated = annotationById(edited, existing.id, 'sticky');
        assert.deepEqual(updated, { ...existing, text: `Edited body ${host} ${target.id}` }, 'body-only editing preserves null color, quote and microsecond createdAt');
        assertOnlyAnnotation(editBefore.document!.document!, edited, target.id, existing.id);

        const moveBefore = await observe(page, id); await edit(page, updated);
        await form(page).getByLabel('注釈の分類', { exact: true }).fill('changed-label');
        await form(page).getByLabel('注釈の色', { exact: true }).selectOption('#facc15');
        await form(page).getByRole('button', { name: '注釈の位置を変更', exact: true }).click();
        const moveProbe = await beginReadonlyAnnotationProbe(page, 'sticky-move', target);
        const destination = await point(page, .4, .55), beforePointerGeometry = await annotationGeometry(page);
        await page.mouse.click(destination.x, destination.y);
        const legacyPointerEvidence = (await annotationPointerEvidence(page)).slice(-6);
        const afterInputProbe = await moveProbe.collect();
        // This probe starts before point() and has its own monotonic event
        // sequence, so the fixture's capped ring cannot supply an older up.
        const pointerEvidence = afterInputProbe.events.filter(value => value.annotationLayer);
        const pointerDown = pointerEvidence.find(value => value.name === 'pointerdown'), afterPointerGeometry = await annotationGeometry(page);
        const pointerUp = [...pointerEvidence].reverse().find(value => value.name === 'pointerup');
        const pointerCanonical = pointerUp?.bounds ? { x: (pointerUp.clientX - pointerUp.bounds.x) / pointerUp.bounds.width * target.widthPt,
          y: (pointerUp.clientY - pointerUp.bounds.y) / pointerUp.bounds.height * target.heightPt } : null;
        const moved = await confirm(page, id, moveBefore), movedAnnotation = annotationById(moved, existing.id, 'sticky');
        console.error('sticky-readonly-move', JSON.stringify({ destination, beforePointerGeometry, afterPointerGeometry,
          inputProbe: afterInputProbe, afterSaveProbe: await moveProbe.collect(), legacyPointerEvidence, pointerEvidence, pointerCanonical,
          actual: movedAnnotation.anchor, expected: { x: target.widthPt * .4, y: target.heightPt * .55 } }));
        await moveProbe.stop();
        assert.ok(pointerDown, 'the move must have a new pointerdown on the annotation layer after its probe baseline');
        assert.ok(pointerUp, 'the move must have a new pointerup on the annotation layer after its probe baseline');
        assert.deepEqual({ ...movedAnnotation, anchor: updated.anchor }, { ...updated, color: '#facc15', metadata: { ...updated.metadata, label: 'changed-label' } });
        assert.ok(pointerCanonical, 'the move must have an actual pointerup observation');
        assert.deepEqual(movedAnnotation.anchor, pointerCanonical, 'saved pt anchor equals the actual event coordinates projected through its contemporaneous input-layer box');
        assert.ok(Math.abs(movedAnnotation.anchor.x - target.widthPt * .4) < 2 && Math.abs(movedAnnotation.anchor.y - target.heightPt * .55) < 2,
          JSON.stringify({ actual: movedAnnotation.anchor, expected: { x: target.widthPt * .4, y: target.heightPt * .55 },
            destination, beforePointerGeometry, afterPointerGeometry, pointerEvidence, pointerCanonical,
            afterBox: await placement(page).boundingBox(), pageId: target.id, dimensions: { width: target.widthPt, height: target.heightPt } }));
        assertOnlyAnnotation(moveBefore.document!.document!, moved, target.id, existing.id);

        const deleteBefore = await observe(page, id); await edit(page, created);
        await form(page).getByRole('button', { name: 'この注釈を削除', exact: true }).click();
        const deleted = await confirm(page, id, deleteBefore);
        assert.equal(pageById(deleted, target.id).annotations.some(value => value.id === created.id), false);
        assertOnlyAnnotation(deleteBefore.document!.document!, deleted, target.id, created.id);
        const restored = await historyAction(page, id, '元に戻す');
        assert.deepEqual(annotationById(restored, created.id, 'sticky'), created);
        await historyAction(page, id, 'やり直す');
        stage(`${host ? 'Web' : 'Native'}: synthetic same-page lifecycle restoration (${isPaper ? 'paper' : target.id === pdf.pages[0].id ? 'original PDF' : 'translated PDF'})`);
        await syntheticLifecycleReentry(page, id, target, movedAnnotation.text);
      }

      // F37 location resolves an exact candidate; editing starts only on explicit input.
      await openItem(page, title, pdf.id);
      const panelToggle = browser(page).getByRole('button', { name: /^付箋・ハイライト一覧/ });
      if (await panelToggle.getAttribute('aria-expanded') !== 'true') await panelToggle.click();
      await browser(page).getByLabel('検索', { exact: true }).fill(`Edited body ${host} ${pdf.translation!.pages[0].id}`);
      await currentBrowserRow(page, (await idle(page, pdf.id)).document!.document!, `Edited body ${host} ${pdf.translation!.pages[0].id}`);
      await browser(page).locator('li').getByRole('button', { name: '場所へ移動', exact: true }).click();
      await page.getByRole('button', { name: 'この注釈を編集', exact: true }).waitFor(); assert.equal(await form(page).count(), 0);
      await clickCandidateWithReadonlyProbe(page, pdf.translation!.pages[0], 'ordinary-f37-candidate');
      assert.equal(await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).inputValue(), `Edited body ${host} ${pdf.translation!.pages[0].id}`);
      await form(page).getByRole('button', { name: 'キャンセル', exact: true }).click(); await idle(page, pdf.id);

      stage(`${host ? 'Web' : 'Native'}: guarded annotation landing survives simultaneous ordinary synchronization`);
      const witnessRead = await repository.read(gesturePapers[host].id); assert.equal(witnessRead.heads.length, 1);
      const witnessDocument = new EditGraph(witnessRead.checkpoint).snapshot(witnessRead.heads[0]); assert.ok(witnessDocument?.kind === 'document');
      const witnessBatch = remoteChange(witnessDocument, witnessDocument.pages[0].id, repository.scope.libraryId, 'payload');
      const witnessExpected = applyBatch(witnessDocument, witnessBatch); assert.ok(witnessExpected.kind === 'document');
      await controlledAnnotationLanding(page, pdf.id, pdf.translation!.pages[0], `Edited body ${host} ${pdf.translation!.pages[0].id}`,
        { batch: witnessBatch, expected: witnessExpected, publish: () => publishRemote(page, witnessBatch), acknowledged: peerId => setup.hasRemoteImportReceipt(witnessBatch.id, peerId) });

      // Native loses the durable response: retry and reload must resend the full
      // immutable payload, and the pending operation must be the sole authority.
      if (host === 0) {
        stage('Native: lost durable reply, reload and exact fixed-batch retry');
        const before = await observe(page, pdf.id), target = pdf.translation!.pages[0];
        const sticky = annotationById(before.document!.document!, target.annotations.find(value => value.kind === 'sticky')!.id, 'sticky');
        await edit(page, sticky); await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).fill('Fixed retry body');
        const start = setup.committedPayloads.length; setup.setCommitReplyLoss(true);
        await form(page).getByRole('button', { name: '確定', exact: true }).click();
        await page.getByRole('button', { name: '再試行', exact: true }).waitFor();
        const failed = await observe(page, pdf.id); assert.notEqual(failed.document!.phase, 'idle');
        assert.equal(await form(page).count(), 0); assert.equal(failed.document!.inputActive, false);
        await reloadContent(page, pdf.id); await page.getByRole('button', { name: '再試行', exact: true }).waitFor();
        assert.equal(await form(page).count(), 0);
        setup.setCommitReplyLoss(false); await page.getByRole('button', { name: '再試行', exact: true }).click();
        const recovered = await idle(page, pdf.id), recoveredDocument = recovered.document!.document!;
        const attempts = setup.committedPayloads.slice(start).map(value => JSON.parse(value)); assert.ok(attempts.length >= 2);
        for (const attempt of attempts) assert.deepEqual(attempt, attempts[0], 'same batch ID and every payload field are reused');
        assert.equal(recovered.state.history.length, before.state.history.length + 1);
        assert.deepEqual(annotationById(recoveredDocument, sticky.id, 'sticky'), { ...sticky, text: 'Fixed retry body' });
        assertOnlyAnnotation(before.document!.document!, recoveredDocument, target.id, sticky.id);
      }

      stage(`${host ? 'Web' : 'Native'}: later payload/background changes reject fixed F37 candidates`);
      for (const kind of ['payload', 'background'] as const) {
        await synchronize(page, pdf.id);
        if (host === 1) { await reloadContent(pages[0], pdf.id); await synchronize(pages[0], pdf.id); }
        // A fresh host entry clears the previous explicit checkout, while the
        // following F37 navigation deliberately pins its exact source version.
        await reloadContent(page, pdf.id); const current = await idle(page, pdf.id), before = current.document!.document!;
        const target = pageById(before, pdf.translation!.pages[0].id), sticky = target.annotations.find(value => value.kind === 'sticky'); assert.ok(sticky?.kind === 'sticky');
        const toggle = browser(page).getByRole('button', { name: /^付箋・ハイライト一覧/ });
        if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
        await browser(page).getByLabel('検索', { exact: true }).fill(sticky.text);
        await currentBrowserRow(page, before, sticky.text);
        await browser(page).locator('li').getByRole('button', { name: '場所へ移動', exact: true }).click();
        await page.getByRole('button', { name: 'この注釈を編集', exact: true }).waitFor();
        await rendered(page, target);
        assert.equal(await form(page).count(), 0);
        const batch = remoteChange(before, target.id, repository.scope.libraryId, kind), expected = applyBatch(before, batch);
        await publishRemote(page, batch); await pull(page, pdf.id, batch.id);
        await waitForSnapshot(() => observe(page, pdf.id), value => !!value.document?.heads.includes(batch.id));
        await page.getByRole('button', { name: 'この注釈を編集', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '注釈や表示中の版が変わりました。一覧から選び直してください。' }).waitFor();
        assert.equal(await form(page).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'この注釈を編集', exact: true }).count(), 0);
        const rejected = await observe(page, pdf.id);
        assert.equal(rejected.document!.inputActive, false); assert.deepEqual(rejected.state.history, current.state.history);
        assert.deepEqual(new EditGraph(rejected.state.checkpoint).snapshot(batch.id), expected);
        await reloadContent(page, pdf.id); const refreshed = await idle(page, pdf.id);
        assert.deepEqual(refreshed.document!.document, expected);
      }

      stage(`${host ? 'Web' : 'Native'}: remote updates retain unfinished forms and refuse commit`);
      await openItem(page, `Sticky paper ${host}`, paper.id); await synchronize(page, paper.id);
      if (host === 1) { await reloadContent(pages[0], paper.id); await synchronize(pages[0], paper.id); }
      for (const kind of ['payload', 'background'] as const) {
        await reloadContent(page, paper.id); const current = await idle(page, paper.id), before = current.document!.document!;
        const target = before.pages[0], sticky = target.annotations.find(value => value.kind === 'sticky'); assert.ok(sticky?.kind === 'sticky');
        await rendered(page, target); await edit(page, sticky);
        const draftText = `Keep unfinished ${host} ${kind}`;
        await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).fill(draftText);
        const drafting = await observe(page, paper.id), draft = drafting.document!.surfaces[target.id].annotationDraft; assert.ok(draft);
        const batch = remoteChange(before, target.id, repository.scope.libraryId, kind), expected = applyBatch(before, batch);
        await publishRemote(page, batch); await pull(page, paper.id, batch.id);
        await form(page).getByRole('button', { name: '確定', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '注釈を保存できません。入力内容を保持しています。' }).waitFor();
        const rejected = await observe(page, paper.id);
        assert.equal(await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).inputValue(), draftText);
        assert.deepEqual(rejected.document!.surfaces[target.id].annotationDraft, draft, 'refusal keeps the exact draft and original expected tuple');
        assert.equal(rejected.document!.inputActive, true); assert.equal(rejected.leave.status, 'refused');
        assert.deepEqual(rejected.state.history, current.state.history, 'a rejected form never creates local history');
        assert.deepEqual(rejected.state.heads, [batch.id]); assert.deepEqual(new EditGraph(rejected.state.checkpoint).snapshot(batch.id), expected);
        assert.equal(rejected.state.checkpoint.batches.length, current.state.checkpoint.batches.length + 1, 'only the ordinary remote batch was persisted');
        await form(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
        await pull(page, paper.id, batch.id);
        const refreshed = await waitForSnapshot(() => observe(page, paper.id), value => durableIdle(value) && value.document!.document!.version === batch.id);
        assert.deepEqual(refreshed.document!.document, expected);
      }
      stage(`${host ? 'Web' : 'Native'}: reload and ordinary peer full-snapshot convergence`);
      for (const id of [pdf.id, paper.id]) {
        await reloadContent(page, id); await idle(page, id); const local = await synchronize(page, id), expected = local.document!.document!;
        await reloadContent(page, id); assert.deepEqual((await idle(page, id)).document!.document, expected);
        const peer = pages[1 - host]; await reloadContent(peer, id); await idle(peer, id); const received = await synchronize(peer, id);
        assert.deepEqual(received.document!.document, expected, 'peer receives the complete canonical snapshot through ordinary replication');
        const durable = await waitForSnapshot(() => repository.read(id), value => value.heads.length === 1
          && isDeepStrictEqual(new EditGraph(value.checkpoint).snapshot(value.heads[0]), expected));
        assert.deepEqual(new EditGraph(durable.checkpoint).snapshot(durable.heads[0]), expected);
      }

      stage(`${host ? 'Web' : 'Native'}: remote logical deletion keeps a draft until explicit cancellation`);
      await openItem(page, `Sticky paper ${host}`, paper.id); const beforeDeletion = await synchronize(page, paper.id);
      await rendered(page, beforeDeletion.document!.document!.pages[0]); await place(page);
      const unfinished = `Explicitly cancel deleted draft ${host}`;
      await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).fill(unfinished);
      const drafting = await observe(page, paper.id), targetId = beforeDeletion.document!.document!.pages[0].id;
      const pendingDraft = drafting.document!.surfaces[targetId].annotationDraft; assert.ok(pendingDraft);
      const libraryBefore = await readOn(page, repository.scope.libraryId); assert.equal(libraryBefore.heads.length, 1);
      const catalog = new EditGraph(libraryBefore.checkpoint).snapshot(libraryBefore.heads[0]); assert.ok(catalog?.kind === 'library');
      const contentBefore = await readOn(page, paper.id); assert.deepEqual(canonicalState(contentBefore), canonicalState(beforeDeletion.state));
      const deletionId = crypto.randomUUID(), batch: LibraryEditBatch = { kind: 'library', id: crypto.randomUUID(),
        libraryId: catalog.id, targetId: catalog.id, parents: [catalog.version], changes: deleteLibraryItems(catalog, {
          id: deletionId, itemIds: [paper.id], childNotes: 'detach', observed: { [paper.id]: contentBefore.heads },
        }) };
      const deletedCatalog = applyBatch(catalog, batch); assert.ok(deletedCatalog.kind === 'library');
      await publishRemote(page, batch); await pull(page, catalog.id, batch.id);
      await page.getByRole('status').filter({ hasText: 'この資料は削除されています（閲覧のみ）' }).waitFor();
      const deletedDraft = await observe(page, paper.id), catalogAfterDeletion = (await observe(page, catalog.id)).state;
      assert.deepEqual(deletedDraft.document!.surfaces[targetId].annotationDraft, pendingDraft, 'remote deletion cannot silently discard an unfinished form');
      assert.equal(deletedDraft.document!.inputActive, true); assert.equal(deletedDraft.leave.status, 'refused');
      assert.deepEqual(canonicalState(deletedDraft.state), canonicalState(contentBefore), 'catalog deletion leaves the entire content graph and history untouched');
      assert.equal(await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).inputValue(), unfinished);
      for (const label of ['付箋のメモ', '注釈の分類', '注釈の色']) assert.equal(await form(page).getByLabel(label, { exact: true }).isDisabled(), true);
      for (const label of ['確定', '注釈の位置を変更']) assert.equal(await form(page).getByRole('button', { name: label, exact: true }).isDisabled(), true);
      assert.equal(await form(page).getByRole('button', { name: 'キャンセル', exact: true }).isEnabled(), true);
      await form(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
      const canceledDeletion = await idle(page, paper.id);
      assert.equal(await form(page).count(), 0); assert.equal(canceledDeletion.leave.status, 'allowed');
      assert.deepEqual(canonicalState(canceledDeletion.state), canonicalState(contentBefore));
      const catalogAfterCancel = (await observe(page, catalog.id)).state;
      assert.deepEqual(canonicalState(catalogAfterCancel), canonicalState(catalogAfterDeletion), 'cancel never undoes or rewrites the remote deletion record');
      assert.deepEqual(new EditGraph(catalogAfterCancel.checkpoint).snapshot(batch.id), deletedCatalog);
      assert.ok(deletedCatalog.deletions.some(record => record.id === deletionId && record.active && record.itemIds.includes(paper.id)));
      await openItem(page, title, pdf.id);
      assert.equal((await observe(page, paper.id)).leave.status, 'allowed');
      assert.deepEqual(canonicalState(await readOn(page, paper.id)), canonicalState(contentBefore));
      assert.deepEqual(new EditGraph((await readOn(page, catalog.id)).checkpoint).snapshot(batch.id), deletedCatalog);

      stage(`${host ? 'Web' : 'Native'}: remote logical deletion cancels an admitted placement gesture`);
      const gesturePaper = gesturePapers[host]; await openItem(page, `Sticky gesture paper ${host}`, gesturePaper.id);
      const beforeGesture = await synchronize(page, gesturePaper.id); await rendered(page, gesturePaper.pages[0]);
      const tool = page.getByRole('button', { name: '付箋を貼る', exact: true });
      if (await tool.getAttribute('aria-pressed') !== 'true') await tool.click();
      const placementStart = await point(page, .6, .35); await page.mouse.move(placementStart.x, placementStart.y); await page.mouse.down();
      try {
        const admitted = await waitForSnapshot(() => observe(page, gesturePaper.id), value => value.document!.inputActive);
        assert.equal(admitted.leave.status, 'refused'); assert.equal(await form(page).count(), 0);
        assert.equal(admitted.document!.surfaces[gesturePaper.pages[0].id]?.annotationDraft ?? null, null);
        const libraryRead = await readOn(page, repository.scope.libraryId); assert.equal(libraryRead.heads.length, 1);
        const source = new EditGraph(libraryRead.checkpoint).snapshot(libraryRead.heads[0]); assert.ok(source?.kind === 'library');
        const content = await readOn(page, gesturePaper.id); assert.deepEqual(canonicalState(content), canonicalState(beforeGesture.state));
        const deletion: LibraryEditBatch = { kind: 'library', id: crypto.randomUUID(), libraryId: source.id, targetId: source.id,
          parents: [source.version], changes: deleteLibraryItems(source, { id: crypto.randomUUID(), itemIds: [gesturePaper.id],
            childNotes: 'detach', observed: { [gesturePaper.id]: content.heads } }) };
        const expected = applyBatch(source, deletion);
        await publishRemote(page, deletion);
        // Keep the actual mouse contact held. The production periodic sync must
        // receive the deletion; another UI click would release that contact.
        await page.getByRole('status').filter({ hasText: 'この資料は削除されています（閲覧のみ）' }).waitFor();
        const canceled = await idle(page, gesturePaper.id);
        assert.equal(canceled.leave.status, 'allowed'); assert.equal(await form(page).count(), 0);
        assert.equal(canceled.document!.surfaces[gesturePaper.pages[0].id]?.annotationDraft ?? null, null);
        assert.deepEqual(canonicalState(canceled.state), canonicalState(content), 'deletion-driven gesture cancellation persists no annotation or history');
        assert.equal(await page.locator('[data-annotation-preview]').count(), 0);
        const catalogRead = (await observe(page, source.id)).state;
        assert.deepEqual(catalogRead.heads, [deletion.id]); assert.deepEqual(new EditGraph(catalogRead.checkpoint).snapshot(deletion.id), expected);
        await page.mouse.up();
        assert.deepEqual(canonicalState((await observe(page, gesturePaper.id)).state), canonicalState(content), 'the late physical pointerup cannot create an annotation');
        await openItem(page, title, pdf.id);
        assert.equal((await observe(page, gesturePaper.id)).leave.status, 'allowed');
        assert.deepEqual(canonicalState(await readOn(page, gesturePaper.id)), canonicalState(content));
        assert.deepEqual(new EditGraph((await readOn(page, source.id)).checkpoint).snapshot(deletion.id), expected);
      } finally { await page.mouse.up(); }

      stage(`${host ? 'Web' : 'Native'}: remote deletion during real save-preflight I/O refuses persistence`);
      const preflightPaper = preflightPapers[host]; await openItem(page, `Sticky preflight paper ${host}`, preflightPaper.id);
      const beforePreflight = await synchronize(page, preflightPaper.id); await rendered(page, preflightPaper.pages[0]);
      await place(page); const preflightText = `Retain preflight draft ${host}`;
      await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).fill(preflightText);
      const preflightDraft = (await observe(page, preflightPaper.id)).document!.surfaces[preflightPaper.pages[0].id].annotationDraft; assert.ok(preflightDraft);
      const readIntent = () => page.evaluate(id => (window as unknown as { compositionReadIntent(id: string): Promise<unknown> }).compositionReadIntent(id), preflightPaper.id);
      assert.equal(await readIntent(), undefined);
      await page.evaluate(id => (window as unknown as { compositionHoldAnnotationPreflightRead(id: string): void }).compositionHoldAnnotationPreflightRead(id), preflightPaper.id);
      try {
        await form(page).getByRole('button', { name: '確定', exact: true }).click();
        const held = await waitForSnapshot(() => page.evaluate(() => (window as unknown as {
          compositionAnnotationPreflightTiming(): { id: string; captured: boolean; completed: boolean; released: boolean; caller: string } | null;
        }).compositionAnnotationPreflightTiming()), value => !!value?.captured && value.completed && !value.released);
        assert.equal(held!.id, preflightPaper.id); assert.match(held!.caller, /commitAnnotationDraft/);
        assert.equal(await readIntent(), undefined, 'held preflight has not created a journal or pending writer');
        const libraryRead = await readOn(page, repository.scope.libraryId); assert.equal(libraryRead.heads.length, 1);
        const source = new EditGraph(libraryRead.checkpoint).snapshot(libraryRead.heads[0]); assert.ok(source?.kind === 'library');
        const content = await readOn(page, preflightPaper.id); assert.deepEqual(canonicalState(content), canonicalState(beforePreflight.state));
        const deletion: LibraryEditBatch = { kind: 'library', id: crypto.randomUUID(), libraryId: source.id, targetId: source.id,
          parents: [source.version], changes: deleteLibraryItems(source, { id: crypto.randomUUID(), itemIds: [preflightPaper.id],
            childNotes: 'detach', observed: { [preflightPaper.id]: content.heads } }) };
        const expected = applyBatch(source, deletion);
        await publishRemote(page, deletion); await pull(page, source.id, deletion.id);
        await page.getByRole('status').filter({ hasText: 'この資料は削除されています（閲覧のみ）' }).waitFor();
        // The one captured save read stays held; independent catalog/corpus
        // reads have already adopted the actual ordinary deletion above.
        assert.equal(await readIntent(), undefined);
        assert.deepEqual((await observe(page, preflightPaper.id)).document!.surfaces[preflightPaper.pages[0].id].annotationDraft, preflightDraft);
        await page.evaluate(() => (window as unknown as { compositionReleaseAnnotationPreflightRead(): void }).compositionReleaseAnnotationPreflightRead());
        await page.getByRole('alert').filter({ hasText: '注釈を保存できません。入力内容を保持しています。' }).waitFor();
        const refused = await observe(page, preflightPaper.id);
        assert.deepEqual(refused.document!.surfaces[preflightPaper.pages[0].id].annotationDraft, preflightDraft);
        assert.equal(await form(page).getByRole('textbox', { name: '付箋のメモ', exact: true }).inputValue(), preflightText);
        assert.equal(refused.document!.phase, 'idle'); assert.equal(refused.document!.inputActive, true); assert.equal(refused.leave.status, 'refused');
        assert.deepEqual(canonicalState(refused.state), canonicalState(content), 'fresh-read admission refusal creates no annotation batch or history');
        assert.equal(await readIntent(), undefined, 'a changed UI admission never becomes a pending journal');
        assert.equal(await form(page).getByRole('button', { name: '確定', exact: true }).isDisabled(), true);
        assert.equal(await form(page).getByRole('button', { name: 'キャンセル', exact: true }).isEnabled(), true);
        await form(page).getByRole('button', { name: 'キャンセル', exact: true }).click();
        const canceled = await idle(page, preflightPaper.id); assert.equal(canceled.leave.status, 'allowed');
        assert.deepEqual(canonicalState(canceled.state), canonicalState(content)); assert.equal(await readIntent(), undefined);
        const afterCatalog = (await observe(page, source.id)).state;
        assert.deepEqual(afterCatalog.heads, [deletion.id]); assert.deepEqual(new EditGraph(afterCatalog.checkpoint).snapshot(deletion.id), expected);
        await openItem(page, title, pdf.id);
        assert.deepEqual(canonicalState(await readOn(page, preflightPaper.id)), canonicalState(content));
        assert.deepEqual(new EditGraph((await readOn(page, source.id)).checkpoint).snapshot(deletion.id), expected);
      } finally {
        await page.evaluate(() => (window as unknown as { compositionReleaseAnnotationPreflightRead(): void }).compositionReleaseAnnotationPreflightRead());
      }
    }
    await finish();
  } catch (error) {
    console.error('Sticky annotation acceptance error', error);
    for (const page of pages) {
      console.error('Sticky annotation acceptance state', page.url(), await page.locator('body').innerText().catch(String));
      console.error('sticky-readonly-probes-on-failure', JSON.stringify(await page.evaluate(() => {
        const holder=window as unknown as {stickyReadonlyProbes?:Record<string,{collect():ReadonlyProbeDump}>;
          compositionStartupEvidence?:()=>{nativeTransport?:{originEpochMs?:number;replication?:unknown[];replicationDropped?:number}}};
        const transport=holder.compositionStartupEvidence?.().nativeTransport;
        return {probes:Object.values(holder.stickyReadonlyProbes??{}).map(probe=>probe.collect()),nativeReplicationAfterRelease:transport&&{capturedEpochMs:Date.now(),originEpochMs:transport.originEpochMs,events:transport.replication?.slice(-64),dropped:transport.replicationDropped}};
      }).catch(String)));
    }
    throw error;
  }
});
