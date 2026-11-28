import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, driveView, editRecordCount, openNote, openWorld, prepareOfflineEdit, records, uiSnapshot, unlock, until, visibleText, type Engine } from '../../../support/provider/offlineOrdinary.ts';

for (const engine of ['chromium', 'webkit'] as const satisfies Engine[]) test(`a different Google principal B is never sent A's unsent edit, and A resends the same batch (${engine})`, { timeout: 480_000 }, async t => {
  const w = await openWorld(t, engine, 'identity'), profile = w.profile('a');
  const library = `Identity Library ${engine}`, note = `Identity note ${engine}`; let phase = 'prepare';
  try {
    const { id, edit } = await prepareOfflineEdit(w, profile, library, note, 'online initial', 'offline durable edit');
    phase = 'principal-b-online'; const postsBefore = w.drive.posts.length, editRecordsBefore = editRecordCount(w.drive);
    const b = await w.launch(profile, 'online', 'principal-b', driveView(w.drive, { principal: 'fixture-distinct-google-principal-b' }));
    await connect(b.page);
    await b.page.getByRole('button', { name: library, exact: true }).click();
    await b.page.getByRole('alert').filter({ hasText: '編集前のGoogleアカウントで再接続してください。保存途中の内容は保持しています。' }).waitFor();
    await b.page.waitForTimeout(2_000);
    const refused = await uiSnapshot(b.page);
    assert.equal(refused.editors, 0); assert.equal(refused.offlineHeader, false);
    assert.equal(w.drive.posts.length, postsBefore, 'nothing of A was sent while B was connected');
    const seenByB = await records(b.page, id);
    assert.equal(seenByB.filter(row => row.batch.id === edit.batch.id && row.receipt.upload === 'pending').length, 1);
    assert.equal(seenByB.some(row => row.batch.id === edit.batch.id && row.receipt.upload === 'accepted'), false);
    await w.close(b.context);

    phase = 'fresh-a-same-id-resend'; const a = await w.launch(profile, 'online', 'identity-a-again'); await unlock(a.page, library);
    await openNote(a.page, note); assert.equal(await visibleText(a.page), 'offline durable edit');
    assert.equal(w.drive.posts.length, postsBefore, 'the offline Library alone does not transfer');
    // Reconnecting is refused while the note is still saving; wait for the settled "saved on this device" state first (as the existing ordinary case does).
    await a.page.getByRole('toolbar', { name: 'Markdownノートの操作', exact: true }).getByRole('status').filter({ hasText: /^端末保存済み・同期停止中（未送信の変更は保持されます）$/ }).waitFor();
    await a.page.getByRole('button', { name: 'Googleへ再接続', exact: true }).click(); await connect(a.page);
    await until(() => records(a.page, id), rows => rows.some(row => row.batch.id === edit.batch.id && row.receipt.upload === 'accepted'), 'same batch accepted');
    const finalRows = await records(a.page, id);
    assert.equal(finalRows.filter(row => row.batch.id === edit.batch.id).length, 1, 'the same batch ID, not a new one');
    assert.ok(w.drive.posts.length > postsBefore, 'the batch reached the synthetic Drive only after A reconnected');
    assert.equal(editRecordCount(w.drive) - editRecordsBefore, 1, 'exactly one edit-record was written for the resent batch');
  } catch (error) { await w.diagnose(t, phase); throw error; }
});
