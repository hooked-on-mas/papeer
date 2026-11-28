import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { SavedReaderState } from '../src/features/reader/ReaderSession.ts';
import { openComposition, evidence, sync } from './support/documentComposition.ts';

const region = '[aria-label="中央の編集"], [aria-label="右側の編集"]';
const pane = (page: Page) => page.locator(region).locator('[data-pdf-scroller], .web-pdf-pane');
async function saved(page: Page): Promise<SavedReaderState> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find(key => key.startsWith('paper-desk.reader.v1:'));
    if (!key) throw new Error('Reader preferences have not been saved');
    return JSON.parse(localStorage.getItem(key)!);
  });
}
async function rendered(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.locator(region).locator('[data-rendered="true"] .react-pdf__Page__canvas').waitFor();
}
async function position(page: Page) {
  return pane(page).evaluate(element => {
    const surface = element.querySelector('.ink-page, [data-pdf-surface]')!.getBoundingClientRect();
    const frame = element.getBoundingClientRect();
    return { x: (frame.left + element.clientLeft + element.clientWidth / 2 - surface.left) / surface.width,
      y: Math.max(0, (frame.top + element.clientTop - surface.top) / surface.height), width: surface.width,
      scrollTop: element.scrollTop, height: surface.height, viewportHeight: element.clientHeight };
  });
}
async function focus(page: Page) {
  const box = await pane(page).boundingBox(); assert.ok(box);
  await page.mouse.click(box.x + Math.min(70, box.width / 2), box.y + 50);
}
async function atPlace(page: Page, y: number) {
  await page.waitForFunction(({ y, region }) => {
    const root = document.querySelector('[data-editor-placement="right"]')
      ? document.querySelector('[aria-label="右側の編集"]') : document.querySelector('[aria-label="中央の編集"]');
    const pane = root?.querySelector('[data-pdf-scroller], .web-pdf-pane');
    const surface = pane?.querySelector('.ink-page, [data-pdf-surface]');
    if (!pane || !surface || !document.querySelector(region)) return false;
    return Math.abs(Math.max(0, (pane.getBoundingClientRect().top + pane.clientTop - surface.getBoundingClientRect().top) / surface.getBoundingClientRect().height) - y) < .015;
  }, { y, region });
}

