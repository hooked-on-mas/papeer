/** Shared harness for the ordinary-Web offline cases of work B9. Synthetic Google boundary only (createCompositionDrive); no real Google, user data or token. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit, type BrowserContext, type Page } from 'playwright-core';
import { build, createServer, preview } from 'vite';
import type { StoredEdit } from '../../../src/runtime/edits/repository.ts';
import { createCompositionDrive, installBrowserDriveBoundary } from './fakeDrive.ts';

export type Engine = 'chromium' | 'webkit';
export type Drive = ReturnType<typeof createCompositionDrive>;
type DriveRequest = Parameters<Drive['request']>[0];
type DriveReply = Awaited<ReturnType<Drive['request']>>;
export const passphrase = 'synthetic offline refusal passphrase';
const frontend = path.resolve(import.meta.dirname, '../../..');

/** A view of the same synthetic Drive. `principal` answers /about with another Google principal; `intercept` may answer a request itself (fault injection). */
export function driveView(drive: Drive, options: { principal?: string; intercept?: (input: DriveRequest, client: string) => DriveReply | undefined } = {}): Drive {
  return { ...drive, async request(input: DriveRequest, client: string) {
    const fault = options.intercept?.(input, client); if (fault) return fault;
    const result = await drive.request(input, client);
    if (options.principal && new URL(input.url).pathname === '/drive/v3/about' && input.method.toUpperCase() === 'GET')
      return { ...result, bodyBase64: Buffer.from(JSON.stringify({ user: { permissionId: options.principal } })).toString('base64') };
    return result;
  } };
}

