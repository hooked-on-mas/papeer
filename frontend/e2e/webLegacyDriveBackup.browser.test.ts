import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) {
test(`shared Drive migration input crosses authenticated browser HTTP/IndexedDB, abort/reload, late operations and account changes (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-legacy-drive-backup', optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const fixture = JSON.parse(readFileSync(path.resolve(frontend, '../tests/fixtures/shared-legacy-drive.json'), 'utf8'));
  const before = structuredClone(fixture), methods: string[] = [];
  await page.route('https://www.googleapis.com/**', async route => {
    const request = route.request(), url = new URL(request.url()), headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    methods.push(request.method()); assert.equal(request.method(), 'GET'); assert.equal(request.headers().authorization, 'Bearer fixture-token');
    if (url.pathname.endsWith('/about')) { await route.fulfill({ json: { user: { permissionId: fixture.identity.accountId } }, headers }); return; }
    if (url.pathname.endsWith('/files')) {
      const q = url.searchParams.get('q')!, properties = [...q.matchAll(/key='([^']+)' and value='([^']+)'/g)], parent = /'([^']+)' in parents/.exec(q);
      const files = Object.values(fixture.objects).map((value: any) => value.metadata).filter((value: any) => !value.trashed
        && properties.every(match => value.properties[match[1]] === match[2]) && (!parent || value.parents.includes(parent[1])));
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      await route.fulfill({ json: { files: files.slice(offset, offset + 2), incompleteSearch: false, ...(offset + 2 < files.length ? { nextPageToken: String(offset + 2) } : {}) }, headers }); return;
    }
    const value = fixture.objects[url.pathname.split('/').pop()!];
    assert.ok(value, 'read stayed inside the synthetic Drive catalog');
    if (url.searchParams.get('alt') === 'media') await route.fulfill({ body: Buffer.from(value.dataBase64, 'base64'), headers });
    else await route.fulfill({ json: value.metadata, headers });
  });
  await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.exposeFunction('mutateLegacyDriveFixture', (mode: string) => {
    if (mode === 'late') { fixture.objects.late = structuredClone(fixture.objects['note-operation']); fixture.objects.late.metadata.id = 'late'; }
    if (mode === 'account') fixture.identity.accountId = 'other-account';
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  const name = 'legacy-drive-artifacts-' + crypto.randomUUID();
  const plan = await page.evaluate(async ({ name, identity }) => {
    // @ts-expect-error -- Production authenticated browser session and read-only transport.
    const { DriveSession, CLIENT_ID } = await import('/src/web/drive.ts');
    // @ts-expect-error -- Common source collection/policy, same module used by PC.
    const { createLegacyDriveBackup } = await import('/src/migrations/legacyDrive.ts');
    // @ts-expect-error -- Real browser durability.
    const { IndexedDbLegacyBackupStore } = await import('/src/adapters/browser/legacyBackupStore.ts');
    sessionStorage.setItem('papeer-google-session:v1', JSON.stringify({ clientId: CLIENT_ID, scope: 'https://www.googleapis.com/auth/drive.file', token: 'fixture-token', expires: Date.now() + 60_000 }));
    const store = new IndexedDbLegacyBackupStore(name), port = await createLegacyDriveBackup(identity, new DriveSession().legacyDriveRead(), store);
    const plan = await port.inventory(crypto.randomUUID()), nativeAdd = IDBObjectStore.prototype.add; let aborted = false;
    try {
      IDBObjectStore.prototype.add = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const request = nativeAdd.call(this, value, key); if (this.name === 'manifests' && key === plan.manifest.id) this.transaction.abort(); return request;
      };
      try { await port.capture(plan); } catch { aborted = true; }
    } finally { IDBObjectStore.prototype.add = nativeAdd; }
    if (!aborted || await port.load(plan.manifest.id) || !await port.plan(plan.manifest.id)) throw new Error('native abort lost fixed plan or leaked completion');
    return plan;
  }, { name, identity: before.identity });
  assert.deepEqual(fixture, before, 'capture issued no source mutations');
  await page.reload();
  const evidence = await page.evaluate(async ({ name, plan, expected }) => {
    // @ts-expect-error -- Vite browser module.
    const { DriveSession } = await import('/src/web/drive.ts');
    // @ts-expect-error -- Common capture/source policy.
    const { createLegacyDriveBackup } = await import('/src/migrations/legacyDrive.ts');
    // @ts-expect-error -- Native IndexedDB artifact persistence.
    const { IndexedDbLegacyBackupStore } = await import('/src/adapters/browser/legacyBackupStore.ts');
    // @ts-expect-error -- Common fixed-plan/body verification.
    const { captureLegacyBackup, readLegacyBackupEntry } = await import('/src/migrations/legacyBackup.ts');
    const expect = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
    const store = new IndexedDbLegacyBackupStore(name), session = new DriveSession(), io = session.legacyDriveRead(), port = await createLegacyDriveBackup(expected.identity, io, store);
    try {
      expect(JSON.stringify(await port.plan(plan.manifest.id)) === JSON.stringify(plan), 'reload lost the fixed plan');
      const publish = store.publish.bind(store);
      store.publish = async (manifest: any) => { await publish(manifest); throw new Error('response-lost'); };
      let lost = false; try { await captureLegacyBackup(port, plan); } catch { lost = true; } store.publish = publish;
      expect(lost && !!await port.load(plan.manifest.id), 'response loss erased completed input');
      const manifest = await captureLegacyBackup(port, plan);
      for (const [id, value] of Object.entries(expected.objects) as [string, any][]) {
        if (expected.excluded.includes(id)) { expect(!manifest.entries.some((entry: any) => entry.key[1] === id), 'other-library operation leaked'); continue; }
        const metadata = JSON.parse(new TextDecoder().decode(await readLegacyBackupEntry(port, manifest, ['metadata', id])));
        expect(metadata.version === '9007199254740993', 'metadata version lost integer precision');
        if (value.dataBase64 !== null) {
          const bytes = await readLegacyBackupEntry(port, manifest, ['bodies', id]), body = Uint8Array.from(atob(value.dataBase64), c => c.charCodeAt(0));
          expect(bytes.length === body.length && bytes.every((value: number, index: number) => value === body[index]), 'PDF/operation/raw ledger bytes changed');
          expect(!new TextDecoder().decode(bytes).includes('fixture-token'), 'credential entered a backup');
        }
      }
      const next = await port.inventory(crypto.randomUUID()), put = store.putObject.bind(store); let mutated = false;
      store.putObject = async (entry: any, bytes: Uint8Array) => {
        if (!mutated) { mutated = true; await (window as any).mutateLegacyDriveFixture('late'); } await put(entry, bytes);
      };
      let changed = false; try { await captureLegacyBackup(port, next); } catch { changed = true; } store.putObject = put;
      expect(changed && !await port.load(next.manifest.id) && !!await port.plan(next.manifest.id), 'late operation mixed input or erased plan');
      await (window as any).mutateLegacyDriveFixture('account');
      let account = false; try { await port.assertCurrent(plan); } catch { account = true; }
      expect(account && !!await port.load(plan.manifest.id), 'account change was accepted as captured source or erased durable input');
      session.signOut(); expect(!!await port.load(plan.manifest.id), 'durable raw input cannot reopen without remote credentials');
      return ['shared collector', 'authenticated GET pagination', 'raw PDF/ledger/operations', 'empty/nested folders', 'native abort/reload', 'publication response loss', 'late operation refusal', 'account isolation/offline recovery'];
    } finally {
      await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('fixture-database-blocked')); });
    }
  }, { name, plan, expected: before });
  assert.equal(evidence.length, 8); assert.ok(methods.length > 30); assert.ok(methods.every(method => method === 'GET'));
});
}
