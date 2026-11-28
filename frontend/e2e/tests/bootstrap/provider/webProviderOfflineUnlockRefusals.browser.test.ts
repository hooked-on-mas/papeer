import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { createEnrolledLibrary, damageRow, fillNote, offlinePanel, openNote, openWorld, passphrase, records, restoreRow, submitSecret, uiSnapshot, unlock, until, vaultRows, visibleText, type Engine } from '../../../support/provider/offlineOrdinary.ts';

/** A refused-by-emptiness unlock still leaves a (library-less) unlocked session; lock it so that the next attempt starts clean. */
async function leaveEmptyUnlock(page: Page) {
  const state = await uiSnapshot(page);
  if (state.alerts.length) return;
  await offlinePanel(page).getByRole('button', { name: '端末での利用をロック', exact: true }).click();
  await offlinePanel(page).getByLabel('端末のパスフレーズ').waitFor();
}
const wrong = ['synthetic wrong passphrase 000', 'short'];

for (const engine of ['chromium', 'webkit'] as const satisfies Engine[]) test(`offline unlock refuses a wrong secret and a missing or damaged permission, then opens the retained content (${engine})`, { timeout: 480_000 }, async t => {
  const w = await openWorld(t, engine, 'refusal'), profile = w.profile('a');
  const library = `Refusal Library ${engine}`, note = `Refusal note ${engine}`; let phase = 'online-create';
  try {
    let a = await w.launch(profile, 'online', 'refusal-a');
    const id = await createEnrolledLibrary(a.page, library, note, 'online initial');
    const before = new Set((await records(a.page, id)).map(row => row.batch.id));
    await w.close(a.context);
    phase = 'cold-offline-edit'; a = await w.launch(profile, 'offline', 'unused'); await unlock(a.page, library); await openNote(a.page, note);
    await fillNote(a.page, 'offline durable edit');
    const rows = await until(() => records(a.page, id), values => values.some(row => !before.has(row.batch.id) && row.receipt.durable && row.receipt.upload === 'pending'), 'offline durable outbox');
    const edit = rows.find(row => !before.has(row.batch.id) && row.receipt.durable && row.receipt.upload === 'pending'); assert.ok(edit);
    await w.close(a.context);

    phase = 'wrong-secret'; a = await w.launch(profile, 'offline', 'unused');
    for (const secret of wrong) {
      await submitSecret(a.page, secret);
      await offlinePanel(a.page).getByRole('alert').waitFor({ timeout: 25_000 });
      const state = await uiSnapshot(a.page); t.diagnostic(`wrong-secret ${JSON.stringify(secret)}: ${JSON.stringify(state)}`);
      assert.equal(state.editors, 0); assert.equal(state.offlineHeader, false); assert.equal(await offlinePanel(a.page).getByRole('button', { name: library, exact: true }).count(), 0);
      assert.deepEqual(state.passwordValues.filter(length => length > 0), []);
    }
    assert.deepEqual(w.outside, []);

    phase = 'missing-permission'; await damageRow(a.page, 'grant', 'delete'); assert.equal((await vaultRows(a.page)).filter(row => row.kind === 'grant').length, 0);
    await submitSecret(a.page, passphrase); await a.page.waitForTimeout(3_000);
    const missing = await uiSnapshot(a.page); t.diagnostic(`missing-permission: ${JSON.stringify(missing)}`);
    assert.equal(missing.editors, 0); assert.equal(missing.offlineHeader, false); assert.ok(missing.buttons.includes('端末での利用をロック'), 'an empty unlocked session, never a Library');
    assert.equal(await offlinePanel(a.page).getByRole('button', { name: library, exact: true }).count(), 0);
    assert.equal((await records(a.page, id)).filter(row => row.batch.id === edit.batch.id && row.receipt.upload === 'pending').length, 1);
    await leaveEmptyUnlock(a.page); await restoreRow(a.page, 'grant');

    phase = 'damaged-permission'; await damageRow(a.page, 'grant', 'corrupt');
    await submitSecret(a.page, passphrase); await a.page.waitForTimeout(3_000);
    const damaged = await uiSnapshot(a.page); t.diagnostic(`damaged-permission: ${JSON.stringify(damaged)}`);
    assert.equal(damaged.editors, 0); assert.equal(damaged.offlineHeader, false); assert.equal(damaged.alerts.length, 1, 'a damaged permission is refused with the generic alert');
    assert.equal(await offlinePanel(a.page).getByRole('button', { name: library, exact: true }).count(), 0);
    assert.equal((await records(a.page, id)).filter(row => row.batch.id === edit.batch.id && row.receipt.upload === 'pending').length, 1);
    await leaveEmptyUnlock(a.page); await restoreRow(a.page, 'grant');

    for (const [target, mode] of [['header', 'corrupt'], ['counter', 'corrupt'], ['peer', 'delete']] as const) {
      phase = `damaged-${target}`; await damageRow(a.page, target, mode);
      await submitSecret(a.page, passphrase); await a.page.waitForTimeout(3_000);
      const listed = offlinePanel(a.page).getByRole('button', { name: library, exact: true });
      if (await listed.count()) { await listed.click(); await a.page.waitForTimeout(3_000); }
      const state = await uiSnapshot(a.page); t.diagnostic(`${phase}: ${JSON.stringify(state)}`);
      assert.equal(state.editors, 0, `${phase}: no editor`); assert.equal(state.offlineHeader, false, `${phase}: not opened`);
      assert.equal((await records(a.page, id)).filter(row => row.batch.id === edit.batch.id && row.receipt.upload === 'pending').length, 1, `${phase}: the unsent edit is kept`);
      if (!(await uiSnapshot(a.page)).buttons.includes('端末で開く')) {
        await offlinePanel(a.page).getByRole('button', { name: '端末での利用をロック', exact: true }).click();
        await offlinePanel(a.page).getByLabel('端末のパスフレーズ').waitFor();
      }
      await restoreRow(a.page, target);
    }

    phase = 'unlock-after-restore'; await unlock(a.page, library); await openNote(a.page, note);
    assert.equal(await visibleText(a.page), 'offline durable edit');
    assert.equal((await records(a.page, id)).filter(row => row.batch.id === edit.batch.id && row.receipt.upload === 'pending').length, 1);
    assert.deepEqual(w.outside, []);
  } catch (error) { await w.diagnose(t, phase); throw error; }
});

for (const engine of ['chromium', 'webkit'] as const satisfies Engine[]) test(`offline unlock with no existing cache creates nothing and shows no Library (${engine})`, { timeout: 180_000 }, async t => {
  const w = await openWorld(t, engine, 'nocache'); let phase = 'cold-start';
  try {
    const { page } = await w.launch(w.profile('fresh'), 'offline', 'unused');
    await submitSecret(page, passphrase);
    await offlinePanel(page).getByRole('alert').waitFor({ timeout: 25_000 });
    const state = await uiSnapshot(page); t.diagnostic(`no cache: ${JSON.stringify(state)}`);
    assert.equal(state.editors, 0); assert.equal(state.offlineHeader, false); assert.equal(state.alerts.length, 1);
    assert.deepEqual(state.passwordValues.filter(length => length > 0), []);
    phase = 'nothing-created';
    const databases = await page.evaluate(async () => (await indexedDB.databases()).map(database => database.name ?? ''));
    t.diagnostic(`databases after the refused unlock: ${JSON.stringify(databases)}`);
    assert.equal(databases.includes('papeer-shared-cloud-v1'), false, 'the refused unlock did not create the cloud cache');
    assert.deepEqual(w.outside, []);
  } catch (error) { await w.diagnose(t, phase); throw error; }
});
