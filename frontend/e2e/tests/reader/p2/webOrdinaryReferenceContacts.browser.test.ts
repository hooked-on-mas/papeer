import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page } from 'playwright-core';
import { ordinaryWeb } from './ordinaryWeb.ts';
import { committed } from './ordinaryStorage.ts';
import { observePointers } from '../../../support/observePointers.ts';

type Point = { x: number; y: number };
const pane = (page: Page, side: 'original' | 'translated') => page.locator(`[data-reader-surface="${side}"]`);
const ref = (page: Page) => page.locator('[data-reader-reference]');
async function saved(page: Page, id: string, count: number) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await committed(page, id);
    if (value.edits.length === count && !value.pendingIntents && value.edits.every(edit => edit.receipt.durable)) {
      await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).first().waitFor(); return value;
    }
    assert.ok(Date.now() < deadline, `expected exactly ${count} durable operations`); await delay(50);
  }
}
async function point(layer: Locator, fraction = .3): Promise<Point> {
  await layer.scrollIntoViewIfNeeded();
  return layer.evaluate((element, fraction) => {
    const a = element.getBoundingClientRect(), b = element.closest('[data-pdf-scroller]')!.getBoundingClientRect();
    const left = Math.max(a.left, b.left, 0), right = Math.min(a.right, b.right, innerWidth);
    const top = Math.max(a.top, b.top, 0), bottom = Math.min(a.bottom, b.bottom, innerHeight);
    if (right - left < 30 || bottom - top < 30) throw new Error('contact target not visibly inside PDF pane');
    const x = left + (right - left) * fraction, y = top + (bottom - top) * .45;
    const hit = document.elementFromPoint(x, y), owner = element.closest('[data-reader-surface], [data-reader-reference]');
    if (hit?.closest('[data-reader-surface], [data-reader-reference]') !== owner) throw new Error('contact hit-test belongs to another pane');
    return { x, y };
  }, fraction);
}
async function setup(t: Parameters<typeof ordinaryWeb>[0], engine: 'chromium' | 'webkit') {
  const app = await ordinaryWeb(t, engine), page = app.page;
  const root = path.resolve(import.meta.dirname, '../../../../..'), originalFile = path.join(app.scratch, 'contact-original.pdf');
  const generated = spawnSync(path.join(root, '.venv/Scripts/python.exe'), [path.join(root, 'frontend/e2e/fixtures/p2PdfNavigation.py'), originalFile], { encoding: 'utf8', windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr);
  const translatedFile = path.join(app.scratch, 'contact-translated.pdf'); await copyFile(originalFile, translatedFile);
  await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles(originalFile);
  await page.getByRole('heading', { name: 'contact-original.pdf', exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') === 'true') await catalog.click();
  const original = (await committed(page, id)).root.pages[0];
  await pane(page, 'original').locator('[data-rendered="true"] .react-pdf__Page__canvas').waitFor();
  const chooser = page.waitForEvent('filechooser'); await page.getByLabel('取り込む訳文PDF', { exact: true }).click();
  await (await chooser).setFiles(translatedFile);
  const originals = (await committed(page, id)).root.pages;
  for (const [index, value] of originals.entries())
    await page.getByLabel(`訳文${index + 1}ページに対応する原文ページ`, { exact: true }).selectOption(value.id);
  await page.getByRole('button', { name: '訳文PDFを登録する', exact: true }).click();
  const mapped = await saved(page, id, 1), batch = mapped.edits[0].batch;
  await page.getByRole('button', { name: '訳文PDFを登録する', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="取り込む訳文PDF"]')?.disabled);
  assert.equal(batch.kind, 'document'); if (batch.kind !== 'document') throw new Error('translation document operation required');
  const change = batch.changes.find(value => value.type === 'translation'); assert.ok(change?.type === 'translation' && change.translation);
  const translated = change.translation.pages[0];
  await page.getByRole('button', { name: '左右', exact: true }).click();
  await pane(page, 'translated').locator('[data-rendered="true"] .react-pdf__Page__canvas').waitFor();
  await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
  await ref(page).locator(`[data-canonical-page="${original.id}"] [data-rendered="true"] .react-pdf__Page__canvas`).waitFor();
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  return { app, page, id, original, translated };
}
async function active(page: Page, side: 'original' | 'translated') {
  assert.equal(await pane(page, side).getAttribute('data-active-surface'), 'true');
}
async function heldCommands(page: Page, originalId: string) {
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '1');
  await page.getByRole('button', { name: '固定を解除', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('alert').filter({ hasText: '入力や保存、接触の終了後' }).waitFor();
  await ref(page).locator(`[data-canonical-page="${originalId}"]`).waitFor();
}
async function preview(page: Page, side: 'original' | 'translated') {
  await page.waitForFunction(side => !!document.querySelector(`[data-reader-surface="${side}"] [data-ink-preview]`)?.getAttribute('d'), side);
}
function owners(value: Awaited<ReturnType<typeof committed>>) {
  return value.edits.flatMap(edit => edit.batch.kind === 'page' ? [edit.batch] : []);
}

test('ordinary Chromium trusted pen/touch cross-pane ownership and cancel drain', { timeout: 240_000 }, async t => {
  const { page, id, original, translated } = await setup(t, 'chromium');
  const events = await observePointers(page), cdp = await page.context().newCDPSession(page);
  let phase = 'original-pen';
  const pen = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', p: Point) => cdp.send('Input.dispatchMouseEvent', {
    type, ...p, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1,
    pointerType: 'pen', force: type === 'mouseReleased' ? 0 : .7,
  });
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: (Point & { id: number })[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  async function stillHeld(side: 'translated' | 'reference') {
    const observed = await events.read();
    const down = [...observed].reverse().find(event => event.trusted && event.pointerType === 'touch' && event.type === 'pointerdown' && event.surface === side);
    assert.ok(down, `trusted ${side} touch down must be observed`);
    assert.equal(observed.some(event => event.at >= down.at && event.pointerId === down.pointerId && ['pointerup', 'pointercancel'].includes(event.type)), false,
      `${side} contact must actually remain held after pen release`);
  }
  try {
    const a = await point(pane(page, 'original').getByLabel('PDF書き込みレイヤー', { exact: true })), b = { ...a, x: a.x + 45 };
    const other = await point(pane(page, 'translated').locator('.react-pdf__Page__canvas'));
    await pen('mousePressed', a); await pen('mouseMoved', b); await preview(page, 'original');
    await heldCommands(page, original.id);
    await touch('touchStart', [{ id: 0, ...other }]);
    await pane(page, 'translated').focus(); await active(page, 'original');
    await pen('mouseReleased', b);
    await stillHeld('translated');
    phase = 'remaining-translated-contact';
    await touch('touchMove', [{ id: 0, ...other, x: other.x + 10 }]);
    await heldCommands(page, original.id); await active(page, 'original');
    assert.equal(owners(await committed(page, id)).some(batch => batch.expected.pageId === translated.id), false);
    await touch('touchEnd', []);
    const first = await saved(page, id, 2); assert.deepEqual(owners(first).map(batch => batch.expected.pageId), [original.id]);
    await pane(page, 'translated').click({ position: { x: 12, y: 20 } }); await active(page, 'translated');
    assert.equal((await committed(page, id)).edits.length, 2, 'activation click is consumed without ink');
    phase = 'translated-pen-reference-contact';
    const c = await point(pane(page, 'translated').getByLabel('PDF書き込みレイヤー', { exact: true })), d = { ...c, x: c.x + 45 };
    const referencePoint = await point(ref(page).locator('.react-pdf__Page__canvas'));
    await pen('mousePressed', c); await pen('mouseMoved', d); await preview(page, 'translated');
    await touch('touchStart', [{ id: 1, ...referencePoint }]);
    await pane(page, 'original').focus(); await active(page, 'translated');
    await pen('mouseReleased', d);
    await stillHeld('reference');
    await touch('touchMove', [{ id: 1, ...referencePoint, x: referencePoint.x + 10 }]);
    await active(page, 'translated'); await touch('touchEnd', []);
    const second = await saved(page, id, 3);
    assert.deepEqual(owners(second).map(batch => batch.expected.pageId).sort(), [original.id, translated.id].sort());
    phase = 'trusted-finger-cancel';
    await page.getByLabel('指で描く', { exact: true }).check();
    const finger = await point(pane(page, 'translated').getByLabel('PDF書き込みレイヤー', { exact: true }), .5);
    await touch('touchStart', [{ id: 2, ...finger }]);
    await touch('touchMove', [{ id: 2, ...finger, x: finger.x + 35 }]); await preview(page, 'translated');
    await touch('touchCancel', []);
    assert.equal((await committed(page, id)).edits.length, 3);
    await pane(page, 'original').click({ position: { x: 12, y: 20 } }); await active(page, 'original');
    const e = await point(pane(page, 'original').getByLabel('PDF書き込みレイヤー', { exact: true }), .55), f = { ...e, x: e.x + 35 };
    await pen('mousePressed', e); await pen('mouseMoved', f); await pen('mouseReleased', f);
    const final = await saved(page, id, 4), batches = owners(final);
    assert.equal(batches.filter(batch => batch.expected.pageId === original.id).length, 2);
    assert.equal(batches.filter(batch => batch.expected.pageId === translated.id).length, 1);
    assert.equal(new Set(batches.map(batch => batch.id)).size, 3);
    assert.ok(batches.every(batch => batch.changes.length === 1 && batch.changes[0].type === 'create'));
    assert.equal(await ref(page).locator('[data-ink-overlay], [aria-label$="書き込みレイヤー"]').count(), 0);
    const observed = await events.read(), downs = observed.filter(event => event.type === 'pointerdown');
    assert.ok(downs.some(event => event.trusted && event.pointerType === 'pen' && event.surface === 'original'));
    assert.ok(downs.some(event => event.trusted && event.pointerType === 'pen' && event.surface === 'translated'));
    for (const side of ['translated', 'reference']) assert.ok(downs.some(event => event.trusted && event.pointerType === 'touch' && event.surface === side));
    assert.ok(observed.some(event => event.trusted && event.pointerType === 'touch' && event.type === 'pointercancel'));
    t.diagnostic(JSON.stringify({ id, originalPage: original.id, translatedPage: translated.id, inkOwners: batches.map(batch => batch.expected.pageId), durableOperations: 4,
      trustedObservedEvents: observed.filter(event => event.trusted).length, scope: 'Chromium CDP pen/touch, not physical stylus or all-device matrix' }));
  } catch (error) {
    console.error(JSON.stringify({ phase, error: String(error), events: await events.read().catch(() => []), body: await page.locator('body').innerText().catch(String) })); throw error;
  } finally { await events.stop().catch(() => undefined); await cdp.detach().catch(() => undefined); }
});

test('ordinary WebKit held mouse excludes commands and focus handoff until release', { timeout: 180_000 }, async t => {
  const { page, id, original, translated } = await setup(t, 'webkit'), events = await observePointers(page);
  try {
    const a = await point(pane(page, 'original').getByLabel('PDF書き込みレイヤー', { exact: true }));
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + 45, a.y); await preview(page, 'original');
    await heldCommands(page, original.id); await pane(page, 'translated').focus(); await active(page, 'original');
    assert.equal((await committed(page, id)).edits.length, 1);
    await page.mouse.up(); await saved(page, id, 2);
    await pane(page, 'translated').click({ position: { x: 12, y: 20 } }); await active(page, 'translated');
    assert.equal((await committed(page, id)).edits.length, 2);
    const b = await point(pane(page, 'translated').getByLabel('PDF書き込みレイヤー', { exact: true }));
    await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.mouse.move(b.x + 45, b.y); await page.mouse.up();
    const final = await saved(page, id, 3), batches = owners(final);
    assert.deepEqual(batches.map(batch => batch.expected.pageId).sort(), [original.id, translated.id].sort());
    assert.equal(await ref(page).locator('[data-ink-overlay], [aria-label$="書き込みレイヤー"]').count(), 0);
    const observed = await events.read(); assert.ok(observed.some(event => event.trusted && event.pointerType === 'mouse' && event.type === 'pointerdown'));
    t.diagnostic(JSON.stringify({ id, inkOwners: batches.map(batch => batch.expected.pageId), durableOperations: 3,
      scope: 'WebKit Playwright mouse hold/release and keyboard/focus guards only; no simultaneous touch, pen, cancel or physical-device claim' }));
  } catch (error) {
    console.error(JSON.stringify({ error: String(error), events: await events.read().catch(() => []), body: await page.locator('body').innerText().catch(String) })); throw error;
  } finally { await events.stop().catch(() => undefined); }
});