export type World = Awaited<ReturnType<typeof openWorld>>;
export async function openWorld(t: TestContext, engine: Engine, prefix: string, options: { built?: boolean } = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), `papeer-b9-${prefix}-`));
  const fontRoot = path.dirname(createRequire(import.meta.url).resolve('@fontsource-variable/geist/package.json'));
  const dist = path.join(scratch, 'dist');
  // built: a real production build of the ordinary Web entry (own output folder; frontend/web-dist is never touched), served by `vite preview`.
  if (options.built) await build({ configFile: path.join(frontend, 'vite.web.config.ts'), logLevel: 'error', build: { outDir: dist, emptyOutDir: true } });
  const server = options.built
    ? await preview({ configFile: path.join(frontend, 'vite.web.config.ts'), logLevel: 'error', build: { outDir: dist },
      preview: { host: '127.0.0.1', port: 0, strictPort: false } })
    : await createServer({ root: path.join(frontend, 'web'), configFile: path.join(frontend, 'vite.web.config.ts'), logLevel: 'error',
      cacheDir: path.join(scratch, 'vite'), server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [frontend, fontRoot] } } });
  if ('listen' in server) await server.listen();
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/`, origin = new URL(url).origin, drive = createCompositionDrive();
  const contexts = new Set<BrowserContext>(), outside: string[] = [], errors: string[] = [], manifestDiagnostics: string[] = [];
  const observed = new WeakSet<Page>(); let activePage: Page | undefined, serverStopped = false;
  const observePage = (page: Page) => {
    if (observed.has(page)) return; observed.add(page);
    page.on('pageerror', error => errors.push(error.stack ?? String(error)));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (message.text() === 'Manifest: Line: 1, column: 1, Syntax error.') manifestDiagnostics.push(message.text());
      else errors.push(`console.error: ${message.text()}`);
    });
  };
  t.after(async () => {
    const cleanup: unknown[] = [];
    for (const context of contexts) try { await context.close(); } catch (error) { cleanup.push(error); }
    if (!serverStopped) try { await server.close(); } catch (error) { cleanup.push(error); }
    try { assert.equal(path.dirname(path.resolve(scratch)), path.resolve(tmpdir())); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (error) { cleanup.push(error); }
    if (manifestDiagnostics.length) t.diagnostic(JSON.stringify({ sourceDevOnly: !options.built, manifestDiagnostics }));
    if (errors.length) cleanup.push(new Error(`unhandled browser errors: ${JSON.stringify(errors)}`));
    if (cleanup.length) throw new Error(`cleanup failures: ${cleanup.map(String).join('; ')}`);
  });
  /** online: all Drive traffic goes to the synthetic Drive. offline: any request outside the app origin is recorded in `outside` and aborted. */
  const launch = async (profile: string, mode: 'online' | 'offline', client: string, view: Drive = drive, query = '') => {
    const launchOptions = { headless: true, viewport: { width: 1440, height: 1080 } };
    const context = engine === 'chromium' ? await chromium.launchPersistentContext(profile, { ...launchOptions, channel: 'msedge' })
      : await webkit.launchPersistentContext(profile, launchOptions);
    contexts.add(context); context.on('page', observePage);
    if (mode === 'online') await installBrowserDriveBoundary(context, view, client);
    else await context.route('**/*', async route => {
      const request = new URL(route.request().url());
      if (request.origin === origin || request.protocol === 'data:' || request.protocol === 'blob:') await route.continue();
      else { outside.push(`${request.protocol}//${request.host}${request.pathname}`); await route.abort(); }
    });
    const page = context.pages()[0] ?? await context.newPage(); observePage(page); activePage = page; page.setDefaultTimeout(25_000);
    await page.goto(url + query, { waitUntil: 'domcontentloaded' }); return { context, page };
  };
  /** The origin stops answering at all (a service worker is the only thing left that can serve the shell). */
  const stopServer = async () => { serverStopped = true; await server.close(); };
  const close = async (context: BrowserContext) => { await context.close(); contexts.delete(context); };
  const track = (context: BrowserContext) => { contexts.add(context); context.on('page', observePage); };
  /** Diagnostic only; never changes state. */
  const diagnose = async (t: TestContext, phase: string) => {
    t.diagnostic(`offline case phase: ${phase}`);
    if (!activePage || activePage.isClosed()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const details = await Promise.race([activePage.evaluate(() => ({ visibility: document.visibilityState, readyState: document.readyState,
        buttons: [...document.querySelectorAll('button')].slice(0, 30).map(button => ({ text: button.textContent?.trim().slice(0, 100), disabled: button.disabled })),
        messages: [...document.querySelectorAll('[role="status"],[role="alert"]')].slice(0, 12).map(node => node.textContent?.trim().slice(0, 150)) })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('diagnostic timeout')), 2_000); })]);
      t.diagnostic(`offline case UI: ${JSON.stringify(details)}`);
    } catch (diagnostic) { t.diagnostic(`offline case UI unavailable: ${String(diagnostic)}`); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  return { scratch, url, origin, drive, outside, errors, launch, close, track, diagnose, stopServer, engine, profile: (name: string) => path.join(scratch, name) };
}

export async function records(page: Page, targetId: string): Promise<StoredEdit[]> {
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
/** Raw vault rows of the cloud cache ('host-offline-v1' keys). Reads only. */
export async function vaultRows(page: Page): Promise<{ kind: string; id: string }[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('papeer-shared-cloud-v1');
      r.onupgradeneeded = () => { r.transaction?.abort(); reject(new Error('existing provider cache required')); };
      r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
    });
    try { return await new Promise<{ kind: string; id: string }[]>((resolve, reject) => {
      const tx = db.transaction('canonicalProviderArtifacts', 'readonly'), request = tx.objectStore('canonicalProviderArtifacts').getAll();
      tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve(request.result.flatMap((row: { key: string }) => {
        try { const key = JSON.parse(row.key); return Array.isArray(key) && key[0] === 'host-offline-v1' ? [{ kind: String(key[2]), id: String(key[3] ?? '') }] : []; } catch { return []; }
      }));
    }); } finally { db.close(); }
  });
}
/** Rows a test may damage in the cloud cache. `grant`/`header`/`counter` are the offline-vault rows ('host-offline-v1' keys); `peer` is the device peer row. */
export type DamageTarget = 'grant' | 'header' | 'counter' | 'peer';
/**
 * Test-side raw damage of the single row of `target`. The original row stays in `window.__b9Held[target]` of the same page, so `restoreRow` puts it back byte for byte.
 * `corrupt` flips the lowest bit of the first byte of the sealed bytes (grant ciphertext, header wrapped seed, counter MAC); `peer` can only be deleted.
 */
