import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { EditRecord } from '../../../../src/runtime/edits/contracts.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { openComposition, waitForNativeCloseReadiness } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

const secret = 'synthetic native ordinary offline passphrase';
const pending = (page: Page) => page.evaluate(() => (window as unknown as {
  compositionRepository(method: string, args: unknown[]): Promise<EditRecord[]>;
}).compositionRepository('pendingRecords', []));
async function connect(page: Page) {
  const expand = page.getByRole('button', { name:'Google Driveを使う', exact:true });
  const button = page.getByRole('button', { name:'Googleに接続', exact:true });
  const connected = page.getByText('Google Drive', { exact:true });
  await expand.or(button).or(connected).first().waitFor({ timeout:25_000 });
  if (await expand.isVisible()) {
    await expand.click();
    await button.or(connected).first().waitFor({ timeout:25_000 });
  }
  if (await button.isVisible()) await button.click();
}
async function unlock(page: Page, title: string) {
  await page.bringToFront();
  const panel = page.getByRole('region', { name:'端末でのオフライン利用' });
  assert.equal(await panel.getByRole('button', { name:title, exact:true }).count(), 0);
  const input = panel.getByLabel('端末のパスフレーズ');
  const expand = panel.getByRole('button', { name:'端末で開く', exact:true });
  await expand.or(input).first().waitFor({ timeout:25_000 });
  if (await expand.isVisible() && !await input.isVisible()) await expand.click();
  await input.fill(secret); await input.press('Enter');
  await panel.getByRole('button', { name:title, exact:true }).click();
  await page.getByText('Google Drive（オフライン）', { exact:true }).waitFor();
  assert.equal(await page.locator('input[type=password]').evaluateAll(inputs => inputs.some(input => (input as HTMLInputElement).value.length > 0)), false);
}

for (const engine of ['chromium','webkit'] as const) test(`Native ASGI cold offline permission and durable Library outbox (${engine})`, { timeout:600_000 }, async t => {
  const setup = await openComposition(t, engine, undefined, { emptyScope:true, nativeColdRestart:true });
  let native = setup.native;
  const title = 'Composition ' + engine, folderTitle = 'Native cold folder ' + engine;
  await native.getByRole('button', { name:'オフライン利用…', exact:true }).click();
  const panel = native.getByRole('region', { name:'端末でのオフライン利用' });
  await panel.getByLabel('端末のパスフレーズ').fill(secret);
  await panel.getByLabel('端末のパスフレーズ').press('Enter');
  await panel.getByText('この端末での利用を許可しました。', { exact:true }).waitFor();
  await native.keyboard.press('Escape');
  await native.getByRole('dialog', { name:'オフライン利用の設定', exact:true }).waitFor({ state:'hidden' });
  assert.equal(await native.locator('input[type=password]').evaluateAll(inputs => inputs.some(input => (input as HTMLInputElement).value.length > 0)), false);

  setup.setNativeDriveOffline(true);
  native = await setup.restartNative();
  assert.deepEqual(await setup.nativeNetworkEvidence(), { browserOpened:0, driveRequests:0 });
  await unlock(native, title);
  const catalog = native.getByRole('button', { name:'資料一覧', exact:true });
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await native.getByRole('button', { name:'フォルダーを作成', exact:true }).click();
  await native.getByRole('textbox', { name:'フォルダー名', exact:true }).fill(folderTitle);
  await native.getByLabel('親フォルダー', { exact:true }).selectOption('');
  await native.getByRole('button', { name:'フォルダーを保存', exact:true }).click();
  const edits = await waitForSnapshot(() => pending(native), records => records.some(record => record.batch.kind === 'library'
    && record.batch.changes.some(change => change.type === 'put-folder' && change.folder.title === folderTitle)));
  const record = edits.find(record => record.batch.kind === 'library' && record.batch.changes.some(change => change.type === 'put-folder' && change.folder.title === folderTitle));
  assert.ok(record); const batchId = record.batch.id;
  assert.deepEqual(await setup.nativeNetworkEvidence(), { browserOpened:0, driveRequests:0 });

  // A durable outbox record may precede journal/catalog/form cleanup. Require
  // ordinary UI completion, without draining or delivering the pending record.
  await native.getByRole('form', { name:'フォルダーの操作', exact:true }).waitFor({ state:'hidden', timeout:25_000 });
  await waitForNativeCloseReadiness(native);
  assert.deepEqual((await pending(native)).find(value => value.batch.id === batchId), record);

  native = await setup.restartNative(); await unlock(native, title);
  assert.deepEqual((await pending(native)).find(value => value.batch.id === batchId), record);
  assert.deepEqual(await setup.nativeNetworkEvidence(), { browserOpened:0, driveRequests:0 });
  for (const value of setup.nativeRestartWitnesses()) {
    assert.equal(value.bearerRotated, true); assert.equal(value.oldBearerRefused, true); assert.equal(value.oldLeaseRefused, true);
  }
  assert.equal(setup.nativeRestartWitnesses().length, 2);

  setup.setNativeDriveOffline(false);
  await native.getByRole('button', { name:'Googleへ再接続', exact:true }).click();
  await connect(native);
  await native.getByText('Google Drive', { exact:true }).waitFor();
  await waitForSnapshot(() => pending(native), values => !values.some(value => value.batch.id === batchId));
  await setup.web.bringToFront();
  const received = await waitForSnapshot(() => setup.web.evaluate(async id => {
    const api = window as unknown as { compositionAdmittedPeer():string;
      compositionRepository(method:string,args:unknown[]):Promise<{id:string;durable:boolean;importedBy:string[]}|null> };
    return { peer:api.compositionAdmittedPeer(), receipt:await api.compositionRepository('receipt',[id]) };
  }, batchId), value => !!value.peer && value.receipt?.id === batchId && value.receipt.durable && value.receipt.importedBy.includes(value.peer));
  assert.ok(received.receipt?.importedBy.includes(received.peer));
  const peerState = await setup.web.evaluate(() => (window as unknown as {
    compositionLibraryEvidence():Promise<{state:RepositoryState}>;
  }).compositionLibraryEvidence());
  assert.deepEqual(peerState.state.checkpoint.batches.find(value => value.id === batchId), record.batch);
  // No sync()/compositionDelivery()/finish() was allowed to cause these outcomes.
  await setup.finish();
});
