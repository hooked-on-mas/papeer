import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { createServer, preview } from 'vite';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright-core';

/** A fresh ordinary Web entry. Never installs bindings, sessions, leases or fixture state. `options.deviceScaleFactor` (opt-in, B14-2) is passed to every browser context this entry launches; omitted, the launch options are exactly as before. */
export async function ordinaryWeb(t: TestContext, engine: 'chromium' | 'webkit', options: { deviceScaleFactor?: number } = {}) {
  const frontend = path.resolve(import.meta.dirname, '../../../..');
  const scratch = await mkdtemp(path.join(tmpdir(), 'paper-desk-p2-ordinary-'));
  const fontRoot = path.dirname(createRequire(import.meta.url).resolve('@fontsource-variable/geist/package.json'));
  const errors: string[] = [];
  /** Browser errors a test has announced it will provoke (B13-search); matched ones are kept apart and still reported by `allowedBrowserErrors()`. Empty unless a test calls `allowBrowserErrors`. */
  let allowed: RegExp[] = []; const allowedSeen: string[] = [];
  const record = (text: string) => { if (allowed.some(pattern => pattern.test(text))) allowedSeen.push(text); else errors.push(text); };
  const buildOnlyManifestDiagnostics: string[] = [];
  const built = process.env.PAPEER_WEB_BUILT === '1';
  let context: BrowserContext | undefined;
  let currentPage: Page | undefined;
  const server = built ? await preview({ configFile: path.join(frontend, 'vite.web.config.ts'), logLevel: 'error',
    preview: { host: '127.0.0.1', port: 0, strictPort: false } }) : await createServer({ root: path.join(frontend, 'web'), configFile: path.join(frontend, 'vite.web.config.ts'),
    logLevel: 'error', cacheDir: path.join(scratch, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [frontend, fontRoot] } } });
  t.after(async () => {
    try { await context?.close(); } finally {
      try { await server.close(); } finally {
        assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir()));
        await rm(scratch, { recursive: true, force: true });
      }
    }
    assert.deepEqual(errors, [], 'ordinary entry has no unhandled browser errors');
    if (buildOnlyManifestDiagnostics.length) t.diagnostic(JSON.stringify({ sourceDevOnly: true,
      reason: 'webPwa emits manifest only during build; source dev server HTML fallback is not a built-PWA validation',
      buildOnlyManifestDiagnostics }));
  });
  if ('listen' in server) await server.listen();
  t.diagnostic(`P2 ordinary server mode: ${built ? 'built web-dist preview' : 'source dev server'}`);
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`;
  let scale = options.deviceScaleFactor;
  const launch = async (timeoutMs = 30_000) => {
    const launchOptions = { headless: true, viewport: { width: 1440, height: 1080 }, ...(scale === undefined ? {} : { deviceScaleFactor: scale }) };
    context = engine === 'chromium'
      ? await chromium.launchPersistentContext(path.join(scratch, 'profile'), { ...launchOptions, channel: 'msedge' })
      : await webkit.launchPersistentContext(path.join(scratch, 'profile'), launchOptions);
    const page = context.pages()[0] ?? await context.newPage();
    currentPage = page;
    page.on('pageerror', error => record(error.stack ?? String(error)));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (!built && message.text() === 'Manifest: Line: 1, column: 1, Syntax error.') buildOnlyManifestDiagnostics.push(message.text());
      else record(`console.error: ${message.text()}`);
    });
    page.setDefaultTimeout(timeoutMs);
    await page.goto(url);
    return page;
  };
  const page = await launch();
  const library = `P2 ordinary ${engine}`;
  await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).click();
  await page.getByLabel('新しいライブラリの名前').fill(library);
  await page.getByRole('button', { name: '作成', exact: true }).click();
  await page.getByRole('button', { name: '確認しました', exact: true }).click();
  await page.getByRole('button', { name: library, exact: true }).click();
  await page.getByText('資料を選択してください。', { exact: true }).waitFor();
  /** `timings` (optional, measurement only) receives `libraryClickedAt` (epoch ms just before the Library button is clicked); `timeoutMs` raises the page's default wait (upper limit against a hang only). */
  const restartLibrary = async ({ showCatalog = true, timings, timeoutMs, deviceScaleFactor }: { showCatalog?: boolean; timings?: { libraryClickedAt?: number }; timeoutMs?: number; deviceScaleFactor?: number } = {}) => {
    await context!.close(); context = undefined; currentPage = undefined;
    if (deviceScaleFactor !== undefined) scale = deviceScaleFactor;
    const reopened = await launch(timeoutMs);
    if (timings) timings.libraryClickedAt = Date.now();
    await reopened.getByRole('button', { name: library, exact: true }).click();
    await reopened.getByText('資料を選択してください。', { exact: true }).or(reopened.locator('[data-content-document]:not([data-content-document=""])')).first().waitFor();
    const catalog = reopened.getByRole('button', { name: '資料一覧', exact: true });
    if (showCatalog && await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
    return reopened;
  };
  return { page, library, scratch, restartLibrary, currentPage: () => currentPage, browserErrors: () => [...errors],
    allowBrowserErrors: (patterns: RegExp[]) => { allowed = [...patterns]; }, allowedBrowserErrors: () => [...allowedSeen], async restart(title: string, reopen: { deviceScaleFactor?: number } = {}) {
    const reopened = await restartLibrary(reopen);
    await reopened.getByRole('button', { name: title, exact: true }).click();
    await reopened.getByRole('heading', { name: title, exact: true }).waitFor();
    const catalog = reopened.getByRole('button', { name: '資料一覧', exact: true });
    if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
    return reopened;
  } };
}

export async function createNotebook(page: Page, title: string) {
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByRole('button', { name: '新規', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新しい資料を作成', exact: true });
  await dialog.getByLabel('新しい資料の名前', { exact: true }).fill(title);
  await dialog.getByLabel('資料の種類', { exact: true }).selectOption('notebook');
  await dialog.getByRole('button', { name: '資料を作成', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document');
  assert.ok(id);
  return id;
}

export async function gesture(page: Page, points: [number, number][], label = 'ノート書き込みレイヤー') {
  const layer = page.getByLabel(label, { exact: true });
  await layer.scrollIntoViewIfNeeded();
  const box = await layer.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
  const [first, ...rest] = points;
  await page.mouse.move(box.x + box.width * first[0], box.y + box.height * first[1]);
  await page.mouse.down();
  for (const point of rest) await page.mouse.move(box.x + box.width * point[0], box.y + box.height * point[1], { steps: 12 });
  await page.mouse.up();
}
