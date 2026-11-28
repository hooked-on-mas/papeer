import { createRoot } from 'react-dom/client';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { PdfSurface, type PdfDocumentObservation } from '../../src/features/reader/pdf/PdfSurface';
import { useDocumentPdfAsset } from '../../src/features/reader/useDocumentPdfAsset';
import { ReaderSession, type ReaderStatePort, type ReaderViewport, type SavedReaderState } from '../../src/features/reader/ReaderSession';
import { BrowserReaderStatePort } from '../../src/adapters/browser/readerState';
import { CanonicalPageAnnotations } from '../../src/features/reader/annotations/CanonicalPageAnnotations';
import { captureCanonicalPdfHighlight, canonicalPdfHighlightCaptureProblem,
  type CanonicalPdfTextBinding, type CanonicalPdfHighlightCapture } from '../../src/features/reader/pdf/canonicalPdfHighlight';
import type { ContentRepository, EditScope } from '../../src/runtime/edits/ports';
import type { DocumentSnapshot, Page, TextHighlight } from '../../src/runtime/edits/contracts';
import type { PdfSpikeOracle, PdfSpikeSnapshot, PdfSpikeCapture, PdfSpikeLiveDom } from '../support/canonicalPdfSurfaceTypes';
import '../../src/index.css';

const oracle = await (await fetch('/canonical-pdf-spike/config')).json() as PdfSpikeOracle;
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'normal';
const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const documentId = id(100), libraryId = id(101);
const spikeInputBundle = Object.freeze({ kind: 'canonical-managed' as const });
const initialPhysical = scenario === 'minfit' ? 2 : 1;
const initialPageId = scenario === 'bad-page' ? id(199) : id(initialPhysical);
const initialScale = .5; // Valid for the tall page; deliberately below landscape min-fit.
const metadata = structuredClone(oracle.metadata);
if (scenario === 'bad-count') metadata.pdfPages!.pop();
if (scenario === 'false-dimensions') metadata.pdfPages![0].heightPt += 800;

type ReadRecord = PdfSpikeSnapshot['reads'][number];
const reads: ReadRecord[] = [], pending: { record: ReadRecord; release(): void }[] = [];
let holdReads = scenario === 'hold-first';
let notify = () => {};
let readSnapshot: (() => PdfSpikeSnapshot) | null = null;
// The only exposed API is a clone of observations. No authority, setter, proof,
// Range, PDF.js object, source capture or mutable state crosses this boundary.
Object.defineProperty(window, 'canonicalPdfSpikeSnapshot', { configurable: false, writable: false,
  value: () => { if (!readSnapshot) throw new Error('fixture-not-ready'); return structuredClone(readSnapshot()); } });

function makePage(physicalPage: number, pageId: string, hash: string): Page {
  const size = metadata.pdfPages?.[physicalPage - 1] ?? oracle.metadata.pdfPages![0];
  return { id: pageId, backgroundRevision: id((hash === oracle.metadata.sha256 ? 1000 : 6000) + physicalPage), lifecycleVersion: id(2000 + physicalPage), annotationVersion: id(3000 + physicalPage),
    widthPt: size.widthPt, heightPt: size.heightPt,
    background: { kind: 'pdf', resourceId: metadata.id, sourceRevision: hash, pdfPage: physicalPage }, annotations: [] };
}
function makeDocument(hash: string): DocumentSnapshot {
  return { kind: 'document', id: documentId, version: id(hash === oracle.metadata.sha256 ? 102 : 103), deletedPages: [],
    pages: [...oracle.pages.map(page => makePage(page.physicalPage, id(page.physicalPage), hash)),
      makePage(1, id(150), hash), makePage(999, id(199), hash)] };
}
function releaseOldest() {
  const entry = pending.shift(); if (entry) entry.release(); notify();
}
function resumeReads() { holdReads = false; while (pending.length) releaseOldest(); }

