// B13-search (T09): the "取得できた範囲の結果です" notice of a saved-content search, for three states a small ordinary Library can be put into (the third is artificial, see below):
// an unsupported attachment, a PDF whose text extraction fails (the PDF.js worker request is really answered with a throwing script) and a PDF whose stored resource-bytes row is missing
// (an artificial state the product never creates by itself: the bytes row is really removed while the resource metadata stays, then really put back). A "not retrieved" Markdown body at scale is already observed by
// webOrdinaryLibraryLargeSearch (B13-c) and is not repeated here.
// Observed: the real DOM, the real IndexedDB rows and the real request record of the page. There is no provider in the ordinary Web entry:
// "putting the row back" is the bytes row being present again in the same IndexedDB the product reads, not a Drive transfer and not a real arrival (see IMPL-r161-b13search.md).
// The product writes resource metadata and bytes together (indexedDbMutationWriter.ts), so metadata-without-bytes is not a state it produces; reading it is rejected with
// EditRejected('resource-bytes-missing') (repository.ts). The catalog revision looks at resource metadata only (canonicalLibraryCorpus.ts revision()), so putting the row back does not
// change the revision and is not an automatic re-search path either: this test re-runs the search itself.
// NOT exercised: the real not-arrived path (no resource row at all: readResource returns undefined -> 'library-corpus-resource'). Both paths end in the same catch
// (canonicalLibraryCorpus.ts, status "partial"), so the notice itself is verified for the "partial" count, but the real not-arrived path is not covered by this test.
// No time is asserted; every wait is an observation bounded only against a hang.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { Page, Request } from 'playwright-core';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';
import { createItemUi, locateCatalog, showCatalog, waitCatalogClosed } from '../../support/ordinaryCatalog.ts';
import { waitForSnapshot } from '../../support/waitForSnapshot.ts';
import { committed } from '../reader/p2/ordinaryStorage.ts';

const sample = path.resolve(import.meta.dirname, '../../../../tests/fixtures/sample.pdf');
const NOTICE = /^\s*本文の未取得 (\d+)件、一部のみ取得 (\d+)件、未対応の添付 (\d+)件。取得できた範囲の結果です。\s*$/;
type Observation = { ids: string[]; loading: boolean; count: number | null; notices: string[]; alerts: string[] };

/** One snapshot of everything the search surface shows. */
const observe = (page: Page): Promise<Observation> => page.evaluate(() => {
  const statuses = [...document.querySelectorAll('[role="status"]')].map(node => (node.textContent ?? '').trim());
  const counted = statuses.map(text => /^(\d+)件の資料が一致$/.exec(text)).find(match => match);
  return { ids: [...document.querySelectorAll('[role="tree"][aria-label="資料の階層"] [data-library-item]')].map(row => row.getAttribute('data-library-item')!),
    loading: statuses.includes('保存済み本文を検索しています…'), count: counted ? Number(counted[1]) : null,
    notices: statuses.filter(text => text.includes('取得できた範囲の結果です')), alerts: [...document.querySelectorAll('[role="alert"]')].map(node => (node.textContent ?? '').trim()) };
});
/** Wait until the search has finished (not loading, a count shown) and return the snapshot. */
const settled = (page: Page, count: number) => waitForSnapshot(() => observe(page), value => !value.loading && value.count === count, 120_000);
const counts = (value: Observation) => { assert.equal(value.notices.length, 1, `exactly one notice: ${JSON.stringify(value.notices)}`);
  const match = NOTICE.exec(value.notices[0]); assert.ok(match, `the notice has its fixed wording: ${value.notices[0]}`);
  return { missing: Number(match[1]), partial: Number(match[2]), unsupported: Number(match[3]) }; };
