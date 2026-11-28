import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { connect, damageRow, editRecordCount, fillNote, hasRetainedRuntime, offlinePanel, openNote, openWorld, passphrase, prepareOfflineEdit, records, restoreRow, stashRetainedRuntime, submitSecret, uiSnapshot, unlock, until, vaultRows, visibleText, writeThroughStashedRuntime, type Engine } from '../../../support/provider/offlineOrdinary.ts';

for (const engine of ['chromium', 'webkit'] as const satisfies Engine[]) test(`another tab cannot open the held offline Library; a revoked permission keeps the unsent edits and the retired runtime cannot write (${engine})`, { timeout: 480_000 }, async t => {
  const w = await openWorld(t, engine, 'tabs'), profile = w.profile('a');
  const library = `Tabs Library ${engine}`, note = `Tabs note ${engine}`; let phase = 'prepare';
  try {
    const { id, edit } = await prepareOfflineEdit(w, profile, library, note, 'online initial', 'offline durable edit');
    phase = 'first-tab-holds'; const first = await w.launch(profile, 'offline', 'unused'); await unlock(first.page, library); await openNote(first.page, note);
    assert.equal(await stashRetainedRuntime(first.page), true);
    phase = 'second-tab'; const second = await first.context.newPage(); second.setDefaultTimeout(25_000);
    await second.goto(w.url, { waitUntil: 'domcontentloaded' });
    await submitSecret(second, passphrase); await second.waitForTimeout(3_000);
    const secondState = await uiSnapshot(second); t.diagnostic(`second tab after unlock attempt: ${JSON.stringify(secondState)}`);
    assert.equal(secondState.editors, 0); assert.equal(secondState.offlineHeader, false);
    assert.equal(await offlinePanel(second).getByRole('button', { name: library, exact: true }).count(), 0);
    assert.equal(await visibleText(first.page), 'offline durable edit');
    await fillNote(first.page, 'edit while the second tab was refused');
    await until(() => records(first.page, id), rows => rows.some(row => row.receipt.durable && row.receipt.upload === 'pending' && row.batch.id !== edit.batch.id), 'second pending batch');
    phase = 'revoke-in-first-tab'; await second.close();
    const pendingBeforeRevoke = (await records(first.page, id)).filter(row => row.receipt.upload === 'pending').map(row => row.batch.id).sort();
    t.diagnostic(`first tab before revoke: ${JSON.stringify(await uiSnapshot(first.page))}`);
    await first.page.getByRole('toolbar', { name: 'Markdownノートの操作', exact: true }).getByRole('status').filter({ hasText: /^端末保存済み・同期停止中（未送信の変更は保持されます）$/ }).waitFor();
    await first.page.getByRole('button', { name: 'オフライン設定', exact: true }).click();
    const revoke = offlinePanel(first.page).getByRole('button', { name: 'この端末での許可を取り消す', exact: true });
    await revoke.click(); await first.page.waitForTimeout(3_000);
    t.diagnostic(`first tab after revoke: ${JSON.stringify(await uiSnapshot(first.page))}`);
    assert.equal((await vaultRows(first.page)).filter(row => row.kind === 'grant').length, 0);
    const written = await writeThroughStashedRuntime(first.page, id, 'written after revoke'); t.diagnostic(`write through the retired runtime: ${JSON.stringify(written)}`);
    const after = await records(first.page, id);
    assert.deepEqual(after.filter(row => row.receipt.upload === 'pending').map(row => row.batch.id).sort(), pendingBeforeRevoke, 'no new batch after the revocation');
    assert.equal(after.some(row => row.batch.kind === 'markdown' && row.batch.content === 'written after revoke'), false);
    await w.close(first.context);

    phase = 'cold-after-revoke'; const postsBefore = w.drive.posts.length, editRecordsBefore = editRecordCount(w.drive);
    let again = await w.launch(profile, 'offline', 'unused'); await submitSecret(again.page, passphrase); await again.page.waitForTimeout(3_000);
    const refused = await uiSnapshot(again.page); t.diagnostic(`cold unlock after revoke: ${JSON.stringify(refused)}`);
    assert.equal(refused.editors, 0); assert.equal(await offlinePanel(again.page).getByRole('button', { name: library, exact: true }).count(), 0);
    assert.deepEqual((await records(again.page, id)).filter(row => row.receipt.upload === 'pending').map(row => row.batch.id).sort(), pendingBeforeRevoke);
    assert.deepEqual(w.outside, []); await w.close(again.context);

    phase = 'online-after-revoke'; again = await w.launch(profile, 'online', 'tabs-a-again'); await connect(again.page);
    await again.page.getByRole('button', { name: library, exact: true }).click();
    await again.page.getByRole('button', { name: 'オフライン利用…', exact: true }).waitFor();
    t.diagnostic(`online after revoke: ${JSON.stringify(await uiSnapshot(again.page))}`);
    await openNote(again.page, note); assert.equal(await visibleText(again.page), 'edit while the second tab was refused');
    await until(() => records(again.page, id), rows => pendingBeforeRevoke.every(batch => rows.some(row => row.batch.id === batch && row.receipt.upload === 'accepted')), 'both pending batches accepted');
    const finalRows = await records(again.page, id);
    for (const batch of pendingBeforeRevoke) assert.equal(finalRows.filter(row => row.batch.id === batch).length, 1);
    assert.ok(w.drive.posts.length > postsBefore);
    // The IndexedDB key cannot hold a batch twice, so only the Drive side shows duplicates: exactly one edit-record per resent batch.
    assert.equal(editRecordCount(w.drive) - editRecordsBefore, pendingBeforeRevoke.length, 'each unsent batch was sent exactly once');
  } catch (error) { await w.diagnose(t, phase); throw error; }
});

