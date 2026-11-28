import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLegacyDriveBackup, type LegacyDriveReadPort } from '../src/migrations/legacyDrive.ts';
import { captureLegacyBackup, readLegacyBackupEntry } from '../src/migrations/legacyBackup.ts';
import { createBrowserLegacyDriveRead } from '../src/adapters/browser/legacyDrive.ts';
import { MemoryBackupStore } from './support/legacyBackupStore.ts';
import { resourceHash } from '../src/runtime/edits/contentPublication.ts';

const source = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-legacy-drive.json', import.meta.url), 'utf8'));
function input() {
  const fixture = structuredClone(source);
  const io: LegacyDriveReadPort = {
    account: async () => fixture.identity.accountId,
    metadata: async id => structuredClone(fixture.objects[id].metadata),
    children: async parent => Object.values(fixture.objects).filter((value: any) => value.metadata.parents.includes(parent)).map((value: any) => structuredClone(value.metadata)),
    libraryFiles: async (id, kind) => Object.values(fixture.objects).filter((value: any) => value.metadata.properties.library === id && value.metadata.properties.papeer === kind).map((value: any) => structuredClone(value.metadata)),
    read: async id => Uint8Array.from(Buffer.from(fixture.objects[id].dataBase64, 'base64')),
  };
  return { fixture, io };
}

test('Drive raw capture retains snapshot references, both operation kinds, orphan blobs and empty nested folders verbatim', async () => {
  const { fixture, io } = input(), before = structuredClone(fixture), store = new MemoryBackupStore();
  const port = await createLegacyDriveBackup(fixture.identity, io, store), plan = await port.inventory(crypto.randomUUID());
  const manifest = await captureLegacyBackup(port, plan);
  for (const [id, value] of Object.entries(fixture.objects) as [string, any][]) {
    if (fixture.excluded.includes(id)) { assert.equal(manifest.entries.some(entry => entry.key[1] === id), false); continue; }
    const metadata = JSON.parse(new TextDecoder().decode(await readLegacyBackupEntry(port, manifest, ['metadata', id])));
    assert.equal(metadata.version, '9007199254740993');
    if (value.dataBase64 !== null) assert.deepEqual(await readLegacyBackupEntry(port, manifest, ['bodies', id]), Uint8Array.from(Buffer.from(value.dataBase64, 'base64')));
  }
  assert.deepEqual(await readLegacyBackupEntry(port, manifest, ['manifest.json']), Uint8Array.from(Buffer.from(fixture.objects[fixture.identity.libraryId].dataBase64, 'base64')));
  assert.deepEqual(fixture, before);
  await port.assertCurrent(plan);
  // Loading durable input does not require a currently working Drive connection.
  io.account = async () => { throw new Error('offline'); }; assert.deepEqual(await port.load(manifest.id), manifest);
});

test('Drive late operations or version changes retain the fixed plan, reject completion, and do not overwrite prior artifacts', async () => {
  const { fixture, io } = input(), store = new MemoryBackupStore(), port = await createLegacyDriveBackup(fixture.identity, io, store);
  const plan = await port.inventory(crypto.randomUUID()); let changed = false;
  store.beforeObject = () => {
    if (changed) return; changed = true;
    fixture.objects.late = structuredClone(fixture.objects['note-operation']); fixture.objects.late.metadata.id = 'late';
  };
  await assert.rejects(captureLegacyBackup(port, plan), /backup-source-changed/);
  assert.deepEqual(await port.plan(plan.manifest.id), plan); assert.equal(await port.load(plan.manifest.id), undefined);
  await assert.rejects(captureLegacyBackup(port, plan), /backup-source-changed/);
  store.beforeObject = undefined;
  const next = await port.inventory(crypto.randomUUID()); await captureLegacyBackup(port, next);
  fixture.objects['pdf-blob'].metadata.version = '9007199254740994';
  await assert.rejects(port.assertCurrent(next), /backup-source-changed/); assert.deepEqual(await port.load(next.manifest.id), next.manifest);
});