async function search(page: Page, scope: 'metadata' | 'content' | 'all', text: string) {
  await page.getByLabel('資料の検索範囲', { exact: true }).selectOption(scope);
  await page.getByLabel('資料の検索語', { exact: true }).fill(text);
}
/** Run the same content search again (the query itself is unchanged, so go through the metadata scope and back). */
async function rerun(page: Page, text: string, count: number) {
  await search(page, 'metadata', text);
  const metadata = await settled(page, 0);
  assert.deepEqual(metadata.notices, [], 'a metadata search reports no body status');
  await search(page, 'content', text);
  return settled(page, count);
}
/** Remove (or put back) the stored bytes row of one resource through a second IndexedDB connection; the row is kept in page memory in between. */
function resourceBytesRow(page: Page, namespace: string, sha256: string, action: 'take' | 'restore') {
  return page.evaluate(async ({ namespace, sha256, action }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing database required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    const g = globalThis as unknown as { __savedRow?: { key: string; scope: string; value: Uint8Array } };
    const key = JSON.stringify([namespace, sha256]);
    try {
      return await new Promise<{ present: boolean; byteLength: number }>((resolve, reject) => {
        const tx = db.transaction(['resourceBytes'], 'readwrite'), store = tx.objectStore('resourceBytes');
        let result = { present: false, byteLength: 0 };
        if (action === 'take') {
          const read = store.get(key);
          read.onsuccess = () => { const row = read.result as { key: string; scope: string; value: Uint8Array } | undefined;
            if (!row) { reject(new Error('the resource bytes row to remove does not exist')); return; }
            g.__savedRow = row; result = { present: true, byteLength: row.value.byteLength }; store.delete(key); };
        } else {
          if (!g.__savedRow) { reject(new Error('no saved row to restore')); return; }
          store.put(g.__savedRow); result = { present: true, byteLength: g.__savedRow.value.byteLength };
        }
        tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error ?? new Error('resource row transaction aborted'));
      });
    } finally { db.close(); }
  }, { namespace, sha256, action });
}
const bytesRowCount = (page: Page, namespace: string, sha256: string) => page.evaluate(async ({ namespace, sha256 }) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('papeer-shared-edits'); request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
  });
  try { return await new Promise<number>((resolve, reject) => {
    const tx = db.transaction(['resourceBytes'], 'readonly'), read = tx.objectStore('resourceBytes').count(JSON.stringify([namespace, sha256]));
    tx.oncomplete = () => resolve(read.result); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}, { namespace, sha256 });

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary content search names what it could not retrieve: unsupported attachment, failed PDF extraction, PDF resource-bytes row missing (a state the product does not create by itself) (${engine})`, { timeout: 420_000 }, async t => {
  const app = await ordinaryWeb(t, engine), firstPage = app.page; let page = firstPage;
  let phase = 'create-note';
  const workerRequests: string[] = [];
  const onRequest = (request: Request) => { if (/pdf\.worker/.test(request.url())) workerRequests.push(request.url()); };
  firstPage.on('request', onRequest);
  try {
    const noteId = await createItemUi(page, 'Notice note', 'markdown');
    const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
    const body = 'needle-md saved body\n';
    await editor.fill(body); await editor.blur(); await ordinaryMarkdownSaved(page, noteId, body, 1);

    phase = 'import-pdf';
    await showCatalog(page);
    const title = 'Notice sample.pdf';
    await page.getByLabel('取り込むPDF', { exact: true }).setInputFiles({ name: title, mimeType: 'application/pdf', buffer: await readFile(sample) });
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    const pdfId = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(pdfId);
    await waitCatalogClosed(page);
    const stored = await committed(page, pdfId), background = stored.root.pages[0].background; assert.equal(background.kind, 'pdf');
    if (background.kind !== 'pdf') throw new Error('PDF background missing');
    const catalog = await locateCatalog(page), sha256 = background.sourceRevision;
    assert.equal(await bytesRowCount(page, catalog.namespace, sha256), 1, 'the imported PDF bytes are stored once');

    phase = 'baseline-complete';
    await showCatalog(page);
    await search(page, 'content', 'adaptive control');
    const baseline = await settled(page, 1);
    assert.deepEqual(baseline.ids, [pdfId], 'the PDF text is extracted and found');
    assert.deepEqual(baseline.notices, [], 'with every body retrieved there is no notice');
    assert.deepEqual(baseline.alerts, []);

    phase = 'unsupported-attachment';
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByLabel(`「${title}」にファイルを添付`, { exact: true }).click();
    await (await chooserPromise).setFiles({ name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment evidence bytes') });
    await waitCatalogClosed(page); await showCatalog(page);
    const withAttachment = await settled(page, 1);
    assert.deepEqual(withAttachment.ids, [pdfId], 'the PDF hit is still returned');
    assert.deepEqual(counts(withAttachment), { missing: 0, partial: 0, unsupported: 1 }, 'the attachment is counted as unsupported');
    assert.deepEqual(withAttachment.alerts, [], 'an unsupported attachment is a notice, not an error');
    const metadataOnly = await (async () => { await search(page, 'metadata', 'adaptive control'); return settled(page, 0); })();
    assert.deepEqual(metadataOnly.notices, [], 'the notice belongs to a saved-content search only');
    await search(page, 'content', 'adaptive control'); await settled(page, 1);

    phase = 'extraction-failure';
    // The PDF.js worker is the real extractor: answer its requests with a script that throws, so the extraction really fails (no product code is replaced).
    // (An aborted request would log a browser console error, which the ordinary entry treats as an unhandled error.)
    const requestsBefore = workerRequests.length; let served = 0;
    // The throwing worker is reported by the engine as an uncaught page error (WebKit: an error with an empty message). Announce exactly that, only for this step.
    app.allowBrowserErrors([/^$/, /pdf worker blocked by the test/]);
    await page.context().route(/pdf\.worker/, route => { served++; return route.fulfill({ status: 200, contentType: 'text/javascript', body: "throw new Error('pdf worker blocked by the test');" }); });
    const failed = await rerun(page, 'adaptive control', 0);
    assert.ok(workerRequests.length > requestsBefore && served > 0, `the worker was requested and answered with the throwing script (${workerRequests.length - requestsBefore} requests, ${served} answered)`);
    assert.deepEqual(failed.ids, [], 'the PDF text was not extracted, so the PDF is not found by it');
    assert.deepEqual(counts(failed), { missing: 0, partial: 1, unsupported: 1 }, 'the PDF is counted as partially retrieved, the attachment as unsupported');
    assert.deepEqual(failed.alerts, [], 'a failed extraction of one PDF is not a search error');
    // Other bodies are still searched: the saved Markdown body is found while the notice stays.
    await search(page, 'content', 'needle-md');
    const partialResult = await settled(page, 1);
    assert.deepEqual(partialResult.ids, [noteId], 'the retrievable body is still found');
    assert.deepEqual(counts(partialResult), { missing: 0, partial: 1, unsupported: 1 }, 'the notice stays with the partial result');
    await page.context().unroute(/pdf\.worker/);
    // Observed (recorded, not asserted): in the same page, PDF.js keeps its failed worker set-up, so the PDF is still not extracted although requests are allowed again.
    await search(page, 'content', 'adaptive control');
    const samePage = await waitForSnapshot(() => observe(page), value => !value.loading && value.count !== null, 120_000);
    page = await app.restartLibrary({ showCatalog: true });
    app.allowBrowserErrors([]);
    phase = 'extraction-recovers-after-restart';
    await search(page, 'content', 'adaptive control');
    const recovered = await settled(page, 1);
    assert.deepEqual(recovered.ids, [pdfId], 'after a restart (requests allowed) the PDF is found again');
    assert.deepEqual(counts(recovered), { missing: 0, partial: 0, unsupported: 1 }, 'only the unsupported attachment remains in the notice');

    phase = 'pdf-resource-bytes-row-missing';
    const taken = await resourceBytesRow(page, catalog.namespace, sha256, 'take');
    assert.equal(taken.present, true); assert.equal(await bytesRowCount(page, catalog.namespace, sha256), 0, 'the bytes are really absent from IndexedDB');
    const missing = await rerun(page, 'adaptive control', 0);
    assert.deepEqual(missing.ids, [], 'without its bytes the PDF text cannot be searched');
    assert.deepEqual(counts(missing), { missing: 0, partial: 1, unsupported: 1 }, 'the PDF whose resource-bytes row is missing is counted as partially retrieved');
    assert.deepEqual(missing.alerts, []);
    const restored = await resourceBytesRow(page, catalog.namespace, sha256, 'restore');
    assert.equal(restored.byteLength, taken.byteLength); assert.equal(await bytesRowCount(page, catalog.namespace, sha256), 1, 'the bytes row is back');
    const arrived = await rerun(page, 'adaptive control', 1);
    assert.deepEqual(arrived.ids, [pdfId], 'after the bytes row is put back the PDF is found again');
    assert.deepEqual(counts(arrived), { missing: 0, partial: 0, unsupported: 1 }, 'the partial count returns to 0');

    t.diagnostic(JSON.stringify({ engine, pdfId, noteId, workerRequestsAnswered: served, announcedBrowserErrors: app.allowedBrowserErrors().map(text => text.slice(0, 80)), workerRequestsTotal: workerRequests.length,
      statesObserved: { baseline: 'no notice', samePageAfterUnroute: { ids: samePage.ids.length, notice: samePage.notices }, unsupported: counts(withAttachment), extractionFailure: counts(failed), bytesRowMissing: counts(missing), bytesRowPutBack: counts(arrived) },
      realGoogle: false, provider: 'none (ordinary Web entry; IndexedDB row removed and put back)' }));
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase, observed: await observe(page).catch(String), workerRequests }));
    throw error;
  } finally { firstPage.off('request', onRequest); }
});
