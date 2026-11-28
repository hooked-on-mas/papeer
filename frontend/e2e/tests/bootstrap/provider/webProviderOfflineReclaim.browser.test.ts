import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';
import { createCompositionDrive, installBrowserDriveBoundary } from '../../../support/provider/fakeDrive.ts';
import type { OfflineOwnerFixture } from '../../../fixtures/provider/offlineOwner.tsx';

for (const engine of ['chromium', 'webkit'] as const) test(`online authenticated offline grant retirement (${engine})`, { timeout: 180_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '../../../..'), scratch = await mkdtemp(path.join(tmpdir(), 'papeer-reclaim-'));
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), cacheDir: path.join(scratch, 'cache'),
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  const context = await browser.newContext(), errors: string[] = []; await installBrowserDriveBoundary(context, createCompositionDrive(), 'reclaim');
  const page = await context.newPage(); page.setDefaultTimeout(25_000); page.on('pageerror', error => errors.push(String(error)));
  t.after(async () => { try { await context.close(); } finally { try { await browser.close(); } finally { try { await server.close(); } finally {
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir())); await rm(scratch, { recursive: true, force: true });
  } } } });
  await page.goto(`http://127.0.0.1:${address.port}/e2e/fixtures/provider/offlineOwner.html`);
  const expand = page.getByRole('button', { name: 'Google Driveを使う', exact: true }), connect = page.getByRole('button', { name: 'Googleに接続', exact: true });
  await expand.or(connect).first().waitFor(); if (await expand.isVisible()) await expand.click(); await connect.click();
  await page.getByLabel('新しいクラウドライブラリの名前').fill('Reclaim Library');
  await page.getByRole('button', { name: 'クラウドライブラリを作成', exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.ready(), undefined, { timeout: 30_000 });
  const secret = 'synthetic-passphrase-42', requestId = crypto.randomUUID();
  const note = await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.createNote('Reclaim note', 'Unchanged online content'));
  const queued = await page.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.onlinePendingEdit(id, 'Queued online content'), note);
  assert.equal(queued.receipt?.durable, true); assert.equal(queued.receipt?.upload, 'pending');
  const pendingBefore = queued.pending.filter(record => record.batch.id === queued.version); assert.equal(pendingBefore.length, 1);
  assert.deepEqual(await page.evaluate(({ secret, requestId }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.enroll(secret, requestId), { secret, requestId }), { requestId, status: 'accepted' });
  assert.deepEqual(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.recover(secret), secret), { requestId, status: 'accepted' });
  // Two actual factories in the same origin/storage partition compete for the existing Web Lock.
  const beforeSecondOwner = await page.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultRowHash(id), requestId);
  const rival = await context.newPage(); rival.setDefaultTimeout(25_000); rival.on('pageerror', error => errors.push(String(error)));
  try {
    await rival.goto(`http://127.0.0.1:${address.port}/e2e/fixtures/provider/offlineOwner.html`);
    const expandRival = rival.getByRole('button', { name: 'Google Driveを使う', exact: true }), connectRival = rival.getByRole('button', { name: 'Googleに接続', exact: true });
    await expandRival.or(connectRival).first().waitFor(); if (await expandRival.isVisible()) await expandRival.click(); await connectRival.click();
    await rival.getByRole('alert').filter({ hasText: 'このブラウザーの別のタブでGoogle Driveのライブラリを開いています。' }).waitFor();
    await assert.rejects(rival.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.reclaim(secret), secret));
  } finally { await rival.close(); }
  assert.equal(await page.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultRowHash(id), requestId), beforeSecondOwner);
  const counter = await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultCounter());
  await assert.rejects(page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.reclaim('wrong-synthetic-passphrase')));
  assert.deepEqual(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.recover(secret), secret), { requestId, status: 'accepted' });
  assert.deepEqual(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.reclaim(secret), secret), { status: 'revoked' });
  assert.equal(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.recover(secret), secret), null);
  assert.equal(await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultCounter()), counter);
  assert.deepEqual(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.reclaim(secret), secret), { status: 'revoked' });
  // The crypto result is genuinely produced, then held before the real enrollment can write its pending row.
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.holdNextGrantSeal());
  const racedId = crypto.randomUUID(), racing = page.evaluate(({ secret, requestId }) =>
    (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.enroll(secret, requestId), { secret, requestId: racedId });
  void racing.catch(() => undefined);
  try {
    await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.waitSeal());
    assert.deepEqual(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.reclaim(secret), secret), { status: 'unknown' });
    const blockedId = crypto.randomUUID();
    assert.deepEqual(await page.evaluate(({ secret, requestId }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.enroll(secret, requestId), { secret, requestId: blockedId }), { requestId: blockedId, status: 'rejected' });
  } finally { await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.releaseSeal()); }
  assert.deepEqual(await racing, { requestId: racedId, status: 'unknown' });
  assert.deepEqual(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.reclaim(secret), secret), { status: 'revoked' });
  assert.equal(await page.evaluate(({ id }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.hasVaultRow(id, 'pending'), { id: racedId }), false);
  assert.equal(await page.evaluate(({ id }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.hasVaultRow(id, 'grant'), { id: racedId }), false);
  const laterId = crypto.randomUUID();
  assert.deepEqual(await page.evaluate(({ secret, requestId }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.enroll(secret, requestId), { secret, requestId: laterId }), { requestId: laterId, status: 'accepted' });
  assert.ok(BigInt(await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultCounter())) > BigInt(counter));
  // Synthetic private vault rows exercise retired selector metadata; they do not impersonate historical provider admission.
  const seed = (kind: 'grant' | 'pending', variant: 'same' | 'other-account' | 'other-library' | 'other-principal') => page.evaluate(({ secret, sourceId, kind, variant }) =>
    (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.seedRetiredVaultRow(secret, sourceId, kind, variant), { secret, sourceId: laterId, kind, variant });
  const staleGrant = await seed('grant', 'same'), stalePending = await seed('pending', 'same');
  const otherAccount = await seed('grant', 'other-account'), otherLibrary = await seed('grant', 'other-library'), otherPrincipal = await seed('grant', 'other-principal');
  const has = (id: string, kind: 'grant' | 'pending') => page.evaluate(({ id, kind }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.hasVaultRow(id, kind), { id, kind });
  const seededCounter = await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultCounter());
  await assert.rejects(page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.reclaim('wrong-synthetic-passphrase')));
  assert.equal(await has(staleGrant, 'grant'), true); assert.equal(await has(stalePending, 'pending'), true); assert.equal(await has(laterId, 'grant'), true);
  assert.deepEqual(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.reclaimAfterCommitSignalLoss(secret), secret), { result: { status: 'unknown' }, observed: true });
  assert.equal(await has(staleGrant, 'grant'), false); assert.equal(await has(stalePending, 'pending'), false); assert.equal(await has(laterId, 'grant'), false);
  assert.equal(await has(otherAccount, 'grant'), true); assert.equal(await has(otherLibrary, 'grant'), true); assert.equal(await has(otherPrincipal, 'grant'), true);
  assert.equal(await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultCounter()), seededCounter);
  assert.deepEqual(await page.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.reclaim(secret), secret), { status: 'revoked' });
  assert.equal((await page.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.onlineRead(id), note))?.content, 'Queued online content');
  assert.deepEqual(await page.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.onlinePending(id), queued.version), pendingBefore);
  await page.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.close());
  assert.deepEqual(errors, []);
});