for (const engine of ['chromium', 'webkit'] as const satisfies Engine[]) test(`leaving and locking retire each offline runtime generation while the unsent edits stay (${engine})`, { timeout: 480_000 }, async t => {
  const w = await openWorld(t, engine, 'generation'), profile = w.profile('a');
  const library = `Generation Library ${engine}`, note = `Generation note ${engine}`; let phase = 'prepare';
  try {
    const { id, edit } = await prepareOfflineEdit(w, profile, library, note, 'online initial', 'first generation edit');
    const postsBefore = w.drive.posts.length;
    const pendingIds = async (page: Page) => (await records(page, id)).filter(row => row.receipt.upload === 'pending').map(row => row.batch.id).sort();
    phase = 'generation-1'; const a = await w.launch(profile, 'offline', 'unused'); await unlock(a.page, library); await openNote(a.page, note);
    assert.equal(await visibleText(a.page), 'first generation edit'); assert.equal(await stashRetainedRuntime(a.page), true);
    phase = 'leave'; await a.page.getByRole('button', { name: 'ライブラリを切り替える', exact: true }).click();
    // The leave is complete only when the runtime is no longer retained; until then the same generation may still be saving.
    await until(() => hasRetainedRuntime(a.page), retained => !retained, 'the runtime to be left');
    await offlinePanel(a.page).getByRole('button', { name: library, exact: true }).waitFor();
    t.diagnostic(`after leaving: ${JSON.stringify(await uiSnapshot(a.page))}`);
    const afterLeave = await pendingIds(a.page); assert.deepEqual(afterLeave, [edit.batch.id]);
    const oldWrite = await writeThroughStashedRuntime(a.page, id, 'written by the left generation'); t.diagnostic(`write through the left generation: ${JSON.stringify(oldWrite)}`);
    assert.deepEqual(await pendingIds(a.page), afterLeave, 'a left runtime wrote nothing');
    assert.equal((await records(a.page, id)).some(row => row.batch.kind === 'markdown' && row.batch.content === 'written by the left generation'), false);

    phase = 'generation-2'; await offlinePanel(a.page).getByRole('button', { name: library, exact: true }).click();
    await a.page.getByText('Google Drive（オフライン）', { exact: true }).waitFor(); await openNote(a.page, note);
    assert.equal(await visibleText(a.page), 'first generation edit');
    await fillNote(a.page, 'second generation edit');
    const second = await until(() => pendingIds(a.page), ids => ids.length === 2 && ids.includes(edit.batch.id), 'second generation pending batch');
    assert.equal(await stashRetainedRuntime(a.page), true);
    phase = 'lock';
    await a.page.getByRole('button', { name: 'オフライン設定', exact: true }).click();
    await offlinePanel(a.page).getByRole('button', { name: '端末での利用をロック', exact: true }).click();
    await offlinePanel(a.page).getByLabel('端末のパスフレーズ').waitFor();
    const lockedWrite = await writeThroughStashedRuntime(a.page, id, 'written after the lock'); t.diagnostic(`write through the locked generation: ${JSON.stringify(lockedWrite)}`);
    assert.deepEqual(await pendingIds(a.page), second, 'a locked runtime wrote nothing');
    assert.equal((await records(a.page, id)).some(row => row.batch.kind === 'markdown' && row.batch.content === 'written after the lock'), false);

    phase = 'generation-3'; await unlock(a.page, library); await openNote(a.page, note);
    assert.equal(await visibleText(a.page), 'second generation edit'); assert.deepEqual(await pendingIds(a.page), second);
    assert.equal(w.drive.posts.length, postsBefore, 'no transfer in any generation'); assert.deepEqual(w.outside, []);
  } catch (error) { await w.diagnose(t, phase); throw error; }
});