// Observe the live renderer even before it publishes a text binding. Absence of
// a binding is not evidence that its actual text layer contains no DOM nodes.
const diagnosticNodes = new WeakMap<Node, number>();
let diagnosticNodeSequence = 0;
function diagnosticNodeId(node: Node | null): number | null {
  if (!node) return null;
  let value = diagnosticNodes.get(node);
  if (value === undefined) { value = ++diagnosticNodeSequence; diagnosticNodes.set(node, value); }
  return value;
}
function liveDom(pane: HTMLElement | null, pixelRatio: number): PdfSpikeLiveDom {
  const page = pane?.querySelector<HTMLElement>('.react-pdf__Page');
  const layer = pane?.querySelector('.textLayer'), canvas = pane?.querySelector('canvas');
  const surface = pane?.querySelector<HTMLElement>('[data-pdf-surface]');
  const layerStructure: PdfSpikeLiveDom['layerStructure'] = [];
  const visit = (node: Node) => {
    layerStructure.push({ id: diagnosticNodeId(node)!, parent: diagnosticNodeId(node.parentNode), kind: node.nodeName, text: node.textContent });
    node.childNodes.forEach(visit);
  };
  if (layer) visit(layer);
  return { pages: pane?.querySelectorAll('.react-pdf__Page').length ?? 0,
    layers: pane?.querySelectorAll('.textLayer').length ?? 0,
    ends: layer?.querySelectorAll('.endOfContent').length ?? 0,
    spans: layer?.querySelectorAll('span[role="presentation"]').length ?? 0,
    breaks: layer?.querySelectorAll('br[role="presentation"]').length ?? 0,
    marked: layer?.querySelectorAll('.markedContent').length ?? 0,
    text: layer?.textContent ?? '', canvasWidth: canvas?.width ?? 0, canvasHeight: canvas?.height ?? 0,
    dpr: window.devicePixelRatio, pixelRatio, pageNode: diagnosticNodeId(page ?? null), layerNode: diagnosticNodeId(layer ?? null),
    layerStructure, paneClient: { width: pane?.clientWidth ?? 0, height: pane?.clientHeight ?? 0 },
    surfaceInlineWidth: surface?.style.width ?? '', canvasInlineWidth: canvas?.style.width ?? '', previewZoom: surface?.parentElement?.style.zoom ?? '' };
}

