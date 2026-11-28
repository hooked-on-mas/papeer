import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { connect, fillNote, offlinePanel, openNote, openWorld, passphrase, records, submitSecret, uiSnapshot, unlock, until, vaultRows, visibleText, type Engine } from '../../../support/provider/offlineOrdinary.ts';

/** Hold the next WebCrypto `encrypt` after it has really produced its result (the same seam as the fixture's held seal), so the enrollment is cut mid-crypto. */
const holdNextEncrypt = (page: Page) => page.evaluate(() => {
  const subtle = crypto.subtle, original = subtle.encrypt.bind(subtle); let armed = true;
  (window as unknown as { __b9Reached: Promise<void> }).__b9Reached = new Promise<void>(resolve => {
    Object.defineProperty(subtle, 'encrypt', { configurable: true, value: async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      const result = await original(...args); if (armed) { armed = false; resolve(); await new Promise<never>(() => {}); } return result; } });
  });
});
const encryptReached = (page: Page) => page.evaluate(() => (window as unknown as { __b9Reached: Promise<void> }).__b9Reached);
/** Make the next write of a `grant` vault row abort like a transaction that lost its completion (the same seam as the fixture's aborted grant add). */
const abortNextGrantAdd = (page: Page) => page.evaluate(() => {
  const original = IDBObjectStore.prototype.add; let fired = false;
  (window as unknown as { __b9Restore: () => void }).__b9Restore = () => { IDBObjectStore.prototype.add = original; };
  IDBObjectStore.prototype.add = function(value: unknown, key?: IDBValidKey) {
    const candidate = value as { key?: unknown } | null;
    if (!fired && this.name === 'canonicalProviderArtifacts' && typeof candidate?.key === 'string') {
      try { const parts = JSON.parse(candidate.key) as unknown;
        if (Array.isArray(parts) && parts[0] === 'host-offline-v1' && parts[2] === 'grant') { fired = true; (window as unknown as { __b9Fired: boolean }).__b9Fired = true; throw new DOMException('synthetic grant commit abort', 'AbortError'); }
      } catch (error) { if (fired) throw error; }
    }
    return original.call(this, value, key);
  };
});
const restoreAdd = (page: Page) => page.evaluate(() => (window as unknown as { __b9Restore: () => void }).__b9Restore());
async function counterOf(page: Page): Promise<bigint> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('papeer-shared-cloud-v1');
      r.onupgradeneeded = () => { r.transaction?.abort(); reject(new Error('existing provider cache required')); }; r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result); });
    try { return await new Promise<string>((resolve, reject) => {
      const tx = db.transaction('canonicalProviderArtifacts', 'readonly'), request = tx.objectStore('canonicalProviderArtifacts').getAll();
      tx.onabort = () => reject(tx.error); tx.oncomplete = () => {
        const rows = request.result.filter((row: { key: string }) => { try { const key = JSON.parse(row.key); return Array.isArray(key) && key[0] === 'host-offline-v1' && key[2] === 'counter'; } catch { return false; } });
        if (rows.length !== 1) reject(new Error('counter-missing')); else resolve(rows[0].value.next);
      };
    }); } finally { db.close(); }
  }).then(value => BigInt(value));
}
const kinds = async (page: Page) => { const rows = await vaultRows(page); return { header: rows.filter(row => row.kind === 'header').length,
  counter: rows.filter(row => row.kind === 'counter').length, grant: rows.filter(row => row.kind === 'grant').length, pending: rows.filter(row => row.kind === 'pending').length }; };
async function openOnline(page: Page, library: string) {
  await connect(page); await page.getByRole('button', { name: library, exact: true }).click();
  await page.getByRole('button', { name: 'オフライン利用…', exact: true }).waitFor();
}
async function createLibrary(page: Page, library: string) {
  await page.getByLabel('新しいクラウドライブラリの名前').fill(library);
  await page.getByRole('button', { name: 'クラウドライブラリを作成', exact: true }).click();
  await page.getByRole('button', { name: 'オフライン利用…', exact: true }).waitFor();
}
const accepted = (page: Page) => offlinePanel(page).getByText('この端末での利用を許可しました。', { exact: true });