export async function damageRow(page: Page, target: DamageTarget, mode: 'delete' | 'corrupt'): Promise<void> {
  await page.evaluate(async ({ target, mode }) => {
    const w = window as unknown as { __b9Held?: Record<string, { store: string; key: string; row: unknown }> };
    w.__b9Held ??= {}; if (w.__b9Held[target]) throw new Error(`${target} already held`);
    if (target === 'peer' && mode === 'corrupt') throw new Error('peer rows are only deleted');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('papeer-shared-cloud-v1');
      r.onupgradeneeded = () => { r.transaction?.abort(); reject(new Error('existing provider cache required')); };
      r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
    });
    try {
      const storeName = target === 'peer' ? 'canonicalPeers' : 'canonicalProviderArtifacts';
      const rows = await new Promise<{ key: string; value: Record<string, number[]> }[]>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly'), request = tx.objectStore(storeName).getAll();
        tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve(request.result);
      });
      const matches = target === 'peer' ? rows : rows.filter(row => { try { const key = JSON.parse(row.key); return Array.isArray(key) && key[0] === 'host-offline-v1' && key[2] === target; } catch { return false; } });
      if (matches.length !== 1) throw new Error(`expected one ${target} row, found ${matches.length}`);
      const original = structuredClone(matches[0]); w.__b9Held[target] = { store: storeName, key: original.key, row: original };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite'), store = tx.objectStore(storeName);
        if (mode === 'delete') store.delete(original.key);
        else { const damaged = structuredClone(original), field = ({ grant: 'ciphertext', header: 'wrapped', counter: 'mac' } as Record<string, string>)[target];
          damaged.value[field][0] ^= 1; store.put(damaged); }
        tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve();
      });
    } finally { db.close(); }
  }, { target, mode });
}
export async function restoreRow(page: Page, target: DamageTarget): Promise<void> {
  await page.evaluate(async target => {
    const w = window as unknown as { __b9Held?: Record<string, { store: string; key: string; row: unknown }> };
    const held = w.__b9Held?.[target]; if (!held) throw new Error(`no held ${target}`);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('papeer-shared-cloud-v1');
      r.onupgradeneeded = () => { r.transaction?.abort(); reject(new Error('existing provider cache required')); };
      r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
    });
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(held.store, 'readwrite'); tx.objectStore(held.store).put(held.row);
      tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve();
    }); } finally { db.close(); }
    delete w.__b9Held![target];
  }, target);
}
export async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, name: string, budget = 30_000) {
  const end = Date.now() + budget;
  for (;;) { const value = await read(); if (predicate(value)) return value;
    assert.ok(Date.now() < end, `${name} did not settle`); await delay(50); }
}
export async function connect(page: Page) {
  const expand = page.getByRole('button', { name: 'Google Driveを使う', exact: true });
  const button = page.getByRole('button', { name: 'Googleに接続', exact: true });
  await expand.or(button).first().waitFor({ timeout: 25_000 });
  if (await expand.isVisible()) await expand.click();
  await button.click();
}
export const offlinePanel = (page: Page) => page.getByRole('region', { name: '端末でのオフライン利用' });
export async function ensureOfflinePanelOpen(page: Page) {
  const input = offlinePanel(page).getByLabel('端末のパスフレーズ');
  if (await input.isVisible()) return;
  const openDialog = page.getByRole('button', { name: 'オフライン利用…', exact: true });
  if (await openDialog.isVisible()) { await openDialog.click(); await input.waitFor(); return; }
  const expand = offlinePanel(page).getByRole('button', { name: '端末で開く', exact: true });
  await expand.or(input).first().waitFor({ timeout: 25_000 });
  if (await expand.isVisible()) { await expand.click(); }
  await input.waitFor();
}
/** Type the passphrase and press Enter; does not click any Library. */
export async function submitSecret(page: Page, secret: string) {
  await ensureOfflinePanelOpen(page);
  const input = offlinePanel(page).getByLabel('端末のパスフレーズ');
  await input.fill(secret); await input.press('Enter');
}
export async function unlock(page: Page, title: string, secret = passphrase) {
  await submitSecret(page, secret);
  await offlinePanel(page).getByRole('button', { name: title, exact: true }).click();
  await page.getByText('Google Drive（オフライン）', { exact: true }).waitFor();
}
export async function openNote(page: Page, title: string) {
  const catalog = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await catalog.getAttribute('aria-expanded') !== 'true') await catalog.click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
}
export async function visibleText(page: Page) {
  return page.getByRole('textbox', { name: 'Markdownノート', exact: true }).locator('.cm-line')
    .evaluateAll(lines => lines.map(line => line.textContent ?? '').join('\n'));
}
export async function fillNote(page: Page, text: string) {
  const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.fill(text); await editor.blur();
}
export const passwordFieldsEmpty = (page: Page) => page.locator('input[type=password]')
  .evaluateAll(inputs => inputs.every(input => (input as HTMLInputElement).value.length === 0));