// The ordinary UI cannot revoke from another tab: while one tab holds the offline Library (Web Lock on the cache), a second tab can neither open nor revoke it
// (first test above). The design still asks that a revocation made by ANOTHER tab/context is seen at the holder's next transaction (offline-unlock-design.md,
// "別tabによる失効も同じstoreのtransaction順序で検出する"). So the removal is simulated: a second page of the same origin deletes the grant row directly in IndexedDB.
for (const engine of ['chromium', 'webkit'] as const satisfies Engine[]) test(`a permission removed by another tab (simulated by a raw row delete) is refused at the holding tab's next write (${engine})`, { timeout: 480_000 }, async t => {
  const w = await openWorld(t, engine, 'crosstab'), profile = w.profile('a');
  const library = `Crosstab Library ${engine}`, note = `Crosstab note ${engine}`; let phase = 'prepare';
  try {
    const { id, edit } = await prepareOfflineEdit(w, profile, library, note, 'online initial', 'offline durable edit');
    phase = 'holder'; const first = await w.launch(profile, 'offline', 'unused'); await unlock(first.page, library); await openNote(first.page, note);
    await first.page.getByRole('toolbar', { name: 'Markdownノートの操作', exact: true }).getByRole('status').filter({ hasText: /^端末保存済み・同期停止中（未送信の変更は保持されます）$/ }).waitFor();
    const pendingBefore = (await records(first.page, id)).filter(row => row.receipt.upload === 'pending').map(row => row.batch.id).sort();
    assert.deepEqual(pendingBefore, [edit.batch.id]);
    const postsBefore = w.drive.posts.length;
    phase = 'other-tab-removes'; const other = await first.context.newPage(); other.setDefaultTimeout(25_000); await other.goto(w.url, { waitUntil: 'domcontentloaded' });
    await damageRow(other, 'grant', 'delete'); assert.equal((await vaultRows(other)).filter(row => row.kind === 'grant').length, 0);
    phase = 'holder-writes'; const typed = 'edit after another tab removed the permission'; await fillNote(first.page, typed);
    await first.page.getByRole('alert').filter({ hasText: '変更を保存できません。入力内容を保持しています。' }).waitFor();
    const refused = await records(first.page, id);
    assert.deepEqual(refused.filter(row => row.receipt.upload === 'pending').map(row => row.batch.id).sort(), pendingBefore, 'no new durable batch');
    assert.equal(refused.some(row => (row.batch as { content?: string }).content === typed), false);
    assert.equal(await visibleText(first.page), typed, 'the typed text is kept on screen');
    assert.equal(w.drive.posts.length, postsBefore, 'nothing was sent'); assert.deepEqual(w.outside, []);
    phase = 'restore-and-retry'; await restoreRow(other, 'grant');
    // The editor retries on its own once the row is back (its 再試行 button re-renders continuously); no click is needed.
    const saved = await until(() => records(first.page, id), rows => rows.some(row => (row.batch as { content?: string }).content === typed && row.receipt.durable), 'retry after the permission is back', 15_000);
    t.diagnostic(`after restore and retry: ${JSON.stringify(saved.map(row => [row.receipt.durable, row.receipt.upload]))}`);
    await other.close(); await w.close(first.context);
  } catch (error) { await w.diagnose(t, phase); throw error; }
});
