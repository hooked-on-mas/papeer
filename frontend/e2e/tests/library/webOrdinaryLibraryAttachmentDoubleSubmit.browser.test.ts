// B13-b (G08): a double click or a second trigger while the file chooser is pending must not open a second chooser nor import twice.
// Deliberately NOT the retry-after-failure path (already covered by webOrdinaryLibraryCrud.browser.test.ts: one resource id, one publication).
// Observed: real chooser events, real `input.click()` calls on the file inputs, and the persisted catalog / resource rows in IndexedDB.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import type { FileChooser, Page } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { catalogOf, catalogUntil, createItemUi, locateCatalog, showCatalog, waitCatalogClosed, type CatalogHandle } from '../../support/ordinaryCatalog.ts';

const pdfFixture = path.resolve(import.meta.dirname, '../../../../tests/fixtures/shared-coordinate-pages.pdf');

/** Count `click()` calls reaching the (hidden) file inputs: the product opens a chooser exactly by clicking the input. */
async function countInputClicks(page: Page) {
  await page.evaluate(() => {
    const g = globalThis as unknown as { __inputClicks?: Record<string, number> };
    g.__inputClicks = { attachment: 0, pdf: 0 };
    for (const [key, label] of [['attachment', '取り込む添付ファイル'], ['pdf', '取り込むPDF']] as const) {
      document.querySelector(`input[type="file"][aria-label="${label}"]`)?.addEventListener('click', () => { g.__inputClicks![key]++; }, true);
    }
  });
}
const inputClicks = (page: Page) => page.evaluate(() => (globalThis as unknown as { __inputClicks: Record<string, number> }).__inputClicks);

