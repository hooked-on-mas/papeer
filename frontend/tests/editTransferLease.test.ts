import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDriveEditTransfer, type DriveEditStorage } from '../src/adapters/drive/editTransfer.ts';
import { DriveSession } from '../src/web/drive.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const scope = { accountId: 'A', libraryId: fixture.libraryId, epoch: 'lease-fixture' };

test('poll skips dataset bodies, retries unacknowledged arrivals, then fetches only new immutable versions', async () => {
  const record = fixture.editRecords[0];
  const files = [{ id: 'large-checkpoint', kind: 'repository-checkpoint', version: '1' },
    { id: 'manifest', kind: 'dataset-manifest', version: '1' },
    { id: 'record', kind: 'edit-record', version: '1' }];
  let body = { kind: 'edit-record', record }, reads = 0;
  const storage: DriveEditStorage = {
    assertCurrent() {},
    async bindAccount(account) { assert.equal(account, 'A'); return this; },
    sharedEditFiles: async () => structuredClone(files),
    annotation: async id => { assert.equal(id, 'record'); reads++; return structuredClone(body); },
    saveSharedEdit: async () => undefined,
    sharedResource: async () => { throw Error('unused'); },
    saveSharedResource: async () => undefined,
  };
  const transfer = createDriveEditTransfer(storage, scope, 'folder');
  assert.equal((await transfer.pull()).edits.length, 1);
  assert.equal((await transfer.pull()).edits.length, 1, 'failed durable receive must remain retryable');
  assert.equal(reads, 1);
  await transfer.acknowledgePull!([record.batch.id], [], []);
  assert.equal((await transfer.pull()).edits.length, 0);
  assert.equal(reads, 1, 'unchanged polls never re-read immutable bodies');
  files[2].version = '2';
  body = { ...body, record: { ...record, unexpected: true } };
  await assert.rejects(transfer.pull(), /immutable-drive-file-changed/);
  assert.equal(reads, 2, 'a changed Drive version cannot hide a changed payload');
});

test('Web account binding rejects A scope on B, invalidates old leases and rejects late responses', async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalFetch = globalThis.fetch;
  let account = 'A', delayRead: (() => void) | undefined;
  const calls: { account: string; write: boolean }[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    google: { accounts: { oauth2: { initTokenClient: (options: { callback: (value: object) => void }) => ({
      requestAccessToken: () => options.callback({ access_token: account, expires_in: 100 }),
    }) } } },
  } });
  globalThis.fetch = async (input, init) => {
    const token = new Headers(init?.headers).get('Authorization')!.slice(7);
    calls.push({ account: token, write: init?.method === 'POST' });
    if (String(input).includes('/about?')) return Response.json({ user: { permissionId: token } });
    if (delayRead) { const run = delayRead; delayRead = undefined; run(); }
    return Response.json({ files: [], id: 'uploaded' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  });
  const session = new DriveSession(); await session.signIn();
  const transfer = createDriveEditTransfer(session, scope, 'shared-folder');
  await transfer.pull();
  account = 'B'; await session.signIn();
  await assert.rejects(transfer.upload(fixture.editRecords[0]), /auth-changed/);
  await assert.rejects(createDriveEditTransfer(session, scope, 'shared-folder').pull(), /account-mismatch/);
  assert.equal(calls.some(call => call.account === 'B' && call.write), false);
  account = 'A'; await session.signIn();
  const current = createDriveEditTransfer(session, scope, 'shared-folder');
  await current.pull();
  delayRead = () => session.signOut();
  await assert.rejects(current.pull(), /ログイン/);
});
