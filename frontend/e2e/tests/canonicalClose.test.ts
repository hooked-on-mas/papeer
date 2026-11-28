import assert from 'node:assert/strict';
import type { Route } from 'playwright-core';
import type { EditWriteRequest } from '../../src/runtime/edits/contracts.ts';
import type { BatchReceipt } from '../../src/runtime/edits/ports.ts';
import { scenario } from '../lib/app.ts';
import { isListening, SIDECAR_PORT, waitFor } from '../lib/processes.ts';

scenario('実際の終了要求は保存結果不明を保護し、再試行後に終了する', { seed: false, guardExit: false, timeout: 300_000 }, async (app, t) => {
  const { page } = app;
  t.diagnostic('phase: ordinary startup and isolated Library creation');
  await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).click();
  await page.getByLabel('新しいライブラリの名前').fill('P1 close library');
  await page.getByRole('button', { name: '作成', exact: true }).click();
  await page.getByText('P1 close library: 作成しました。一覧を更新してください。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '確認しました', exact: true }).click();
  await page.getByRole('button', { name: 'P1 close library', exact: true }).click();
  await page.getByLabel('新しい資料の名前', { exact: true }).fill('P1 close notebook');
  await page.getByLabel('資料の種類', { exact: true }).selectOption('notebook');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true });
  await layer.waitFor();
  const documentId = await page.locator('[data-content-document]').getAttribute('data-content-document');
  assert.ok(documentId);
  await page.getByRole('button', { name: 'ペン', exact: true }).click();

  // Let the real sidecar commit, then lose only its HTTP reply at the WebView transport boundary.
  let resolveLost!: (value: { request: EditWriteRequest; receipt: BatchReceipt }) => void;
  let rejectLost!: (reason: unknown) => void;
  const lost = new Promise<{ request: EditWriteRequest; receipt: BatchReceipt }>((resolve, reject) => { resolveLost = resolve; rejectLost = reject; });
  let originalRequest: EditWriteRequest | undefined, lostReplies = 0;
  const pattern = '**/api/edits/commit';
  const loseReply = async (route: Route) => {
    try {
      const request = route.request().postDataJSON() as EditWriteRequest;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const value = await response.json() as { status: string; receipt: BatchReceipt };
      assert.equal(value.status, 'durable'); assert.equal(value.receipt.durable, true);
      assert.equal(value.receipt.id, request.batch.id); assert.equal(value.receipt.targetId, documentId);
      assert.equal(request.batch.targetId, documentId);
      if (originalRequest) assert.deepEqual(request, originalRequest);
      else originalRequest = request;
      lostReplies++;
      resolveLost({ request, receipt: value.receipt });
    } catch (error) { rejectLost(error); }
    finally { await route.abort('failed'); }
  };
  await page.route(pattern, loseReply);
  t.diagnostic('phase: commit reaches sidecar and its response is lost');
  await layer.scrollIntoViewIfNeeded(); const box = await layer.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .3); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .45, box.y + box.height * .3, { steps: 10 }); await page.mouse.up();
  const committed = await lost;
  await page.getByRole('status').filter({ hasText: '未保存の変更があります' }).waitFor();
  await page.getByRole('alert').filter({ hasText: '書き込みを保存できません' }).waitFor();
  const ink = page.locator('[data-reader-root] [data-ink-id]');
  await page.waitForFunction(() => document.querySelectorAll('[data-reader-root] [data-ink-id]').length === 1);
  const inkId = await ink.first().getAttribute('data-ink-id'); assert.ok(inkId);

  t.diagnostic('phase: WM_CLOSE is refused while the result is unknown');
  app.requestWindowClose();
  await page.getByRole('alert').filter({ hasText: '入力を確定または取り消し、保存を確認してから終了してください。' }).waitFor();
  assert.ok(lostReplies >= 2, 'the close guard retry must also see the lost response');
  assert.equal(app.appRunning(), true);
  assert.equal(app.sidecarRunning(), true);
  assert.equal((await app.api.request('GET', '/health')).ok, true);
  assert.equal(await ink.first().getAttribute('data-ink-id'), inkId);

  t.diagnostic('phase: retry same operation and confirm durable receipt');
  await page.unroute(pattern, loseReply);
  const retried = page.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/commit' && response.request().method() === 'POST');
  await page.getByRole('alert').filter({ hasText: '書き込みを保存できません' }).getByRole('button', { name: '再試行', exact: true }).click();
  const response = await retried;
  assert.equal(response.status(), 200);
  assert.deepEqual(response.request().postDataJSON(), committed.request);
  const result = await response.json() as { status: string; receipt: BatchReceipt };
  assert.equal(result.status, 'durable'); assert.deepEqual(result.receipt, committed.receipt);
  await page.getByRole('status').filter({ hasText: /端末保存済み/ }).first().waitFor();
  assert.equal(await ink.count(), 1); assert.equal(await ink.first().getAttribute('data-ink-id'), inkId);

  t.diagnostic('phase: WM_CLOSE exits the real Tauri window and sidecar');
  app.requestWindowClose();
  await waitFor(() => !app.appRunning(), 'Tauri process exit', 30_000, 200);
  await waitFor(async () => !app.sidecarRunning() && !await isListening(SIDECAR_PORT), 'sidecar shutdown', 30_000, 200);
  t.diagnostic('Tauri process exited and sidecar port closed after durable retry');
});
