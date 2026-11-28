import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { gesture, ordinaryWeb } from './ordinaryWeb.ts';

// B14-2 (R14 / REF03): the same imported PDF is reopened at device pixel ratios 1, 2, 1.5 and 3 (Playwright's
// `deviceScaleFactor`, a simulation of a HiDPI display, not a real one). At each ratio the same gesture draws an arrow on
// page 2 (physical 1400x1080 pt) and the same kind of click places a sticky note on page 4 (physical 1225x945 pt).
// Expected values are literal points derived from the fixture's physical page sizes, not read back from the product.
const RATIOS = [1, 2, 1.5, 3] as const;
const TITLE = 'shared-coordinate-pages.pdf';
const ARROW = { page: 2, widthPt: 1400, heightPt: 1080, from: [.2, .3], to: [.45, .4] } as const;
const STICKY = { page: 4, widthPt: 1225, heightPt: 945, y: .5, x: [.25, .4, .55, .7] } as const;
const PT_TOLERANCE = 3; // Chromium stores fraction x physical size to better than 1e-3 pt; WebKit lands up to about 1.5 pt (0.9 CSS px) off the pointer point (observed). 1 CSS px is 1.6 to 1.8 pt on these pages. Wrong-ratio bugs move points by tens to hundreds of pt.
// The same CSS layout must give the same points at every ratio: Chromium agrees to 1e-3 pt. WebKit's first stroke sample is not the mouse-down point and moves by up to about 1.2 pt (0.7 CSS px) from run to run and at ratio 1.5, where it also snaps the layout by about 2 CSS px; so WebKit agrees to about 1.5 CSS px (3 pt).
const crossRatioPt = (engine: 'chromium' | 'webkit') => engine === 'chromium' ? .01 : 3;
const numbers = (markup: string) => [...markup.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0]));

async function showPage(page: Page, number: number, ratio: number) {
  // A page jump typed before the document's page count is known may be lost (seen twice in WebKit): wait until "next page" is enabled, which needs the count.
  await page.waitForFunction(() => { const next = document.querySelector<HTMLButtonElement>('button[aria-label="次のページ"]'); return !!next && !next.disabled; });
  await page.getByLabel('ページ番号', { exact: true }).fill(String(number));
  await page.getByLabel('ページ番号', { exact: true }).press('Enter');
  try { await page.locator(`[data-rendered="true"] .react-pdf__Page[data-page-number="${number}"] canvas`).waitFor(); } catch (error) {
    const state = await page.evaluate(() => ({ ratio: window.devicePixelRatio, rendered: document.querySelector('[data-rendered]')?.getAttribute('data-rendered'),
      canvases: [...document.querySelectorAll('canvas')].map(canvas => [canvas.width, canvas.height, canvas.getBoundingClientRect().width]),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(alert => alert.textContent),
      pageNumberField: document.querySelector<HTMLInputElement>('input[aria-label="ページ番号"]')?.value, count: document.querySelector('.sr-only')?.textContent })).catch(String);
    throw new Error(`page ${number} not rendered at ratio ${ratio}: ${JSON.stringify(state)}: ${String(error)}`);
  }
}

/** Real DOM: the page's canvas backing store against its CSS box, and the annotation layer's CSS box. */
const rendering = (page: Page, number: number, label: string) => page.evaluate(({ number, label }) => {
  const canvas = document.querySelector<HTMLCanvasElement>(`[data-rendered="true"] .react-pdf__Page[data-page-number="${number}"] canvas`)!;
  const layer = document.querySelector(`[aria-label="${label}"]`)!.getBoundingClientRect(), css = canvas.getBoundingClientRect();
  return { devicePixelRatio: window.devicePixelRatio, backingRatio: canvas.width / css.width, cssWidth: css.width, cssHeight: css.height,
    layerWidth: layer.width, layerHeight: layer.height };
}, { number, label });