test('Drive verifies bytes even without provider checksum and refuses account switches, bad references and unsupported files', async () => {
  for (const mode of ['bytes', 'note-bytes', 'account', 'manifest-reference', 'unsupported-file', 'wrong-operation', 'version']) {
    const { fixture, io } = input(), port = await createLegacyDriveBackup(fixture.identity, io, new MemoryBackupStore());
    if (mode === 'bytes') { const bytes = Buffer.from(fixture.objects['external-blob'].dataBase64, 'base64'); bytes[0] ^= 255; fixture.objects['external-blob'].dataBase64 = bytes.toString('base64'); }
    if (mode === 'note-bytes') { const bytes = Buffer.from(fixture.objects['moved-note-body'].dataBase64, 'base64'); bytes[0] ^= 255; fixture.objects['moved-note-body'].dataBase64 = bytes.toString('base64'); }
    if (mode === 'account') fixture.identity.accountId = 'another-account';
    if (mode === 'manifest-reference') fixture.objects['pdf-blob'].metadata.size = '1';
    if (mode === 'unsupported-file') { fixture.objects['old-blob'].metadata.mimeType = 'application/vnd.google-apps.document'; delete fixture.objects['old-blob'].metadata.size; }
    if (mode === 'wrong-operation') io.libraryFiles = async () => [fixture.objects['unrelated-operation'].metadata];
    if (mode === 'version') fixture.objects['old-blob'].metadata.version += '\r';
    await assert.rejects(port.inventory(crypto.randomUUID()), /backup-/);
  }
  const { fixture, io } = input(), port = await createLegacyDriveBackup(fixture.identity, io, new MemoryBackupStore()), read = io.read;
  io.read = async id => { const bytes = await read(id); if (id === 'pdf-blob') fixture.objects[id].metadata.version = '9007199254740994'; return bytes; };
  await assert.rejects(port.inventory(crypto.randomUUID()), /backup-source-changed/);
});

test('browser Drive I/O rejects incomplete listings, repeated page tokens and query injection before collection', async () => {
  const calls: string[] = []; let mode = 'valid';
  const port = createBrowserLegacyDriveRead(async (resource, path) => {
    calls.push(resource + path);
    if (resource === 'about') return { user: { permissionId: source.identity.accountId } };
    if (mode === 'incomplete') return { files: [], incompleteSearch: true };
    if (mode === 'repeat') return { files: [], nextPageToken: 'same' };
    const url = new URL('https://fixture.test/' + path);
    return url.searchParams.has('pageToken') ? { files: [{ id: 'second' }] } : { files: [{ id: 'first' }], nextPageToken: 'next' };
  });
  assert.equal(await port.account(), source.identity.accountId); assert.deepEqual(await port.children('folder'), [{ id: 'first' }, { id: 'second' }]);
  assert.ok(calls.some(path => path.includes('pageToken=next')));
  for (const id of ['bad\n', "bad'query", '../outside']) { const count = calls.length; await assert.rejects(async () => port.metadata(id), /invalid-drive-id/); assert.equal(calls.length, count); }
  mode = 'incomplete'; await assert.rejects(port.children('folder'), /incomplete-list/);
  mode = 'repeat'; await assert.rejects(port.children('folder'), /pagination/);
});

test('Drive saves the fixed plan before reading and awaits each large body sink; interrupted capture resumes', async () => {
  const { fixture, io } = input(), originalRead = io.read, store = new MemoryBackupStore();
  const template = fixture.objects['old-blob'].metadata, count = 24, size = 1024 * 1024;
  for (let i = 0; i < count; i++) {
    fixture.objects[`large-${String(i).padStart(2, '0')}`] = { metadata: { ...structuredClone(template), id: `large-${String(i).padStart(2, '0')}`, size: String(size) }, dataBase64: null };
    delete fixture.objects[`large-${String(i).padStart(2, '0')}`].metadata.sha256Checksum;
  }
  let capturing = false, prepared = false, outstanding: string | undefined, reads = 0, saves = 0, interrupt = true;
  io.read = async id => {
    if (capturing) assert.equal(prepared, true, 'source read happened before durable plan');
    if (!id.startsWith('large-')) return originalRead(id);
    if (capturing) {
      assert.equal(outstanding, undefined, 'next large body was fetched before the preceding sink finished');
      outstanding = id; reads++;
    }
    return new Uint8Array(size).fill(Number(id.slice(6)));
  };
  const prepare = store.prepare.bind(store);
  store.prepare = async plan => { await prepare(plan); prepared = true; plan.manifest.source.id = 'host-mutated-copy'; };
  // A discard sink measures live transfer backpressure without retaining the test library itself in RAM.
  store.putObject = async (entry, bytes) => {
    assert.equal(await resourceHash(bytes), entry.sha256);
    if (entry.key[0] !== 'bodies' || !entry.key[1].startsWith('large-')) return;
    assert.equal(outstanding, entry.key[1]);
    await new Promise(resolve => setTimeout(resolve, 1));
    if (interrupt && ++saves === 3) throw new Error('interrupted sink');
    outstanding = undefined;
  };
  const port = await createLegacyDriveBackup(fixture.identity, io, store), plan = await port.inventory(crypto.randomUUID()), fixed = structuredClone(plan);
  capturing = true;
  await assert.rejects(port.capture(plan), /interrupted sink/);
  assert.equal(reads, 3); assert.deepEqual(await port.plan(plan.manifest.id), fixed); assert.equal(await port.load(plan.manifest.id), undefined);
  interrupt = false; outstanding = undefined; reads = 0;
  assert.deepEqual(await port.capture(plan), fixed.manifest);
  assert.equal(reads, count); assert.deepEqual(plan, fixed);
});
