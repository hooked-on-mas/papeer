import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import { scenario } from '../lib/app.ts';
import { isLegacyLocalStorageKey } from '../../src/adapters/browser/legacySourceNames.ts';

/** Inspect only the test-created WebView artifact; no host/main injection or source upgrade. */
async function clientBackup(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-migration-backups');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('client backup disappeared')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      const stores = Array.from(db.objectStoreNames), records = [];
      for (const store of stores) {
        const rows = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
          const tx = db.transaction(store, 'readonly'), keys = tx.objectStore(store).getAllKeys(), values = tx.objectStore(store).getAll();
          tx.oncomplete = () => resolve({ keys: keys.result, values: values.result });
          tx.onabort = () => reject(tx.error);
        });
        records.push({ store, ...rows });
      }
      return { version: db.version, stores, records };
    } finally { db.close(); }
  });
}

scenario('実Tauri起動は旧WebView下書きを保護し、新テーマだけでは停止しない', { seed: false, timeout: 300_000 }, async (initial, t) => {
  let app = initial, page = app.page;
  t.diagnostic('phase: empty native root and ordinary local setup');
  await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).waitFor();
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/presence', {}), 'clear');
  const oldThemes = await page.evaluate(() => ({
    papeer: localStorage.getItem('papeer-ui-theme'),
    paperdesk: localStorage.getItem('paperdesk-ui-theme'),
  }));
  await page.evaluate(() => localStorage.setItem('paper-desk.ui-theme.v1', 'dark'));

  // Re-enter the real entry after a document reload. A freshly seeded localStorage
  // value does not claim crash durability when the harness force-kills WebView2.
  t.diagnostic('phase: reload ordinary entry with only canonical theme preference');
  await page.reload();
  await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).waitFor();
  assert.equal(await page.locator('#root').getAttribute('data-startup-state'), 'running');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/presence', {}), 'clear');
  assert.deepEqual(await page.evaluate(() => ({
    papeer: localStorage.getItem('papeer-ui-theme'),
    paperdesk: localStorage.getItem('paperdesk-ui-theme'),
  })), oldThemes);

  const original = await page.evaluate(() => {
    localStorage.setItem('papeer-ink:legacy:original:1', '{broken ink');
    localStorage.setItem('papeer-note-draft:legacy', 'not JSON: 日本語');
    return {
      ink: localStorage.getItem('papeer-ink:legacy:original:1'),
      note: localStorage.getItem('papeer-note-draft:legacy'),
      theme: localStorage.getItem('paper-desk.ui-theme.v1'),
      papeer: localStorage.getItem('papeer-ui-theme'),
      paperdesk: localStorage.getItem('paperdesk-ui-theme'),
    };
  });
  t.diagnostic('phase: reload ordinary entry with malformed legacy WebView records');
  await page.reload();
  const gate = page.locator('#root[data-startup-state="legacy-present"]');
  await gate.waitFor();
  await gate.getByRole('status').filter({ hasText: '以前の保存データが見つかりました。移行・復旧を確認するまで、編集画面の起動を保留しています。' }).waitFor();
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/presence', {}), 'clear');
  assert.equal(await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'ライブラリを選択', exact: true }).count(), 0);

  t.diagnostic('phase: retry remains gated without changing raw records');
  const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/legacy-startup/presence' && response.request().method() === 'POST');
  await gate.getByRole('button', { name: '起動を再試行', exact: true }).click();
  assert.equal((await checked).status(), 200);
  await page.locator('#root[data-startup-state="legacy-present"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'ライブラリを選択', exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => ({
    ink: localStorage.getItem('papeer-ink:legacy:original:1'),
    note: localStorage.getItem('papeer-note-draft:legacy'),
    theme: localStorage.getItem('paper-desk.ui-theme.v1'),
    papeer: localStorage.getItem('papeer-ui-theme'),
    paperdesk: localStorage.getItem('paperdesk-ui-theme'),
  })), original);
  assert.deepEqual({ papeer: original.papeer, paperdesk: original.paperdesk }, oldThemes);
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/presence', {}), 'clear');
});

scenario('実Tauri起動はWebViewだけの移行holdと破損holdを保護する', { seed: false, timeout: 300_000 }, async (initial, t) => {
  let app = initial, page = app.page;
  t.diagnostic('phase: ordinary empty setup with no Native hold or legacy source');
  await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).waitFor();
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/read', {}), null);
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/presence', {}), 'clear');
  const originalLocal = await page.evaluate(() => Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)));
  assert.deepEqual(originalLocal.map(([key]) => key).filter(isLegacyLocalStorageKey), [], 'this scenario has no legacy draft or preference keys');

  t.diagnostic('phase: seed an actual isolated WebView hold record only');
  const hold = await page.evaluate(async () => {
    const hold = { version: 1, runId: crypto.randomUUID() };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('papeer-migration-backups', 3);
      request.onupgradeneeded = () => {
        for (const name of ['plans', 'objects', 'manifests', 'holds']) request.result.createObjectStore(name);
        request.transaction!.objectStore('holds').put(hold, 'origin');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    return hold;
  });
  const originalBackup = await clientBackup(page);
  assert.equal(originalBackup.version, 3);
  assert.deepEqual(originalBackup.stores, ['holds', 'manifests', 'objects', 'plans']);
  assert.deepEqual(originalBackup.records, [
    { store: 'holds', keys: ['origin'], values: [hold] },
    { store: 'manifests', keys: [], values: [] }, { store: 'objects', keys: [], values: [] }, { store: 'plans', keys: [], values: [] },
  ]);

  t.diagnostic('phase: same-profile restart is held by the real client record');
  app = await app.restart(); page = app.page;
  await page.locator('#root[data-startup-state="held"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'ライブラリを選択', exact: true }).count(), 0);
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/read', {}), null);
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/presence', {}), 'clear');
  assert.deepEqual(await clientBackup(page), originalBackup);

  t.diagnostic('phase: retry re-reads both holds and preserves the client source');
  const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/edits/legacy-startup/read' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '起動を再試行', exact: true }).click();
  assert.equal((await checked).status(), 200);
  await page.locator('#root[data-startup-state="held"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'ライブラリを選択', exact: true }).count(), 0);
  assert.deepEqual(await clientBackup(page), originalBackup);
  assert.deepEqual(await page.evaluate(() => Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b))), originalLocal);
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/read', {}), null);
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/presence', {}), 'clear');

  t.diagnostic('phase: malformed client hold remains unavailable without rewriting it');
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-migration-backups');
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('holds', 'readwrite');
        tx.objectStore('holds').put({ version: 1, runId: 'malformed-client-hold' }, 'origin');
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  });
  const malformedBackup = await clientBackup(page);
  app = await app.restart(); page = app.page;
  await page.locator('#root[data-startup-state="unavailable"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'ライブラリを選択', exact: true }).count(), 0);
  assert.deepEqual(await clientBackup(page), malformedBackup);
  assert.deepEqual(await page.evaluate(() => Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b))), originalLocal);
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/read', {}), null);
  assert.equal(await app.api.call('POST', '/api/edits/legacy-startup/presence', {}), 'clear');
});
