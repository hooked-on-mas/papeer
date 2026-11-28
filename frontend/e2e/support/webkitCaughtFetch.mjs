/** Standalone WebKit engine diagnostic repro; no application imports or automatic suite discovery.
 * Run from frontend: node e2e/support/webkitCaughtFetch.mjs
 * A caught navigation failure followed by another caught fetch can emit pageerror before pagehide.
 * This distinguishes that engine diagnostic from window.unhandledrejection in composition tests.
 */
import http from 'node:http';
import { webkit } from 'playwright-core';
const events = [];
const availableModes = ['direct', 'chain', 'inflight', 'guarded', 'aftercatch', 'nestedpost', 'nesteddataset', 'nestedcatalog'];
const requestedMode = process.argv.find(arg => arg.startsWith('--mode='))?.slice('--mode='.length);
if (requestedMode && !availableModes.includes(requestedMode)) throw new Error('Unknown mode: ' + requestedMode);
const modes = requestedMode ? [requestedMode] : availableModes;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://local');
  if (url.pathname === '/slow') { setTimeout(() => { response.setHeader('Content-Type', 'application/json'); response.end('{}'); }, 80); return; }
  if (url.pathname === '/after') { response.setHeader('Content-Type', 'application/json'); response.end('{}'); return; }
  // POST is deliberately read-only, matching the fixture transfer's pull contract.
  if (url.pathname === '/composition/pull' && request.method === 'POST') {
    response.setHeader('Content-Type', 'application/json'); response.end('{"edits":[],"imports":[],"resources":[]}'); return;
  }
  if (url.pathname === '/api/edits/dataset-control' && request.method === 'POST') {
    response.setHeader('Content-Type', 'application/json'); response.end('null'); return;
  }
  if (url.pathname === '/api/edits/read' && request.method === 'POST') {
    response.setHeader('Content-Type', 'application/json'); response.end('{}'); return;
  }
  response.setHeader('Content-Type', 'text/html');
  const html = `<!doctype html><title>unload repro</title><p>same origin fetch, no application code</p><script>
    const mode = ${JSON.stringify(url.searchParams.get('mode'))};
    let alive = true;
    window.addEventListener('unhandledrejection', event => console.log('UNHANDLED: ' + String(event.reason)));
    window.addEventListener('pagehide', () => { alive = false; console.log('pagehide'); });
    const chain = async () => {
      if (mode === 'nestedcatalog') {
        const request = async path => {
          try { return await (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"targetId":"readonly"}' })).json(); }
          catch(error) { console.log('catalog request rethrow: ' + String(error)); throw error; }
        };
        // A failed content-graph read is caught inside the catalog loop; the next target
        // is still queried if navigation aborts that previous request.
        const catalog = async () => {
          for (const path of ['/slow', '/api/edits/read']) {
            try { await request(path); }
            catch(error) { console.log('catalog inner caught: ' + String(error)); }
          }
        };
        try { await catalog(); console.log('catalog completed'); }
        catch(error) { console.log('outer caught: ' + String(error)); }
        return;
      }
      if (mode === 'nestedpost' || mode === 'nesteddataset') {
        try { await fetch('/slow'); } catch(error) { console.log('caught first: ' + String(error)); }
        const inner = async () => {
          try { await fetch(mode === 'nesteddataset' ? '/api/edits/dataset-control' : '/composition/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
          catch(error) { console.log('inner rethrow: ' + String(error)); throw error; }
        };
        try { await inner(); } catch(error) { console.log('outer caught: ' + String(error)); }
        return;
      }
      if (mode === 'aftercatch') {
        try { await fetch('/slow'); } catch(error) { console.log('caught first: ' + String(error)); }
        try { await fetch('/after'); } catch(error) { console.log('caught continuation: ' + String(error)); }
        return;
      }
      try {
        await fetch('/slow');
        if (mode === 'guarded' && !alive) { console.log('guard skipped continuation'); return; }
        await fetch('/after');
      } catch (error) { console.log('caught fetch: ' + String(error)); }
    };
    window.addEventListener('beforeunload', () => {
      console.log('beforeunload');
      if (mode === 'direct') void (async () => { try { await fetch('/after'); } catch(error) { console.log('caught direct: ' + String(error)); } })();
      if (mode === 'chain') void chain();
    });
    window.startChain = chain;
  </script>`;
  // Keep the departing context alive long enough to observe both catch blocks during reload.
  if (url.searchParams.get('mode') === 'nestedcatalog') setTimeout(() => response.end(html), 100);
  else response.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await webkit.launch({ headless: true });
  for (const mode of modes) {
    const page = await browser.newPage(); let stage = 'opening';
    page.on('console', message => events.push({ mode, stage, kind: 'console', text: message.text() }));
    page.on('pageerror', error => events.push({ mode, stage, kind: 'pageerror', text: error.message, stack: error.stack }));
    for (let attempt = 0; attempt < (mode === 'aftercatch' || mode === 'nestedpost' || mode === 'nesteddataset' || mode === 'nestedcatalog' ? 10 : 3); attempt++) {
      stage = 'opening'; await page.goto(`${base}/?mode=${mode}`);
      if (mode === 'inflight' || mode === 'guarded' || mode === 'aftercatch' || mode === 'nestedpost' || mode === 'nesteddataset' || mode === 'nestedcatalog') await page.evaluate(() => { void window.startChain(); });
      stage = 'reloading'; await page.reload(); stage = 'loaded';
      await page.waitForTimeout(120);
    }
    await page.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify({ byMode: Object.fromEntries(modes.map(mode => {
  const selected = events.filter(event => event.mode === mode);
  return [mode, { pageerrors: selected.filter(event => event.kind === 'pageerror').length,
    outerCaught: selected.filter(event => event.text.startsWith('outer caught:')).length,
    unhandled: selected.filter(event => event.text.startsWith('UNHANDLED:')).length }];
})), pageerrors: events.filter(event => event.kind === 'pageerror').length,
  unhandled: events.filter(event => event.text.startsWith('UNHANDLED:')).length,
  caughtContinuation: events.filter(event => event.text.startsWith('caught continuation:')).length,
  nestedPost: { pageerrors: events.filter(event => event.mode === 'nestedpost' && event.kind === 'pageerror').length,
    innerRethrow: events.filter(event => event.mode === 'nestedpost' && event.text.startsWith('inner rethrow:')).length,
    outerCaught: events.filter(event => event.mode === 'nestedpost' && event.text.startsWith('outer caught:')).length,
    unhandled: events.filter(event => event.mode === 'nestedpost' && event.text.startsWith('UNHANDLED:')).length },
  nestedCatalog: { pageerrors: events.filter(event => event.mode === 'nestedcatalog' && event.kind === 'pageerror').length,
    innerCaught: events.filter(event => event.mode === 'nestedcatalog' && event.text.startsWith('catalog inner caught:')).length,
    completed: events.filter(event => event.mode === 'nestedcatalog' && event.text === 'catalog completed').length,
    unhandled: events.filter(event => event.mode === 'nestedcatalog' && event.text.startsWith('UNHANDLED:')).length },
  errorModes: [...new Set(events.filter(event => event.kind === 'pageerror').map(event => event.mode))] }));
if (process.argv.includes('--details')) console.log(JSON.stringify(events, null, 2));
if (requestedMode === 'nestedcatalog') {
  const catalog = events.filter(event => event.mode === 'nestedcatalog');
  const diagnostics = catalog.filter(event => event.kind === 'pageerror').length;
  const caught = catalog.filter(event => event.text.startsWith('catalog inner caught:')).length;
  const completed = catalog.filter(event => event.text === 'catalog completed').length;
  if (!diagnostics || caught < diagnostics || completed < diagnostics || catalog.some(event => event.text.startsWith('UNHANDLED:')))
    throw new Error('Catalog navigation diagnostic was not proven to be fully caught');
}