/** Where a drawn element sits on screen, as a fraction of the annotation layer (independent of the stored points). */
const onScreen = (page: Page, selector: string, label: string) => page.evaluate(({ selector, label }) => {
  const layer = document.querySelector(`[aria-label="${label}"]`)!.getBoundingClientRect(), box = document.querySelector(selector)!.getBoundingClientRect();
  return { left: (box.left - layer.left) / layer.width, right: (box.right - layer.left) / layer.width,
    top: (box.top - layer.top) / layer.height, bottom: (box.bottom - layer.top) / layer.height,
    centerX: (box.left + box.width / 2 - layer.left) / layer.width, centerY: (box.top + box.height / 2 - layer.top) / layer.height };
}, { selector, label });

async function collapseCatalog(page: Page) {
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') === 'true') await catalog.click();
  assert.equal(await catalog.getAttribute('aria-expanded'), 'false');
}

const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected} within ${tolerance}, actual ${actual}`);

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary P2 keeps canonical points and on-screen positions of ink and sticky notes identical across device pixel ratios 1, 2, 1.5, 3 (${engine})`, { timeout: 420_000 }, async t => {
  const app = await ordinaryWeb(t, engine, { deviceScaleFactor: RATIOS[0] });
  let page = app.page;
  const fixture = path.resolve(import.meta.dirname, '../../../../../tests/fixtures/shared-coordinate-pages.pdf');
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(fixture);
  await page.getByRole('heading', { name: TITLE, exact: true }).waitFor();
  const documentId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(documentId);
  await collapseCatalog(page);
  const imported = await committed(page, documentId);
  assert.deepEqual(imported.root.pages.map(physical => [Math.round(physical.widthPt), Math.round(physical.heightPt)]),
    [[810, 1050], [1400, 1080], [675, 875], [1225, 945], [720, 932]], 'physical points do not depend on the ratio');
  assert.equal(imported.edits.length, 0);

  const arrowIds: string[] = [], drawings = new Map<string, string>(), arrowOnScreen: { left: number; right: number; top: number; bottom: number }[] = [];
  const stickyIds: string[] = [];
  let previousEdits: Awaited<ReturnType<typeof committed>>['edits'] = [];
  const report: unknown[] = [];
  let layout = { cssWidth: 0, cssHeight: 0, layerWidth: 0, layerHeight: 0 };

  for (const [index, ratio] of RATIOS.entries()) {
    if (index > 0) page = await app.restart(TITLE, { deviceScaleFactor: ratio });
    await collapseCatalog(page); // the same layout at every ratio, so that only the ratio differs
    // ---- page 2: ink ----
    await showPage(page, ARROW.page, ratio);
    const draw = await rendering(page, ARROW.page, 'PDF書き込みレイヤー');
    assert.equal(draw.devicePixelRatio, ratio, `the context really runs at ratio ${ratio}`);
    // The canvas backing store follows the ratio (the product caps it only for very large canvases).
    near(draw.backingRatio, ratio, .02, `canvas backing ratio at ${ratio}`);
    const reopened = await committed(page, documentId);
    assert.deepEqual(reopened.edits, previousEdits, 'reopening at another ratio changes no stored edit');
    assert.deepEqual(reopened.root.pages.map(physical => physical.widthPt), imported.root.pages.map(physical => physical.widthPt));
    assert.ok(draw.layerWidth > 0 && draw.layerHeight > 0);
    if (index === 0) layout = { cssWidth: draw.cssWidth, cssHeight: draw.cssHeight, layerWidth: draw.layerWidth, layerHeight: draw.layerHeight };
    else for (const key of ['cssWidth', 'cssHeight', 'layerWidth', 'layerHeight'] as const) near(draw[key], layout[key], 3, `${key} in CSS px at ratio ${ratio} stays the ratio-1 size (WebKit at 1.5 snaps the layout by about 2 CSS px)`);
    // Arrows drawn at earlier ratios appear exactly as drawn, at the same place on the page.
    const shown = await inks(page);
    assert.deepEqual(shown.map(value => value.id).sort(), [...arrowIds].sort(), `earlier arrows shown at ratio ${ratio}`);
    for (const value of shown) assert.equal(value.drawing, drawings.get(value.id), `arrow ${value.id} drawn identically at ratio ${ratio}`);
    for (const [seen, id] of arrowIds.entries()) {
      const place = await onScreen(page, `[data-ink-id="${id}"]`, 'PDF書き込みレイヤー');
      for (const side of ['left', 'right', 'top', 'bottom'] as const) near(place[side], arrowOnScreen[seen][side], .002, `arrow ${seen} ${side} at ratio ${ratio}`);
    }
    await page.getByLabel('描画の種類', { exact: true }).selectOption('arrow');
    await page.getByLabel('書き込みの色', { exact: true }).fill('#228855');
    await page.getByLabel('線の太さ', { exact: true }).selectOption('0.006');
    await gesture(page, [[...ARROW.from], [...ARROW.to]], 'PDF書き込みレイヤー');
    await page.waitForFunction(count => document.querySelectorAll('[data-ink-id]').length === count, arrowIds.length + 1);
    const nowShown = await inks(page), added = nowShown.filter(value => !arrowIds.includes(value.id)); assert.equal(added.length, 1);
    const inkId = added[0].id;
    const afterInk = await durable(page, documentId, [...arrowIds, inkId], 2 * index + 1);
    const arrowEdit = afterInk.edits.find(edit => edit.batch.kind === 'page' && edit.batch.changes.some(change => change.type === 'create' && change.annotation.id === inkId));
    assert.ok(arrowEdit && arrowEdit.batch.kind === 'page'); if (arrowEdit.batch.kind !== 'page') throw new Error('page edit expected');
    assert.equal(arrowEdit.batch.expected.pageId, imported.root.pages[ARROW.page - 1].id, 'the arrow belongs to physical page 2 whatever the ratio');
    const created = arrowEdit.batch.changes.find(change => change.type === 'create');
    assert.ok(created && created.type === 'create' && created.annotation.kind === 'ink'); if (created.type !== 'create' || created.annotation.kind !== 'ink') throw new Error('ink expected');
    const geometry = created.annotation.geometry; assert.equal(geometry.kind, 'arrow'); if (geometry.kind !== 'arrow') throw new Error('arrow expected');
    near(geometry.start.x, ARROW.from[0] * ARROW.widthPt, PT_TOLERANCE, `arrow start.x pt at ratio ${ratio}`);
    near(geometry.start.y, ARROW.from[1] * ARROW.heightPt, PT_TOLERANCE, `arrow start.y pt at ratio ${ratio}`);
    near(geometry.end.x, ARROW.to[0] * ARROW.widthPt, PT_TOLERANCE, `arrow end.x pt at ratio ${ratio}`);
    near(geometry.end.y, ARROW.to[1] * ARROW.heightPt, PT_TOLERANCE, `arrow end.y pt at ratio ${ratio}`);
    // Cross-ratio: the first arrow's stored points are the reference for every later ratio.
    const firstEdit = index === 0 ? arrowEdit : previousEdits.find(edit => edit.batch.kind === 'page' && edit.batch.changes.some(change => change.type === 'create' && change.annotation.id === arrowIds[0]))!;
    const firstCreated = firstEdit.batch.kind === 'page' ? firstEdit.batch.changes.find(change => change.type === 'create') : undefined;
    assert.ok(firstCreated && firstCreated.type === 'create' && firstCreated.annotation.kind === 'ink' && firstCreated.annotation.geometry.kind === 'arrow');
    if (firstCreated.type !== 'create' || firstCreated.annotation.kind !== 'ink' || firstCreated.annotation.geometry.kind !== 'arrow') throw new Error('arrow expected');
    const reference = firstCreated.annotation.geometry;
    near(geometry.start.x, reference.start.x, crossRatioPt(engine), `arrow start.x equals the ratio-1 arrow at ${ratio}`);
    near(geometry.start.y, reference.start.y, crossRatioPt(engine), `arrow start.y equals the ratio-1 arrow at ${ratio}`);
    near(geometry.end.x, reference.end.x, crossRatioPt(engine), `arrow end.x equals the ratio-1 arrow at ${ratio}`);
    near(geometry.end.y, reference.end.y, crossRatioPt(engine), `arrow end.y equals the ratio-1 arrow at ${ratio}`);
    arrowIds.push(inkId); drawings.set(inkId, added[0].drawing);
    const place = await onScreen(page, `[data-ink-id="${inkId}"]`, 'PDF書き込みレイヤー');
    // The arrow's box covers the stroke around the segment (.2,.3)-(.45,.4) of the layer.
    near(place.left, ARROW.from[0], .02, `arrow left edge on screen at ${ratio}`); near(place.right, ARROW.to[0], .02, `arrow right edge on screen at ${ratio}`);
    near(place.top, ARROW.from[1], .03, `arrow top on screen at ${ratio}`); near(place.bottom, ARROW.to[1], .03, `arrow bottom on screen at ${ratio}`);
    arrowOnScreen.push({ left: place.left, right: place.right, top: place.top, bottom: place.bottom });
    if (index > 0) {
      // Same drawing as the ratio-1 arrow up to float noise in the last digits (the markup is otherwise identical).
      const first = numbers(drawings.get(arrowIds[0])!), again = numbers(added[0].drawing);
      assert.equal(again.length, first.length);
      first.forEach((value, at) => near(again[at], value, crossRatioPt(engine), `drawing number ${at} at ratio ${ratio}`));
      assert.equal(added[0].drawing.replace(/-?\d+(?:\.\d+)?/g, '#'), drawings.get(arrowIds[0])!.replace(/-?\d+(?:\.\d+)?/g, '#'));
    }

    // ---- page 4: sticky note ----
    await showPage(page, STICKY.page, ratio);
    const sticky = await rendering(page, STICKY.page, '注釈の配置と選択');
    assert.equal(sticky.devicePixelRatio, ratio);
    await page.getByRole('button', { name: '付箋を貼る', exact: true }).click();
    await gesture(page, [[STICKY.x[index], STICKY.y]], '注釈の配置と選択');
    const form = page.getByRole('region', { name: '注釈を編集', exact: true });
    await form.getByRole('textbox', { name: '付箋のメモ', exact: true }).fill(`dpr ${ratio}`);
    await form.getByRole('button', { name: '確定', exact: true }).click();
    const afterSticky = await durable(page, documentId, [], 2 * index + 2);
    const stickyEdit = afterSticky.edits.find(edit => edit.batch.kind === 'page' && edit.batch.changes.some(change => change.type === 'create' && change.annotation.kind === 'sticky'
      && change.annotation.text === `dpr ${ratio}`));
    assert.ok(stickyEdit && stickyEdit.batch.kind === 'page'); if (stickyEdit.batch.kind !== 'page') throw new Error('page edit expected');
    assert.equal(stickyEdit.batch.expected.pageId, imported.root.pages[STICKY.page - 1].id, 'the sticky belongs to physical page 4 whatever the ratio');
    const note = stickyEdit.batch.changes.find(change => change.type === 'create');
    assert.ok(note && note.type === 'create' && note.annotation.kind === 'sticky'); if (note.type !== 'create' || note.annotation.kind !== 'sticky') throw new Error('sticky expected');
    near(note.annotation.anchor.x, STICKY.x[index] * STICKY.widthPt, PT_TOLERANCE, `sticky anchor.x pt at ratio ${ratio}`);
    near(note.annotation.anchor.y, STICKY.y * STICKY.heightPt, PT_TOLERANCE, `sticky anchor.y pt at ratio ${ratio}`);
    stickyIds.push(note.annotation.id);
    // Rendered position: the saved sticky's circle sits where the click was, as a fraction of the page layer.
    const dot = await onScreen(page, `[data-sticky-id="${note.annotation.id}"] circle`, '注釈の配置と選択');
    near(dot.centerX, STICKY.x[index], .005, `sticky circle x on screen at ${ratio}`); near(dot.centerY, STICKY.y, .005, `sticky circle y on screen at ${ratio}`);
    previousEdits = afterSticky.edits;
    report.push({ ratio, observedRatio: draw.devicePixelRatio, backingRatio: draw.backingRatio, cssWidth: draw.cssWidth, cssHeight: draw.cssHeight,
      arrow: { start: geometry.start, end: geometry.end }, sticky: note.annotation.anchor, arrowOnScreen: place, stickyOnScreen: dot });
  }
  // Every stored edit survived all four reopenings unchanged; stickies from every ratio are present and ordered by their own x.
  const final = await committed(page, documentId);
  assert.deepEqual(final.edits, previousEdits);
  assert.equal(final.edits.length, 8);
  assert.equal(stickyIds.length, 4); assert.equal(arrowIds.length, 4);
  t.diagnostic(JSON.stringify({ engine, documentId, report }));
});
