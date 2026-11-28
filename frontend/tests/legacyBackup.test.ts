import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { LegacyBackupPlan, LegacyBackupManifest } from '../src/runtime/edits/contracts.ts';
import { assertLegacyBackupManifest, compareBackupKeys, captureLegacyBackup, legacyInventoryHash, readLegacyBackupEntry, type LegacyBackupPort } from '../src/migrations/legacyBackup.ts';
import { LegacyLocalStorageBackup } from '../src/adapters/browser/legacyLocalStorage.ts';
import { MemoryBackupStore } from './support/legacyBackupStore.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8')).legacyBackup;
function storageFixture() {
  const values = new Map<string, string>([
    ['papeer-ink:library:pending', '{broken JSON: keep it'], ['papeer-notes:v1:library:ack:op', '1'],
    ['papeer-note-session:library:note', '未送信😀\n'], ['papeer-handwriting:note', '\ud800'],
    ['paper-desk-storage', '{"old":"preferences"}'],
    ['papeer-\ud800', 'damaged key'], ['papeer-google-session:v1', 'credential'], ['other-app:note', 'private to another app'],
  ]);
  let writes = 0;
  const storage: Storage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes++; values.set(key, value); }, removeItem: key => { writes++; values.delete(key); }, clear: () => { writes++; values.clear(); } };
  return { values, storage, writes: () => writes };
}

test('backup manifests use the same Python hash and scalar key ordering, including empty bodies and nested journals', async () => {
  const manifest = fixture.plan.manifest as LegacyBackupManifest;
  await assertLegacyBackupManifest(manifest);
  assert.equal(await legacyInventoryHash(manifest), manifest.inventorySha256);
  assert.ok(compareBackupKeys(['drafts', '\ue000'], ['drafts', '😀']) < 0);
  for (const mode of ['duplicate', 'unsorted', 'parent', 'collision', 'digest']) {
    const bad = structuredClone(manifest);
    if (mode === 'duplicate') bad.entries.splice(1, 0, structuredClone(bad.entries[0]));
    if (mode === 'unsorted') bad.entries.reverse();
    if (mode === 'parent') bad.containers = [];
    if (mode === 'collision') { bad.containers.push(bad.entries[0].key); bad.containers.sort(compareBackupKeys); }
    bad.inventorySha256 = mode === 'digest' ? '0'.repeat(64) : await legacyInventoryHash(bad);
    await assert.rejects(assertLegacyBackupManifest(bad));
  }
});

test('the common capture/read entry preserves its fixed input despite a mutating host callback', async () => {
  const plan: LegacyBackupPlan = structuredClone(fixture.plan), bodies = new Map<string, Uint8Array>(fixture.bodies.map((value: any) => [value.sha256, Uint8Array.from(Buffer.from(value.dataBase64, 'base64'))]));
  const port: LegacyBackupPort = { inventory: async () => plan, plan: async () => plan, assertCurrent: async () => {},
    capture: async input => structuredClone(input.manifest), load: async () => plan.manifest, object: async (_id, entry) => Uint8Array.from(bodies.get(entry.sha256)!) };
  assert.deepEqual(await captureLegacyBackup(port, plan), plan.manifest);
  const entry = plan.manifest.entries[0]; assert.deepEqual(await readLegacyBackupEntry(port, plan.manifest, entry.key), bodies.get(entry.sha256));
  await assert.rejects(captureLegacyBackup({ ...port, capture: async input => { input.manifest.id = crypto.randomUUID(); return input.manifest; } }, plan), /backup-plan-changed/);
  await assert.rejects(readLegacyBackupEntry({ ...port, object: async (_id, input) => { input.byteLength = 1; return new Uint8Array([1]); } }, plan.manifest, entry.key), /backup-object-hash/);
  assert.deepEqual(plan, fixture.plan);
});

test('raw localStorage keeps acknowledged/invalid drafts and UTF-16 verbatim without reading credentials or writing source', async () => {
  const source = storageFixture(), before = [...source.values], store = new MemoryBackupStore();
  const port = new LegacyLocalStorageBackup('fixture', source.storage, store), plan = await port.inventory(crypto.randomUUID());
  assert.equal(plan.manifest.source.kind, 'browser-local-storage'); assert.equal(plan.manifest.entries.length, 6);
  const captured = await captureLegacyBackup(port, plan), records: [string, string][] = [];
  for (const entry of captured.entries) records.push(JSON.parse(new TextDecoder().decode(await readLegacyBackupEntry(port, captured, entry.key))));
  assert.deepEqual(records.sort(), before.filter(([key]) => key !== 'papeer-google-session:v1' && key !== 'other-app:note').sort());
  assert.equal(source.writes(), 0); assert.deepEqual([...source.values], before);
  assert.deepEqual(await port.plan(plan.manifest.id), plan); assert.deepEqual(await port.load(plan.manifest.id), captured);
  const external = await port.inventory(crypto.randomUUID()); external.manifest.source.id = 'mutated-by-caller';
  assert.equal((await port.inventory(crypto.randomUUID())).manifest.source.id, 'fixture', 'inventory does not expose mutable source identity');
  source.values.set('papeer-reading:late', 'new'); await assert.rejects(port.assertCurrent(plan), /backup-source-changed/);
  assert.deepEqual(await port.load(plan.manifest.id), captured, 'completed immutable input survives later edits');
});

test('localStorage drift or quota keeps the original plan and never publishes partial completion', async () => {
  const source = storageFixture(), store = new MemoryBackupStore(), port = new LegacyLocalStorageBackup('fixture', source.storage, store);
  const plan = await port.inventory(crypto.randomUUID());
  store.failPublish = true; await assert.rejects(captureLegacyBackup(port, plan), /quota/);
  assert.deepEqual(await port.plan(plan.manifest.id), plan); assert.equal(await port.load(plan.manifest.id), undefined);
  const restarted = new LegacyLocalStorageBackup('fixture', source.storage, store); store.failPublish = false;
  assert.deepEqual(await captureLegacyBackup(restarted, plan), plan.manifest);
  const next = await port.inventory(crypto.randomUUID()); store.beforeObject = () => source.values.set('papeer-notes:v1:library:late', 'late');
  await assert.rejects(captureLegacyBackup(port, next), /backup-source-changed/);
  assert.deepEqual(await port.plan(next.manifest.id), next); assert.equal(await port.load(next.manifest.id), undefined);
  await assert.rejects(new LegacyLocalStorageBackup('different-source', source.storage, store).load(plan.manifest.id), /backup-source-identity/);
  assert.equal(source.writes(), 0);
});
