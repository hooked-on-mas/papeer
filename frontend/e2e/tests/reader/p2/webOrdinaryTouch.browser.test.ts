import assert from 'node:assert/strict';
import { test } from 'node:test';
import { committed, durable, inks } from './ordinaryStorage.ts';
import { createNotebook, gesture, ordinaryWeb } from './ordinaryWeb.ts';

test('ordinary P2 trusted Chromium touch pinch and cancel preserve canonical ink without writing', { timeout: 120_000 }, async t => {
  const app = await ordinaryWeb(t, 'chromium'), page = app.page;
  const documentId = await createNotebook(page, 'P2 trusted touch');
  await page.getByRole('button', { name: 'ペン', exact: true }).click();
  await gesture(page, [[.2, .25], [.45, .25]]);
  await page.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
  const before = await inks(page), ids = before.map(value => value.id);
  await durable(page, documentId, ids, 1);
  await page.getByLabel('倍率', { exact: true }).selectOption('1');
  const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true });
  await layer.scrollIntoViewIfNeeded();
  const box = await layer.boundingBox(); assert.ok(box);
  const center = { x: box.x + box.width * .5, y: Math.min(box.y + box.height * .5, 800) };
  // Observation only; trusted input comes from Chromium's native input dispatch.
  await page.evaluate(() => {
    const observed: boolean[] = [];
    (window as unknown as { p2ObservedTouchTrust: boolean[] }).p2ObservedTouchTrust = observed;
    document.addEventListener('pointerdown', event => { if (event.pointerType === 'touch') observed.push(event.isTrusted); });
  });
  const cdp = await page.context().newCDPSession(page);
  const points = (distance: number) => [{ id: 0, x: center.x - distance, y: center.y }, { id: 1, x: center.x + distance, y: center.y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(40) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(80) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => Number((document.querySelector('[aria-label="倍率"]') as HTMLSelectElement)?.value) > 1.2);
  const zoom = Number(await page.getByLabel('倍率', { exact: true }).inputValue());
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(40) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await cdp.detach();
  assert.deepEqual(await inks(page), before);
  const saved = await committed(page, documentId); assert.equal(saved.edits.length, 1); assert.equal(saved.pendingIntents, 0);
  const trust = await page.evaluate(() => (window as unknown as { p2ObservedTouchTrust: boolean[] }).p2ObservedTouchTrust);
  assert.ok(trust.length >= 4 && trust.every(Boolean));
  t.diagnostic(JSON.stringify({ documentId, zoom, trustedTouchPointers: trust.length, durableBatches: 1,
    coverage: 'native Chromium touch pinch/cancel; no finger-ink or OS stylus claim' }));
});
