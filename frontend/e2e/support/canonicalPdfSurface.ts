import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit, type Page as BrowserPage, type Request, type BrowserServer } from 'playwright-core';
import type { PdfSpikeOracle, PdfSpikeSnapshot } from './canonicalPdfSurfaceTypes.ts';

type ResourceWaitClock = { calibration: boolean; readyBudgetMs: number; startedEpochMs: number; deadlineEpochMs: number; nodeSampleEpochMs?: number; nodeSampleMonotonicMs?: number; browserTimeOrigin?: number; browserNow?: number; error?: string };
const warmupScenePages = new WeakMap<BrowserPage, { clocks: ResourceWaitClock[]; readyBudgetMs: number; caseDeadline?: number; calibration: boolean }>();

export const pageId = (physical: number) => `00000000-0000-4000-8000-${String(physical).padStart(12, '0')}`;
export type PdfSpikeEngine = 'chromium' | 'webkit';
/** Preserve the primary failure and every cleanup failure without requiring ES2021 AggregateError. */
class PreparationCleanupError extends Error {
  readonly errors: readonly unknown[];
  readonly cause: unknown;
  constructor(message: string, errors: readonly unknown[]) {
    super(message); this.name = 'PreparationCleanupError'; this.errors = [...errors]; this.cause = errors[0];
    if (errors[0] instanceof Error && errors[0].stack) this.stack += `\nCaused by: ${errors[0].stack}`;
  }
}
const frontend = path.resolve(import.meta.dirname, '../..'), root = path.resolve(frontend, '..');

export const snapshot = (page: BrowserPage) => page.evaluate(() =>
  (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot());
// Return the sample that passed readiness. A later font event may invalidate
// it; this does not promise continuous readiness until the next UI operation.
const remaining = (deadline?: number) => {
  if (deadline === undefined) return 25_000;
  const time = deadline - Date.now();
  if (time <= 0) throw new Error('geometry-readiness-budget-exhausted');
  return time;
};
export async function ready(page: BrowserPage, physical?: number, afterDrawing?: PdfSpikeSnapshot, deadline?: number) {
  const started = Date.now(), settings = warmupScenePages.get(page), readyBudgetMs = settings?.readyBudgetMs ?? 25_000;
  const effectiveDeadline = Math.min(deadline ?? started + readyBudgetMs, started + readyBudgetMs, settings?.calibration ? settings.caseDeadline ?? Infinity : Infinity);
  const resourceWaitClocks = settings?.clocks;
  const clock: ResourceWaitClock | undefined = settings ? { calibration: settings.calibration, readyBudgetMs, startedEpochMs: started, deadlineEpochMs: effectiveDeadline } : undefined;
  if (clock && resourceWaitClocks) {
    resourceWaitClocks.push(clock); if (resourceWaitClocks.length > 200) resourceWaitClocks.shift();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sample = await Promise.race([page.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now() })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('resource-clock-sample-timeout')), remaining(effectiveDeadline)); })]);
      clock.nodeSampleEpochMs = Date.now(); clock.nodeSampleMonotonicMs = performance.now();
      clock.browserTimeOrigin = sample.timeOrigin; clock.browserNow = sample.now;
    } catch (error) { clock.error = String(error); throw error; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const accepted = await page.waitForFunction(expected => {
    const read = (window as unknown as { canonicalPdfSpikeSnapshot?: () => PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot;
    if (!read) return false;
    const state = read();
    const previous = expected.afterDrawing;
    const width = Number.parseFloat(state.dom.surfaceInlineWidth);
    return state.textReady && state.rasterReady && (!expected.physical || state.physicalPage === expected.physical)
      && state.asset?.scope === state.scope && state.asset?.physicalPage === state.physicalPage && state.asset?.sourceHash === state.expectedHash
      && (!previous || state.dom.pageNode !== null && state.dom.layerNode !== null
        && state.dom.pageNode !== previous.dom.pageNode && state.dom.layerNode !== previous.dom.layerNode
        && Number.isFinite(width) && width > 0 && width !== Number.parseFloat(previous.dom.surfaceInlineWidth)
        && !!previous.asset?.url && state.asset?.url === previous.asset.url && state.diagnostics.textSurface === 'current')
      ? state : false;
  }, { physical, afterDrawing }, { timeout: remaining(effectiveDeadline) });
  try { return await accepted.jsonValue() as PdfSpikeSnapshot; }
  finally { await accepted.dispose(); }
}
export async function navigate(page: BrowserPage, physical: number, wait = true, deadline?: number) {
  await page.getByLabel('Logical page', { exact: true }).selectOption(pageId(physical));
  if (wait) await ready(page, physical === 150 ? 1 : physical, undefined, deadline);
}
export async function selectText(page: BrowserPage, text: string, start: number, end: number, lastText?: string, drawing?: PdfSpikeSnapshot) {
  return page.evaluate(({ text, start, end, lastText, drawing }) => {
    if (drawing) {
      const current = (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot();
      if (current.dom.pageNode !== drawing.dom.pageNode || current.dom.layerNode !== drawing.dom.layerNode
        || current.diagnostics.textSurface !== 'current') throw new Error('selection-drawing-changed');
    }
    const layer = document.querySelector('.textLayer');
    if (!layer) throw new Error('actual-text-layer-missing');
    const nodes = [...layer.querySelectorAll('span[role="presentation"]')]
      .map(element => element.firstChild).filter((node): node is Text => node?.nodeType === Node.TEXT_NODE);
    const joined = nodes.map(node => node.data).join('');
    const first = joined.indexOf(text), last = lastText ? joined.indexOf(lastText, first + text.length) : first;
    if (first < 0 || last < 0) throw new Error(`actual-DOM-text-missing:${JSON.stringify({ text, lastText, joined })}`);
    const locate = (position: number, isEnd: boolean) => {
      let offset = 0;
      for (const node of nodes) {
        if (position < offset + node.length || isEnd && position === offset + node.length)
          return { node, offset: position - offset };
        offset += node.length;
      }
      throw new Error('actual-DOM-offset-outside-text');
    };
    const from = locate(first + start, false), to = locate(last + end, true);
    const range = document.createRange(); range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
    const selection = window.getSelection(); if (!selection) throw new Error('selection-unavailable');
    selection.removeAllRanges(); selection.addRange(range);
    return { quote: range.toString(), rects: [...range.getClientRects()].map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })) };
  }, { text, start, end, lastText, drawing });
}
/** Geometry-only synthetic Range: readiness, selection and one visible-button
 * activation share a browser task. An attempted refusal is never retried. */
