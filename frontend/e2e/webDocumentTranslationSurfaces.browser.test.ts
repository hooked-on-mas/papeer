import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Page, Locator } from 'playwright-core';
import type { ContentPublication, DocumentSnapshot, ResourceMetadata } from '../src/runtime/edits/contracts.ts';
import type { SavedReaderState } from '../src/features/reader/ReaderSession.ts';
import { openComposition, evidence, sync } from './support/documentComposition.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8')) as {
  resource: { metadata: ResourceMetadata };
};
type Surface = 'original' | 'translated';
function seed(publication: ContentPublication) {
  assert.ok(publication.content?.kind === 'document');
  const document = publication.content, template = document.pages[0];
  document.pages = Array.from({ length: 7 }, () => ({ ...structuredClone(template), id: crypto.randomUUID(), annotations: [] }));
  const pages = [2, 4, 3].map(pdfPage => {
    assert.equal(template.background.kind, 'pdf');
    if (template.background.kind !== 'pdf') throw new Error('PDF fixture required');
    const dimensions = fixture.resource.metadata.pdfPages![pdfPage - 1];
    return { ...structuredClone(template), ...dimensions, id: crypto.randomUUID(), annotations: [],
      background: { ...template.background, pdfPage } };
  });
  document.translation = { revision: crypto.randomUUID(), pages, bindings: [0, 2, 6].map((index, offset) => ({
    original: { pageId: document.pages[index].id, backgroundRevision: document.pages[index].backgroundRevision },
    candidates: [{ pageId: pages[offset].id, backgroundRevision: pages[offset].backgroundRevision }],
  })) };
}
const surface = (page: Page, value: Surface) => page.locator(`[data-reader-surface="${value}"]`);
const pane = (page: Page, value: Surface) => surface(page, value).locator('[data-pdf-scroller], .web-pdf-pane');
async function saved(page: Page): Promise<SavedReaderState> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find(value => value.startsWith('paper-desk.reader.v1:'));
    if (!key) throw new Error('missing reader preference');
    return JSON.parse(localStorage.getItem(key)!);
  });
}
async function idle(page: Page) {
  await waitForSnapshot(() => evidence(page), value => value.session.ready && value.session.phase === 'idle' && !value.session.inputActive);
}
async function rendered(page: Page, value: Surface, id: string, physical: number) {
  await surface(page, value).locator(`[data-canonical-page="${id}"]`).waitFor();
  await surface(page, value).locator(`.react-pdf__Page[data-page-number="${physical}"] canvas`).waitFor();
  await surface(page, value).locator('[data-rendered="true"] .react-pdf__Page__canvas').waitFor();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function measuredPosition(page: Page, value: Surface) {
  return pane(page, value).evaluate(element => {
    const child = element.querySelector('.ink-page, [data-pdf-surface]')!.getBoundingClientRect();
    const frame = element.getBoundingClientRect();
    return { x: (frame.left + element.clientLeft + element.clientWidth / 2 - child.left) / child.width,
      y: Math.max(0, (frame.top + element.clientTop - child.top) / child.height), scrollTop: element.scrollTop };
  });
}
async function pointOnPage(page: Page, value: Surface, point: { x: number; y: number }) {
  return pane(page, value).evaluate((element, point) => {
    const box = element.querySelector('.ink-page, [data-pdf-surface]')!.getBoundingClientRect();
    return { x: (point.x - box.left) / box.width, y: (point.y - box.top) / box.height };
  }, point);
}
async function jump(page: Page, value: number) {
  await page.getByLabel('ページ番号', { exact: true }).fill(String(value));
  await page.getByLabel('ページ番号', { exact: true }).press('Enter');
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), String(value));
}
async function focus(page: Page, value: Surface) {
  const box = await pane(page, value).boundingBox(); assert.ok(box);
  await page.mouse.click(box.x + Math.min(60, box.width / 2), box.y + 45);
}
async function stroke(page: Page, target: Locator, settle = true) {
  const box = await target.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width * .25, box.y + Math.min(90, box.height * .2));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .5, box.y + Math.min(160, box.height * .4), { steps: 10 });
  await page.mouse.up(); if (settle) await idle(page);
}
async function counts(page: Page) {
  const document = (await evidence(page)).session.document!;
  return [document.pages[0].annotations.length, document.translation!.pages[0].annotations.length];
}
async function assertFit(page: Page, value: Surface) {
  const dimensions = await pane(page, value).evaluate(element => {
    const child = element.querySelector<HTMLElement>('.ink-page, [data-pdf-surface]')!;
    const bounds = child.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, availableWidth: element.clientWidth, availableHeight: element.clientHeight };
  });
  assert.ok(dimensions.width <= dimensions.availableWidth + 2 && dimensions.height <= dimensions.availableHeight + 2,
    `${value} fit must display the whole page: ${JSON.stringify(dimensions)}`);
  // Each host reserves page padding; at least one side must fill the available region within that padding.
  assert.ok(dimensions.width >= dimensions.availableWidth - 48 || dimensions.height >= dimensions.availableHeight - 48,
    `${value} must not shrink below fit: ${JSON.stringify(dimensions)}`);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production original/translated mapping, shared input and independent fit (${engine})`, { timeout: 360_000 }, async t => {
  const { pages, publication, reload, finish } = await openComposition(t, engine, seed);
  assert.ok(publication.content?.kind === 'document');
  const document: DocumentSnapshot = publication.content;
  const originalId = document.pages[0].id, translatedId = document.translation!.pages[0].id;
  for (const [host, page] of pages.entries()) {
    t.diagnostic(`${host ? 'Web' : 'Native'}: logical pages 1/3/7 map to physical translated pages 2/4/3`);
    await sync(page);
    await page.getByRole('button', { name: '読む', exact: true }).click();
    await page.getByRole('button', { name: '左右', exact: true }).click();
    await rendered(page, 'original', originalId, 1); await rendered(page, 'translated', translatedId, 2);
    assert.equal(await page.getByRole('toolbar', { name: 'PDFの操作', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '消しゴム', exact: true }).count(), 1);

    await jump(page, 2);
    await surface(page, 'translated').getByRole('status').filter({ hasText: 'このページの訳文はまだありません。' }).waitFor();
    assert.equal(await surface(page, 'translated').locator('.react-pdf__Page').count(), 0, 'missing translation must never reuse its previous physical page');
    await page.getByRole('checkbox', { name: '訳文があるページだけ', exact: true }).check();
    assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '1');
    for (const [logical, physical, index] of [[3, 4, 1], [7, 3, 2]] as const) {
      await page.getByRole('button', { name: '次のページ', exact: true }).click();
      assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), String(logical));
      await rendered(page, 'translated', document.translation!.pages[index].id, physical);
    }
    assert.equal(await page.getByRole('button', { name: '次のページ', exact: true }).isDisabled(), true);
    await focus(page, 'original'); await page.keyboard.press('Home');
    await rendered(page, 'original', originalId, 1);
    assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '1');
    await waitForSnapshot(() => saved(page), value => value.pageId === originalId && value.landing?.toEnd === false);
    assert.ok((await measuredPosition(page, 'original')).scrollTop < 2);
    await focus(page, 'original'); await page.keyboard.press('End');
    await rendered(page, 'original', document.pages[6].id, 1);
    assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '7');
    await waitForSnapshot(() => saved(page), value => value.pageId === document.pages[6].id && value.landing?.toEnd === false);
    assert.ok((await measuredPosition(page, 'original')).scrollTop < 2);
    // Even an explicit same-page jump clears the translated-only filter.
    await jump(page, 7);
    assert.equal(await page.getByRole('checkbox', { name: '訳文があるページだけ', exact: true }).isChecked(), false);
    await page.getByRole('button', { name: '前のページ', exact: true }).click();
    assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '6');
    await jump(page, 1); await rendered(page, 'translated', translatedId, 2);

    await page.getByLabel('倍率', { exact: true }).selectOption('0');
    await rendered(page, 'original', originalId, 1); await rendered(page, 'translated', translatedId, 2);
    await assertFit(page, 'original'); await assertFit(page, 'translated');
    const baseline = await counts(page);
    await page.getByRole('button', { name: 'ペン', exact: true }).click();
    await stroke(page, pane(page, 'translated'));
    assert.equal(await surface(page, 'translated').getAttribute('data-active-surface'), 'true');
    assert.deepEqual(await counts(page), baseline, 'the entire inactive-surface activation gesture is consumed');
    // Contacts must be released by the same-window pointerup listener after activation.
    await page.getByRole('button', { name: '読む', exact: true }).click();
    await focus(page, 'translated'); await page.keyboard.press('Control+Equal');
    await waitForSnapshot(() => page.getByLabel('倍率', { exact: true }).inputValue(), value => Number(value) > 0);
    await page.getByLabel('倍率', { exact: true }).selectOption('0');
    await rendered(page, 'translated', translatedId, 2);
    await page.getByRole('button', { name: 'ペン', exact: true }).click();
    await stroke(page, page.getByLabel('PDF書き込みレイヤー', { exact: true }));
    await waitForSnapshot(() => counts(page), value => value[0] === baseline[0] && value[1] === baseline[1] + 1);
    await stroke(page, pane(page, 'original')); assert.deepEqual(await counts(page), [baseline[0], baseline[1] + 1]);
    await stroke(page, page.getByLabel('PDF書き込みレイヤー', { exact: true }));
    await waitForSnapshot(() => counts(page), value => value[0] === baseline[0] + 1 && value[1] === baseline[1] + 1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await idle(page);
    assert.deepEqual(await counts(page), [baseline[0], baseline[1] + 1], 'one document history spans both surfaces');
    await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await idle(page);
    assert.deepEqual(await counts(page), [baseline[0] + 1, baseline[1] + 1]);

    await page.getByRole('button', { name: '文字', exact: true }).click();
    const textBox = await page.getByLabel('PDF書き込みレイヤー', { exact: true }).boundingBox(); assert.ok(textBox);
    await page.mouse.click(textBox.x + textBox.width * .3, textBox.y + textBox.height * .2);
    const draft = page.getByRole('textbox', { name: '書き込みテキスト', exact: true }); await draft.fill('surface guard');
    assert.equal(await page.getByRole('button', { name: '訳文', exact: true }).isDisabled(), true);
    await stroke(page, pane(page, 'translated'), false);
    assert.equal(await surface(page, 'original').getAttribute('data-active-surface'), 'true');
    assert.equal(await draft.inputValue(), 'surface guard');
    await draft.press('Escape'); await idle(page);

    t.diagnostic(`${host ? 'Web' : 'Native'}: independent original/translated single-pane positions`);
    await page.getByRole('button', { name: '読む', exact: true }).click();
    await page.getByRole('button', { name: '原文', exact: true }).click();
    // Leave enough scroll range for the landscape translation after returning to a half-width pane.
    await page.getByLabel('倍率', { exact: true }).selectOption('3'); await rendered(page, 'original', originalId, 1);
    await focus(page, 'original'); await page.mouse.wheel(0, 280);
    const originalPlace = await waitForSnapshot(() => saved(page), value => (value.positions[originalId]?.y ?? 0) > .05);
    await page.getByRole('button', { name: '訳文', exact: true }).click();
    await rendered(page, 'translated', translatedId, 2);
    await focus(page, 'translated'); await page.mouse.wheel(0, 420);
    const translatedPlace = await waitForSnapshot(() => saved(page), value => (value.positions[translatedId]?.y ?? 0) > .05
      && Math.abs(value.positions[translatedId].y - originalPlace.positions[originalId].y) > .04);
    const expectedPlaces = { [originalId]: originalPlace.positions[originalId], [translatedId]: translatedPlace.positions[translatedId] };
    await page.getByRole('button', { name: '左右', exact: true }).click();
    await rendered(page, 'original', originalId, 1); await rendered(page, 'translated', translatedId, 2);
    const position = await saved(page);
    t.diagnostic(`${host ? 'Web' : 'Native'}: split restore ${JSON.stringify({ original: position.positions[originalId], translated: position.positions[translatedId] })}`);
    try {
      await sync(page);
      await waitForSnapshot(() => saved(page), value => Math.abs(value.positions[originalId].y - position.positions[originalId].y) < .02
        && Math.abs(value.positions[translatedId].y - position.positions[translatedId].y) < .02);
      for (const value of ['original', 'translated'] as const) {
        const id = value === 'original' ? originalId : translatedId;
        await waitForSnapshot(() => measuredPosition(page, value), actual => Math.abs(actual.y - expectedPlaces[id].y) < .02
          && Math.abs(actual.x - expectedPlaces[id].x) < .02 && actual.scrollTop > 0);
      }
    } catch (cause) {
      console.error('split-position-failure', { expected: expectedPlaces, saved: (await saved(page)).positions,
        original: await measuredPosition(page, 'original'), translated: await measuredPosition(page, 'translated') });
      throw Object.assign(new Error('independent split positions were not restored'), { cause });
    }
    await reload(page); await page.getByRole('button', { name: '読む', exact: true }).click();
    t.diagnostic(`${host ? 'Web' : 'Native'}: reload restore`);
    await rendered(page, 'original', originalId, 1); await rendered(page, 'translated', translatedId, 2);
    assert.equal(await page.getByRole('button', { name: '左右', exact: true }).getAttribute('aria-pressed'), 'true');
    await waitForSnapshot(() => saved(page), value => Math.abs(value.positions[originalId].y - position.positions[originalId].y) < .02
      && Math.abs(value.positions[translatedId].y - position.positions[translatedId].y) < .02);
    for (const value of ['original', 'translated'] as const) {
      const id = value === 'original' ? originalId : translatedId;
      await waitForSnapshot(() => measuredPosition(page, value), actual => Math.abs(actual.y - expectedPlaces[id].y) < .02
        && Math.abs(actual.x - expectedPlaces[id].x) < .02 && actual.scrollTop > 0);
    }

    // The active point and the companion's independent top anchor survive asynchronous raster completion.
    t.diagnostic(`${host ? 'Web' : 'Native'}: continuous wheel anchors`);
    const bounds = await pane(page, 'translated').boundingBox(); assert.ok(bounds);
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + 90 };
    await page.mouse.move(point.x, point.y);
    for (let index = 0; index < 3; index++) {
      const activeAnchor = await pointOnPage(page, 'translated', point), companionAnchor = await measuredPosition(page, 'original');
      const previousZoom = Number(await page.getByLabel('倍率', { exact: true }).inputValue());
      await page.keyboard.down('Control'); await page.mouse.wheel(0, -5); await page.keyboard.up('Control');
      await waitForSnapshot(() => page.getByLabel('倍率', { exact: true }).inputValue(), value => Number(value) > previousZoom);
      await rendered(page, 'original', originalId, 1); await rendered(page, 'translated', translatedId, 2);
      await waitForSnapshot(() => pointOnPage(page, 'translated', point), value => Math.abs(value.x - activeAnchor.x) < .02 && Math.abs(value.y - activeAnchor.y) < .02);
      await waitForSnapshot(() => measuredPosition(page, 'original'), value => Math.abs(value.y - companionAnchor.y) < .02);
    }
    if (engine === 'chromium') {
      // Actual browser touch pointers exercise the device-owned anchor path (keepPlace=false).
      await page.getByLabel('倍率', { exact: true }).selectOption('2');
      await rendered(page, 'translated', translatedId, 2);
      const frame = await pane(page, 'translated').boundingBox(); assert.ok(frame);
      const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height * .4 };
      const before = await pointOnPage(page, 'translated', centre);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      const touches = (radius: number, dx = 0, dy = 0) => [
        { id: 1, x: centre.x + dx - radius, y: centre.y + dy }, { id: 2, x: centre.x + dx + radius, y: centre.y + dy },
      ];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(40) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touches(50, 15, 20) });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await waitForSnapshot(() => page.getByLabel('倍率', { exact: true }).inputValue(), value => Number(value) > 2.2);
      await rendered(page, 'translated', translatedId, 2);
      await waitForSnapshot(() => pointOnPage(page, 'translated', { x: centre.x + 15, y: centre.y + 20 }), value => Math.abs(value.x - before.x) < .02 && Math.abs(value.y - before.y) < .02);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await cdp.detach();
      t.diagnostic(`${host ? 'Web' : 'Native'}: device-owned touch pinch anchor preserved`);
    }

    await page.getByLabel('倍率', { exact: true }).selectOption('0');
    for (const value of ['original', 'translated'] as const) {
      await focus(page, value); await rendered(page, value, value === 'original' ? originalId : translatedId, value === 'original' ? 1 : 2);
      for (let index = 0; index < 5; index++) await page.keyboard.press('Control+Minus');
      await assertFit(page, value);
    }
    await page.setViewportSize({ width: 900, height: 700 });
    await rendered(page, 'original', originalId, 1); await rendered(page, 'translated', translatedId, 2);
    await assertFit(page, 'original'); await assertFit(page, 'translated');
    await page.getByRole('button', { name: '右側で編集', exact: true }).click();
    await rendered(page, 'original', originalId, 1); await rendered(page, 'translated', translatedId, 2);
    assert.equal(await page.getByLabel('PDF書き込みレイヤー', { exact: true }).count(), 1);
    assert.equal(await page.locator('[aria-label="参照表示"]').getByLabel('PDF書き込みレイヤー', { exact: true }).count(), 0);
    assert.equal(await page.locator(`[aria-label="参照表示"] [data-canonical-page="${translatedId}"]`).count(), 1);
    await page.getByRole('button', { name: '中央で編集', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await sync(page);
  }
  await finish();
});
