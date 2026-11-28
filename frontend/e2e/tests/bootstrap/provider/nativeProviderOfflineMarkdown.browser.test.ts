import { installNativeGateObservation, readNativeGateObservation } from '../../../support/nativeGateObservation.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { EditRecord } from '../../../../src/runtime/edits/contracts.ts';
import type { BatchReceipt, RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { openComposition, waitForNativeCloseReadiness } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

const secret = 'synthetic native ordinary offline passphrase';
const panel = (page: Page) => page.getByRole('region', { name: '端末でのオフライン利用' });
const editor = (page: Page) => page.getByRole('textbox', { name: 'Markdownノート', exact: true });
const visible = (page: Page) => editor(page).locator('.cm-line').evaluateAll(lines => lines.map(line => line.textContent ?? '').join('\n'));
const pending = (page: Page): Promise<EditRecord[]> => page.evaluate(() => (window as unknown as {
  compositionRepository(method: string, args: unknown[]): Promise<EditRecord[]>;
}).compositionRepository('pendingRecords', []));
const read = (page: Page, id: string): Promise<RepositoryState> => page.evaluate(id => (window as unknown as {
  compositionRepository(method: string, args: unknown[]): Promise<RepositoryState>;
}).compositionRepository('read', [id]), id);
const receipt = (page: Page, id: string): Promise<BatchReceipt | undefined> => page.evaluate(id => (window as unknown as {
  compositionRepository(method: string, args: unknown[]): Promise<BatchReceipt | undefined>;
}).compositionRepository('receipt', [id]), id);
async function enroll(page: Page) {
  await page.getByRole('button', { name: 'オフライン利用…', exact: true }).click();
  const input = panel(page).getByLabel('端末のパスフレーズ'); await input.fill(secret); await input.press('Enter');
  await panel(page).getByText('この端末での利用を許可しました。', { exact: true }).waitFor({ timeout: 25_000 });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'オフライン利用の設定', exact: true }).waitFor({ state: 'hidden' });
}
async function unlock(page: Page, title: string) {
  await page.bringToFront();
  const input = panel(page).getByLabel('端末のパスフレーズ');
  const expand = panel(page).getByRole('button', { name: '端末で開く', exact: true });
  await expand.or(input).first().waitFor({ timeout: 25_000 });
  if (await expand.isVisible() && !await input.isVisible()) await expand.click();
  await input.fill(secret); await input.press('Enter');
  await panel(page).getByRole('button', { name: title, exact: true }).click({ timeout: 25_000 });
  await page.getByText('Google Drive（オフライン）', { exact: true }).waitFor({ timeout: 25_000 });
}
async function openNote(page: Page, title: string) {
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByRole('button', { name: title, exact: true }).click({ timeout: 25_000 });
  await editor(page).waitFor({ timeout: 25_000 });
}
async function createNote(page: Page, title: string) {
  await page.bringToFront();
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByRole('button', { name: '新規', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: '新しい資料を作成', exact: true });
  await createDialog.getByLabel('新しい資料の名前', { exact: true }).fill(title);
  await createDialog.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
  await createDialog.getByRole('button', { name: '資料を作成', exact: true }).click();
  await createDialog.waitFor({ state: 'hidden' });
  await editor(page).waitFor({ timeout: 25_000 });
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id); return id;
}
async function connect(page: Page) {
  const expand = page.getByRole('button', { name: 'Google Driveを使う', exact: true });
  const button = page.getByRole('button', { name: 'Googleに接続', exact: true });
  const connected = page.getByText('Google Drive', { exact: true });
  await expand.or(button).or(connected).first().waitFor({ timeout: 25_000 });
  if (await expand.isVisible()) {
    await expand.click();
    await button.or(connected).first().waitFor({ timeout: 25_000 });
  }
  if (await button.isVisible()) await button.click();
  await connected.waitFor({ timeout: 25_000 });
}
async function savedOffline(page: Page) {
  await page.getByRole('toolbar', { name: 'Markdownノートの操作', exact: true }).getByRole('status')
    .filter({ hasText: /^端末保存済み・同期停止中（未送信の変更は保持されます）$/ }).waitFor({ timeout: 25_000 });
}
function assertRestarts(witnesses: { bearerRotated: boolean; oldBearerRefused: boolean; oldLeaseRefused: boolean }[], expected: number) {
  assert.equal(witnesses.length, expected);
  for (const value of witnesses) { assert.equal(value.bearerRotated, true); assert.equal(value.oldBearerRefused, true); assert.equal(value.oldLeaseRefused, true); }
}