export async function captureSynthetic(page: BrowserPage, physical: number, text: string, start: number, end: number,
  options: { lastText?: string; drawing?: PdfSpikeSnapshot; deadline?: number; checkAdmission?: boolean; expectedQuote?: string;
    fault?: { label: 'Fault replace equal Text node' | 'Fault clear text layer' | 'Fault skew wrapper'; kind: 'replace-node' | 'clear-layer' | 'skew-wrapper' }; preview?: boolean } = {}) {
  if ((options.fault || options.preview) && !options.checkAdmission) throw new Error('transaction-requires-admission-checks');
  if (options.fault && options.preview) throw new Error('fault-preview-incompatible');
  const accepted = await page.waitForFunction(expected => {
    const read = (window as unknown as { canonicalPdfSpikeSnapshot?: () => PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot;
    if (!read) return false;
    const state = read();
    if (!state.textReady || !state.rasterReady || state.physicalPage !== expected.physical
      || state.asset?.scope !== state.scope || state.asset?.physicalPage !== state.physicalPage
      || state.asset?.sourceHash !== state.expectedHash || state.diagnostics.textSurface !== 'current') return false;
    if (expected.drawing && (state.dom.pageNode !== expected.drawing.dom.pageNode || state.dom.layerNode !== expected.drawing.dom.layerNode)) return false;
    const layer = document.querySelector('.textLayer');
    if (!layer) throw new Error('actual-text-layer-missing');
    const nodes = [...layer.querySelectorAll('span[role="presentation"]')]
      .map(element => element.firstChild).filter((node): node is Text => node?.nodeType === Node.TEXT_NODE);
    const joined = nodes.map(node => node.data).join(''), first = joined.indexOf(expected.text);
    const last = expected.lastText ? joined.indexOf(expected.lastText, first + expected.text.length) : first;
    if (first < 0 || last < 0) throw new Error('actual-selection-text-missing');
    const locate = (position: number, isEnd: boolean) => {
      let offset = 0;
      for (const node of nodes) {
        if (position < offset + node.length || isEnd && position === offset + node.length) return { node, offset: position - offset };
        offset += node.length;
      }
      throw new Error('actual-marker-offset-outside-text');
    };
    const from = locate(first + expected.start, false), to = locate(last + expected.end, true), range = document.createRange();
    range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
    if (range.collapsed || !layer.contains(range.startContainer) || !layer.contains(range.endContainer) || expected.expectedQuote !== undefined && range.toString() !== expected.expectedQuote)
      throw new Error('actual-marker-range-invalid');
    const selection = window.getSelection(); if (!selection) throw new Error('selection-unavailable');
    selection.removeAllRanges(); selection.addRange(range);
    const button = [...document.querySelectorAll('button')].find(element => element.textContent === 'Capture selection');
    if (!button || !button.isConnected || !button.getClientRects().length || button.disabled) throw new Error('capture-button-unavailable');
    const current = read();
    if (!current.textReady || !current.rasterReady || current.diagnostics.textSurface !== 'current'
      || current.physicalPage !== expected.physical || current.asset?.scope !== current.scope
      || current.asset?.physicalPage !== current.physicalPage || current.asset?.sourceHash !== current.expectedHash
      || current.asset?.url !== state.asset?.url || current.asset?.pageId !== state.asset?.pageId
      || current.expectedHash !== state.expectedHash || current.scope !== state.scope
      || current.dom.pageNode !== state.dom.pageNode || current.dom.layerNode !== state.dom.layerNode
      || document.querySelector('.textLayer') !== layer) return false;
    const admissionButton = expected.checkAdmission
      ? [...document.querySelectorAll('button')].find(element => element.textContent === 'Check capture admission') : undefined;
    if (expected.checkAdmission && (!admissionButton || !admissionButton.isConnected || !admissionButton.getClientRects().length || admissionButton.disabled))
      throw new Error('admission-button-unavailable');
    const faultButton = expected.fault ? [...document.querySelectorAll('button')].find(element => element.textContent === expected.fault?.label) : undefined;
    if (expected.fault && (!faultButton || !faultButton.isConnected || !faultButton.getClientRects().length || faultButton.disabled))
      throw new Error('fault-button-unavailable');
    const previewButton = expected.preview ? [...document.querySelectorAll('button')].find(element => element.textContent === 'Show captured overlay') : undefined;
    if (expected.preview && (!previewButton || !previewButton.isConnected || !previewButton.getClientRects().length || previewButton.disabled))
      throw new Error('preview-button-unavailable');
    const final = read();
    if (!final.textReady || !final.rasterReady || final.diagnostics.textSurface !== 'current'
      || final.physicalPage !== expected.physical || final.asset?.scope !== final.scope
      || final.asset?.physicalPage !== final.physicalPage || final.asset?.sourceHash !== final.expectedHash
      || final.asset?.url !== state.asset?.url || final.asset?.pageId !== state.asset?.pageId
      || final.expectedHash !== state.expectedHash || final.scope !== state.scope
      || final.dom.pageNode !== state.dom.pageNode || final.dom.layerNode !== state.dom.layerNode
      || document.querySelector('.textLayer') !== layer) return false;
    button.click();
    if (expected.fault) admissionButton?.click();
    faultButton?.click();
    admissionButton?.click();
    previewButton?.click();
    const result = read();
    if (result.captureAttempts !== final.captureAttempts + 1 || !result.capture) throw new Error('capture-attempt-not-observed');
    const checks = expected.fault || expected.preview ? 2 : expected.checkAdmission ? 1 : 0;
    if (result.admissionChecks !== final.admissionChecks + checks) throw new Error('admission-attempt-not-observed');
    const records = result.admissionHistory.filter(item => item.check > final.admissionChecks);
    if (records.length !== checks || records.some((item, index) => item.check !== final.admissionChecks + index + 1
      || item.captureAttempt !== result.captureAttempts)) throw new Error('admission-attempt-mismatch');
    if (expected.fault && (result.injectedFaults.length !== final.injectedFaults.length + 1
      || result.injectedFaults[result.injectedFaults.length - 1] !== expected.fault.kind)) throw new Error('fault-attempt-not-observed');
    const admissionResult = expected.checkAdmission ? result.admission : undefined;
    return { attempted: true, result: result.capture, admission: admissionResult,
      baselineAdmission: expected.fault || expected.preview ? records[0].problem : undefined, selection: { quote: range.toString(),
      rects: [...range.getClientRects()].map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })) } };
  }, { physical, text, start, end, lastText: options.lastText, drawing: options.drawing, checkAdmission: options.checkAdmission, expectedQuote: options.expectedQuote, fault: options.fault, preview: options.preview },
  { timeout: remaining(options.deadline) });
  try { return await accepted.jsonValue() as { attempted: true; result: NonNullable<PdfSpikeSnapshot['capture']>; admission?: string | null; baselineAdmission?: string | null;
    selection: { quote: string; rects: { x: number; y: number; width: number; height: number }[] } }; }
  finally { await accepted.dispose(); }
}
export async function capture(page: BrowserPage) {
  await page.getByRole('button', { name: 'Capture selection', exact: true }).click();
  const value = (await snapshot(page)).capture; assert.ok(value); return value;
}
export async function admission(page: BrowserPage) {
  const previous = (await snapshot(page)).admissionChecks;
  await page.getByRole('button', { name: 'Check capture admission', exact: true }).click();
  await page.waitForFunction(count => (window as unknown as { canonicalPdfSpikeSnapshot(): PdfSpikeSnapshot }).canonicalPdfSpikeSnapshot().admissionChecks > count, previous);
  return (await snapshot(page)).admission;
}

