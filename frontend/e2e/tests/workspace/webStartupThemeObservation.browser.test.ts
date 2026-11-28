// B13-f (2): OBSERVATION ONLY. What colour does a cold start paint before the Library's own display settings are applied (F29 / T30 / D2)?
// Nothing here asserts a colour or a timing. A test passes when its observation could be taken (the set-up facts hold and a frame timeline exists);
// the recorded values (t.diagnostic JSON lines) are the input for the owner's decision D2, not a verdict on the product.
//
// Entries observed (all served by Vite, headless, one persistent profile per scenario group, `colorScheme` fixed at launch so the very first frame sees it):
//   web-dev        frontend/web/index.html (no start-up theme script) with the real Web main.tsx.
//   pc-real-dev    frontend/index.html with the real src/main.tsx. There is no sidecar and no Tauri here, so the app stops at its own start-up gate;
//                  theme-init.js and startup.css are the real ones, but the app never reaches a Library (the "after" state is the gate, not a canonical theme).
//   pc-shell-web   frontend/index.html (real theme-init.js, startup.css) whose main module is replaced by the Web main.tsx, so a Library can be opened and the
//                  canonical theme applied. A SIMULATION of the PC shell, not the PC app (no Tauri, no desktop adapter, no sidecar).
//   web-built / pc-real-built  the same two real entries from a production build (only when B13F_WEB_DIST / B13F_PC_DIST name built folders).
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright-core';
import { changeDisplay } from '../../support/ordinaryWorkspace.ts';

type Engine = 'chromium' | 'webkit';
type Scheme = 'light' | 'dark';
const frontend = path.resolve(import.meta.dirname, '../../..');
const LIBRARY = 'T30 observation';

/** Runs in every document before its own scripts. Logs data-theme / background changes per frame (rAF = state used for that frame), DOM events and paint timing. */
const RECORDER = `(() => {
  const log = []; window.__b13fLog = log; window.__b13fMarks = {};
  const state = () => { const root = document.documentElement, body = document.body;
    return { dataTheme: root ? root.getAttribute('data-theme') : null, rootBg: root ? getComputedStyle(root).backgroundColor : null,
      bodyBg: body ? getComputedStyle(body).backgroundColor : null, colorScheme: root ? getComputedStyle(root).colorScheme : null,
      ready: document.readyState, sheets: document.styleSheets.length, rootChild: (document.getElementById('root') || {}).firstElementChild ? document.getElementById('root').firstElementChild.className || document.getElementById('root').firstElementChild.tagName : null }; };
  const push = event => log.push({ event, t: Math.round(performance.now() * 10) / 10, ...state() });
  push('init');
  document.addEventListener('DOMContentLoaded', () => push('DOMContentLoaded'));
  window.addEventListener('load', () => push('load'));
  new MutationObserver(records => { for (const record of records) log.push({ event: 'data-theme-changed', t: Math.round(performance.now() * 10) / 10, from: record.oldValue,
    to: record.target.getAttribute('data-theme'), target: record.target.tagName, ...state() }); }).observe(document, { attributes: true, attributeFilter: ['data-theme'], attributeOldValue: true, subtree: true });
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) log.push({ event: 'paint:' + entry.name, t: Math.round(entry.startTime * 10) / 10, ...state() }); })
    .observe({ type: 'paint', buffered: true }); } catch { window.__b13fMarks.paintTiming = 'unsupported'; }
  let previous = '', frames = 0;
  const frame = () => { frames++; const now = state(), key = [now.dataTheme, now.rootBg, now.bodyBg].join('|');
    if (key !== previous) { previous = key; log.push({ event: 'frame-change', frame: frames, t: Math.round(performance.now() * 10) / 10, ...now }); }
    window.__b13fMarks.frames = frames; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})();`;

