/** Explicit diagnostic, excluded from automatic browser-suite discovery.
 * Run from frontend: node e2e/support/webkitCorpusNavigation.mjs --details
 * Imports the production corpus/session. Does not change shared fixtures, assertions, or classifications.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import { webkit } from 'playwright-core';

const frontend = path.resolve(import.meta.dirname, '../..'), root = path.resolve(frontend, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/shared-edits.json'), 'utf8'));
const secondId = '00000000-0000-0000-0000-000000000009';
const documents = [structuredClone(fixture.document), { ...structuredClone(fixture.document), id: secondId }];
const catalog = { ...structuredClone(fixture.library), deletions: [], items: documents.map((document, index) => ({
  ...structuredClone(fixture.library.items[0]), id: document.id, kind: 'notebook', title: `Diagnostic ${index + 1}`,
})) };
const states = new Map(documents.map(document => [document.id, {
  checkpoint: { version: 1, libraryId: fixture.libraryId, root: document, batches: [] },
  heads: [document.version], waiting: [], rejected: {},
}]));
const availableModes = ['success', 'handled-failure', 'unhandled-control', 'late-handled-control', 'current', 'pagehide-abort', 'pre-navigation-cancel'];
const selected = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7);
if (selected && !availableModes.includes(selected)) throw new Error('Unknown mode: ' + selected);
const modes = selected ? [selected] : availableModes;
const repeats = Number(process.argv.find(arg => arg.startsWith('--repeats='))?.slice(10) ?? '10');
assert.ok(Number.isInteger(repeats) && repeats > 0 && repeats <= 100);
const events = [], cache = fs.mkdtempSync(path.join(tmpdir(), 'papeer-corpus-navigation-'));
const readWaiters = new Map();
let ordinal = 0;
const record = (kind, detail) => events.push({ ordinal: ++ordinal, receivedAt: Date.now(), kind, ...detail });
const pendingReplies = new Set();
let browser, server;
try {
  server = await createServer({ root: frontend, configFile: false, logLevel: 'error', cacheDir: cache,
    optimizeDeps: { entries: ['e2e/fixtures/corpusNavigation.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [root] } },
    plugins: [{ name: 'corpus-navigation-diagnostic', configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://local');
        if (url.pathname === '/corpus-diagnostic/config') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ scope: { accountId: 'diagnostic', libraryId: fixture.libraryId, epoch: 'webkit' }, catalog })); return;
        }
        if (url.pathname === '/api/edits/read') {
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          record('server.read.received', body);
          readWaiters.get(body.requestId)?.();
          response.on('close', () => record('server.read.closed', { requestId: body.requestId, ended: response.writableEnded }));
          const reply = () => {
            pendingReplies.delete(timer);
            if (response.destroyed) { record('server.read.reply-skipped', { requestId: body.requestId }); return; }
            response.setHeader('Content-Type', 'application/json');
            response.statusCode = body.mode === 'handled-failure' ? 503 : 200;
            response.end(JSON.stringify(states.get(body.targetId)));
          };
          // The first pending read is guaranteed to exist before navigation begins.
          const timer = setTimeout(reply, body.mode === 'success' || body.mode === 'handled-failure' || body.requestId.endsWith(':2') ? 0 : 500);
          pendingReplies.add(timer); return;
        }
        // Retain the departing context briefly so catch blocks/lifecycle events can be observed.
        if (url.pathname.endsWith('/corpusNavigation.html') && url.searchParams.get('destination') === '1') {
          setTimeout(() => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Destination</title>Navigation completed'); }, 180); return;
        }
        next();
      });
    } }],
  });
  await server.listen(); browser = await webkit.launch({ headless: true });
  const base = server.resolvedUrls.local[0];
  for (const mode of modes) {
    const count = mode.endsWith('control') || mode === 'handled-failure' || mode === 'success' ? 1 : repeats;
    for (let attempt = 1; attempt <= count; attempt++) {
      const page = await browser.newPage(); let stage = 'opening';
      page.on('pageerror', error => record('pageerror', { mode, attempt, stage, message: error.message, stack: error.stack }));
      page.on('console', message => {
        const text = message.text();
        if (text.startsWith('corpus-navigation:')) record('fixture', { mode, attempt, stage, observation: JSON.parse(text.slice(18)) });
        else if (message.type() === 'error') record('console.error', { mode, attempt, stage, text });
      });
      page.on('requestfailed', request => record('requestfailed', { mode, attempt, stage, url: request.url(),
        body: request.postData(), failure: request.failure() }));
      await page.goto(`${base}e2e/fixtures/corpusNavigation.html?mode=${mode}&attempt=${attempt}`);
      await page.waitForFunction(() => window.corpusDiagnosticReady);
      stage = 'active';
      const requestId = `${mode}:${attempt}:1`;
      const readStarted = mode.endsWith('control') ? null : new Promise((resolve, reject) => {
        const timer = setTimeout(() => { readWaiters.delete(requestId); reject(new Error('First read never reached diagnostic server: ' + requestId)); }, 10_000);
        readWaiters.set(requestId, () => { clearTimeout(timer); readWaiters.delete(requestId); resolve(); });
      });
      await page.evaluate(() => window.corpusDiagnosticStart());
      if (readStarted) await readStarted;
      if (mode === 'handled-failure' || mode === 'success') {
        await page.waitForFunction(() => !window.corpusDiagnosticState().loading);
        const state = await page.evaluate(() => window.corpusDiagnosticState());
        assert.equal(state.missingIds.length, mode === 'success' ? 0 : 2);
        assert.equal(state.error, mode === 'success' ? '' : 'annotation-source-unavailable');
      } else if (!mode.endsWith('control')) {
        if (mode === 'pre-navigation-cancel') await page.evaluate(() => window.corpusDiagnosticCancel());
        stage = 'navigating';
        await page.goto(`${base}e2e/fixtures/corpusNavigation.html?destination=1`); stage = 'destination';
      }
      await page.waitForTimeout(150);
      await page.close();
    }
  }
} finally {
  await browser?.close();
  for (const timer of pendingReplies) clearTimeout(timer);
  await server?.close();
  assert.equal(path.dirname(cache), path.resolve(tmpdir()));
  assert.ok(path.basename(cache).startsWith('papeer-corpus-navigation-'));
  fs.rmSync(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
const summary = Object.fromEntries(modes.map(mode => {
  const selectedEvents = events.filter(event => event.mode === mode);
  const fixtureEvents = selectedEvents.filter(event => event.kind === 'fixture').map(event => event.observation);
  const count = event => fixtureEvents.filter(value => value.event === event).length;
  return [mode, { pageerrors: selectedEvents.filter(event => event.kind === 'pageerror').length,
    unhandled: count('unhandledrejection'), rejectionhandled: count('rejectionhandled'),
    requestCaught: count('request.caught-rethrow'), corpusResolved: count('corpus.resolved'), corpusRejected: count('corpus.caught-rethrow'),
    pagehide: count('pagehide'), failedRequests: selectedEvents.filter(event => event.kind === 'requestfailed').length }];
}));
console.log(JSON.stringify({ summary, events: process.argv.includes('--details') ? events : undefined }, null, 2));
// Controls establish observation fidelity; current/navigation modes report evidence without reclassification.
for (const mode of ['success', 'handled-failure']) if (summary[mode]) {
  assert.equal(summary[mode].unhandled, 0); assert.equal(summary[mode].corpusResolved, 1);
}
if (summary['unhandled-control']) assert.equal(summary['unhandled-control'].unhandled, 1);
if (summary['late-handled-control']) {
  assert.equal(summary['late-handled-control'].unhandled, 1); assert.equal(summary['late-handled-control'].rejectionhandled, 1);
}