for (const engine of ['chromium', 'webkit'] as const) test(`an actually admitted B owner cannot reclaim A's sealed permission (${engine})`, { timeout: 180_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '../../../..'), scratch = await mkdtemp(path.join(tmpdir(), 'papeer-reclaim-b-'));
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), cacheDir: path.join(scratch, 'cache'),
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  const drive = createCompositionDrive(), errors: string[] = [], contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  t.after(async () => { try { await Promise.allSettled(contexts.map(context => context.close())); } finally { try { await browser.close(); } finally { try { await server.close(); } finally {
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir())); await rm(scratch, { recursive: true, force: true });
  } } } });
  const origin = `http://127.0.0.1:${address.port}`, first = await browser.newContext(); contexts.push(first);
  await installBrowserDriveBoundary(first, drive, 'principal-a'); const a = await first.newPage(); a.setDefaultTimeout(25_000); a.on('pageerror', error => errors.push(String(error)));
  await a.goto(`${origin}/e2e/fixtures/provider/offlineOwner.html`);
  const connect = async (page: typeof a) => { const expand = page.getByRole('button', { name: 'Google Driveを使う', exact: true }), button = page.getByRole('button', { name: 'Googleに接続', exact: true });
    await expand.or(button).first().waitFor(); if (await expand.isVisible()) await expand.click(); await button.click(); };
  const create = async (page: typeof a, title: string) => { await connect(page); await page.getByLabel('新しいクラウドライブラリの名前').fill(title);
    await page.getByRole('button', { name: 'クラウドライブラリを作成', exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.ready(), undefined, { timeout: 30_000 }); };
  const secret = 'synthetic-passphrase-42', requestId = crypto.randomUUID(); await create(a, 'A private Library');
  assert.deepEqual(await a.evaluate(({ secret, requestId }) => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.enroll(secret, requestId), { secret, requestId }), { requestId, status: 'accepted' });
  const before = await a.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultRowHash(id), requestId);
  const counter = await a.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultCounter());
  await a.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.close());
  const storageState = await first.storageState({ indexedDB: true }); await first.close();
  const second = await browser.newContext({ storageState }); contexts.push(second);
  const driveB = { ...drive, async request(input: Parameters<typeof drive.request>[0], client: string) {
    const result = await drive.request(input, client);
    if (new URL(input.url).pathname === '/drive/v3/about') return { ...result, bodyBase64: Buffer.from(JSON.stringify({ user: { permissionId: 'fixture-distinct-google-principal-b' } })).toString('base64') };
    return result;
  } };
  await installBrowserDriveBoundary(second, driveB, 'principal-b'); const b = await second.newPage(); b.setDefaultTimeout(25_000); b.on('pageerror', error => errors.push(String(error)));
  await b.goto(`${origin}/e2e/fixtures/provider/offlineOwner.html`); await create(b, 'B private Library');
  assert.deepEqual(await b.evaluate(secret => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.reclaim(secret), secret), { status: 'revoked' });
  assert.equal(await b.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultRowHash(id), requestId), before);
  assert.equal(await b.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.vaultCounter()), counter);
  const note = await b.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.createNote('B still writes', 'B remains active'));
  assert.equal((await b.evaluate(id => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.onlineRead(id), note))?.content, 'B remains active');
  await b.evaluate(() => (window as unknown as { offlineOwner: OfflineOwnerFixture }).offlineOwner.close()); assert.deepEqual(errors, []);
});