type Entry = { name: string; origin: string; librarySetup: boolean; hasThemeInit: boolean; close(): Promise<void> };
async function viteEntry(name: 'web-dev' | 'pc-real-dev' | 'pc-shell-web'): Promise<Entry> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'paper-desk-t30-'));
  const fontRoot = path.dirname(createRequire(import.meta.url).resolve('@fontsource-variable/geist/package.json'));
  const web = name === 'web-dev';
  const server = await createServer(web
    ? { root: path.join(frontend, 'web'), configFile: path.join(frontend, 'vite.web.config.ts'), logLevel: 'error', cacheDir: path.join(scratch, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [frontend, fontRoot] } } }
    : { root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error', cacheDir: path.join(scratch, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, fs: { allow: [frontend, fontRoot] } } });
  await server.listen();
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const html = await (await fetch(`${origin}/`)).text();
  return { name, origin, librarySetup: name !== 'pc-real-dev', hasThemeInit: html.includes('theme-init.js'),
    close: async () => { await server.close(); await rm(scratch, { recursive: true, force: true }); } };
}
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
async function builtEntry(name: 'web-built' | 'pc-real-built', directory: string): Promise<Entry> {
  const server: Server = createHttpServer(async (request, response) => {
    try {
      let file = path.join(directory, decodeURIComponent((request.url ?? '/').split('?')[0]));
      if (!file.startsWith(directory)) throw new Error('outside');
      if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
      await stat(file);
      response.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream'); createReadStream(file).pipe(response);
    } catch { response.statusCode = 404; response.end('not found'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const html = await (await fetch(`${origin}/`)).text();
  return { name, origin, librarySetup: name === 'web-built', hasThemeInit: html.includes('theme-init.js'), close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function launch(engine: Engine, profile: string, entry: Entry, colorScheme: Scheme): Promise<{ context: BrowserContext; page: Page; blocked: string[] }> {
  const options = { headless: true, viewport: { width: 1440, height: 1080 }, colorScheme };
  const context = engine === 'chromium' ? await chromium.launchPersistentContext(profile, { ...options, channel: 'msedge' }) : await webkit.launchPersistentContext(profile, options);
  const blocked: string[] = [];
  // Never let the page talk to anything but its own origin (a developer sidecar may be listening on 127.0.0.1:8000).
  await context.route(url => url.origin !== entry.origin && !url.protocol.startsWith('data') && !url.protocol.startsWith('blob'), route => { blocked.push(route.request().url()); return route.abort(); });
  if (entry.name === 'pc-shell-web') await context.route(url => url.pathname === '/src/main.tsx', route => route.fulfill({ contentType: 'text/javascript', body: "import '/src/web/main.tsx';" }));
  await context.addInitScript({ content: RECORDER });
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(45_000);
  return { context, page, blocked };
}
async function seedLocalStorage(page: Page, entry: Entry, items: Record<string, string>) {
  await page.goto(`${entry.origin}/theme-init.js`);   // a same-origin static document (no app boots): the keys exist before the app's first script runs
  await page.evaluate(items => { for (const key of ['papeer-ui-theme', 'paperdesk-ui-theme']) localStorage.removeItem(key); for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value); }, items);
}
async function createLibraryAndSetTheme(page: Page, entry: Entry, theme: 'dark' | 'light', first: boolean) {
  await seedLocalStorage(page, entry, {});   // no stale old key while the canonical setting is prepared
  await page.goto(`${entry.origin}/`);
  if (first) {
    await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).click();
    await page.getByLabel('新しいライブラリの名前').fill(LIBRARY);
    await page.getByRole('button', { name: '作成', exact: true }).click();
    await page.getByRole('button', { name: '確認しました', exact: true }).click();
  }
  await page.getByRole('button', { name: LIBRARY, exact: true }).click();
  await page.getByText('資料を選択してください。', { exact: true }).waitFor();
  await changeDisplay(page, { theme });
  await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
}
type Row = Record<string, unknown> & { event: string; t: number; dataTheme?: string | null; rootBg?: string | null; bodyBg?: string | null };
async function observe(page: Page, entry: Entry, openLibrary: boolean) {
  await page.goto(`${entry.origin}/`);
  let openedAt: number | null = null;
  let libraryReached: boolean | null = null;
  if (openLibrary) {
    // A stale old theme key is a "legacy" localStorage key (papeer-* / paperdesk-*): the start-up gate may hold the app before any Library is offered. Record which happened.
    const library = page.getByRole('button', { name: LIBRARY, exact: true });
    await library.or(page.locator('#root[data-startup-state="legacy-present"], #root[data-startup-state="held"], #root[data-startup-state="unavailable"]')).first().waitFor();
    libraryReached = await library.count() > 0;
    if (libraryReached) {
      openedAt = await page.evaluate(() => performance.now());
      await library.click();
      await page.getByText('資料を選択してください。', { exact: true }).waitFor();
    }
  } else {
    await page.locator('#root > *').first().waitFor();
    await page.waitForFunction(() => { const root = document.getElementById('root'); return !!root && (root.dataset.startupState === 'unavailable' || root.dataset.startupState === 'held' || root.dataset.startupState === 'legacy-present'); }, undefined, { timeout: 40_000 }).catch(() => undefined);
  }
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const log = await page.evaluate(() => (window as unknown as { __b13fLog: Row[] }).__b13fLog);
  const marks = await page.evaluate(() => (window as unknown as { __b13fMarks: Record<string, unknown> }).__b13fMarks);
  const startupState = await page.evaluate(() => document.getElementById('root')?.dataset.startupState ?? null);
  const final = await page.evaluate(() => ({ dataTheme: document.documentElement.getAttribute('data-theme'), bodyBg: getComputedStyle(document.body).backgroundColor }));
  const frames = log.filter(row => row.event === 'frame-change');
  const firstPaint = log.find(row => row.event === 'paint:first-paint'), firstContentful = log.find(row => row.event === 'paint:first-contentful-paint');
  const dcl = log.find(row => row.event === 'DOMContentLoaded');
  /** The latest recorded state that is not later than a paint entry: the colours that paint can have shown. */
  const stateAt = (time: number | undefined) => time === undefined ? null : [...log].filter(row => row.t <= time && row.event !== 'paint:first-paint' && row.event !== 'paint:first-contentful-paint').pop() ?? null;
  const pick = (row: Row | null | undefined) => row ? { event: row.event, t: row.t, dataTheme: row.dataTheme ?? null, rootBg: row.rootBg ?? null, bodyBg: row.bodyBg ?? null } : null;
  const colours = frames.map(row => `${row.dataTheme ?? 'none'} / body ${row.bodyBg} / root ${row.rootBg}`);
  const distinct = colours.filter((value, index) => value !== colours[index - 1]);
  return {
    domContentLoaded: pick(dcl), firstPaintTime: firstPaint?.t ?? null, stateAtFirstPaint: pick(stateAt(firstPaint?.t)), firstContentfulPaintTime: firstContentful?.t ?? null,
    stateAtFirstContentfulPaint: pick(stateAt(firstContentful?.t)), paintTiming: marks.paintTiming ?? 'supported',
    frameChanges: frames.map(row => ({ frame: row.frame, t: row.t, dataTheme: row.dataTheme, bodyBg: row.bodyBg, rootBg: row.rootBg, rootChild: row.rootChild })),
    distinctFrameColours: distinct, dataThemeTransitions: log.filter(row => row.event === 'data-theme-changed').map(row => ({ t: row.t, target: row.target, from: row.from, to: row.to, bodyBg: row.bodyBg })),
    libraryReached, libraryClickedAt: openedAt, startupState, gateText: libraryReached === false ? (await page.locator('#root').innerText()).slice(0, 120) : null, final, framesRendered: marks.frames ?? null,
  };
}

async function scenarioRun(t: TestContext, engine: Engine, entry: Entry, plan: { canonical?: 'dark' | 'light'; old?: 'dark' | 'light'; scheme: Scheme; open: boolean }[]) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'paper-desk-t30-profile-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const profile = path.join(scratch, 'profile');
  let canonicalNow: 'dark' | 'light' | undefined;
  const rows: unknown[] = [];
  for (const step of plan) {
    if (step.canonical && step.canonical !== canonicalNow) {
      const { context, page } = await launch(engine, profile, entry, 'light');
      try { await createLibraryAndSetTheme(page, entry, step.canonical, canonicalNow === undefined); canonicalNow = step.canonical;
        // The record the app itself wrote is what the observation below is about.
        const stored = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('paper-desk.workspace.v1:')).map(key => JSON.parse(localStorage.getItem(key) ?? 'null')));
        assert.equal(stored.length, 1); assert.equal(stored[0].theme, step.canonical);
      } finally { await context.close(); }
    }
    const { context, page, blocked } = await launch(engine, profile, entry, step.scheme);
    try {
      const items: Record<string, string> = {};
      if (step.old) items['papeer-ui-theme'] = step.old;
      await seedLocalStorage(page, entry, items);
      const present = await page.evaluate(() => ({ papeer: localStorage.getItem('papeer-ui-theme'), paperdesk: localStorage.getItem('paperdesk-ui-theme'),
        canonical: Object.keys(localStorage).filter(key => key.startsWith('paper-desk.workspace.v1:')).length })).catch(() => null);
      const observation = await observe(page, entry, step.open);
      rows.push({ engine, entry: entry.name, scheme: step.scheme, oldKey: step.old ?? null, canonical: step.open ? canonicalNow ?? null : null,
        setUpBeforeLoad: present, otherOriginRequestsBlocked: blocked.length, ...observation });
    } finally { await context.close(); }
  }
  for (const row of rows) t.diagnostic(`T30-OBSERVATION ${JSON.stringify(row)}`);
  return rows;
}

for (const engine of ['chromium', 'webkit'] as const) {
  test(`observation: first painted colours of the Web entry, which has no start-up theme script (${engine})`, { timeout: 600_000 }, async t => {
    const entry = await viteEntry('web-dev'); t.after(() => entry.close());
    t.diagnostic(`T30-OBSERVATION ${JSON.stringify({ engine, entry: entry.name, themeInitScriptInServedHtml: entry.hasThemeInit })}`);
    const rows = await scenarioRun(t, engine, entry, [
      { canonical: 'dark', scheme: 'light', open: true }, { canonical: 'dark', scheme: 'dark', open: true }, { canonical: 'dark', old: 'light', scheme: 'dark', open: true },
      { canonical: 'light', scheme: 'dark', open: true }, { canonical: 'light', scheme: 'light', open: true }]);
    assert.equal(rows.length, 5, 'every scenario was observed');
  });

  test(`observation: first painted colours of the PC entry (real index.html and main.tsx, no sidecar) with old theme keys (${engine})`, { timeout: 600_000 }, async t => {
    const entry = await viteEntry('pc-real-dev'); t.after(() => entry.close());
    assert.equal(entry.hasThemeInit, true, 'the PC entry HTML loads theme-init.js');
    const rows = await scenarioRun(t, engine, entry, [
      { scheme: 'light', open: false }, { scheme: 'dark', open: false }, { old: 'dark', scheme: 'light', open: false }, { old: 'light', scheme: 'dark', open: false },
      { old: 'light', scheme: 'light', open: false }, { old: 'dark', scheme: 'dark', open: false }]);
    assert.equal(rows.length, 6);
  });

  test(`observation: PC shell (real index.html, theme-init.js, startup.css) with the Web app mounted: old key against the canonical theme (${engine})`, { timeout: 900_000 }, async t => {
    const entry = await viteEntry('pc-shell-web'); t.after(() => entry.close());
    assert.equal(entry.hasThemeInit, true, 'the shell HTML loads theme-init.js');
    const rows = await scenarioRun(t, engine, entry, [
      { canonical: 'dark', scheme: 'light', open: true }, { canonical: 'dark', scheme: 'dark', open: true }, { canonical: 'dark', old: 'light', scheme: 'light', open: true },
      { canonical: 'dark', old: 'light', scheme: 'dark', open: true }, { canonical: 'light', old: 'dark', scheme: 'dark', open: true }, { canonical: 'light', old: 'dark', scheme: 'light', open: true },
      { canonical: 'light', scheme: 'dark', open: true }]);
    assert.equal(rows.length, 7);
  });

  for (const [name, variable] of [['web-built', 'B13F_WEB_DIST'], ['pc-real-built', 'B13F_PC_DIST']] as const) {
    test(`observation: first painted colours of the production build (${name}) (${engine})`, { timeout: 900_000 }, async t => {
      const directory = process.env[variable];
      if (!directory) { t.diagnostic(`T30-OBSERVATION ${JSON.stringify({ engine, entry: name, status: 'not-run', reason: `${variable} is not set` })}`); return; }
      const entry = await builtEntry(name, path.resolve(directory)); t.after(() => entry.close());
      t.diagnostic(`T30-OBSERVATION ${JSON.stringify({ engine, entry: name, themeInitScriptInServedHtml: entry.hasThemeInit })}`);
      const plan = name === 'web-built'
        ? [{ canonical: 'dark' as const, scheme: 'light' as const, open: true }, { canonical: 'dark' as const, scheme: 'dark' as const, open: true },
          { canonical: 'light' as const, scheme: 'dark' as const, open: true }, { canonical: 'light' as const, scheme: 'light' as const, open: true }]
        : [{ scheme: 'light' as const, open: false }, { scheme: 'dark' as const, open: false }, { old: 'dark' as const, scheme: 'light' as const, open: false },
          { old: 'light' as const, scheme: 'dark' as const, open: false }];
      const rows = await scenarioRun(t, engine, entry, plan);
      assert.equal(rows.length, plan.length);
    });
  }
}