for (const engine of ['chromium', 'webkit'] as const) test(`Native offline Markdown survives restart and reaches Web peer (${engine})`, { timeout: 600_000 }, async t => {
  const setup = await openComposition(t, engine, undefined, { emptyScope: true, nativeColdRestart: true });
  let native = setup.native; const title = 'Composition ' + engine, note = `Native offline Markdown ${engine}`;
  const id = await createNote(native, note); await editor(native).fill('Native online base'); await editor(native).blur();
  const base = await waitForSnapshot(() => read(native, id), value => value.checkpoint.batches.some(batch => batch.kind === 'markdown' && batch.content === 'Native online base'));
  const baseBatch = base.checkpoint.batches.find(batch => batch.kind === 'markdown' && batch.content === 'Native online base'); assert.ok(baseBatch);
  await waitForSnapshot(() => receipt(native, baseBatch.id), value => value?.durable === true && value.upload === 'accepted', 30_000);
  await enroll(native); await waitForNativeCloseReadiness(native, { requireCreatedFolder: false });
  setup.setNativeDriveOffline(true); native = await setup.restartNative(); await unlock(native, title); await openNote(native, note);
  assert.equal(await visible(native), 'Native online base'); assert.deepEqual(await setup.nativeNetworkEvidence(), { browserOpened: 0, driveRequests: 0 });
  const before = await read(native, id), beforeIds = new Set(before.checkpoint.batches.map(batch => batch.id));
  await editor(native).fill('Native offline durable edit'); await editor(native).blur();
  const records = await waitForSnapshot(() => pending(native), rows => rows.some(row => row.batch.kind === 'markdown' && row.batch.targetId === id && row.batch.content === 'Native offline durable edit'));
  const matches = records.filter(row => row.batch.kind === 'markdown' && row.batch.targetId === id && row.batch.content === 'Native offline durable edit');
  assert.equal(matches.length, 1); const record = matches[0], batchId = record.batch.id; assert.equal(beforeIds.has(batchId), false);
  assert.deepEqual(record.batch.parents, before.heads);
  const proof = await receipt(native, batchId); assert.equal(proof?.id, batchId); assert.equal(proof?.targetId, id); assert.equal(proof?.durable, true); assert.equal(proof?.upload, 'pending');
  await savedOffline(native); await waitForNativeCloseReadiness(native, { requireCreatedFolder: false });
  native = await setup.restartNative(); await unlock(native, title); await openNote(native, note);
  assert.equal(await visible(native), 'Native offline durable edit'); assert.deepEqual((await pending(native)).filter(row => row.batch.id === batchId), [record]);
  assert.deepEqual(await receipt(native, batchId), proof); assert.deepEqual(await setup.nativeNetworkEvidence(), { browserOpened: 0, driveRequests: 0 });
  assertRestarts(setup.nativeRestartWitnesses(), 2); await savedOffline(native);
  setup.setNativeDriveOffline(false); await native.getByRole('button', { name: 'Googleへ再接続', exact: true }).click(); await connect(native);
  await waitForSnapshot(() => pending(native), rows => !rows.some(row => row.batch.id === batchId), 30_000);
  const uploaded = await receipt(native, batchId); assert.equal(uploaded?.durable, true); assert.equal(uploaded?.upload, 'accepted');
  await setup.web.bringToFront();
  const peer = await setup.web.evaluate(() => (window as unknown as { compositionAdmittedPeer(): string }).compositionAdmittedPeer());
  assert.ok(peer); const received = await waitForSnapshot(() => receipt(setup.web, batchId), value => value?.durable === true && value.id === batchId && value.importedBy.includes(peer), 30_000);
  assert.equal(received?.targetId, id); const webState = await read(setup.web, id);
  assert.deepEqual(webState.checkpoint.batches.filter(batch => batch.id === batchId), [record.batch]);
  await openNote(setup.web, note); assert.equal(await visible(setup.web), 'Native offline durable edit');
  // No receiver sync/delivery helper was used before either durable witness.
  await setup.finish();
});

