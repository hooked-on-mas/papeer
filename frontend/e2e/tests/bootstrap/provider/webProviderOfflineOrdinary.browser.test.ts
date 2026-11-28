import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright-core';
import type { StoredEdit } from '../../../../src/runtime/edits/repository.ts';
import { createCompositionDrive, installBrowserDriveBoundary } from '../../../support/provider/fakeDrive.ts';

const frontend = path.resolve(import.meta.dirname, '../../../..');
const secret = 'synthetic ordinary offline passphrase';
async function records(page: Page, targetId: string) {
  return page.evaluate(async targetId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('papeer-shared-cloud-v1');
      r.onupgradeneeded = () => { r.transaction?.abort(); reject(new Error('existing provider cache required')); };
      r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
    });
    try { return await new Promise<StoredEdit[]>((resolve, reject) => {
      const tx = db.transaction('edits', 'readonly'), request = tx.objectStore('edits').getAll();
      tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve(request.result
        .map((row: { value: StoredEdit }) => row.value).filter((row: StoredEdit) => row.batch.targetId === targetId));
    }); } finally { db.close(); }
  }, targetId);
}
async function peer(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('papeer-shared-cloud-v1');
      r.onupgradeneeded = () => { r.transaction?.abort(); reject(new Error('existing provider cache required')); };
      r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
    });
    try { return await new Promise<string>((resolve, reject) => {
      const tx = db.transaction('canonicalPeers', 'readonly'), request = tx.objectStore('canonicalPeers').getAll();
      tx.onabort = () => reject(tx.error); tx.oncomplete = () => {
        const values = request.result.map((row: { value?: { peerId?: unknown } }) => row.value?.peerId);
        if (values.length !== 1 || typeof values[0] !== 'string') reject(new Error('expected one admitted peer'));
        else resolve(values[0]);
      };
    }); } finally { db.close(); }
  });
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, name: string, budget = 30_000) {
  const end = Date.now() + budget;
  for (;;) { const value = await read(); if (predicate(value)) return value;
    assert.ok(Date.now() < end, `${name} did not settle`); await delay(50); }
}
async function connect(page: Page) {
  const expand = page.getByRole('button', { name: 'Google Driveを使う', exact: true });
  const connect = page.getByRole('button', { name: 'Googleに接続', exact: true });
  await expand.or(connect).first().waitFor({ timeout: 25_000 });
  if (await expand.isVisible()) await expand.click();
  await connect.click();
}
async function unlock(page: Page, title: string) {
  const panel = page.getByRole('region', { name: '端末でのオフライン利用' });
  const input = panel.getByLabel('端末のパスフレーズ');
  const expand = panel.getByRole('button', { name: '端末で開く', exact: true });
  await expand.or(input).first().waitFor({ timeout: 25_000 });
  if (await expand.isVisible() && !await input.isVisible()) await expand.click();
  await input.fill(secret); await input.press('Enter');
  await panel.getByRole('button', { name: title, exact: true }).click();
  await page.getByText('Google Drive（オフライン）', { exact: true }).waitFor();
}
async function openNote(page: Page, title: string) {
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
}
async function visibleText(page: Page) {
  return page.getByRole('textbox', { name: 'Markdownノート', exact: true }).locator('.cm-line')
    .evaluateAll(lines => lines.map(line => line.textContent ?? '').join('\n'));
}
/** Diagnostic only: inspect the committed Bootstrap's existing objects; do not create a session or perform repository I/O. */
async function guardEvidence(page: Page) {
  return page.evaluate(() => {
    type Fiber = { type?: { name?: string }; memoizedProps?: { session?: Bootstrap }; child?: Fiber; sibling?: Fiber };
    type Snapshot = { phase?: string; locked?: boolean; ready?: boolean; active?: boolean; unhandledTargets?: unknown[]; busy?: boolean; pendingGuard?: boolean };
    type Sessions = { getSnapshot(): Snapshot; needsExitConfirmation(): boolean; scopeViewHeld(): boolean; heldTargets(): unknown[]; markdownDrafts?: { targets(): unknown[] } };
    type Bootstrap = { getSnapshot(): Snapshot; getRetainedRuntime(): { binding: { sessions: Sessions } } | null;
      getOfflineConnection(): { getSnapshot(): Snapshot } | null; getProviderConnection(): { getSnapshot(): Snapshot } | null };
    const root = document.getElementById('root') as (HTMLElement & Record<string, unknown>) | null;
    const key = root && Object.keys(root).find(value => value.startsWith('__reactContainer$'));
    const container = (key ? root?.[key] : undefined) as { stateNode?: { current?: Fiber } } | undefined;
    const stack = container?.stateNode?.current ? [container.stateNode.current] : []; let session: Bootstrap | undefined, count = 0;
    while (stack.length && count++ < 500) { const fiber = stack.pop()!;
      if (fiber.type?.name === 'BootstrapConnection' && fiber.memoizedProps?.session) { session = fiber.memoizedProps.session; break; }
      if (fiber.sibling) stack.push(fiber.sibling); if (fiber.child) stack.push(fiber.child);
    }
    if (!session) return { available: false, visited: count };
    const bootstrap = session.getSnapshot(), offline = session.getOfflineConnection()?.getSnapshot(), provider = session.getProviderConnection()?.getSnapshot();
    const registry = session.getRetainedRuntime()?.binding.sessions, state = registry?.getSnapshot();
    const safe = (fn: () => unknown) => { try { return fn(); } catch { return 'failed'; } };
    return { available: true, phase: bootstrap.phase, locked: bootstrap.locked,
      offline: offline ? { busy: offline.busy, pendingGuard: offline.pendingGuard } : null,
      provider: provider ? { phase: provider.phase, busy: provider.busy, pendingGuard: provider.pendingGuard } : null,
      registry: registry && state ? { ready: state.ready, active: state.active, unhandledCount: state.unhandledTargets?.length,
        heldCount: safe(() => registry.heldTargets().length), scopeViewHeld: safe(() => registry.scopeViewHeld()),
        draftCount: safe(() => registry.markdownDrafts?.targets().length ?? 0), needsExitConfirmation: safe(() => registry.needsExitConfirmation()) } : null };
  });
}
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary provider offline unlock, edit and reconnect (${engine})`, { timeout: 420_000 }, async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'papeer-offline-ui-'));
  const fontRoot = path.dirname(createRequire(import.meta.url).resolve('@fontsource-variable/geist/package.json'));
  const server = await createServer({ root: path.join(frontend, 'web'), configFile: path.join(frontend, 'vite.web.config.ts'),
    logLevel: 'error', cacheDir: path.join(scratch, 'vite'), server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [frontend, fontRoot] } } });
  await server.listen(); const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`, origin = new URL(url).origin, drive = createCompositionDrive();
  const contexts = new Set<BrowserContext>(), outside: string[] = [], errors: string[] = [], manifestDiagnostics: string[] = [];
  const observed = new WeakSet<Page>(); let phase = 'online-create', activePage: Page | undefined;
  const observePage = (page: Page) => {
    if (observed.has(page)) return; observed.add(page);
    page.on('pageerror', error => errors.push(error.stack ?? String(error)));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (message.text() === 'Manifest: Line: 1, column: 1, Syntax error.') manifestDiagnostics.push(message.text());
      else errors.push(`console.error: ${message.text()}`);
    });
  };
  const launch = async (profile: string, online: boolean, client: string) => {
    const options = { headless: true, viewport: { width: 1440, height: 1080 } };
    const context = engine === 'chromium' ? await chromium.launchPersistentContext(profile, { ...options, channel: 'msedge' })
      : await webkit.launchPersistentContext(profile, options);
    contexts.add(context);
    context.on('page', observePage);
    if (online) await installBrowserDriveBoundary(context, drive, client);
    else await context.route('**/*', async route => {
      const request = new URL(route.request().url());
      if (request.origin === origin || request.protocol === 'data:' || request.protocol === 'blob:') await route.continue();
      else { outside.push(`${request.protocol}//${request.host}${request.pathname}`); await route.abort(); }
    });
    const page = context.pages()[0] ?? await context.newPage(); observePage(page); activePage = page; page.setDefaultTimeout(25_000);
    await page.goto(url, { waitUntil: 'domcontentloaded' }); return { context, page };
  };
  const close = async (context: BrowserContext) => { await context.close(); contexts.delete(context); };
  const profileA = path.join(scratch, 'a'), profileB = path.join(scratch, 'b');
  const library = `Offline Library ${engine}`, note = `Offline note ${engine}`; let failed = false;
  try {
    let a = await launch(profileA, true, 'offline-a');
    await connect(a.page);
    await a.page.getByLabel('新しいクラウドライブラリの名前').fill(library);
    await a.page.getByRole('button', { name: 'クラウドライブラリを作成', exact: true }).click();
    await a.page.getByRole('button', { name: 'オフライン利用…', exact: true }).click();
    const panel = a.page.getByRole('region', { name: '端末でのオフライン利用' });
    await panel.getByText('この設定はアプリで開くときの確認に使います。資料自体は暗号化されません。', { exact: true }).waitFor();
    await panel.getByLabel('端末のパスフレーズ').fill(secret); await panel.getByLabel('端末のパスフレーズ').press('Enter');
    await panel.getByText('この端末での利用を許可しました。', { exact: true }).waitFor();
    await a.page.keyboard.press('Escape');
    await a.page.getByRole('dialog', { name: 'オフライン利用の設定', exact: true }).waitFor({ state: 'hidden' });
    await a.page.getByRole('button', { name: '新規', exact: true }).click();
    const createDialog = a.page.getByRole('dialog', { name: '新しい資料を作成', exact: true });
    await createDialog.getByLabel('新しい資料の名前', { exact: true }).fill(note);
    await createDialog.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
    await createDialog.getByRole('button', { name: '資料を作成', exact: true }).click();
    await createDialog.waitFor({ state: 'hidden' });
    const editor = a.page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
    const id = await a.page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
    await editor.fill('online initial'); await editor.blur();
    await until(() => records(a.page, id), rows => rows.some(row => row.receipt.durable && row.receipt.upload === 'accepted'), 'initial upload');
    phase = 'peer-join'; const b = await launch(profileB, true, 'offline-b'); await connect(b.page);
    await b.page.getByRole('button', { name: 'Driveの一覧を更新', exact: true }).click();
    await b.page.getByRole('button', { name: library, exact: true }).click();
    await b.page.getByRole('button', { name: 'オフライン利用…', exact: true }).waitFor();
    await openNote(b.page, note);
    const peerB = await peer(b.page);
    await until(() => visibleText(b.page), value => value === 'online initial', 'peer initial content');
    const before = new Set((await records(a.page, id)).map(row => row.batch.id)); await close(a.context);
    phase = 'cold-unlock'; a = await launch(profileA, false, 'unused'); await unlock(a.page, library); await openNote(a.page, note);
    const coldEditor = a.page.getByRole('textbox', { name: 'Markdownノート', exact: true });
    assert.equal(await visibleText(a.page), 'online initial');
    await coldEditor.fill('offline durable edit'); await coldEditor.blur();
    const offlineRows = await until(() => records(a.page, id), rows => rows.some(row => !before.has(row.batch.id) && row.receipt.durable && row.receipt.upload === 'pending'), 'offline durable outbox');
    const edit = offlineRows.find(row => !before.has(row.batch.id) && row.receipt.durable && row.receipt.upload === 'pending'); assert.ok(edit);
    assert.deepEqual(outside, []); await close(a.context);
    phase = 'cold-reopen'; a = await launch(profileA, false, 'unused'); await unlock(a.page, library); await openNote(a.page, note);
    assert.equal(await visibleText(a.page), 'offline durable edit');
    assert.equal((await records(a.page, id)).filter(row => row.batch.id === edit.batch.id && row.receipt.upload === 'pending').length, 1);
    assert.deepEqual(outside, []); await close(a.context);
    phase = 'fresh-online-reconnect'; a = await launch(profileA, true, 'offline-a-reconnect'); await unlock(a.page, library);
    await openNote(a.page, note); assert.equal(await visibleText(a.page), 'offline durable edit');
    await a.page.getByRole('toolbar', { name: 'Markdownノートの操作', exact: true }).getByRole('status')
      .filter({ hasText: /^端末保存済み・同期停止中（未送信の変更は保持されます）$/ }).waitFor({ timeout: 25_000 });
    await a.page.getByRole('button', { name: 'Googleへ再接続', exact: true }).click();
    await a.page.getByRole('textbox', { name: 'Markdownノート', exact: true }).focus();
    await connect(a.page);
    await until(() => records(a.page, id), rows => rows.some(row => row.batch.id === edit.batch.id && row.receipt.upload === 'accepted'), 'outbox upload');
    await until(() => records(b.page, id), rows => rows.some(row => row.batch.id === edit.batch.id && row.receipt.durable && row.receipt.importedBy.includes(peerB)), 'peer durable receipt');
    await until(() => visibleText(b.page), value => value === 'offline durable edit', 'peer content');
    assert.equal((await records(b.page, id)).filter(row => row.batch.id === edit.batch.id).length, 1);
    phase = 'online-permission-revocation';
    await a.page.getByRole('button', { name: 'オフライン利用…', exact: true }).click();
    const livePanel = a.page.getByRole('region', { name: '端末でのオフライン利用' });
    await livePanel.getByLabel('端末のパスフレーズ').fill(secret);
    await livePanel.getByRole('button', { name: 'このライブラリの端末利用の許可を取り消す', exact: true }).click();
    await livePanel.getByText('このライブラリの端末利用の許可を取り消しました。資料と未送信の変更は保持しています。', { exact: true }).waitFor();
    await a.page.keyboard.press('Escape');
    await a.page.getByRole('dialog', { name: 'オフライン利用の設定', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await visibleText(a.page), 'offline durable edit');
    assert.equal((await records(a.page, id)).filter(row => row.batch.id === edit.batch.id && row.receipt.upload === 'accepted').length, 1);

  } catch (error) {
    failed = true; t.diagnostic(`ordinary offline phase: ${phase}`);
    if (phase === 'fresh-online-reconnect') {
      if (activePage && !activePage.isClosed()) { let timer: ReturnType<typeof setTimeout> | undefined;
        try { const after = await Promise.race([guardEvidence(activePage), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('guard diagnostic timeout')), 2_000); })]);
          t.diagnostic(`reconnect post-failure guard: ${JSON.stringify(after)}`);
        } catch (diagnostic) { t.diagnostic(`reconnect guard unavailable: ${String(diagnostic)}`); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }
    }
    if (activePage && !activePage.isClosed()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const details = await Promise.race([activePage.evaluate(() => ({
          visibility: document.visibilityState, readyState: document.readyState,
          buttons: [...document.querySelectorAll('button')].slice(0, 30).map(button => ({ text: button.textContent?.trim().slice(0, 100), disabled: button.disabled })),
          messages: [...document.querySelectorAll('[role="status"],[role="alert"]')].slice(0, 12).map(node => node.textContent?.trim().slice(0, 150)),
        })), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic timeout')), 2_000); })]);
        t.diagnostic(`ordinary offline UI: ${JSON.stringify(details)}`);
      } catch (diagnostic) { t.diagnostic(`ordinary offline UI unavailable: ${String(diagnostic)}`); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
    throw error;
  }
  finally {
    const cleanup: unknown[] = [];
    for (const context of contexts) try { await context.close(); } catch (error) { cleanup.push(error); }
    try { await server.close(); } catch (error) { cleanup.push(error); }
    try { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { cleanup.push(error); }
    if (manifestDiagnostics.length) t.diagnostic(JSON.stringify({ sourceDevOnly: true,
      reason: 'webPwa emits manifest only during build; source dev server HTML fallback is not a built-PWA validation', manifestDiagnostics }));
    if (errors.length) cleanup.push(new Error(`unhandled browser errors: ${JSON.stringify(errors)}`));
    if (cleanup.length) { const message = `cleanup failures: ${cleanup.map(String).join('; ')}`; t.diagnostic(message); if (!failed) throw new Error(message); }
  }
});