/** Online as A: connect, create a Library, enroll this device (passphrase), create a Markdown note with `base` text and wait for its durable upload. */
export async function createEnrolledLibrary(page: Page, library: string, note: string, base: string, secret = passphrase) {
  await connect(page);
  await page.getByLabel('新しいクラウドライブラリの名前').fill(library);
  await page.getByRole('button', { name: 'クラウドライブラリを作成', exact: true }).click();
  await page.getByRole('button', { name: 'オフライン利用…', exact: true }).waitFor();
  await submitSecret(page, secret);
  await offlinePanel(page).getByText('この端末での利用を許可しました。', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'オフライン利用の設定', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '新規', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: '新しい資料を作成', exact: true });
  await createDialog.getByLabel('新しい資料の名前', { exact: true }).fill(note);
  await createDialog.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
  await createDialog.getByRole('button', { name: '資料を作成', exact: true }).click();
  await createDialog.waitFor({ state: 'hidden' });
  await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
  const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
  await fillNote(page, base);
  await until(() => records(page, id), rows => rows.some(row => row.receipt.durable && row.receipt.upload === 'accepted'), 'initial upload');
  return id;
}

/** What a person can see right now (read only; used for assertions and diagnostics). */
export async function uiSnapshot(page: Page) {
  return page.evaluate(() => ({
    alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent?.trim().slice(0, 150) ?? ''),
    statuses: [...document.querySelectorAll('[role="status"]')].map(node => node.textContent?.trim().slice(0, 150) ?? ''),
    buttons: [...document.querySelectorAll('button')].filter(button => !button.closest('[hidden]')).map(button => `${button.textContent?.trim().slice(0, 60) ?? ''}${button.disabled ? ' (disabled)' : ''}`),
    editors: document.querySelectorAll('[aria-label="Markdownノート"]').length,
    offlineHeader: [...document.querySelectorAll('span')].some(node => node.textContent === 'Google Drive（オフライン）'),
    passwordValues: [...document.querySelectorAll('input[type=password]')].map(input => (input as HTMLInputElement).value.length),
  }));
}

/**
 * Standard starting point: A (online) creates an enrolled Library with one Markdown note (`base` text, uploaded), the profile is closed, then a cold offline start
 * unlocks it and saves `offlineText` (a durable, still-pending outbox batch). Both contexts are closed afterwards.
 */
export async function prepareOfflineEdit(w: World, profile: string, library: string, note: string, base: string, offlineText: string) {
  let a = await w.launch(profile, 'online', 'prepare-a');
  const id = await createEnrolledLibrary(a.page, library, note, base);
  const before = new Set((await records(a.page, id)).map(row => row.batch.id));
  await w.close(a.context);
  a = await w.launch(profile, 'offline', 'unused'); await unlock(a.page, library); await openNote(a.page, note);
  await fillNote(a.page, offlineText);
  const rows = await until(() => records(a.page, id), values => values.some(row => !before.has(row.batch.id) && row.receipt.durable && row.receipt.upload === 'pending'), 'offline durable outbox');
  const edit = rows.find(row => !before.has(row.batch.id) && row.receipt.durable && row.receipt.upload === 'pending'); assert.ok(edit);
  assert.deepEqual(w.outside, []); await w.close(a.context);
  return { id, edit, before };
}

