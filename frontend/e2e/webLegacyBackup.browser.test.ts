import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) {
test(`raw migration backup retains drafts through native abort, reload, response loss and corruption (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-legacy-backup', optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  const name = 'papeer-backup-test-' + crypto.randomUUID();
  const saved = await page.evaluate(async ({ name }) => {
    // @ts-expect-error -- Vite loads production adapters against real browser storage.
    const { LegacyLocalStorageBackup } = await import('/src/adapters/browser/legacyLocalStorage.ts');
    // @ts-expect-error -- Vite browser import.
    const { IndexedDbLegacyBackupStore } = await import('/src/adapters/browser/legacyBackupStore.ts');
    // @ts-expect-error -- Common capture entry used by PC and browser.
    const { captureLegacyBackup } = await import('/src/migrations/legacyBackup.ts');
    const expected = [['papeer-ink:lib:pending', '{bad JSON: keep'], ['papeer-notes:v1:lib:ack:operation', '1'],
      ['papeer-note-session:lib:note', '未送信😀\n'], ['papeer-handwriting:note', '\ud800'], ['papeer-\ud800', 'damaged key'], ['paper-desk-storage', '{"old":"preferences"}']];
    for (const [key, value] of [...expected, ['other-app', 'unrelated'], ['papeer-google-session:v1', 'credential']]) localStorage.setItem(key, value);
    const port = new LegacyLocalStorageBackup('fixture-local', localStorage, new IndexedDbLegacyBackupStore(name));
    const plan = await port.inventory(crypto.randomUUID());
    if (plan.manifest.entries.length !== expected.length) throw new Error('scope or credential filter changed');
    const nativeAdd = IDBObjectStore.prototype.add;
    let aborted = false;
    try {
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const request = nativeAdd.call(this, value, key);
        if (this.name === 'manifests' && key === plan.manifest.id) this.transaction.abort();
        return request;
      };
      try { await captureLegacyBackup(port, plan); } catch { aborted = true; }
    } finally { IDBObjectStore.prototype.add = nativeAdd; }
    if (!aborted || await port.load(plan.manifest.id)) throw new Error('native abort leaked backup completion');
    if (JSON.stringify(await port.plan(plan.manifest.id)) !== JSON.stringify(plan)) throw new Error('native abort lost the fixed plan');
    for (const [key, value] of expected) if (localStorage.getItem(key) !== value) throw new Error('backup modified the source');
    return { plan, expected };
  }, { name });
  await page.reload();
  const evidence = await page.evaluate(async ({ name, plan, expected }) => {
    // @ts-expect-error -- Vite browser import.
    const { LegacyLocalStorageBackup } = await import('/src/adapters/browser/legacyLocalStorage.ts');
    // @ts-expect-error -- Vite browser import.
    const { IndexedDbLegacyBackupStore } = await import('/src/adapters/browser/legacyBackupStore.ts');
    // @ts-expect-error -- Common fixed-plan capture and body verification.
    const { captureLegacyBackup, readLegacyBackupEntry } = await import('/src/migrations/legacyBackup.ts');
    const store = new IndexedDbLegacyBackupStore(name), port = new LegacyLocalStorageBackup('fixture-local', localStorage, store);
    const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
    try {
      expect(JSON.stringify(await port.plan(plan.manifest.id)) === JSON.stringify(plan), 'reload lost the original plan');
      const uncertain = { inventory: port.inventory, plan: port.plan, load: port.load, assertCurrent: port.assertCurrent, object: port.object,
        capture: async (input: any) => { await port.capture(input); throw new Error('response-lost'); } };
      let lost = false; try { await captureLegacyBackup(uncertain, plan); } catch { lost = true; }
      expect(lost && !!await port.load(plan.manifest.id), 'response loss erased a completed backup');
      const manifest = await captureLegacyBackup(port, plan), records: string[][] = [];
      for (const entry of manifest.entries) records.push(JSON.parse(new TextDecoder().decode(await readLegacyBackupEntry(port, manifest, entry.key))));
      expect(JSON.stringify(records.sort()) === JSON.stringify([...expected].sort()), 'draft bytes/keys/acknowledgements did not round-trip');
      for (const [key, value] of expected) expect(localStorage.getItem(key) === value, 'capture changed the original source');
      localStorage.setItem('papeer-text:lib:late', 'late draft');
      let drift = false; try { await port.assertCurrent(plan); } catch { drift = true; }
      expect(drift && !!await port.load(plan.manifest.id), 'late input was mistaken for the captured generation');
      const next = await port.inventory(crypto.randomUUID()); await store.prepare(next);
      let missing = false; try { await store.publish(next.manifest); } catch { missing = true; }
      expect(missing && !await port.load(next.manifest.id), 'missing object and manifest publication were not atomic');
      await captureLegacyBackup(port, next);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        const changeManifest = async (value: any) => {
          const tx = db.transaction('manifests', 'readwrite'); tx.objectStore('manifests').put(value, manifest.id);
          await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
        };
        await changeManifest({ ...manifest, id: crypto.randomUUID() });
        let wrongIdentity = false; try { await port.load(manifest.id); } catch { wrongIdentity = true; }
        expect(wrongIdentity, 'a different manifest ID was accepted under the saved lookup key');
        await changeManifest(manifest);
        const tx = db.transaction('objects', 'readwrite'), entry = manifest.entries[0];
        tx.objectStore('objects').put(new ArrayBuffer(entry.byteLength), entry.sha256);
        await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      } finally { db.close(); }
      let corrupt = false; try { await port.load(plan.manifest.id); } catch { corrupt = true; }
      expect(corrupt, 'a completed marker hid corrupt body bytes');
      for (const [key, value] of expected) expect(localStorage.getItem(key) === value, 'corrupt backup caused source cleanup');
      return ['native abort', 'fixed plan at reload', 'same-ID recovery', 'UTF-16 round-trip', 'late source rejection', 'missing-object atomicity', 'manifest identity', 'corruption detection'];
    } finally {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('fixture-database-blocked'));
      });
    }
  }, { name, ...saved });
  assert.equal(evidence.length, 8);
});
}
