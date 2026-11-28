import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { committed } from './ordinaryStorage.ts';
import { ordinaryWeb } from './ordinaryWeb.ts';

async function landing(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('paper-desk.reader.v1:'))!;
    return JSON.parse(localStorage.getItem(key)!) as { pageId: string; landing?: { place?: { x: number; y: number } | null } };
  });
}
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary P2 Unicode PDF search has distinct anchors, outline and safe internal links (${engine})`, { timeout: 180_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const root = path.resolve(import.meta.dirname, '../../../../..'), file = path.join(app.scratch, 'p2-navigation.pdf');
  const authored = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), file], { encoding: 'utf8', windowsHide: true });
  assert.equal(authored.status, 0, authored.stderr);
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(file);
  await page.getByRole('heading', { name: 'p2-navigation.pdf', exact: true }).waitFor();
  const documentId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(documentId);
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  const original = await committed(page, documentId);
  await page.getByRole('button', { name: '読む', exact: true }).click();
  await page.locator('[data-reader-surface="original"] [data-pdf-scroller][data-rendered="true"] .react-pdf__Page__canvas').waitFor();
  await page.getByRole('button', { name: '本文検索', exact: true }).click();
  await page.getByLabel('PDF本文検索', { exact: true }).fill('反復検索');
  try { await page.getByRole('status').filter({ hasText: /^4件$/ }).waitFor(); }
  catch (error) {
    const state = await page.evaluate(() => ({
      query: (document.querySelector('[aria-label="PDF本文検索"]') as HTMLInputElement | null)?.value,
      statuses: [...document.querySelectorAll('[role="status"]')].map(element => element.textContent),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
      page: (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement | null)?.value,
      raster: [...document.querySelectorAll('[data-reader-surface="original"] [data-pdf-scroller]')].map(element => ({
        rendered: element.getAttribute('data-rendered'), canvases: element.querySelectorAll('canvas').length,
      })),
      visibleContent: document.querySelector('[data-content-document]')?.getAttribute('data-content-document'),
    }));
    console.error(JSON.stringify({ engine, phase: 'initial-search-results', state, storage: await committed(page, documentId).catch(String) }));
    throw error;
  }
  await page.getByRole('button', { name: '次の結果', exact: true }).click();
  await page.locator('[data-pdf-search-hit]').first().waitFor();
  const firstTop = await page.locator('[data-pdf-search-hit]').first().evaluate(element => (element as HTMLElement).style.top);
  await page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('paper-desk.reader.v1:') && JSON.parse(localStorage.getItem(key)!).landing?.place?.y > .1));
  const first = await landing(page);
  await page.getByRole('button', { name: '次の結果', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /^4件・2件目$/ }).waitFor();
  await page.waitForFunction(previous => [...document.querySelectorAll<HTMLElement>('[data-pdf-search-hit]')].some(element => element.style.top !== previous), firstTop);
  await page.waitForFunction(previous => Object.keys(localStorage).some(key => key.startsWith('paper-desk.reader.v1:') && JSON.parse(localStorage.getItem(key)!).landing?.place?.y > previous + .2), first.landing!.place!.y);
  const second = await landing(page);
  assert.equal(first.pageId, second.pageId);
  assert.ok(second.landing!.place!.y > first.landing!.place!.y + .2);
  await page.getByRole('button', { name: '目次', exact: true }).click();
  await page.getByRole('button', { name: 'P2 second page', exact: true }).click();
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
  await page.getByRole('button', { name: 'P2 first page', exact: true }).click();
  await page.getByRole('link', { name: 'PDF内リンク', exact: true }).waitFor();
  const external = page.getByRole('link', { name: '外部リンク https://example.org/p2-reference', exact: true });
  assert.equal(await external.getAttribute('href'), 'https://example.org/p2-reference');
  assert.equal(await external.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  await page.getByRole('link', { name: 'PDF内リンク', exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement)?.value === '2');
  const after = await committed(page, documentId);
  assert.deepEqual(after.root, original.root);
  assert.equal(after.edits.length, 0, 'reading navigation never creates annotation batches or editing history');
  assert.equal(after.pendingIntents, 0);
  t.diagnostic(JSON.stringify({ engine, documentId, unicodeHits: 4, firstAnchor: first.landing, secondAnchor: second.landing,
    outlineNavigated: true, internalLinkNavigated: true, annotationBatches: 0, externalOpened: false }));
});