function Fixture() {
  const [, rerender] = useState(0);
  const [scopeName, setScopeName] = useState('A'), [attempt, setAttempt] = useState(0);
  const [model, setModel] = useState(() => makeDocument(oracle.metadata.sha256));
  const [binding, setBinding] = useState<CanonicalPdfTextBinding | null>(null);
  const [overlays, setOverlays] = useState<TextHighlight[]>([]);
  const [overlayOwner, setOverlayOwner] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [workerRelease, setWorkerRelease] = useState({ phase: 'idle', error: '' });
  const [fontRelease, setFontRelease] = useState({ phase: 'idle', error: '' });
  const paneRef = useRef<HTMLDivElement>(null), scopeRef = useRef<HTMLDivElement>(null);
  const bindingRef = useRef<CanonicalPdfTextBinding | null>(null), captureRef = useRef<CanonicalPdfHighlightCapture | null>(null);
  const diagnosticTuple = useRef<PdfSpikeSnapshot['diagnostics']['tuple'] | null>(null);
  const diagnosticLog = useRef({ domMutations: 0, domHistory: [] as PdfSpikeSnapshot['diagnostics']['domHistory'],
    callbacks: [] as PdfSpikeSnapshot['diagnostics']['callbacks'], fontEvents: [] as PdfSpikeSnapshot['diagnostics']['fontEvents'] });
  const captureProbes = useRef<PdfSpikeSnapshot['diagnostics']['captureProbes']>([]);
  const tokenNumbers = useRef(new WeakMap<object, number>()), tokenSequence = useRef(0);
  const observations = useRef({ documentCallbacks: 0, documentInstances: 0, instances: new WeakSet<object>(),
    documentResourceKeys: [] as string[], urls: [] as string[], lastUrl: null as string | null,
    tokens: new WeakSet<object>(), readyByPage: {} as Record<string, number>,
    writes: [] as SavedReaderState[], metrics: [] as PdfSpikeSnapshot['metrics'], capture: null as PdfSpikeCapture | null, captureAttempts: 0,
    admission: null as string | null, admissionChecks: 0,
    admissionHistory: [] as PdfSpikeSnapshot['admissionHistory'], injectedFaults: [] as string[], fontErrors: [] as string[] });
  const scope = useMemo<EditScope>(() => ({ accountId: `pdf-spike-${scopeName}`, libraryId, epoch: 'real-renderer-v1' }), [scopeName]);
  const resources = useMemo<Pick<ContentRepository, 'scope' | 'readResource'>>(() => ({ scope,
    async readResource(resourceId) {
      const record: ReadRecord = { sequence: reads.length + 1, scope: scope.accountId, resourceId, held: holdReads, completed: false };
      reads.push(record);
      const gate = holdReads ? new Promise<void>(release => { pending.push({ record, release }); }) : Promise.resolve();
      notify();
      // Actual HTTP bytes flow through the real resource read/hash policy. Only
      // this port controls completion; PDF.js methods/promises are untouched.
      const response = await fetch(`/canonical-pdf-spike/resource?scope=${encodeURIComponent(scope.accountId)}&read=${record.sequence}`);
      if (!response.ok) throw new Error('fixture-resource-read-failed');
      const bytes = new Uint8Array(await response.arrayBuffer());
      await gate;
      record.completed = true; notify();
      return { bytes, metadata: structuredClone(metadata) };
    },
  }), [scope]);
  const persistence = useMemo<ReaderStatePort>(() => {
    const delegate = new BrowserReaderStatePort(scope, window.localStorage);
    const initialBackgroundRevision = makePage(scenario === 'bad-page' ? 999 : initialPhysical, initialPageId, oracle.metadata.sha256).backgroundRevision;
    if (!delegate.read(documentId)) delegate.write(documentId, { version: 1, pageId: initialPageId,
      zoom: { kind: 'scale', value: initialScale }, placement: 'center', positions: {}, back: [], forward: [],
      activeSurface: 'original', display: 'original', translatedOnly: false, surfacePageId: initialPageId,
      landing: { toEnd: false, place: null, backgroundRevision: initialBackgroundRevision } });
    return { scope, read: value => delegate.read(value), write: (value, state) => {
      delegate.write(value, state); observations.current.writes.push(structuredClone(state));
    } };
  }, [scope]);
  const reader = useMemo(() => new ReaderSession({ scope, documentId, persistence, canNavigate: () => true }), [scope, persistence]);
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useLayoutEffect(() => { reader.reconcileDocument(model); }, [reader, model]);
  useLayoutEffect(() => () => reader.flush(), [reader]);
  useLayoutEffect(() => { notify = () => rerender(value => value + 1); return () => { notify = () => {}; }; }, []);
  useLayoutEffect(() => {
    const fonts = document.fonts;
    const face = (value: FontFace) => ({ family: value.family, status: value.status, style: value.style, weight: value.weight });
    const record = (event?: Event) => {
      diagnosticLog.current.fontEvents.push({ at: performance.now(), kind: event?.type ?? 'initial', status: fonts.status,
        faces: Array.from(fonts, face), affected: event ? Array.from((event as FontFaceSetLoadEvent).fontfaces ?? [], face) : [] });
    };
    record();
    fonts.addEventListener('loading', record); fonts.addEventListener('loadingdone', record); fonts.addEventListener('loadingerror', record);
    return () => {
      fonts.removeEventListener('loading', record); fonts.removeEventListener('loadingdone', record); fonts.removeEventListener('loadingerror', record);
    };
  }, []);
  const page = reader.resolvePage('original');
  const loaded = useDocumentPdfAsset(resources, page, attempt);
  diagnosticTuple.current = { scope: scope.accountId, attempt, pageId: page?.id ?? null,
    backgroundRevision: page?.backgroundRevision ?? null, physicalPage: page?.background.kind === 'pdf' ? page.background.pdfPage : 0,
    sourceHash: page?.background.kind === 'pdf' ? page.background.sourceRevision : '', url: loaded.asset?.url ?? null };
  useLayoutEffect(() => {
    const pane = paneRef.current; if (!pane) return;
    const observer = new MutationObserver(records => {
      const tuple = diagnosticTuple.current; if (!tuple) return;
      const log = diagnosticLog.current;
      log.domMutations++;
      log.domHistory.push({ sequence: log.domMutations, at: performance.now(), mutations: records.length,
        tuple: { ...tuple }, dom: liveDom(pane, bindingRef.current?.pixelRatio ?? 0) });
      // A bounded diagnostic tail, with the total sequence retained. Reading or
      // recording it never schedules React work or changes renderer callbacks.
      if (log.domHistory.length > 200) log.domHistory.shift();
    });
    observer.observe(pane, { subtree: true, childList: true, characterData: true, attributes: true });
    return () => observer.disconnect();
  }, []);
  // Record every public URL appearance after an invalid/empty asset interval,
  // including reappearance of a previously retired URL. A Set would conceal it.
  if (loaded.asset) {
    if (observations.current.lastUrl !== loaded.asset.url) observations.current.urls.push(loaded.asset.url);
    observations.current.lastUrl = loaded.asset.url;
  } else observations.current.lastUrl = null;
  const metrics = useCallback((value: ReaderViewport) => {
    const current = reader.resolvePage('original'); if (!current) return;
    observations.current.metrics.push({ pageId: current.id, ...value });
    reader.setViewport(current.id, value);
  }, [reader]);
  const observed = useCallback((event: PdfDocumentObservation) => {
    diagnosticLog.current.callbacks.push({ at: performance.now(), kind: 'document-observed', value: event.resourceKey });
    const log = observations.current;
    log.documentCallbacks++;
    if (!log.instances.has(event.instance)) { log.instances.add(event.instance); log.documentInstances++; }
    if (!log.documentResourceKeys.includes(event.resourceKey)) log.documentResourceKeys.push(event.resourceKey);
    notify();
  }, []);
  const textSurface = useCallback((value: CanonicalPdfTextBinding | null) => {
    diagnosticLog.current.callbacks.push({ at: performance.now(), kind: 'text-surface', value: value
      ? JSON.stringify([value.asset.binding.pageId, value.asset.binding.backgroundRevision, value.asset.url]) : 'null',
      ...(value ? { drawing: { drawnWidth: value.drawnWidth, pixelRatio: value.pixelRatio,
        viewportWidth: value.renderViewport.width, viewportHeight: value.renderViewport.height } } : {}) });
    bindingRef.current = value;
    const log = observations.current;
    if (value && !log.tokens.has(value.renderToken)) {
      log.tokens.add(value.renderToken);
      log.readyByPage[value.asset.binding.pageId] = (log.readyByPage[value.asset.binding.pageId] ?? 0) + 1;
    }
    setBinding(value);
  }, []);
  const capture = () => {
    const current = bindingRef.current, selection = window.getSelection();
    let atStart: Record<string, unknown>;
    try {
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      let token = current ? tokenNumbers.current.get(current.renderToken) : undefined;
      if (current && token === undefined) { token = ++tokenSequence.current; tokenNumbers.current.set(current.renderToken, token); }
      atStart = { time: performance.now(), attempt: observations.current.captureAttempts + 1,
        current: current?.isCurrent() ?? false, token: token ?? null, fonts: document.fonts.status,
        rangeCount: selection?.rangeCount ?? 0, startNode: diagnosticNodeId(range?.startContainer ?? null),
        startOffset: range?.startOffset ?? null, endNode: diagnosticNodeId(range?.endContainer ?? null), endOffset: range?.endOffset ?? null };
    } catch (error) { atStart = { error: String(error) }; }
    const result = current && selection?.rangeCount ? captureCanonicalPdfHighlight({ binding: current, range: selection.getRangeAt(0) })
      : { status: 'refused' as const, reason: 'stale-render' };
    try {
    const diagnosticRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const atEnd = { time: performance.now(), current: current?.isCurrent() ?? false };
    queueMicrotask(() => {
    try {
      const range = diagnosticRange;
      const rect = (value: DOMRect) => ({ x: value.x, y: value.y, width: value.width, height: value.height });
      const span = (node: Node | null) => {
        const element = node instanceof Element ? node.closest('span') : node?.parentElement?.closest('span');
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        const text = element.textContent;
        const textItemCandidates = current?.textContent.items.flatMap((item, index) => 'str' in item && item.str === text
          ? [{ index, text: item.str, width: item.width, height: item.height, fontName: item.fontName, transform: [...item.transform] }] : []) ?? [];
        return { text, rect: rect(element.getBoundingClientRect()), offsetWidth: element.offsetWidth, clientWidth: element.clientWidth,
          fontFamily: style.fontFamily, fontSize: style.fontSize, letterSpacing: style.letterSpacing, transform: style.transform,
          scaleX: style.getPropertyValue('--scale-x'), fontHeight: style.getPropertyValue('--font-height'),
          totalScaleFactor: style.getPropertyValue('--total-scale-factor'), minFontSize: style.getPropertyValue('--min-font-size'),
          textItemCandidates };
      };
      captureProbes.current.push({ atStart, atEnd, sampledAt: performance.now(), diagnosticDelayMs: performance.now() - atEnd.time, status: result.status, range: range ? {
        startNode: diagnosticNodeId(range.startContainer), startOffset: range.startOffset,
        endNode: diagnosticNodeId(range.endContainer), endOffset: range.endOffset,
        rects: [...range.getClientRects()].map(rect), bounds: rect(range.getBoundingClientRect()),
        startSpan: span(range.startContainer), endSpan: span(range.endContainer) } : null,
        canvas: current ? rect(current.canvas.getBoundingClientRect()) : null,
        canvasComputedSize: current ? { width: getComputedStyle(current.canvas).width, height: getComputedStyle(current.canvas).height } : null,
        page: current ? rect(current.pageElement.getBoundingClientRect()) : null,
        textLayer: current ? rect(current.textLayer.getBoundingClientRect()) : null,
        textLayerInlineMinFontSize: current?.textLayer.style.getPropertyValue('--min-font-size') ?? null,
        binding: current ? { drawnWidth: current.drawnWidth, pixelRatio: current.pixelRatio,
          current: current.isCurrent(), natural: { width: current.naturalViewport.width, height: current.naturalViewport.height,
            transform: [...current.naturalViewport.transform] }, render: { width: current.renderViewport.width,
            height: current.renderViewport.height, transform: [...current.renderViewport.transform] } } : null,
        dpr: window.devicePixelRatio, fonts: document.fonts.status });
    } catch (error) { captureProbes.current.push({ error: String(error) }); }
    if (captureProbes.current.length > 2) captureProbes.current.shift();
    });
    } catch (error) {
      captureProbes.current.push({ atStart, error: String(error) });
      if (captureProbes.current.length > 2) captureProbes.current.shift();
    }
    captureRef.current = result.status === 'ready' ? result.capture : null;
    observations.current.capture = result.status === 'ready' ? { status: 'ready', quote: result.capture.quote,
      quads: result.capture.quads.map(quad => quad.map(point => ({ ...point }))), anchor: { ...result.capture.anchor },
      pageId: result.capture.pageId, backgroundRevision: result.capture.backgroundRevision, range: { kind: 'unindexed' } } : result;
    observations.current.captureAttempts++;
    notify();
  };
  const admission = () => {
    const source = captureRef.current, current = bindingRef.current;
    const problem = source && current ? canonicalPdfHighlightCaptureProblem(source, current) : 'stale-render';
    observations.current.admission = problem;
    observations.current.admissionChecks++;
    observations.current.admissionHistory.push({ check: observations.current.admissionChecks,
      captureAttempt: observations.current.captureAttempts, problem });
    if (observations.current.admissionHistory.length > 2) observations.current.admissionHistory.shift();
    notify(); return problem;
  };
  const previewCapture = () => {
    if (admission()) return;
    const source = captureRef.current; if (!source) return;
    // Presentation only. No edit session, draft, journal, batch or writer is
    // instantiated; the ephemeral proof/token never enters the annotation.
    setOverlayOwner(`${source.source.scope.accountId}:${source.pageId}:${source.backgroundRevision}`);
    setOverlays([{ kind: 'highlight', id: id(9000), quote: source.quote, text: '', color: '#f59e0b',
      backgroundRevision: source.backgroundRevision, range: { kind: 'unindexed' }, anchor: { ...source.anchor },
      quads: source.quads.map(quad => quad.map(point => ({ ...point }))), metadata: { label: '', createdAt: null } }]);
  };
  const fault = (kind: 'replace-node' | 'clear-layer' | 'skew-wrapper') => {
    const current = bindingRef.current; if (!current) return;
    if (kind === 'replace-node') {
      const first = current.textLayer.querySelector('span[role="presentation"]')?.firstChild;
      if (first?.nodeType === Node.TEXT_NODE) first.parentNode?.replaceChild(document.createTextNode(first.textContent ?? ''), first);
    } else if (kind === 'clear-layer') current.textLayer.replaceChildren();
    else {
      const wrapper = document.createElement('div'); wrapper.style.transform = 'skewX(5deg)';
      current.pageElement.insertBefore(wrapper, current.canvas); wrapper.append(current.canvas, current.textLayer);
    }
    observations.current.injectedFaults.push(kind); notify();
  };
  const loadFont = () => {
    const face = new FontFace('CanonicalSpikeHeld', 'url("/canonical-pdf-spike/font.woff2")');
    document.fonts.add(face);
    void face.load().catch(error => { observations.current.fontErrors.push(String(error)); notify(); });
  };
  const releaseWorker = async () => {
    setWorkerRelease({ phase: 'sending', error: '' });
    try {
      const response = await fetch('/canonical-pdf-spike/worker-release', { method: 'POST' });
      if (response.status !== 200) throw new Error(`worker-release-status:${response.status}`);
      const body = await response.json() as { released?: unknown };
      if (body.released !== true) throw new Error('worker-release-ack-missing');
      setWorkerRelease({ phase: 'done', error: '' });
    } catch (error) {
      setWorkerRelease({ phase: 'error', error: String(error) });
      console.error('pdf-spike-worker-release-failed:' + String(error));
    }
  };
  const releaseFont = async () => {
    setFontRelease({ phase: 'sending', error: '' });
    try {
      const response = await fetch('/canonical-pdf-spike/font-release', { method: 'POST' });
      if (response.status !== 200) throw new Error(`font-release-status:${response.status}`);
      const body = await response.json() as { released?: unknown };
      if (body.released !== true) throw new Error('font-release-ack-missing');
      setFontRelease({ phase: 'done', error: '' });
    } catch (error) {
      setFontRelease({ phase: 'error', error: String(error) });
      console.error('pdf-spike-font-release-failed:' + String(error));
    }
  };
  useLayoutEffect(() => {
    readSnapshot = () => {
      const log = observations.current, current = bindingRef.current;
      const tuple = diagnosticTuple.current!;
      return { scenario, scope: scope.accountId, attempt, expectedHash: page?.background.kind === 'pdf' ? page.background.sourceRevision : '',
        physicalPage: page?.background.kind === 'pdf' ? page.background.pdfPage : 0,
        asset: loaded.asset ? { url: loaded.asset.url, scope: loaded.asset.binding.scope.accountId,
          pageId: loaded.asset.binding.pageId, physicalPage: loaded.asset.binding.pdfPage,
          sourceHash: loaded.asset.binding.sourceRevision } : null, assetError: loaded.error,
        reader: reader.getSnapshot(), persisted: persistence.read(documentId) as SavedReaderState, writes: log.writes,
        metrics: log.metrics, reads, pendingReads: pending.length,
        documentCallbacks: log.documentCallbacks, documentInstances: log.documentInstances,
        documentResourceKeys: log.documentResourceKeys, urls: [...log.urls], readyByPage: log.readyByPage,
        textReady: !!current && current.isCurrent(), rasterReady: paneRef.current?.dataset.rendered === 'true', fonts: document.fonts.status,
        textItems: current?.textContent.items.flatMap(item => 'str' in item ? [{ str: item.str, dir: item.dir, hasEOL: item.hasEOL, transform: item.transform }] : []) ?? [],
        dom: liveDom(paneRef.current, current?.pixelRatio ?? 0),
        diagnostics: { tuple: { ...tuple }, textSurface: !current ? 'absent' : current.isCurrent() ? 'current' : 'stale',
          // The published binding contains no retry-attempt field; its URL is
          // observable, but attributing the current attempt to it would guess.
          bindingTuple: current ? { scope: current.asset.binding.scope.accountId, attempt: null, pageId: current.asset.binding.pageId,
            backgroundRevision: current.asset.binding.backgroundRevision, physicalPage: current.asset.binding.pdfPage,
            sourceHash: current.asset.binding.sourceRevision, url: current.asset.url } : null,
          domMutations: diagnosticLog.current.domMutations, domHistory: diagnosticLog.current.domHistory,
          callbacks: diagnosticLog.current.callbacks, fontEvents: diagnosticLog.current.fontEvents, captureProbes: captureProbes.current },
        capture: log.capture, captureAttempts: log.captureAttempts, admission: log.admission, admissionChecks: log.admissionChecks,
        admissionHistory: log.admissionHistory,
        overlays: overlays.length, injectedFaults: log.injectedFaults, fontErrors: log.fontErrors };
    };
    return () => { readSnapshot = null; };
  }, [scope, attempt, page, loaded, reader, persistence, binding, overlays]);
  const shown = page && { ...page, annotations: [...page.annotations,
    ...(overlayOwner === `${scope.accountId}:${page.id}:${page.backgroundRevision}` ? overlays : [])] };
  const keepSelection = (event: MouseEvent) => event.preventDefault();
  return <main style={{ padding: 12, height: '100vh', display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div role="toolbar" aria-label="Real Reader commands" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <select aria-label="Logical page" value={state.pageId} onChange={event => reader.jump(event.target.value)}>
        {model.pages.map(value => <option key={value.id} value={value.id}>{value.id === id(150) ? 'Physical 1 alias' : value.id === id(199) ? 'Invalid physical page' : `Physical ${value.background.kind === 'pdf' ? value.background.pdfPage : 0}`}</option>)}
      </select>
      <button onClick={() => reader.history('back')}>Reader back</button><button onClick={() => reader.history('forward')}>Reader forward</button>
      <select aria-label="Reader scale" value={reader.numericZoom} onChange={event => reader.setZoom(Number(event.target.value) === 0 ? { kind: 'fit-page' } : { kind: 'scale', value: Number(event.target.value) })}>
        {[0, .5, .75, 1, 1.5, 2].map(value => <option key={value} value={value}>{value}</option>)}
      </select>
      <button onClick={() => reader.flush()}>Flush Reader preferences</button>
      <button onClick={() => setAttempt(value => value + 1)}>Retry resource</button>
      <button onClick={() => setScopeName(value => value === 'A' ? 'B' : 'A')}>Switch scope</button>
      <button onClick={() => { holdReads = true; notify(); }}>Hold future reads</button>
      <button onClick={releaseOldest}>Release oldest read</button><button onClick={resumeReads}>Resume reads</button>
      <button disabled={workerRelease.phase === 'sending' || workerRelease.phase === 'done'} onClick={releaseWorker}>Release PDF worker</button>
      {workerRelease.phase === 'done' && <output role="status" aria-label="PDF worker release">PDF worker released</output>}
      {workerRelease.phase === 'error' && <p role="alert">PDF worker release failed: {workerRelease.error}</p>}
      <button onClick={() => setModel(makeDocument('0'.repeat(64)))}>Use stale source hash</button>
      <button onClick={() => setModel(makeDocument(oracle.metadata.sha256))}>Use valid source hash</button>
      <button onClick={() => setModel(value => ({ ...value, version: id(104), pages: value.pages.map(candidate => candidate.id === state.pageId ? {
        ...candidate, annotationVersion: id(8000), annotations: [{ kind: 'sticky', id: id(8001), text: 'read model only', anchor: { x: 40, y: 40 }, color: null,
          metadata: { label: '', createdAt: null } }] } : candidate) }))}>Apply annotation-only read model</button>
      <button onClick={() => setNarrow(value => !value)}>Resize pane</button>
    </div>
    <div role="toolbar" aria-label="Geometry spike controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <button onMouseDown={keepSelection} onClick={capture}>Capture selection</button>
      <button onMouseDown={keepSelection} onClick={admission}>Check capture admission</button>
      <button onMouseDown={keepSelection} onClick={previewCapture}>Show captured overlay</button>
      <button onClick={loadFont}>Start held font</button><button disabled={fontRelease.phase === 'sending' || fontRelease.phase === 'done'} onClick={releaseFont}>Release font</button>
      {fontRelease.phase === 'done' && <output role="status" aria-label="Font release">Font released</output>}
      {fontRelease.phase === 'error' && <p role="alert">Font release failed: {fontRelease.error}</p>}
      <button onClick={() => fault('replace-node')}>Fault replace equal Text node</button>
      <button onClick={() => fault('clear-layer')}>Fault clear text layer</button>
      <button onClick={() => fault('skew-wrapper')}>Fault skew wrapper</button>
    </div>
    <output aria-label="Fixture readiness">{binding?.isCurrent() ? 'text-ready' : loaded.error ? 'refused' : 'waiting'}</output>
    <section aria-label="Actual canonical PDF surface" style={{ minHeight: 0, flex: 1, width: narrow ? '55%' : '100%' }}>
      <PdfSurface inputBundle={spikeInputBundle} asset={loaded.asset} assetError={loaded.error} retryAsset={() => setAttempt(value => value + 1)}
        zoom={reader.numericZoom} paneRef={paneRef} scopeRef={scopeRef}
        pointer={{ zoom: { get: () => reader.numericZoom, set: value => reader.setZoom(value === 0 ? { kind: 'fit-page' } : { kind: 'scale', value }) }, activate: () => {} }}
        onMetrics={metrics} onPdfTextSurface={textSurface} onDocumentObserved={observed}
        renderOverlay={() => shown && <CanonicalPageAnnotations page={shown} includeInk={false} />} />
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
