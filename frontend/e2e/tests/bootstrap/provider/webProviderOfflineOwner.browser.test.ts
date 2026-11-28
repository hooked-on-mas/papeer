import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright-core';
import { createCompositionDrive, installBrowserDriveBoundary } from '../../../support/provider/fakeDrive.ts';
import type { OfflineOwnerFixture } from '../../../fixtures/provider/offlineOwner.tsx';

for (const engine of ['chromium', 'webkit'] as const) test(`provider cold offline owner and retained outbox (${engine})`, { timeout: 300_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '../../../..');
  const scratch = await mkdtemp(path.join(tmpdir(), 'papeer-offline-owner-'));
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), cacheDir: path.join(scratch, 'cache'),
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  let context: BrowserContext | undefined;
  t.after(async () => { try { await context?.close(); } finally { try { await server.close(); } finally {
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir())); assert.ok(path.basename(scratch).startsWith('papeer-offline-owner-'));
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } } });
  await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`, profile = path.join(scratch, 'profile'), drive = createCompositionDrive();
  const external: string[] = [], errors: string[] = [], secret = 'synthetic-passphrase-42';
  const launch = async (cold: boolean) => {
    context = engine === 'chromium' ? await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true }) : await webkit.launchPersistentContext(profile, { headless: true });
    if (cold) await context.route('**/*', route => { const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.origin + url.pathname); return route.abort(); } return route.continue(); });
    else await installBrowserDriveBoundary(context, drive, 'web');
    const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(25_000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${origin}/e2e/fixtures/provider/offlineOwner.html${cold ? '?cold=1' : ''}`);
    await page.waitForFunction(() => !!(window as unknown as { offlineOwner?: unknown }).offlineOwner);
    return page;
  };
  let page: Page | undefined, phase = 'initial-online-start';
  const connect = async (active: Page) => {
    const expand = active.getByRole('button', { name: 'Google Driveを使う', exact: true });
    const button = active.getByRole('button', { name: 'Googleに接続', exact: true });
    await expand.or(button).first().waitFor({ timeout: 25_000 });
    if (await expand.isVisible()) await expand.click();
    await button.click();
  };
  try {
  page = await launch(false);
  await connect(page);
  await page.getByLabel('新しいクラウドライブラリの名前').fill('Synthetic offline Library');
  await page.getByRole('button', { name: 'クラウドライブラリを作成', exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.ready(), undefined, { timeout: 30_000 });
  const note = await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.createNote('Synthetic note', 'Online base'));
  const requestId = crypto.randomUUID();
  assert.equal(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.recover(secret), secret), null);
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.abortNextGrantAdd());
  const pending = await page.evaluate(({ secret, requestId }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.enroll(secret, requestId), { secret, requestId });
  assert.deepEqual(pending, { requestId, status: 'unknown' });
  assert.equal(await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.restoreGrantAdd()), true);
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.close());
  await context!.close(); context = undefined;

  phase = 'cold-online-recovery'; page = await launch(false);
  await connect(page);
  await page.getByRole('button', { name: 'Driveの一覧を更新', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic offline Library', exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.ready(), undefined, { timeout: 30_000 });
  await assert.rejects(page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.recover('incorrect-passphrase-000')));
  assert.deepEqual(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.recover(secret), secret), { requestId, status: 'pending' });
  const enrolled = await page.evaluate(({ secret, requestId }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.enroll(secret, requestId), { secret, requestId });
  assert.deepEqual(enrolled, { requestId, status: 'accepted' });
  assert.deepEqual(await page.evaluate(({ secret, requestId }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.enroll(secret, requestId), { secret, requestId }), enrolled);
  const duplicateId = crypto.randomUUID();
  assert.deepEqual(await page.evaluate(({ secret, requestId }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.enroll(secret, requestId), { secret, requestId: duplicateId }), { requestId: duplicateId, status: 'rejected' });
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.close());
  await context!.close(); context = undefined;

  phase = 'first-offline-open'; page = await launch(true);
  await assert.rejects(page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.unlock('incorrect-passphrase-000')));
  const unlocked = await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.unlock(secret), secret);
  assert.deepEqual(unlocked, { title: 'Synthetic offline Library', count: 1 });
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.open());
  assert.equal(await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.replicationDenied()), true);
  const saved = await page.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.edit(id, 'Offline durable body'), note);
  assert.equal(saved.accepted?.content, 'Offline durable body'); assert.equal(saved.receipt?.durable, true); assert.equal(saved.receipt?.upload, 'pending');
  assert.equal(saved.pending.filter(record => record.batch.id === saved.version).length, 1);
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.close());
  await context!.close(); context = undefined;

  phase = 'second-offline-open'; page = await launch(true);
  await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.unlock(secret), secret);
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.open());
  const restored = await page.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.read(id), note);
  assert.equal(restored.accepted?.content, 'Offline durable body'); assert.equal(restored.accepted?.version, saved.version);
  assert.equal(restored.pending.filter(record => record.batch.id === saved.version).length, 1);
  assert.equal(await page.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.rawBatchCount(id), saved.version), 1);
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.revoke());
  assert.equal(await page.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.rawBatchCount(id), saved.version), 1);
  assert.equal(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.unlockCount(secret), secret), 0);
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.lock());
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.close());
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  } catch (error) {
    t.diagnostic(`offline owner failure phase: ${phase}`);
    if (page && !page.isClosed()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const details = await Promise.race([page.evaluate(() => ({ readyState: document.readyState, visibility: document.visibilityState,
          buttons: [...document.querySelectorAll('button')].slice(0, 30).map(button => ({ text: button.textContent?.trim().slice(0, 100), disabled: button.disabled })),
          messages: [...document.querySelectorAll('[role="status"],[role="alert"]')].slice(0, 12).map(node => node.textContent?.trim().slice(0, 150)) })),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic timeout')), 2_000); })]);
        t.diagnostic(`offline owner UI: ${JSON.stringify(details)}`);
      } catch (failure) { t.diagnostic(`offline owner UI unavailable: ${String(failure)}`); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
    throw error;
  }
});