export async function openPdfSpike(t: TestContext, engine: PdfSpikeEngine, trace?: (stage: string) => void,
  options: { moduleWarmup?: boolean; caseDeadline?: number; readyCalibration?: boolean } = {}) {
  if (options.readyCalibration && (!options.moduleWarmup || engine !== 'webkit' || options.caseDeadline === undefined))
    throw new Error('ready-calibration-requires-prepared-webkit-and-case-deadline');
  const directory = path.join(root, 'output/canonical-pdf-surface-spike', engine + '-' + randomUUID());
  // Registered before acquiring Vite or the warmup helper. Once normal test
  // teardown is installed, it owns Vite; this early hook handles only setup failure.
  let earlyVite: Awaited<ReturnType<typeof createServer>> | undefined;
  let earlyWarmServer: BrowserServer | undefined;
  t.after(async () => {
    const failures: string[] = [];
    const boundedCleanup = async (work: Promise<void>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('early-cleanup-timeout')), 5000); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    };
    try { if (earlyWarmServer) await boundedCleanup(earlyWarmServer.kill()); }
    catch (error) { failures.push(`warm-server pid=${earlyWarmServer?.process().pid ?? 'unknown'} unresolved: ${String(error)}`); }
    try { if (earlyVite) await boundedCleanup(earlyVite.close()); }
    catch (error) { failures.push('vite-close unresolved: ' + String(error)); }
    if (failures.length) {
      fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'early-cleanup-failure.json'), JSON.stringify({ failures }, null, 2));
      throw new PreparationCleanupError('early cleanup unresolved', failures);
    }
  });
  const resourceWaitClocks: ResourceWaitClock[] = [];
  const pdfPath = path.join(root, 'tests/fixtures/canonical-highlight.pdf');
  const oraclePath = path.join(root, 'tests/fixtures/canonical-highlight.oracle.json');
  assert.ok(fs.existsSync(pdfPath) && fs.existsSync(oraclePath), 'generate and visually inspect the real fixture before running this suite');
  const bytes = fs.readFileSync(pdfPath), oracle = JSON.parse(fs.readFileSync(oraclePath, 'utf8')) as PdfSpikeOracle;
  assert.equal(createHash('sha256').update(bytes).digest('hex'), oracle.metadata.sha256);
  assert.equal(bytes.length, oracle.metadata.byteLength);
  const font = fs.readFileSync(path.join(frontend, 'node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'));
  const heldFonts = new Set<ServerResponse>();
  const workerHolds = new Map<BrowserPage, { seen: number; expectedUrl: string; ready: Promise<void>; release(): void }>();
  const workerTasks = new Set<Promise<void>>();
  const releaseWorkers = () => { for (const hold of workerHolds.values()) hold.release(); };
  const releaseFonts = () => {
    for (const response of heldFonts) { response.setHeader('Content-Type', 'font/woff2'); response.end(font); }
    heldFonts.clear();
  };
  const httpFailures: { url: string; method: string; status: number; referer: string; destination: string }[] = [];
  const workerReleaseServer: { method: string; url: string; events: { event: string; at: number; complete: boolean;
    aborted: boolean; status: number; responseFinished: boolean }[] }[] = [];
  const workerReleaseClient: { url: string; method: string; navigation: boolean; status: number | null; body: unknown;
    finished: string | null; acknowledged: boolean; error?: string }[] = [];
  trace?.('support:create-server:before');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: path.join(directory, 'vite'), server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    plugins: [{ name: 'canonical-pdf-spike-actual-resource', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const incoming = { url: new URL(request.url ?? '/', `http://${request.headers.host}`).href,
          method: request.method ?? '', referer: request.headers.referer ?? '',
          destination: String(request.headers['sec-fetch-dest'] ?? '') };
        // Also observe browser-initiated requests (such as automatic icons)
        // which an engine may omit from Playwright's Page request events.
        response.once('finish', () => {
          if (response.statusCode >= 400) httpFailures.push({ ...incoming, status: response.statusCode });
        });
        const url = new URL(request.url ?? '/', 'http://fixture.invalid');
        if (url.pathname === '/canonical-pdf-spike/config') {
          response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(oracle));
        } else if (url.pathname === '/canonical-pdf-spike/worker-bootstrap') {
          // Import only the real rendering policy. No React root, Document,
          // Page or Worker is constructed before the exact URL route exists.
          response.setHeader('Content-Type', 'text/html');
          response.end(`<!doctype html><html><head><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3Crect width='1' height='1' fill='white'/%3E%3C/svg%3E"></head><body><output aria-label="Actual PDF worker URL"></output><script type="module">
            import { pdfjs } from '/src/features/reader/pdf/pdfRendering.ts';
            document.querySelector('output').textContent = pdfjs.GlobalWorkerOptions.workerSrc;
          </script></body></html>`);
        } else if (url.pathname === '/canonical-pdf-spike/resource') {
          response.setHeader('Content-Type', 'application/pdf'); response.end(bytes);
        } else if (url.pathname === '/canonical-pdf-spike/font.woff2') {
          heldFonts.add(response); response.on('close', () => heldFonts.delete(response));
        } else if (url.pathname === '/canonical-pdf-spike/font-release') {
          releaseFonts(); response.statusCode = 200; response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ released: true }));
        } else if (url.pathname === '/canonical-pdf-spike/worker-release') {
          const exchange = { method: request.method ?? '', url: incoming.url, events: [] as typeof workerReleaseServer[number]['events'] };
          workerReleaseServer.push(exchange);
          const record = (event: string) => exchange.events.push({ event, at: performance.now(), complete: request.complete,
            aborted: request.aborted, status: response.statusCode, responseFinished: response.writableFinished });
          request.once('aborted', () => record('request-aborted'));
          request.once('end', () => record('request-end'));
          request.once('close', () => record('request-close'));
          response.once('finish', () => record('response-finish'));
          response.once('close', () => record('response-close'));
          record('received');
          releaseWorkers();
          response.statusCode = 200; response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ released: true }));
          record('ack-sent');
        } else next();
      });
    } }],
  });
  earlyVite = server;
  trace?.('support:create-server:after');
  trace?.('support:server-listen:before');
  await server.listen();
  trace?.('support:server-listen:after');
  if (options.moduleWarmup) {
    // This is an isolated module-only browser. The real test always launches a
    // fresh browser after this one closes; no PDF fixture state is created.
    const started = Date.now(), deadline = Math.min(started + 30_000, options.caseDeadline ?? started + 30_000);
    const budget = () => { const left = deadline - Date.now(); if (left <= 0) throw new Error('module-warmup-budget-exhausted'); return left; };
    const within = async <T>(work: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('module-warmup-budget-exhausted')), budget()); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    };
    const log: { stage: string; nodeStartedEpochMs: number; nodeStartedMonotonicMs: number; nodeDeadlineEpochMs: number; nodeEndEpochMs?: number; nodeClockSampleEpochMs?: number; nodeClockSampleMonotonicMs?: number;
      browserClock?: { timeOrigin: number; now: number }; requests: { atEpochMs: number; url: string; kind: string; status?: number; failure?: string }[]; error?: string } =
      { stage: 'launch', nodeStartedEpochMs: started, nodeStartedMonotonicMs: performance.now(), nodeDeadlineEpochMs: deadline, requests: [] };
    let warmBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let warmServer: BrowserServer | undefined;
    let primary: unknown; const cleanupErrors: string[] = [];
    let helperClosed = false;
    const forbidden: string[] = []; let forbiddenCount = 0;
    const record = (item: typeof log.requests[number]) => { log.requests.push(item); if (log.requests.length > 1000) log.requests.shift(); };
    try {
      warmServer = await (engine === 'chromium' ? chromium.launchServer({ channel: 'msedge', headless: true, timeout: budget() }) : webkit.launchServer({ headless: true, timeout: budget() }));
      earlyWarmServer = warmServer;
      log.stage = 'connect';
      warmBrowser = await within((engine === 'chromium' ? chromium : webkit).connect(warmServer.wsEndpoint(), { timeout: budget() }));
      log.stage = 'context';
      const warmContext = await within(warmBrowser.newContext({ serviceWorkers: 'block' }));
      const warmPage = await within(warmContext.newPage());
      const failures: string[] = [];
      warmPage.on('pageerror', error => failures.push(String(error)));
      warmPage.on('request', request => {
        const raw = request.url(), url = new URL(raw), filename = url.pathname.toLowerCase();
        if (filename.endsWith('.pdf') || /\.(?:woff2?|ttf|otf)$/.test(filename)
          || filename.endsWith('/canonical-pdf-spike/resource') || filename.endsWith('/canonical-pdf-spike/config')
          || filename.endsWith('/canonical-pdf-spike/font-release') || filename.endsWith('/canonical-pdf-spike/worker-release')
          || filename.endsWith('/pdf.worker.min.mjs') && !url.searchParams.has('url')) {
          forbiddenCount++; if (forbidden.length < 100) forbidden.push(raw);
        }
        record({ atEpochMs: Date.now(), url: raw, kind: request.resourceType() });
      });
      warmPage.on('requestfailed', request => { failures.push(`${request.url()}: ${request.failure()?.errorText}`); record({ atEpochMs: Date.now(), url: request.url(), kind: 'failed', failure: request.failure()?.errorText }); });
      warmPage.on('response', response => { if (response.status() >= 400) failures.push(`${response.url()}: ${response.status()}`); record({ atEpochMs: Date.now(), url: response.url(), kind: 'response', status: response.status() }); });
      log.stage = 'module-load';
      await warmPage.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/canonicalPdfModuleWarmup.html`, { timeout: budget() });
      await warmPage.waitForFunction(() => document.body.dataset.pdfModuleWarmup === 'ready', undefined, { timeout: budget() });
      log.stage = 'verify';
      const facts = await within(warmPage.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now(), canvas: document.querySelectorAll('canvas').length })));
      log.nodeClockSampleEpochMs = Date.now(); log.nodeClockSampleMonotonicMs = performance.now();
      log.browserClock = { timeOrigin: facts.timeOrigin, now: facts.now };
      assert.equal(facts.canvas, 0, 'module warmup must not create canvas');
      assert.equal(forbiddenCount, 0, 'module warmup must not request PDF/font/actual worker or fixture controls: ' + JSON.stringify(forbidden));
      assert.deepEqual(failures, [], 'module warmup must not hide module/network errors');
      log.stage = 'close-context'; await within(warmContext.close());
      log.stage = 'close-browser'; await within(warmBrowser.close()); warmBrowser = undefined;
      log.stage = 'close-server'; await within(warmServer.close());
      helperClosed = true; earlyWarmServer = undefined; warmServer = undefined;
      log.stage = 'complete';
    } catch (error) {
      primary = error; log.error = String(error);
    } finally {
      // A successful preparation includes a fully closed owned helper within
      // its original budget. On failure, bounded safety cleanup is separate;
      // it cannot turn the failed preparation into success.
      if (warmServer && !helperClosed) {
        let pid: number | undefined;
        try {
          pid = warmServer.process().pid;
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([warmServer.kill(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('owned-helper-kill-timeout')), 5000); })])
            .finally(() => { if (timer !== undefined) clearTimeout(timer); });
          helperClosed = true; earlyWarmServer = undefined;
        } catch (error) { cleanupErrors.push(`owned-helper pid=${pid ?? 'unknown'} unresolved: ${String(error)}`); }
      }
      if (primary) {
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([server.close(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('vite-close-timeout')), 5000); })])
            .finally(() => { if (timer !== undefined) clearTimeout(timer); });
          earlyVite = undefined;
        } catch (error) { cleanupErrors.push('vite-close unresolved: ' + String(error)); }
      }
      log.nodeEndEpochMs = Date.now();
      try {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'module-warmup.json'), JSON.stringify({ ...log, helperClosed, cleanupErrors }, null, 2));
      } catch (error) { cleanupErrors.push('warmup-log: ' + String(error)); }
    }
    if (primary || cleanupErrors.length || !helperClosed) {
      throw new PreparationCleanupError('module warmup failed or cleanup unresolved', [...(primary ? [primary] : []), ...cleanupErrors]);
    }
  }
  trace?.('support:launch-browser:before');
  const browser = await (engine === 'chromium' ? chromium.launch({ channel: 'msedge', headless: true }) : webkit.launch({ headless: true }))
    .catch(async error => { releaseFonts(); releaseWorkers(); await server.close(); throw error; });
  trace?.('support:launch-browser:after');
  const errors: string[] = [], unhandled: string[] = [], forbidden: string[] = [], consoleErrors: string[] = [], workerRequests: string[] = [];
  const consoleLocations: { text: string; url: string; lineNumber: number; columnNumber: number }[] = [];
  const networkFailures: { url: string; method: string; navigation: boolean; status?: number; failure?: string;
    resourceType: string; frame: string; referer: string; redirectedFrom: string | null }[] = [];
  const pages: BrowserPage[] = [];
  const sceneTimelines: { scene: string; events: { at: number; kind: string; url?: string; status?: number; failure?: string }[];
    gotoFailure: null | { at: number; error: string; pending: string[] } }[] = [];
  t.after(async () => {
    trace?.('teardown:begin');
    releaseFonts(); releaseWorkers();
    let workerTasksComplete = false, browserCloseComplete = false, serverCloseComplete = false;
    let teardownComplete = false;
    try {
      trace?.('teardown:worker-tasks:before');
      await Promise.all([...workerTasks]);
      workerTasksComplete = true;
      trace?.('teardown:worker-tasks:after');
      if (t.error) {
        fs.mkdirSync(directory, { recursive: true });
        const states = await Promise.all(pages.filter(page => !page.isClosed()).map(async (page, index) => {
          trace?.(`teardown:scene-${index}:failure-screenshot:before`);
          await page.screenshot({ path: path.join(directory, `failure-${index}.png`), fullPage: true }).catch(() => {});
          trace?.(`teardown:scene-${index}:failure-screenshot:after`);
          const url = page.url();
          trace?.(`teardown:scene-${index}:failure-snapshot:before`);
          const state = await snapshot(page).catch(error => String(error));
          trace?.(`teardown:scene-${index}:failure-snapshot:after`);
          trace?.(`teardown:scene-${index}:resource-timings:before`);
          const resourceTimings = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => {
              const resource = entry as PerformanceResourceTiming;
              return { url: resource.name, initiatorType: resource.initiatorType, duration: resource.duration };
            })).catch(error => String(error));
          trace?.(`teardown:scene-${index}:resource-timings:after`);
          return { url, state, resourceTimings };
        }));
        fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ errors, unhandled, forbidden, consoleErrors,
          consoleLocations, networkFailures, httpFailures, workerRequests, workerReleaseClient, workerReleaseServer, sceneTimelines, resourceWaitClocks, states }, null, 2));
      }
    } finally {
      try {
        trace?.('teardown:browser-close:before');
        await browser.close();
        browserCloseComplete = !browser.isConnected();
        trace?.('teardown:browser-close:after');
        trace?.('teardown:server-close:before');
        await server.close();
        serverCloseComplete = server.httpServer !== null && !server.httpServer.listening;
        trace?.('teardown:server-close:after');
        teardownComplete = true;
      } finally {
        const markerPath = process.env.PDF_SPIKE_CLEANUP_MARKER;
        if (markerPath) {
          const statuses = { workerTasksComplete, browserCloseComplete, serverCloseComplete, teardownComplete };
          fs.writeFileSync(markerPath, JSON.stringify({ runId: process.env.PDF_SPIKE_RUN_ID,
            caseId: process.env.PDF_SPIKE_CASE_ID, childWorkerPid: process.pid,
            cleanupComplete: Object.values(statuses).every(Boolean), statuses }), { flag: 'wx' });
        }
      }
    }
    trace?.('teardown:end');
  });
  earlyVite = undefined; // Normal t.after now owns the server.
  let sceneSequence = 0;
  const scene = async (scenario = 'normal', dpr = 1) => {
    const name = `scene-${sceneSequence++}:${scenario}`;
    trace?.(`${name}:new-context:before`);
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: dpr, serviceWorkers: 'block' });
    trace?.(`${name}:new-context:after`);
    trace?.(`${name}:new-page:before`);
    const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(15_000);
    if (options.moduleWarmup) warmupScenePages.set(page, { clocks: resourceWaitClocks, readyBudgetMs: options.readyCalibration ? 30_000 : 25_000,
      caseDeadline: options.caseDeadline, calibration: options.readyCalibration === true });
    const timeline: typeof sceneTimelines[number] = { scene: name, events: [], gotoFailure: null };
    sceneTimelines.push(timeline);
    const pendingRequests = new Map<Request, string>();
    const logEvent = (event: typeof timeline.events[number]) => {
      timeline.events.push(event); if (timeline.events.length > 1000) timeline.events.shift();
    };
    page.on('request', request => {
      if (pendingRequests.size < 1000) pendingRequests.set(request, request.url());
      else logEvent({ at: performance.now(), kind: 'pending-cap-reached' });
      logEvent({ at: performance.now(), kind: 'request', url: request.url() });
    });
    page.on('response', response => logEvent({ at: performance.now(), kind: 'response', url: response.url(), status: response.status() }));
    page.on('requestfinished', request => { pendingRequests.delete(request); logEvent({ at: performance.now(), kind: 'finished', url: request.url() }); });
    page.on('requestfailed', request => { pendingRequests.delete(request); logEvent({ at: performance.now(), kind: 'failed', url: request.url(), failure: request.failure()?.errorText ?? 'unknown' }); });
    page.on('domcontentloaded', () => logEvent({ at: performance.now(), kind: 'domcontentloaded' }));
    page.on('load', () => logEvent({ at: performance.now(), kind: 'load' }));
    trace?.(`${name}:new-page:after`);
    const sceneWorkerRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.stack ?? error.message));
    page.on('console', message => {
      if (message.text().startsWith('pdf-spike-unhandled:')) unhandled.push(message.text());
      else if (message.type() === 'error') {
        consoleErrors.push(message.text()); consoleLocations.push({ text: message.text(), ...message.location() });
      }
    });
    const requestContext = (request: Request) => {
      let frame = '';
      try { frame = request.frame().url(); } catch { frame = 'worker-or-unavailable-frame'; }
      return { url: request.url(), method: request.method(), navigation: request.isNavigationRequest(), resourceType: request.resourceType(), frame,
        referer: request.headers().referer ?? '', redirectedFrom: request.redirectedFrom()?.url() ?? null };
    };
    page.on('response', response => { if (response.status() >= 400) networkFailures.push({ ...requestContext(response.request()), status: response.status() }); });
    page.on('requestfailed', request => networkFailures.push({ ...requestContext(request), failure: request.failure()?.errorText ?? 'unknown' }));
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.includes('pdf.worker')) { workerRequests.push(request.url()); sceneWorkerRequests.push(request.url()); }
      if (/\/(?:Legacy[^/]*|store|inkStore|stickyNotesStore)\.[jt]sx?$/.test(pathname)
        || pathname.startsWith('/api/') || /@tauri-apps/.test(pathname)) forbidden.push(request.url());
    });
    trace?.(`${name}:init-script:before`);
    await page.addInitScript(() => { window.addEventListener('unhandledrejection', event => console.error('pdf-spike-unhandled:' + String(event.reason))); });
    trace?.(`${name}:init-script:after`);
    if (scenario === 'hold-worker') {
      // Read the public setting from the production policy in this fresh
      // context; Vite may resolve a pnpm realpath. The ?url module is not held.
      const origin = server.resolvedUrls!.local[0];
      await page.goto(new URL('/canonical-pdf-spike/worker-bootstrap', origin).href);
      const output = page.getByLabel('Actual PDF worker URL', { exact: true });
      await output.filter({ hasText: /\S/ }).waitFor();
      const worker = new URL((await output.textContent())!, origin);
      assert.equal(worker.origin, new URL(origin).origin, 'the real worker must be same-origin');
      const workerSegments = worker.pathname.split('/');
      assert.equal(workerSegments[workerSegments.length - 1], 'pdf.worker.min.mjs');
      assert.equal(worker.search, '', 'the runtime worker is not the ?url module');
      assert.equal(worker.hash, '');
      const expectedUrl = worker.href;
      assert.equal(sceneWorkerRequests.includes(expectedUrl), false, 'bootstrap must not request the actual worker');
      let seen!: () => void, release!: () => void;
      const seenPromise = new Promise<void>(resolve => { seen = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const hold = { seen: 0, expectedUrl, ready: seenPromise, release };
      workerHolds.set(page, hold);
      await context.route(expectedUrl, async route => {
        assert.equal(route.request().url(), expectedUrl);
        hold.seen++; seen();
        const task = (async () => { await gate; await route.continue(); })();
        workerTasks.add(task);
        try { await task; } finally { workerTasks.delete(task); }
      });
    }
    trace?.(`${name}:goto:before`);
    try { await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/canonicalPdfSurface.html?scenario=${encodeURIComponent(scenario)}`); }
    catch (error) {
      timeline.gotoFailure = { at: performance.now(), error: String(error), pending: [...pendingRequests.values()].slice(0, 1000) };
      throw error;
    }
    trace?.(`${name}:goto:after`);
    trace?.(`${name}:logical-page-visible:before`);
    await page.getByLabel('Logical page', { exact: true }).waitFor();
    trace?.(`${name}:logical-page-visible:after`);
    return page;
  };
  const finish = async () => {
    trace?.('strict-finish:before');
    assert.deepEqual(errors, [], 'actual renderer page errors'); assert.deepEqual(unhandled, [], 'unhandled promise rejections');
    assert.deepEqual(forbidden, [], 'no legacy writers, API clients, stores or native runtime');
    assert.deepEqual(consoleErrors, [], 'actual renderer console errors: ' + JSON.stringify({ consoleLocations, networkFailures, httpFailures }));
    // These diagnostics were previously included only in assertion messages.
    // Observe them at the existing finish boundary, before teardown/navigation.
    // This retains the existing limitation for events arriving after finish.
    assert.deepEqual(networkFailures, [], 'actual renderer network failures');
    assert.deepEqual(httpFailures, [], 'actual renderer HTTP failures');
    if (options.moduleWarmup) { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'resource-wait-clocks.json'), JSON.stringify(resourceWaitClocks, null, 2)); }
    trace?.('strict-finish:after');
  };
  const releaseWorkerAndWait = async (page: BrowserPage) => {
    const url = new URL('/canonical-pdf-spike/worker-release', page.url()).href;
    const exchange: typeof workerReleaseClient[number] = { url, method: 'POST', navigation: false, status: null,
      body: null, finished: null, acknowledged: false };
    workerReleaseClient.push(exchange);
    try {
      // Register before the existing visible click. This observes that click's
      // exact Request, without a second POST or a successful retry substitute.
      const [response] = await Promise.all([
        page.waitForResponse(value => value.url() === url && value.request().method() === 'POST'),
        page.getByRole('button', { name: 'Release PDF worker', exact: true }).click(),
      ]);
      const request = response.request();
      exchange.method = request.method(); exchange.navigation = request.isNavigationRequest(); exchange.status = response.status();
      assert.equal(request.url(), url); assert.equal(exchange.method, 'POST'); assert.equal(exchange.navigation, false);
      assert.equal(response.status(), 200, 'the visible worker release has a successful HTTP acknowledgement');
      exchange.body = await response.json();
      assert.deepEqual(exchange.body, { released: true }, 'read the same release response body completely');
      const finished = await response.finished(); exchange.finished = finished ? String(finished) : 'complete';
      assert.equal(finished, null, 'the same worker release Request finishes without failure');
      assert.equal(response.request(), request);
      await page.getByRole('status', { name: 'PDF worker release', exact: true }).filter({ hasText: 'PDF worker released' }).waitFor();
      exchange.acknowledged = true;
    } catch (error) { exchange.error = String(error); throw error; }
  };
  const releaseFontAndWait = async (page: BrowserPage) => {
    const url = new URL('/canonical-pdf-spike/font-release', page.url()).href;
    const [response] = await Promise.all([
      page.waitForResponse(value => value.url() === url && value.request().method() === 'POST'),
      page.getByRole('button', { name: 'Release font', exact: true }).click(),
    ]);
    const request = response.request();
    assert.equal(request.url(), url); assert.equal(request.method(), 'POST'); assert.equal(request.isNavigationRequest(), false);
    assert.equal(response.status(), 200);
    assert.deepEqual(await response.json(), { released: true });
    assert.equal(await response.finished(), null, 'the same font release Request finishes without failure');
    assert.equal(response.request(), request);
    await page.getByRole('status', { name: 'Font release', exact: true }).filter({ hasText: 'Font released' }).waitFor();
  };
  const waitWorkerHold = async (page: BrowserPage) => {
    const hold = workerHolds.get(page); assert.ok(hold, 'this must be a fresh worker-hold context');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([hold.ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('actual worker hold was not observed: ' + JSON.stringify(workerRequests))), 10_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    assert.equal(hold.seen, 1, 'one exact actual worker request must be held');
    return { requests: hold.seen, url: hold.expectedUrl };
  };
  return { scene, oracle, finish, waitWorkerHold, releaseWorkers, releaseWorkerAndWait, releaseFontAndWait };
}