for (const engine of ['chromium', 'webkit'] as const) test(`production PDF reading anchor and hidden reference preserve canonical zoom (${engine})`, { timeout: 240_000 }, async t => {
  const { pages, publication, reload: reloadMount, finish } = await openComposition(t, engine);
  assert.ok(publication.content?.kind === 'document'); const secondId = publication.content.pages[1].id;
  const reload = async (page: Page) => { await reloadMount(page); await page.getByRole('button', { name: '読む', exact: true }).click(); await rendered(page); };
  for (const [host, page] of pages.entries()) {
    t.diagnostic(`${host ? 'Web' : 'Native'} PDF reading state`);
    const original = await evidence(page);
    await page.getByRole('button', { name: '読む', exact: true }).click();
    await page.getByRole('button', { name: '次のページ', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement).value === '2');
    await page.getByLabel('倍率', { exact: true }).selectOption('1.5'); await rendered(page);
    await focus(page); await page.mouse.wheel(0, 500);
    await page.waitForFunction(id => {
      const key = Object.keys(localStorage).find(key => key.startsWith('paper-desk.reader.v1:'));
      const state = key && JSON.parse(localStorage.getItem(key)!) as SavedReaderState;
      return !!state && state.pageId === id && (state.positions[id]?.y ?? 0) > .05;
    }, secondId);
    const before = await position(page); assert.ok(before.scrollTop > 100);
    await sync(page); // The real replication/status/document refresh rerenders the surface.
    await page.getByRole('button', { name: '範囲選択', exact: true }).click();
    await page.getByRole('button', { name: '読む', exact: true }).click(); await rendered(page);
    await atPlace(page, before.y);
    assert.ok(Math.abs((await saved(page)).positions[secondId].y - before.y) < .015);
    await reload(page); assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
    assert.equal(await page.getByLabel('倍率', { exact: true }).inputValue(), '1.5'); await atPlace(page, before.y);
    const stepped = await saved(page); assert.deepEqual(stepped.back, []); assert.deepEqual(stepped.forward, []);
    await focus(page); await page.keyboard.press('Alt+ArrowLeft');
    await rendered(page); await atPlace(page, before.y);
    assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2', 'adjacent stepping does not create back history');
    // An explicit page-number jump does create history and retains the old page's reading position.
    await page.getByLabel('ページ番号', { exact: true }).fill('1');
    await page.getByLabel('ページ番号', { exact: true }).press('Enter');
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement).value === '1');
    await rendered(page); await atPlace(page, 0);
    await focus(page); await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement).value === '2');
    await rendered(page); await atPlace(page, before.y);
    await focus(page); await page.keyboard.press('Alt+ArrowRight');
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement).value === '1');
    await rendered(page); await atPlace(page, 0);
    await focus(page); await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement).value === '2');
    await rendered(page); await atPlace(page, before.y);

    // The two logical fixture pages share one physical PDF page: readiness must still follow logical identity.
    await page.getByRole('button', { name: '前のページ', exact: true }).click(); await rendered(page);
    await page.getByRole('button', { name: '右側で編集', exact: true }).click(); await rendered(page);
    const wideReference = page.locator('[aria-label="参照表示"]').locator('[data-pdf-scroller], .web-pdf-pane');
    const referenceBox = await wideReference.boundingBox(); assert.ok(referenceBox);
    await page.mouse.move(referenceBox.x + referenceBox.width / 2, referenceBox.y + referenceBox.height / 2);
    await page.mouse.wheel(0, 350);
    await page.waitForFunction(() => (document.querySelector('[aria-label="参照表示"] [data-pdf-scroller], [aria-label="参照表示"] .web-pdf-pane')?.scrollTop ?? 0) > 100);
    await page.getByRole('button', { name: '次のページ', exact: true }).click(); await rendered(page);
    await page.waitForFunction(() => ['参照表示', '右側の編集'].every(name => {
      const pane = document.querySelector(`[aria-label="${name}"] [data-pdf-scroller], [aria-label="${name}"] .web-pdf-pane`);
      return !!pane && pane.scrollTop < 2;
    }));
    const nextReference = await wideReference.boundingBox(); assert.ok(nextReference);
    await page.mouse.click(nextReference.x + 50, nextReference.y + 40); await page.keyboard.press('PageUp');
    await page.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement).value === '1');
    await rendered(page);
    await page.waitForFunction(() => ['参照表示', '右側の編集'].every(name => {
      const pane = document.querySelector(`[aria-label="${name}"] [data-pdf-scroller], [aria-label="${name}"] .web-pdf-pane`);
      return !!pane && pane.scrollTop > 0 && Math.abs(pane.scrollHeight - pane.clientHeight - pane.scrollTop) < 3;
    }));
    await page.getByRole('button', { name: '中央で編集', exact: true }).click(); await rendered(page);

    await page.setViewportSize({ width: 600, height: 650 });
    await page.getByLabel('倍率', { exact: true }).selectOption('1'); await rendered(page);
    const fitWidth = (await position(page)).width;
    await page.getByLabel('倍率', { exact: true }).selectOption('0'); await rendered(page);
    const fit = (await position(page)).width / fitWidth;
    assert.ok(fit > 0 && fit * 1.25 < 1, `fixture must leave a valid fractional scale above fit, measured=${fit}`);
    await focus(page); await page.keyboard.press('Control+Equal'); await rendered(page);
    const scale = Number(await page.getByLabel('倍率', { exact: true }).inputValue());
    assert.ok(scale > fit && scale < 1); assert.ok(Math.abs(scale - fit * 1.25) < .005);
    await page.getByRole('button', { name: '右側で編集', exact: true }).click();
    const reference = page.locator('[aria-label="参照表示"]'); await reference.waitFor({ state: 'attached' });
    assert.equal(await reference.isVisible(), false, 'reference is hidden below the workspace breakpoint');
    // Both canonical hosts share the same renderer: a zero-size reference has
    // no canvas and must never normalize the visible editor's saved scale.
    assert.equal(await reference.locator('.react-pdf__Page__canvas').count(), 0);
    await rendered(page);
    await sync(page); await rendered(page);
    assert.equal(await reference.locator('.react-pdf__Page__canvas').count(), 0);
    assert.equal(Number(await page.getByLabel('倍率', { exact: true }).inputValue()), scale, 'hidden reference must not normalize global zoom');
    await page.waitForFunction(scale => {
      const key = Object.keys(localStorage).find(key => key.startsWith('paper-desk.reader.v1:'));
      const value = key && JSON.parse(localStorage.getItem(key)!) as SavedReaderState;
      return !!value && value.placement === 'right' && value.zoom.kind === 'scale' && value.zoom.value === scale;
    }, scale);
    t.diagnostic(JSON.stringify({ host: host ? 'web' : 'native', width: 600, height: 650, fit, scale }));
    await reload(page); await page.locator('[data-editor-placement="right"]').waitFor();
    assert.equal(await page.locator('[aria-label="参照表示"]').isVisible(), false);
    assert.equal(await page.locator('[aria-label="参照表示"] .react-pdf__Page__canvas').count(), 0);
    assert.equal(Number(await page.getByLabel('倍率', { exact: true }).inputValue()), scale);
    assert.deepEqual((await saved(page)).zoom, { kind: 'scale', value: scale });
    // One visible editor retains the same available width when the hidden reference mounts.
    assert.ok(Math.abs((await position(page)).width / scale - fitWidth) < 5, 'saved scale remains above the same viewport fit floor');
    assert.deepEqual((await evidence(page)).session.document, original.session.document);
    assert.equal((await evidence(page)).state.history.length, original.state.history.length);
  }
  await finish();
});
