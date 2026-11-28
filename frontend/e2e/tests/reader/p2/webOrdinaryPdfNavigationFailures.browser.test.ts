import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { ordinaryWeb } from './ordinaryWeb.ts';
import { committed } from './ordinaryStorage.ts';

type Probe = { enabled: boolean; failures: number; reads: number; keys: string[] };
async function resourceFault(page: Page, resourceId: string) {
  await page.evaluate(resourceId => {
    const probe: Probe = { enabled: true, failures: 0, reads: 0, keys: [] };
    (globalThis as unknown as { navigationReadFault: Probe }).navigationReadFault = probe;
    const original = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      if (this.name === 'resources' && typeof key === 'string' && (JSON.parse(key) as string[])[1] === resourceId) {
        probe.reads++; probe.keys.push(key);
        if (probe.enabled) {
          probe.failures++; this.transaction.abort();
          throw new DOMException('P2 actual PDF resource read abort', 'AbortError');
        }
      }
      return original.call(this, key);
    };
  }, resourceId);
}
const setFault = (page: Page, enabled: boolean) => page.evaluate(enabled => {
  (globalThis as unknown as { navigationReadFault: Probe }).navigationReadFault.enabled = enabled;
}, enabled);
const probe = (page: Page) => page.evaluate(() => (globalThis as unknown as { navigationReadFault: Probe }).navigationReadFault);
const status = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });
async function importPdf(page: Page, file: string) {
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(file);
  await page.getByRole('heading', { name: path.basename(file), exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  if (await catalog.getAttribute('aria-expanded') === 'true') await catalog.click();
  await page.locator('[data-rendered="true"] canvas').first().waitFor();
  return id;
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary PDF no outline, read retry, history and latest query (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  let phase = 'author';
  try {
    const root = path.resolve(import.meta.dirname, '../../../../..');
    const authored = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigationFailures.py'), app.scratch], { encoding: 'utf8', windowsHide: true });
    assert.equal(authored.status, 0, authored.stderr);
    phase = 'no-outline';
    const emptyId = await importPdf(page, path.join(app.scratch, 'no-outline.pdf'));
    const emptyBefore = await committed(page, emptyId);
    await page.getByRole('button', { name: '目次', exact: true }).click();
    await status(page, /^目次はありません$/).waitFor();
    assert.deepEqual(await committed(page, emptyId), emptyBefore);
    phase = 'import-large';
    const documentId = await importPdf(page, path.join(app.scratch, 'navigation-failures.pdf'));
    const before = await committed(page, documentId);
    const background = before.root.pages[0].background; assert.equal(background.kind, 'pdf');
    if (background.kind !== 'pdf') throw new Error('PDF required');
    phase = 'outline-read-failure';
    if (await page.getByRole('button', { name: '目次', exact: true }).getAttribute('aria-expanded') === 'true')
      await page.getByRole('button', { name: '目次', exact: true }).click();
    await resourceFault(page, background.resourceId);
    await page.getByRole('button', { name: '目次', exact: true }).click();
    await status(page, /^目次を取得できませんでした$/).waitFor();
    assert.ok((await probe(page)).failures > 0);
    await setFault(page, false);
    await status(page, /^目次を取得できませんでした$/).locator('..').getByRole('button', { name: '再試行', exact: true }).click();
    await page.getByRole('button', { name: 'Navigation last', exact: true }).waitFor();
    phase = 'back-forward';
    await page.getByRole('button', { name: 'Navigation last', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement)?.value === '32');
    await page.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="32"] canvas').waitFor();
    await page.getByRole('button', { name: '読む', exact: true }).click();
    await page.locator('[data-pdf-scroller]').first().click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement)?.value === '1');
    await page.keyboard.press('Alt+ArrowRight');
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement)?.value === '32');
    phase = 'search-read-failure';
    await setFault(page, true);
    await page.getByRole('button', { name: '本文検索', exact: true }).click();
    await page.getByLabel('PDF本文検索', { exact: true }).fill('OldNeedle');
    await status(page, /^本文を取得できませんでした$/).waitFor();
    assert.equal(await page.getByRole('button', { name: '次の結果', exact: true }).isDisabled(), true);
    await setFault(page, false);
    phase = 'latest-query';
    const reads = (await probe(page)).reads;
    await page.getByLabel('PDF本文検索', { exact: true }).fill('OldNeedle navigation');
    await status(page, /^検索中…$/).waitFor();
    await page.waitForFunction(previous => (globalThis as unknown as { navigationReadFault: Probe }).navigationReadFault.reads > previous, reads);
    assert.equal(await status(page, /^検索中…$/).count(), 1, 'the real old query is still pending when replaced');
    await page.getByLabel('PDF本文検索', { exact: true }).fill('LatestNeedle');
    await status(page, /^2件$/).waitFor();
    await page.getByRole('button', { name: '次の結果', exact: true }).click();
    await status(page, /^2件・1件目$/).waitFor();
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement)?.value === '1');
    await page.locator('[data-pdf-search-hit]').first().waitFor();
    await page.getByRole('button', { name: '次の結果', exact: true }).click();
    await status(page, /^2件・2件目$/).waitFor();
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement)?.value === '32');
    assert.equal(await page.getByLabel('PDF本文検索', { exact: true }).inputValue(), 'LatestNeedle');
    assert.deepEqual(await committed(page, documentId), before, 'failed reads, cancellations, history and search navigation create no content or edit history');
    t.diagnostic(JSON.stringify({ engine, documentId, emptyId, pages: 32, latestHits: 2, backForward: true, resourceProbe: await probe(page) }));
  } catch (error) {
    console.error(JSON.stringify({ engine, phase, error: String(error), body: await page.locator('body').innerText().catch(String), resourceProbe: await probe(page).catch(String) }));
    throw error;
  }
});