for (const engine of ['chromium', 'webkit'] as const) test(`Native online permission revoke preserves editor and denies cold unlock (${engine})`, { timeout: 600_000 }, async t => {
  const setup = await openComposition(t, engine, undefined, { emptyScope: true, nativeColdRestart: true });
  let native = setup.native; await installNativeGateObservation(native); try { const title = 'Composition ' + engine, note = `Native revoke Markdown ${engine}`;
  const id = await createNote(native, note); await editor(native).fill('Native retained after revoke'); await editor(native).blur();
  const saved = await waitForSnapshot(() => read(native, id), value => value.checkpoint.batches.some(batch => batch.kind === 'markdown' && batch.content === 'Native retained after revoke'));
  const batch = saved.checkpoint.batches.find(value => value.kind === 'markdown' && value.content === 'Native retained after revoke'); assert.ok(batch);
  const beforeReceipt = await waitForSnapshot(() => receipt(native, batch.id), value => value?.durable === true);
  await enroll(native); await waitForNativeCloseReadiness(native, { requireCreatedFolder: false });
  setup.setNativeDriveOffline(true); native = await setup.restartNative(); await installNativeGateObservation(native); await unlock(native, title); await openNote(native, note);
  assert.equal(await visible(native), 'Native retained after revoke'); await savedOffline(native);
  assert.deepEqual(await setup.nativeNetworkEvidence(), { browserOpened: 0, driveRequests: 0 });
  setup.setNativeDriveOffline(false); await native.getByRole('button', { name: 'Googleへ再接続', exact: true }).click(); await connect(native);
  assert.equal(await visible(native), 'Native retained after revoke');
  const editorHandle = await editor(native).elementHandle(); assert.ok(editorHandle);
  await native.getByRole('button', { name: 'オフライン利用…', exact: true }).click();
  const input = panel(native).getByLabel('端末のパスフレーズ'); await input.fill(secret);
  await panel(native).getByRole('button', { name: 'このライブラリの端末利用の許可を取り消す', exact: true }).click();
  await panel(native).getByText('このライブラリの端末利用の許可を取り消しました。資料と未送信の変更は保持しています。', { exact: true }).waitFor({ timeout: 25_000 });
  await native.keyboard.press('Escape');
  await native.getByRole('dialog', { name: 'オフライン利用の設定', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await editorHandle.evaluate(element => element.isConnected), true);
  assert.equal(await editor(native).evaluate((element, original) => element === original, editorHandle), true);
  assert.equal(await visible(native), 'Native retained after revoke'); assert.deepEqual((await read(native, id)).checkpoint.batches.filter(value => value.id === batch.id), [batch]);
  const afterReceipt = await receipt(native, batch.id); assert.equal(afterReceipt?.id, beforeReceipt?.id); assert.equal(afterReceipt?.durable, true);
  const priorAuth = await setup.nativeAuthEvidence(); assert.ok(priorAuth.pkceVerified > 0);
  assert.equal(priorAuth.browserOpened, priorAuth.forgedStateRefused); assert.equal(priorAuth.callbackAccepted, priorAuth.pkceVerified); assert.deepEqual(priorAuth.errors, []);
  await waitForNativeCloseReadiness(native, { requireCreatedFolder: false }); setup.setNativeDriveOffline(true); native = await setup.restartNative(); await installNativeGateObservation(native);
  assert.deepEqual(await setup.nativeNetworkEvidence(), { browserOpened: 0, driveRequests: 0 });
  const cold = panel(native), password = cold.getByLabel('端末のパスフレーズ');
  const coldExpand = cold.getByRole('button', { name: '端末で開く', exact: true });
  await coldExpand.or(password).first().waitFor({ timeout: 25_000 });
  if (await coldExpand.isVisible() && !await password.isVisible()) await coldExpand.click();
  const refused = native.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/provider-owner/offline/unlock', { timeout: 25_000 });
  void refused.catch(() => undefined);
  await password.fill(secret); await password.press('Enter');
  const denied = await refused; assert.equal(denied.status(), 403);
  assert.ok(denied.request().headers()['x-papeer-host-lease']);
  assert.deepEqual(await denied.json(), { detail: 'canonical-authority-denied' });
  t.diagnostic('Cold Native unlock returned a real server-side authority denial; generic response does not establish which validation failed.');
  await cold.getByRole('alert').filter({ hasText: '操作を完了できませんでした。入力と保存状態を確認してください。' }).waitFor({ timeout: 25_000 });
  assert.equal(await cold.getByRole('button', { name: title, exact: true }).count(), 0);
  assert.equal(await editor(native).count(), 0); assert.deepEqual(await setup.nativeNetworkEvidence(), { browserOpened: 0, driveRequests: 0 });
  assertRestarts(setup.nativeRestartWitnesses(), 2); await setup.finish({ offlineFinal: true });
  } catch (error) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { const evidence = await Promise.race([readNativeGateObservation(native), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('gate diagnostic timeout')), 2_000); })]);
      t.diagnostic('Native gate diagnostic: ' + JSON.stringify(evidence));
    } catch { t.diagnostic('Native gate diagnostic unavailable'); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    throw error;
  }
});
