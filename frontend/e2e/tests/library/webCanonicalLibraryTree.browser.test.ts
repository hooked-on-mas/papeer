import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { build, preview } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) test(`canonical tree component pages children and retains virtualized keyboard reveal (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '../../..');
  // Dedicated fixture build: actual Web configuration/CSS, no app entry or writer admission.
  const scratch = await mkdtemp(path.join(tmpdir(), 'paper-desk-canonical-tree-'));
  assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir()));
  assert.ok(path.basename(scratch).startsWith('paper-desk-canonical-tree-'));
  let closePreview: (() => Promise<void>) | undefined, closeBrowser: (() => Promise<void>) | undefined;
  t.after(async () => { try { await closeBrowser?.(); } finally { try { await closePreview?.(); } finally { await rm(scratch, { recursive: true, force: true }); } } });
  await build({ root: frontend, configFile: path.join(frontend, 'vite.web.config.ts'), logLevel: 'error',
    build: { outDir: scratch, emptyOutDir: false, rolldownOptions: { input: path.join(frontend, 'e2e/fixtures/canonicalLibraryTree.html') } } });
  const server = await preview({ root: frontend, configFile: false, logLevel: 'error', base: './',
    build: { outDir: scratch }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
  closePreview = () => server.close();
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  closeBrowser = () => browser.close();
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  const started = Date.now(), events: { phase: string; ms: number; detail?: string }[] = [], pending = new Set<string>();
  let phase = 'navigation-load';
  page.on('request', request => { pending.add(request.url()); });
  page.on('requestfinished', request => { pending.delete(request.url()); });
  page.on('requestfailed', request => { pending.delete(request.url()); events.push({ phase: 'requestfailed', ms: Date.now() - started, detail: `${request.url()} ${request.failure()?.errorText}` }); });
  page.on('response', response => { if (response.status() >= 400) events.push({ phase: 'response-error', ms: Date.now() - started, detail: `${response.status()} ${response.url()}` }); });
  page.on('domcontentloaded', () => events.push({ phase: 'domcontentloaded', ms: Date.now() - started }));
  page.on('load', () => events.push({ phase: 'load', ms: Date.now() - started }));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text());
    events.push({ phase: `console-${message.type()}`, ms: Date.now() - started, detail: message.text() }); });
  try {
  // Retained diagnostics measured 14.5s startup and pending Vite modules at 15s, before React mounted.
  // Only navigation startup gets this explicit bound; action predicates and their 15s limit remain unchanged.
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/canonicalLibraryTree.html`, { timeout: 30_000 });
  phase = 'more-disclosure';
  const tree = page.getByRole('tree', { name: '資料の階層', exact: true });
  const focusedVisible = async () => {
    await page.waitForFunction(() => {
      const active = document.activeElement, tree = document.querySelector('[role="tree"]'), clip = document.querySelector('[aria-label="Catalog clip"]');
      if (!(active instanceof HTMLElement) || !tree || !clip) return false;
      const rect = active.getBoundingClientRect(), bounds = [tree, clip].map(element => {
        const box = element.getBoundingClientRect(); return { top: box.top + element.clientTop, bottom: box.top + element.clientTop + element.clientHeight };
      });
      return rect.top >= Math.max(...bounds.map(box => box.top)) - 1 && rect.bottom <= Math.min(...bounds.map(box => box.bottom)) + 1;
    });
  };
  await tree.waitFor({ state: 'visible' });
  assert.equal(await tree.getByRole('treeitem').first().evaluate(element => getComputedStyle(element).display), 'flex', 'actual application Tailwind row layout is active');
  await tree.getByRole('treeitem', { name: 'さらに3件を表示', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-library-item') === 'child-6');
  await focusedVisible();
  assert.equal(await page.getByLabel('Opened item', { exact: true }).textContent(), 'none');
  assert.equal(await page.getByLabel('Full projected rows', { exact: true }).textContent(), '2010');
  await page.keyboard.press('End');
  phase = 'virtual-end-focus';
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-library-item') === 'root-1999');
  await focusedVisible();
  assert.ok(await tree.getByRole('treeitem').count() < 80, 'windowed DOM remains bounded after logical End reveal');
  await page.keyboard.press('Home');
  phase = 'home-and-hidden-reveal';
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-folder-id') === 'folder');
  await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', { name: 'Reveal hidden child', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-library-item') === 'child-8');
  await page.keyboard.press(' ');
  await focusedVisible();
  assert.equal(await page.getByLabel('Opened item', { exact: true }).textContent(), 'none');
  await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('Opened item', { exact: true }).textContent(), 'child-8');
  phase = 'strict-console'; assert.deepEqual(errors, []);
  } catch (error) {
    const dom = await Promise.race([page.evaluate(() => ({ readyState: document.readyState, body: document.body?.innerText.slice(0, 3000),
      treeItems: document.querySelectorAll('[role="treeitem"]').length, clip: document.querySelector('[aria-label="Catalog clip"]')?.getBoundingClientRect().toJSON(), focusedRect: document.activeElement?.getBoundingClientRect().toJSON(), active: document.activeElement?.outerHTML.slice(0, 500) })).catch(reason => ({ error: String(reason) })),
      new Promise(resolve => setTimeout(() => resolve({ observationTimedOut: true }), 2000))]);
    t.diagnostic(JSON.stringify({ phase, events, pendingRequests: [...pending], errors, dom })); throw error;
  }
});