/** Rows of the durable resource store whose bytes hash to `sha256` (the same content stored more than once would show as more rows). */
function resourceRows(page: Page, { namespace }: CatalogHandle, sha256: string) {
  return page.evaluate(async ({ namespace, sha256 }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction(['resources'], 'readonly'), rows = tx.objectStore('resources').getAll();
        tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve((rows.result as { scope: string; value: { sha256: string } }[]).filter(row => row.scope === namespace && row.value.sha256 === sha256).length);
      });
    } finally { db.close(); }
  }, { namespace, sha256 });
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary double click and concurrent triggers open one chooser and import once (${engine})`, { timeout: 300_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  let phase = 'create-owners';
  try {
    const first = await createItemUi(page, 'Dbl owner A', 'markdown');
    await showCatalog(page);
    await page.getByLabel('「Dbl owner A」を選択', { exact: true }).waitFor();
    const second = await createItemUi(page, 'Dbl owner B', 'markdown');
    const catalog = await locateCatalog(page);
    await showCatalog(page);
    const choosers: FileChooser[] = [];
    page.on('filechooser', chooser => { choosers.push(chooser); });

    phase = 'double-click-attach';
    await countInputClicks(page);
    await page.getByLabel('「Dbl owner A」にファイルを添付', { exact: true }).dblclick();
    await page.waitForFunction(() => (globalThis as unknown as { __inputClicks: Record<string, number> }).__inputClicks.attachment >= 1);
    const until = Date.now() + 15_000; while (!choosers.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(choosers.length, 1, 'the browser delivered a chooser');
    phase = 'other-triggers-while-chooser-is-pending';
    // A different owner's attach button and the PDF import button are also ignored while a chooser is held open.
    await page.getByLabel('「Dbl owner B」にファイルを添付', { exact: true }).click();
    await page.getByRole('button', { name: 'PDFを取り込む', exact: true }).click();
    await page.getByLabel('「Dbl owner A」にファイルを添付', { exact: true }).click();
    assert.deepEqual(await inputClicks(page), { attachment: 1, pdf: 0 }, 'only one input.click() reached the file inputs (hold ignores every further trigger)');
    assert.equal(choosers.length, 1, 'no second chooser was opened');

    phase = 'single-import';
    const bytes = 'double click attachment bytes', sha = createHash('sha256').update(bytes).digest('hex');
    await choosers[0].setFiles({ name: 'dbl-evidence.txt', mimeType: 'text/plain', buffer: Buffer.from(bytes) });
    const imported = await catalogUntil(page, catalog, value => value.items.some(item => item.kind === 'attachment'), 'attachment import');
    await page.waitForFunction(id => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === id,
      imported.snapshot.items.find(item => item.kind === 'attachment')!.id);
    await waitCatalogClosed(page);
    const attachments = imported.snapshot.items.filter(item => item.kind === 'attachment');
    assert.equal(attachments.length, 1, 'exactly one attachment item');
    assert.equal(attachments[0].ownerId, first, 'it belongs to the owner whose button was double clicked, not the other owner');
    assert.equal(imported.snapshot.items.filter(item => item.ownerId === second).length, 0, 'the other owner received nothing');
    assert.equal(imported.edits.filter(edit => edit.publication && edit.batch.kind === 'library' && edit.batch.changes.some(change => change.type === 'put-item' && change.item.kind === 'attachment')).length, 1, 'one publication batch for the attachment');
    assert.equal(await resourceRows(page, catalog, sha), 1, 'the bytes are stored once');
    assert.equal(choosers.length, 1, 'still exactly one chooser after the import');
    assert.equal((await inputClicks(page)).attachment, 1);

    phase = 'double-click-pdf-import';
    await showCatalog(page);
    await countInputClicks(page);
    await page.getByRole('button', { name: 'PDFを取り込む', exact: true }).dblclick();
    await page.waitForFunction(() => (globalThis as unknown as { __inputClicks: Record<string, number> }).__inputClicks.pdf >= 1);
    const pdfUntil = Date.now() + 15_000; while (choosers.length < 2 && Date.now() < pdfUntil) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(choosers.length, 2, 'one more chooser for the PDF import, not two');
    assert.deepEqual(await inputClicks(page), { attachment: 0, pdf: 1 }, 'the PDF input was clicked once');
    await choosers[1].setFiles(pdfFixture);
    const withPdf = await catalogUntil(page, catalog, value => value.items.some(item => item.kind === 'pdf'), 'PDF import');
    assert.equal(withPdf.snapshot.items.filter(item => item.kind === 'pdf').length, 1, 'exactly one PDF item');
    assert.equal(choosers.length, 2, 'no extra chooser after the PDF import');
    assert.equal(new Set(withPdf.snapshot.items.filter(item => item.resourceId).map(item => item.resourceId)).size, 2, 'two items, two distinct stored resources (attachment and PDF)');
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, error: String(error), closed: page.isClosed(), body: page.isClosed() ? '<closed>' : (await page.locator('body').innerText({ timeout: 3_000 }).catch(e => `<unavailable: ${String(e).slice(0, 120)}>`)).slice(0, 3000) }));
    throw error;
  }
});

// ---- B13-b review round 1 (中1): the three cases B13-a listed next to G08 and the first version left open ----

/** Everything that would let a second import start, read in ONE evaluate so the snapshot is atomic. */
function importInFlightSnapshot(page: Page) {
  return page.evaluate(() => {
    const status = [...document.querySelectorAll('[role="status"]')].map(node => node.textContent ?? '').find(text => /^(添付|PDF)「/.test(text)) ?? null;
    const attach = [...document.querySelectorAll('button')].filter(button => (button.getAttribute('aria-label') ?? '').endsWith('にファイルを添付'));
    const pdfButton = [...document.querySelectorAll('button')].find(button => button.textContent === 'PDFを取り込む');
    const input = document.querySelector<HTMLInputElement>('input[type="file"][aria-label="取り込む添付ファイル"]');
    return { status, attachDisabled: attach.map(button => button.disabled), pdfDisabled: pdfButton?.disabled ?? null, inputDisabled: input?.disabled ?? null };
  });
}

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary import re-entry while in flight and back-to-back selection of the same file import once (${engine})`, { timeout: 300_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  let phase = 'create-owner';
  try {
    await createItemUi(page, 'Reentry owner', 'markdown');
    const catalog = await locateCatalog(page);
    await showCatalog(page);
    const choosers: FileChooser[] = [];
    page.on('filechooser', chooser => { choosers.push(chooser); });
    const nextChooser = async (count: number) => {
      const until = Date.now() + 15_000; while (choosers.length < count && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(choosers.length, count, 'chooser delivered'); return choosers[count - 1];
    };

    phase = 'in-flight-controls-are-disabled';
    await page.getByLabel('「Reentry owner」にファイルを添付', { exact: true }).click();
    const big = Buffer.alloc(6 * 1024 * 1024, 7), bigSha = createHash('sha256').update(big).digest('hex');
    const first = await nextChooser(1);
    const seen: Awaited<ReturnType<typeof importInFlightSnapshot>>[] = [];
    const watch = (async () => {   // poll the page while the import runs; keep every snapshot that shows the in-flight status
      const until = Date.now() + 40_000;
      while (Date.now() < until) {
        const snap = await importInFlightSnapshot(page);
        if (snap.status) seen.push(snap); else if (seen.length) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    })();
    await first.setFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: big });
    await watch;
    t.diagnostic(`in-flight snapshots seen: ${seen.length}; first=${JSON.stringify(seen[0])}`);
    assert.ok(seen.length >= 1, 'the in-flight import status was observed at least once');
    for (const snap of seen) {
      assert.ok(snap.attachDisabled.length >= 1 && snap.attachDisabled.every(Boolean), `while importing, every attach button is disabled (${JSON.stringify(snap)})`);
      assert.equal(snap.pdfDisabled, true, 'while importing, the PDF import button is disabled');
      assert.equal(snap.inputDisabled, true, 'while importing, the attachment file input is disabled');
    }
    const afterBig = await catalogUntil(page, catalog, value => value.items.some(item => item.kind === 'attachment'), 'big attachment');
    const bigItem = afterBig.snapshot.items.find(item => item.kind === 'attachment')!;
    assert.equal(afterBig.snapshot.items.filter(item => item.kind === 'attachment').length, 1, 'one attachment for the in-flight import');
    assert.equal(await resourceRows(page, catalog, bigSha), 1, 'its bytes are stored once');
    assert.equal(choosers.length, 1, 'no chooser was opened while the import was in flight');
    await page.waitForFunction(id => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === id, bigItem.id);
    await waitCatalogClosed(page);

    phase = 'same-file-selected-twice-back-to-back';
    await showCatalog(page);
    await page.getByLabel('「Reentry owner」にファイルを添付', { exact: true }).click();
    const second = await nextChooser(2);
    const bytes = Buffer.from('same file selected twice'), sha = createHash('sha256').update(bytes).digest('hex');
    const file = { name: 'twice.txt', mimeType: 'text/plain', buffer: bytes };
    // The same file is handed to the same input twice in a row (two change events). A real user cannot do this; it exercises the session guard.
    await Promise.allSettled([second.setFiles(file), second.setFiles(file)]);
    const afterTwice = await catalogUntil(page, catalog, value => value.items.some(item => item.title === 'twice.txt'), 'twice.txt import');
    const twice = afterTwice.snapshot.items.filter(item => item.title === 'twice.txt');
    assert.equal(twice.length, 1, 'two back-to-back selections of the same file produce exactly one attachment');
    assert.equal(afterTwice.edits.filter(edit => edit.publication && edit.batch.kind === 'library' && edit.batch.changes.some(change => change.type === 'put-item' && change.item.title === 'twice.txt')).length, 1, 'one publication batch');
    assert.equal(await resourceRows(page, catalog, sha), 1, 'the bytes are stored once');
    await page.waitForFunction(id => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === id, twice[0].id);
    await waitCatalogClosed(page);

    phase = 'deliberate-second-attach-of-the-same-file';
    // Characterisation, not a duplicate-send check: choosing the same file again later is a second user action.
    await showCatalog(page);
    await page.getByLabel('「Reentry owner」にファイルを添付', { exact: true }).click();
    await (await nextChooser(3)).setFiles(file);
    const afterAgain = await catalogUntil(page, catalog, value => value.items.filter(item => item.title === 'twice.txt').length >= 2, 'second twice.txt');
    t.diagnostic(JSON.stringify({ deliberateSecondAttach: { items: afterAgain.snapshot.items.filter(item => item.title === 'twice.txt').length, resourceRows: await resourceRows(page, catalog, sha) } }));
    assert.equal(afterAgain.snapshot.items.filter(item => item.title === 'twice.txt').length, 2, 'a deliberate second attach is a second attachment');
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, error: String(error), closed: page.isClosed(), body: page.isClosed() ? '<closed>' : (await page.locator('body').innerText({ timeout: 3_000 }).catch(e => `<unavailable: ${String(e).slice(0, 120)}>`)).slice(0, 3000) }));
    throw error;
  }
});

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary double-clicked attachment retry imports once (${engine})`, { timeout: 300_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page;
  let phase = 'create-owner';
  try {
    const owner = await createItemUi(page, 'Retry owner', 'markdown');
    const catalog = await locateCatalog(page);
    await showCatalog(page);
    const bytes = 'retry double click bytes', sha = createHash('sha256').update(bytes).digest('hex');
    // Test instrumentation in the browser (same technique as webOrdinaryLibraryCrud): abort the resource transaction while `enabled`, count every put of these bytes.
    await page.evaluate(({ namespace, sha }) => {
      const probe: { enabled: boolean; attempts: number } = { enabled: true, attempts: 0 };
      (globalThis as unknown as { resourceProbe: typeof probe }).resourceProbe = probe;
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
        const row = value as { scope?: string; value?: { sha256: string } };
        if (this.name === 'resources' && row.scope === namespace && row.value?.sha256 === sha) {
          probe.attempts++;
          if (probe.enabled) { this.transaction.abort(); throw new DOMException('B13-b resource abort', 'AbortError'); }
        }
        return key === undefined ? original.call(this, value) : original.call(this, value, key);
      };
    }, { namespace: catalog.namespace, sha });
    const before = await catalogUntil(page, catalog, () => true);
    phase = 'first-attempt-fails';
    const chooser = page.waitForEvent('filechooser');
    await page.getByLabel('「Retry owner」にファイルを添付', { exact: true }).click();
    await (await chooser).setFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from(bytes) });
    const retry = page.getByRole('button', { name: '添付を再試行', exact: true });
    await retry.waitFor();
    const attempts = () => page.evaluate(() => (globalThis as unknown as { resourceProbe: { attempts: number } }).resourceProbe.attempts);
    const failedAttempts = await attempts(); assert.ok(failedAttempts >= 1, 'the failing put was really attempted');
    assert.deepEqual((await catalogOf(page, catalog)).edits, before.edits, 'a failed resource write publishes nothing');
    phase = 'double-click-retry';
    await page.evaluate(() => { (globalThis as unknown as { resourceProbe: { enabled: boolean } }).resourceProbe.enabled = false; });
    await retry.dblclick();
    const done = await catalogUntil(page, catalog, value => value.items.some(item => item.title === 'retry.txt'), 'retry import');
    const items = done.snapshot.items.filter(item => item.title === 'retry.txt');
    assert.equal(items.length, 1, 'a double-clicked retry creates exactly one attachment');
    assert.equal(items[0].ownerId, owner);
    assert.equal(await attempts(), failedAttempts + 1, 'the retry wrote the resource exactly once (the second click was ignored)');
    assert.equal(await resourceRows(page, catalog, sha), 1, 'the bytes are stored once');
    assert.equal(done.edits.filter(edit => edit.publication && edit.batch.kind === 'library' && edit.batch.changes.some(change => change.type === 'put-item' && change.item.title === 'retry.txt')).length, 1, 'one publication batch');
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, error: String(error), closed: page.isClosed(), body: page.isClosed() ? '<closed>' : (await page.locator('body').innerText({ timeout: 3_000 }).catch(e => `<unavailable: ${String(e).slice(0, 120)}>`)).slice(0, 3000) }));
    throw error;
  }
});
