import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication } from '../src/runtime/edits/contracts.ts';
import type { SavedReaderState } from '../src/features/reader/ReaderSession.ts';
import { openComposition, evidence } from './support/documentComposition.ts';

function seed(publication: ContentPublication) {
  assert.ok(publication.content?.kind === 'document');
  const item = publication.libraryBatch.changes.find(change => change.type === 'put-item'); assert.ok(item?.type === 'put-item');
  item.item.kind = 'notebook'; delete item.item.resourceId;
  const first = publication.content.pages[0];
  publication.content.pages = [[300, 1800], [1100, 300], [450, 900]].map(([widthPt, heightPt], index) => ({
    ...structuredClone(first), id: `30000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    widthPt, heightPt, annotations: [], background: { kind: 'paper', spec: { template: index === 1 ? 'ruled7' : 'grid5', color: 'cream' } },
  }));
}
const activePane = (page: Page) => page.locator('[aria-label="中央の編集"] .document-paper-pane, [aria-label="右側の編集"] .document-paper-pane');
async function saved(page: Page): Promise<SavedReaderState> {
  return page.evaluate(() => {
    const keys = Object.keys(localStorage).filter(key => key.startsWith('paper-desk.reader.v1:'));
    if (keys.length !== 1) throw new Error(`Expected one canonical reader state, got ${keys.length}`);
    return JSON.parse(localStorage.getItem(keys[0])!);
  });
}
async function persisted(page: Page, expected: { pageId?: string; placement?: string; zoomKind?: string; minY?: number }) {
  await page.waitForFunction(expected => {
    const key = Object.keys(localStorage).find(key => key.startsWith('paper-desk.reader.v1:'));
    if (!key) return false;
    const value = JSON.parse(localStorage.getItem(key)!) as SavedReaderState;
    return (!expected.pageId || value.pageId === expected.pageId) && (!expected.placement || value.placement === expected.placement)
      && (!expected.zoomKind || value.zoom.kind === expected.zoomKind)
      && (expected.minY === undefined || (value.positions[value.pageId]?.y ?? -1) > expected.minY);
  }, expected);
}
async function position(page: Page) {
  return activePane(page).evaluate(pane => {
    const surface = pane.querySelector('[data-paper-page]')!;
    const outer = pane.getBoundingClientRect(), box = surface.getBoundingClientRect();
    return { pageId: surface.getAttribute('data-paper-page'), x: (outer.left + pane.clientLeft + pane.clientWidth / 2 - box.left) / box.width,
      y: Math.max(0, (outer.top + pane.clientTop - box.top) / box.height), width: box.width, room: pane.clientWidth,
      scrollTop: pane.scrollTop, maxScroll: pane.scrollHeight - pane.clientHeight };
  });
}
async function focusPaper(page: Page) {
  const box = await activePane(page).boundingBox(); assert.ok(box);
  await page.mouse.click(box.x + Math.min(60, box.width / 2), box.y + 40);
}
async function go(page: Page, number: number) {
  await page.getByLabel('ページ番号', { exact: true }).fill(String(number));
  await page.getByLabel('ページ番号', { exact: true }).press('Enter');
  await activePane(page).locator(`[data-paper-page="30000000-0000-0000-0000-${String(number).padStart(12, '0')}"]`).waitFor();
}
async function anchor(page: Page, top = false, reference = false) {
  return (reference ? page.locator('[aria-label="参照表示"] .document-paper-pane') : activePane(page)).evaluate((pane, top) => {
    const surface = pane.querySelector('[data-paper-page]')!.getBoundingClientRect(), frame = pane.getBoundingClientRect();
    const x = frame.left + pane.clientWidth * (top ? .5 : .4), y = frame.top + (top ? 0 : pane.clientHeight * .3);
    return { x, y, normalizedX: (x - surface.left) / surface.width, normalizedY: (y - surface.top) / surface.height, width: surface.width };
  }, top);
}
async function sameAnchorAfterZoom(page: Page, previous: Awaited<ReturnType<typeof anchor>>, region = '中央の編集') {
  try { await page.waitForFunction(({ previous, region }) => {
    const surface = document.querySelector(`[aria-label="${region}"] [data-paper-page]`)?.getBoundingClientRect();
    return !!surface && Math.abs(surface.width - previous.width) > 1
      && Math.abs(surface.left + previous.normalizedX * surface.width - previous.x) <= 1.1
      && Math.abs(surface.top + previous.normalizedY * surface.height - previous.y) <= 1.1;
  }, { previous, region }); }
  catch (error) {
    console.error('zoom-anchor-diagnostic', JSON.stringify({ previous, current: await anchor(page, true), position: await position(page),
      zoom: await page.getByLabel('倍率', { exact: true }).inputValue(), saved: await saved(page) }));
    throw error;
  }
}

for (const engine of ['chromium', 'webkit'] as const) test(`production reader physical zoom, logical location and persistent placement (${engine})`, { timeout: 240_000 }, async t => {
  const { pages, reload: reloadMount, finish, publication } = await openComposition(t, engine, seed);
  const reload = async (page: Page) => {
    await reloadMount(page);
    // Tool preferences are separate from persistent reading state; a fresh binding defaults to pen.
    await page.getByRole('button', { name: '読む', exact: true }).click();
  };
  assert.ok(publication.content?.kind === 'document'); const [first, second] = publication.content.pages;
  for (const [host, page] of pages.entries()) {
    t.diagnostic(`${host ? 'Web' : 'Native'} reading state`);
    const original = await evidence(page);
    await page.getByRole('button', { name: '読む', exact: true }).click();
    await persisted(page, { pageId: first.id });
    await page.getByLabel('倍率', { exact: true }).selectOption('0');
    const fit = await position(page);
    assert.ok(fit.width / fit.room < .2, 'tall page has a measured fit below the legacy zoom floor');
    await focusPaper(page); await page.keyboard.press('Control+Equal');
    await page.waitForFunction(() => Number((document.querySelector('[aria-label="倍率"]') as HTMLSelectElement).value) > 0);
    const stepped = Number(await page.getByLabel('倍率', { exact: true }).inputValue());
    assert.ok(Math.abs(stepped - fit.width / fit.room * 1.25) < .003, 'zoom-in starts at actual fit × 1.25');
    await page.keyboard.down('Control');
    try { for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 180); }
    finally { await page.keyboard.up('Control'); }
    await page.waitForFunction(() => (document.querySelector('[aria-label="倍率"]') as HTMLSelectElement).value === '0');
    await persisted(page, { zoomKind: 'fit-page' });
    await page.getByLabel('倍率', { exact: true }).selectOption('4');
    await focusPaper(page); await page.keyboard.press('Control+Equal');
    assert.equal(await page.getByLabel('倍率', { exact: true }).inputValue(), '4', 'zoom remains within the maximum');
    await page.getByLabel('倍率', { exact: true }).selectOption('1.5');
    await focusPaper(page); await page.mouse.wheel(0, 550);
    await persisted(page, { minY: .02 });
    const beforeDock = await saved(page), at = beforeDock.positions[first.id];
    await page.getByRole('button', { name: '右側で編集', exact: true }).click();
    await persisted(page, { placement: 'right' });
    await page.waitForFunction(expected => {
      const pane = document.querySelector('[aria-label="右側の編集"] .document-paper-pane');
      const surface = pane?.querySelector('[data-paper-page]'); if (!pane || !surface) return false;
      return Math.abs((pane.getBoundingClientRect().top - surface.getBoundingClientRect().top) / surface.getBoundingClientRect().height - expected) < .02;
    }, at.y);
    await reload(page); await activePane(page).locator(`[data-paper-page="${first.id}"]`).waitFor();
    await page.locator('[data-editor-placement="right"]').waitFor();
    await page.waitForFunction(expected => {
      const pane = document.querySelector('[aria-label="右側の編集"] .document-paper-pane');
      const surface = pane?.querySelector('[data-paper-page]'); if (!pane || !surface) return false;
      return Math.abs((pane.getBoundingClientRect().top - surface.getBoundingClientRect().top) / surface.getBoundingClientRect().height - expected) < .02;
    }, at.y);
    assert.equal(await page.getByLabel('倍率', { exact: true }).inputValue(), '1.5');
    const restored = await position(page); assert.ok(Math.abs(restored.y - at.y) < .02, 'reload restores normalized reading anchor');
    assert.deepEqual((await saved(page)).zoom, { kind: 'scale', value: 1.5 });
    await page.getByRole('button', { name: '中央で編集', exact: true }).click();
    await persisted(page, { placement: 'center' });

    await go(page, 2); await persisted(page, { pageId: second.id });
    await page.getByLabel('倍率', { exact: true }).selectOption('1.25');
    await focusPaper(page);
    const beforePageUp = { position: await position(page), saved: await saved(page), focus: await page.evaluate(() => document.activeElement?.tagName) };
    await page.keyboard.press('PageUp');
    try { await activePane(page).locator(`[data-paper-page="${first.id}"]`).waitFor(); }
    catch (error) {
      console.error('PageUp diagnostic', JSON.stringify({ before: beforePageUp, after: await position(page), saved: await saved(page),
        focus: await page.evaluate(() => document.activeElement?.tagName), diagnostics: await page.evaluate(() => (window as unknown as { compositionDiagnostics(): unknown }).compositionDiagnostics()) }));
      throw error;
    }
    await page.waitForFunction(() => {
      const pane = document.querySelector('[aria-label="中央の編集"] .document-paper-pane');
      return !!pane && pane.scrollTop > 0 && Math.abs(pane.scrollHeight - pane.clientHeight - pane.scrollTop) < 3;
    });
    await reload(page); await activePane(page).locator(`[data-paper-page="${first.id}"]`).waitFor();
    await page.waitForFunction(() => {
      const pane = document.querySelector('[aria-label="中央の編集"] .document-paper-pane');
      return !!pane && pane.scrollTop > 0 && Math.abs(pane.scrollHeight - pane.clientHeight - pane.scrollTop) < 3;
    });
    await focusPaper(page); await page.keyboard.press('PageDown');
    await activePane(page).locator(`[data-paper-page="${second.id}"]`).waitFor();
    await page.getByRole('button', { name: '前のページ', exact: true }).click();
    await activePane(page).locator(`[data-paper-page="${first.id}"]`).waitFor();
    await reload(page); await activePane(page).locator(`[data-paper-page="${first.id}"]`).waitFor();
    assert.ok((await position(page)).scrollTop < 3, 'page button requests top, distinct from PageUp end intent');

    // Prior persisted preferences are fixture input; the live ReaderSession is never mutated.
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.startsWith('paper-desk.reader.v1:'))!;
      const previous = JSON.parse(localStorage.getItem(key)!); previous.zoom = { kind: 'scale', value: .001 };
      localStorage.setItem(key, JSON.stringify(previous));
    });
    await reload(page); await activePane(page).locator(`[data-paper-page="${first.id}"]`).waitFor();
    await page.waitForFunction(() => (document.querySelector('[aria-label="倍率"]') as HTMLSelectElement).value === '0');
    await persisted(page, { zoomKind: 'fit-page' });
    await page.getByLabel('倍率', { exact: true }).selectOption('1.5');
    await focusPaper(page); await page.mouse.wheel(0, 650); await persisted(page, { minY: .03 });
    const wheelAnchor = await anchor(page);
    await page.mouse.move(wheelAnchor.x, wheelAnchor.y); await page.keyboard.down('Control');
    try { await page.mouse.wheel(0, -25); } finally { await page.keyboard.up('Control'); }
    await sameAnchorAfterZoom(page, wheelAnchor);
    assert.ok(Number(await page.getByLabel('倍率', { exact: true }).inputValue()) < 3, 'leave headroom for the following Safari gesture');
    const gestureAnchor = await anchor(page, true);
    await activePane(page).evaluate(pane => {
      for (const [name, scale] of [['gesturestart', 1], ['gesturechange', 1.1], ['gestureend', 1.1]] as const) {
        const event = new Event(name, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'scale', { value: scale }); pane.dispatchEvent(event);
      }
    });
    await sameAnchorAfterZoom(page, gestureAnchor);
    await page.getByLabel('倍率', { exact: true }).selectOption('1.5');
    await page.getByRole('button', { name: '右側で編集', exact: true }).click();
    await persisted(page, { placement: 'right' });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const editorAnchor = await anchor(page, true), referenceAnchor = await anchor(page, false, true);
    await page.mouse.move(referenceAnchor.x, referenceAnchor.y); await page.keyboard.down('Control');
    try { await page.mouse.wheel(0, -25); } finally { await page.keyboard.up('Control'); }
    await sameAnchorAfterZoom(page, referenceAnchor, '参照表示');
    await sameAnchorAfterZoom(page, editorAnchor, '右側の編集');
    const referenceBox = await page.locator('[aria-label="参照表示"] .document-paper-pane').boundingBox(); assert.ok(referenceBox);
    await page.mouse.move(referenceBox.x + referenceBox.width / 2, referenceBox.y + referenceBox.height / 2);
    await page.mouse.wheel(0, 500);
    await page.waitForFunction(() => (document.querySelector('[aria-label="参照表示"] .document-paper-pane')?.scrollTop ?? 0) > 100);
    await page.getByRole('button', { name: '次のページ', exact: true }).click();
    await page.waitForFunction(id => ['参照表示', '右側の編集'].every(name => {
      const pane = document.querySelector(`[aria-label="${name}"] .document-paper-pane`);
      return pane?.querySelector('[data-paper-page]')?.getAttribute('data-paper-page') === id && pane.scrollTop < 2;
    }), second.id);
    const nextReference = await page.locator('[aria-label="参照表示"] .document-paper-pane').boundingBox(); assert.ok(nextReference);
    await page.mouse.click(nextReference.x + 40, nextReference.y + 40); await page.keyboard.press('PageUp');
    await page.waitForFunction(id => ['参照表示', '右側の編集'].every(name => {
      const pane = document.querySelector(`[aria-label="${name}"] .document-paper-pane`);
      return pane?.querySelector('[data-paper-page]')?.getAttribute('data-paper-page') === id
        && pane.scrollTop > 0 && Math.abs(pane.scrollHeight - pane.clientHeight - pane.scrollTop) < 3;
    }), first.id);
    assert.deepEqual((await evidence(page)).session.document, original.session.document);
    assert.equal((await evidence(page)).state.history.length, original.state.history.length, 'reading never authors document operations');
  }
  await finish();
});
