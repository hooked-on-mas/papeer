import assert from 'node:assert/strict';
import type { Route } from 'playwright-core';
import type { PublicationWriteRequest } from '../../src/runtime/edits/contracts.ts';
import type { BatchReceipt, EditScope } from '../../src/runtime/edits/ports.ts';
import { scenario } from '../lib/app.ts';
import { isListening, SIDECAR_PORT, waitFor } from '../lib/processes.ts';

scenario('作成結果不明では実Tauriの終了を拒否し、同じ要求を回復して終了する', { seed: false, guardExit: false, timeout: 300_000 }, async (app, t) => {
  const { page } = app;
  t.diagnostic('phase: ordinary empty startup and local setup');
  await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).click();
  await page.getByLabel('新しいライブラリの名前').fill('P1 creation recovery');

  // The real sidecar accepts this exact initialization; only its WebView response is lost.
  let resolveLost!: (id: string) => void, rejectLost!: (reason: unknown) => void;
  const lost = new Promise<string>((resolve, reject) => { resolveLost = resolve; rejectLost = reject; });
  const pattern = '**/api/edits/bootstrap/initialization/execute';
  const loseReply = async (route: Route) => {
    try {
      const request = route.request().postDataJSON() as { requestId: string };
      assert.match(request.requestId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
      const response = await route.fetch(); assert.equal(response.status(), 200);
      const outcome = await response.json() as { status: string; receipt?: { requestId: string } };
      assert.equal(outcome.status, 'accepted'); assert.equal(outcome.receipt?.requestId, request.requestId);
      resolveLost(request.requestId);
    } catch (error) { rejectLost(error); }
    finally { await route.abort('failed'); }
  };
  await page.route(pattern, loseReply, { times: 1 });
  t.diagnostic('phase: execute accepted by sidecar, response lost to UI');
  await page.getByRole('button', { name: '作成', exact: true }).click();
  const requestId = await lost;
  await page.getByRole('status').filter({ hasText: 'P1 creation recovery: 作成状況を確認してください。' }).waitFor();

  t.diagnostic('phase: WM_CLOSE refuses unknown creation');
  app.requestWindowClose();
  await page.getByRole('alert').filter({ hasText: '入力を確定または取り消し、保存を確認してから終了してください。' }).waitFor();
  assert.equal(app.appRunning(), true); assert.equal(app.sidecarRunning(), true);
  assert.equal((await app.api.request('GET', '/health')).ok, true);

  t.diagnostic('phase: query same request and acknowledge accepted result');
  const query = page.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/bootstrap/initialization/query' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '作成状況を再確認', exact: true }).click();
  const queryReply = await query;
  assert.equal(queryReply.status(), 200);
  assert.equal((queryReply.request().postDataJSON() as { requestId: string }).requestId, requestId);
  const outcome = await queryReply.json() as { status: string; receipt?: { requestId: string } };
  assert.equal(outcome.status, 'accepted'); assert.equal(outcome.receipt?.requestId, requestId);
  await page.getByText('P1 creation recovery: 作成しました。一覧を更新してください。', { exact: true }).waitFor();
  const ack = page.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/bootstrap/initialization/acknowledge' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '確認しました', exact: true }).click();
  const ackReply = await ack; assert.equal(ackReply.status(), 200);
  assert.equal((ackReply.request().postDataJSON() as { requestId: string }).requestId, requestId);
  await page.getByRole('button', { name: 'P1 creation recovery', exact: true }).waitFor();

  t.diagnostic('phase: open recovered Library and lose blank-notebook publication reply');
  await page.getByRole('button', { name: 'P1 creation recovery', exact: true }).click();
  await page.getByLabel('新しい資料の名前', { exact: true }).fill('P1 recovered notebook');
  await page.getByLabel('資料の種類', { exact: true }).selectOption('notebook');
  type PublicationRequest = PublicationWriteRequest & { scope: EditScope };
  let resolvePublication!: (value: { request: PublicationRequest; receipt: BatchReceipt; documentId: string }) => void;
  let rejectPublication!: (reason: unknown) => void;
  const publicationLost = new Promise<{ request: PublicationRequest; receipt: BatchReceipt; documentId: string }>((resolve, reject) => { resolvePublication = resolve; rejectPublication = reject; });
  const losePublication = async (route: Route) => {
    try {
      const request = route.request().postDataJSON() as PublicationRequest;
      const batch = request.publication.libraryBatch, content = request.publication.content;
      assert.ok(content); assert.equal(content.kind, 'document'); assert.ok(content.id);
      assert.equal(batch.libraryId, request.scope.libraryId); assert.equal(batch.targetId, request.scope.libraryId);
      const response = await route.fetch(); assert.equal(response.status(), 200);
      const result = await response.json() as { status: string; receipt: BatchReceipt };
      assert.equal(result.status, 'durable'); assert.equal(result.receipt.durable, true);
      assert.equal(result.receipt.id, batch.id); assert.equal(result.receipt.targetId, batch.targetId);
      resolvePublication({ request, receipt: result.receipt, documentId: content.id });
    } catch (error) { rejectPublication(error); }
    finally { await route.abort('failed'); }
  };
  await page.route('**/api/edits/publish', losePublication, { times: 1 });
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  const publication = await publicationLost;
  await page.getByRole('alert').filter({ hasText: '作成の完了を確認できません。同じ操作を再試行できます。' }).waitFor();
  await page.getByRole('button', { name: '作成を再試行', exact: true }).waitFor();

  t.diagnostic('phase: WM_CLOSE refuses unknown notebook publication');
  const closeAlert = page.getByRole('alert').filter({ hasText: '入力を確定または取り消し、保存を確認してから終了してください。' });
  // Observe the actual window event without adding another close handler. The
  // onCloseRequested convenience wrapper would destroy the window unless its
  // own event were prevented, so use the side-effect-free event listener.
  await page.evaluate(async () => {
    const state = window as unknown as { __p1CloseEvents?: number; __p1CloseUnlisten?: () => void };
    const moduleUrl = '/node_modules/@tauri-apps/api/window.js';
    const { getCurrentWindow } = await import(/* @vite-ignore */ moduleUrl);
    state.__p1CloseEvents = 0;
    state.__p1CloseUnlisten = await getCurrentWindow().listen('tauri://close-requested', () => { state.__p1CloseEvents = (state.__p1CloseEvents ?? 0) + 1; });
  });
  app.requestWindowClose();
  await page.waitForFunction(() => (window as unknown as { __p1CloseEvents?: number }).__p1CloseEvents === 1);
  await closeAlert.waitFor();
  await page.waitForTimeout(500);
  assert.equal(app.appRunning(), true); assert.equal(app.sidecarRunning(), true);
  assert.equal((await app.api.request('GET', '/health')).ok, true);
  await page.evaluate(() => {
    const state = window as unknown as { __p1CloseUnlisten?: () => void; __p1CloseEvents?: number };
    state.__p1CloseUnlisten?.(); delete state.__p1CloseUnlisten; delete state.__p1CloseEvents;
  });

  t.diagnostic('phase: retry identical publication and open exactly the created notebook');
  const retried = page.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/publish' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '作成を再試行', exact: true }).click();
  const publicationReply = await retried; assert.equal(publicationReply.status(), 200);
  const resent = publicationReply.request().postDataJSON() as PublicationRequest;
  assert.deepEqual(resent, publication.request);
  assert.equal(resent.publication.libraryBatch.id, publication.request.publication.libraryBatch.id);
  const retriedResult = await publicationReply.json() as { status: string; receipt: BatchReceipt };
  assert.equal(retriedResult.status, 'durable'); assert.deepEqual(retriedResult.receipt, publication.receipt);
  await page.getByLabel('ノート書き込みレイヤー', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), publication.documentId);
  await page.getByRole('button', { name: '資料一覧', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'P1 recovered notebook', exact: true }).count(), 1);

  t.diagnostic('phase: real Tauri and sidecar exit after durable recovery');
  app.requestWindowClose();
  await waitFor(() => !app.appRunning(), 'Tauri process exit', 30_000, 200);
  await waitFor(async () => !app.sidecarRunning() && !await isListening(SIDECAR_PORT), 'sidecar shutdown', 30_000, 200);
});