/** Stash the retained runtime of the committed Bootstrap in `window.__b9Runtime` so that a later call can prove a retired runtime can no longer write. Reads the React tree only. */
export async function stashRetainedRuntime(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    type Fiber = { type?: { name?: string }; memoizedProps?: { session?: { getRetainedRuntime(): unknown } }; child?: Fiber; sibling?: Fiber };
    const root = document.getElementById('root') as (HTMLElement & Record<string, unknown>) | null;
    const key = root && Object.keys(root).find(value => value.startsWith('__reactContainer$'));
    const container = (key ? root?.[key] : undefined) as { stateNode?: { current?: Fiber } } | undefined;
    const stack = container?.stateNode?.current ? [container.stateNode.current] : []; let count = 0;
    while (stack.length && count++ < 800) {
      const fiber = stack.pop()!;
      if (fiber.type?.name === 'BootstrapConnection' && fiber.memoizedProps?.session) {
        const runtime = fiber.memoizedProps.session.getRetainedRuntime(); if (!runtime) return false;
        (window as unknown as { __b9Runtime?: unknown }).__b9Runtime = runtime; return true;
      }
      if (fiber.sibling) stack.push(fiber.sibling); if (fiber.child) stack.push(fiber.child);
    }
    return false;
  });
}
/** Try to write through the stashed (now retired) runtime. Returns what the product said; the caller asserts the effect on durable records. */
export async function writeThroughStashedRuntime(page: Page, id: string, text: string) {
  return page.evaluate(async ({ id, text }) => {
    type Markdown = { refresh(): Promise<boolean>; editText(text: string): boolean; flush(): Promise<void> };
    const runtime = (window as unknown as { __b9Runtime?: { binding: { sessions: { getMarkdown(id: string): Markdown } } } }).__b9Runtime;
    if (!runtime) return { stashed: false };
    const outcome: Record<string, unknown> = { stashed: true };
    try {
      const markdown = runtime.binding.sessions.getMarkdown(id);
      try { outcome.refresh = await markdown.refresh(); } catch (error) { outcome.refresh = `threw:${String(error).slice(0, 80)}`; }
      try { outcome.edit = markdown.editText(text); } catch (error) { outcome.edit = `threw:${String(error).slice(0, 80)}`; }
      try { await markdown.flush(); outcome.flush = 'returned'; } catch (error) { outcome.flush = `threw:${String(error).slice(0, 80)}`; }
    } catch (error) { outcome.access = `threw:${String(error).slice(0, 80)}`; }
    return outcome;
  }, { id, text });
}

/** True while the committed Bootstrap still retains a runtime (read only). */
export async function hasRetainedRuntime(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    type Fiber = { type?: { name?: string }; memoizedProps?: { session?: { getRetainedRuntime(): unknown } }; child?: Fiber; sibling?: Fiber };
    const root = document.getElementById('root') as (HTMLElement & Record<string, unknown>) | null;
    const key = root && Object.keys(root).find(value => value.startsWith('__reactContainer$'));
    const container = (key ? root?.[key] : undefined) as { stateNode?: { current?: Fiber } } | undefined;
    const stack = container?.stateNode?.current ? [container.stateNode.current] : []; let count = 0;
    while (stack.length && count++ < 800) {
      const fiber = stack.pop()!;
      if (fiber.type?.name === 'BootstrapConnection' && fiber.memoizedProps?.session) return !!fiber.memoizedProps.session.getRetainedRuntime();
      if (fiber.sibling) stack.push(fiber.sibling); if (fiber.child) stack.push(fiber.child);
    }
    throw new Error('Bootstrap session not found');
  });
}

/** Number of `edit-record` files on the synthetic Drive: what was really sent (not the local IndexedDB, whose key cannot hold a batch twice). */
export const editRecordCount = (drive: Drive) => [...drive.files.values()].filter(file => file.properties?.editKind === 'edit-record').length;