for (const engine of ['chromium', 'webkit'] as const satisfies Engine[]) test(`an enrollment cut during crypto leaves no half permission and the retry is accepted once (${engine})`, { timeout: 480_000 }, async t => {
  const w = await openWorld(t, engine, 'enroll-cut'), profile = w.profile('a');
  const one = `Cut Library one ${engine}`, two = `Cut Library two ${engine}`; let phase = 'create-one';
  try {
    // Part 1: the first enrollment of a device (header creation) is cut by closing the page mid-crypto.
    let a = await w.launch(profile, 'online', 'enroll-cut-a'); await connect(a.page); await createLibrary(a.page, one);
    await holdNextEncrypt(a.page); phase = 'cut-header-crypto';
    await submitSecret(a.page, passphrase); await encryptReached(a.page); await w.close(a.context);
    phase = 'after-header-cut'; a = await w.launch(profile, 'online', 'enroll-cut-a2'); await openOnline(a.page, one);
    const afterFirstCut = await kinds(a.page); t.diagnostic(`vault rows after the header-stage cut: ${JSON.stringify(afterFirstCut)}`);
    assert.equal(afterFirstCut.grant, 0); assert.equal(afterFirstCut.pending, 0);
    await submitSecret(a.page, passphrase); await accepted(a.page).waitFor();
    assert.deepEqual(await kinds(a.page), { header: 1, counter: 1, grant: 1, pending: 0 });
    const counterAfterOne = await counterOf(a.page);

    // Part 2: a second Library's grant is sealed under the existing vault; the page is closed after the sealed result exists but before anything is written.
    phase = 'create-two';
    await a.page.keyboard.press('Escape');
    await a.page.getByRole('dialog', { name: 'オフライン利用の設定', exact: true }).waitFor({ state: 'hidden' });
    await a.page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
    await createLibrary(a.page, two).catch(async error => { t.diagnostic(`create second Library: ${JSON.stringify(await uiSnapshot(a.page))}`); throw error; });
    await holdNextEncrypt(a.page); phase = 'cut-grant-seal';
    await submitSecret(a.page, passphrase); await encryptReached(a.page); await w.close(a.context);
    phase = 'after-seal-cut'; a = await w.launch(profile, 'online', 'enroll-cut-a3'); await openOnline(a.page, two);
    const afterSecondCut = await kinds(a.page); t.diagnostic(`vault rows after the seal-stage cut: ${JSON.stringify(afterSecondCut)}`);
    assert.equal(afterSecondCut.grant, 1, 'only the first Library has a permission'); assert.equal(afterSecondCut.pending, 0);
    const counterAfterCut = await counterOf(a.page); assert.ok(counterAfterCut > counterAfterOne, 'a reserved nonce is never given back');
    await submitSecret(a.page, passphrase); await accepted(a.page).waitFor();
    assert.deepEqual(await kinds(a.page), { header: 1, counter: 1, grant: 2, pending: 0 });
    assert.ok(await counterOf(a.page) > counterAfterCut);

    phase = 'cold-unlock-both'; await w.close(a.context);
    const cold = await w.launch(profile, 'offline', 'unused'); await submitSecret(cold.page, passphrase);
    await offlinePanel(cold.page).getByRole('button', { name: one, exact: true }).waitFor(); await offlinePanel(cold.page).getByRole('button', { name: two, exact: true }).waitFor();
    assert.deepEqual(w.outside, []);
  } catch (error) { await w.diagnose(t, phase); throw error; }
});

for (const engine of ['chromium', 'webkit'] as const satisfies Engine[]) test(`an unknown permission save is re-confirmed with the same request and never duplicated (${engine})`, { timeout: 480_000 }, async t => {
  const w = await openWorld(t, engine, 'enroll-unknown'), profile = w.profile('a');
  const library = `Unknown Library ${engine}`, note = `Unknown note ${engine}`; let phase = 'create';
  try {
    let a = await w.launch(profile, 'online', 'enroll-unknown-a'); await connect(a.page); await createLibrary(a.page, library);
    await a.page.getByRole('button', { name: '新規', exact: true }).click();
    const createDialog = a.page.getByRole('dialog', { name: '新しい資料を作成', exact: true });
    await createDialog.getByLabel('新しい資料の名前', { exact: true }).fill(note);
    await createDialog.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
    await createDialog.getByRole('button', { name: '資料を作成', exact: true }).click();
    await createDialog.waitFor({ state: 'hidden' });
    const id = await a.page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
    await fillNote(a.page, 'online initial');
    await until(() => records(a.page, id), rows => rows.some(row => row.receipt.durable && row.receipt.upload === 'accepted'), 'initial upload');

    phase = 'unknown-save'; await abortNextGrantAdd(a.page); await submitSecret(a.page, passphrase);
    await a.page.waitForFunction(() => (window as unknown as { __b9Fired?: boolean }).__b9Fired === true);
    await offlinePanel(a.page).getByText('確認しています…', { exact: true }).waitFor({ state: 'hidden' });
    await offlinePanel(a.page).getByText('許可の保存結果を確認できません。同じ操作を再確認してください。', { exact: true }).waitFor();
    await restoreAdd(a.page);
    const unknown = await kinds(a.page); t.diagnostic(`vault rows while unknown: ${JSON.stringify(unknown)}`);
    assert.equal(unknown.grant, 0, 'no permission is claimed while the save is unknown'); assert.equal(unknown.pending, 1, 'the sealed request is kept for the same-ID confirmation');
    const pendingId = (await vaultRows(a.page)).find(row => row.kind === 'pending')!.id;
    assert.equal(await offlinePanel(a.page).getByText('この端末での利用を許可しました。', { exact: true }).count(), 0);

    phase = 'reconfirm'; await submitSecret(a.page, passphrase); await accepted(a.page).waitFor();
    assert.deepEqual(await kinds(a.page), { header: 1, counter: 1, grant: 1, pending: 0 });
    assert.equal((await vaultRows(a.page)).find(row => row.kind === 'grant')!.id, pendingId, 'the same request ID was finalized, not a new permission');
    await submitSecret(a.page, passphrase).catch(() => undefined);
    assert.equal((await kinds(a.page)).grant, 1, 'a repeated confirmation adds nothing');

    phase = 'cold-unlock'; await w.close(a.context);
    a = await w.launch(profile, 'offline', 'unused'); await unlock(a.page, library); await openNote(a.page, note);
    assert.equal(await visibleText(a.page), 'online initial'); assert.deepEqual(w.outside, []);
  } catch (error) { await w.diagnose(t, phase); throw error; }
});
