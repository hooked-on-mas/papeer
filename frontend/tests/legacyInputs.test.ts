import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { LegacyMigrationCatalog, LegacyMigrationHold, LegacyMigrationInputSet } from '../src/runtime/edits/contracts.ts';
import { assertMigrationInputSet, captureMigrationInputs, prepareMigrationInputs, type LegacyMigrationInputStore, type LegacyMigrationSourceBinding } from '../src/migrations/legacyInputs.ts';
import { LegacyLocalStorageBackup } from '../src/adapters/browser/legacyLocalStorage.ts';
import { MemoryBackupStore } from './support/legacyBackupStore.ts';

const corpus = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8')).legacyMigrationInputs;
test('multi-peer input coverage, shared Drive content and canonical ordering match the Python corpus', async () => {
  for (const example of corpus) {
    if (example.valid) await assertMigrationInputSet(example.value);
    else await assert.rejects(assertMigrationInputSet(example.value), example.name);
  }
});
function fixture() {
  const runId = crypto.randomUUID(), peerId = crypto.randomUUID();
  const artifacts = [new MemoryBackupStore(), new MemoryBackupStore()], values = [new Map([['papeer-note:a', 'a']]), new Map([['papeer-note:b', 'b']])];
  const bindings: LegacyMigrationSourceBinding[] = values.map((value, index) => {
    const storage: Storage = { get length() { return value.size; }, key: index => [...value.keys()][index] ?? null, getItem: key => value.get(key) ?? null,
      setItem: () => assert.fail('source write'), removeItem: () => assert.fail('source delete'), clear: () => assert.fail('source clear') };
    return { peerId, source: { kind: 'browser-local-storage', id: `origin-${index}` }, port: new LegacyLocalStorageBackup(`origin-${index}`, storage, artifacts[index]) };
  });
  const catalog: LegacyMigrationCatalog = { version: 1, runId, identity: { accountId: 'fixture', libraryId: crypto.randomUUID() }, peers: [{ id: peerId, sources: bindings.map(binding => binding.source) }] };
  let hold: LegacyMigrationHold | undefined = { version: 1, runId }, saved: LegacyMigrationInputSet | undefined, loseReply = false;
  const store: LegacyMigrationInputStore = { readHold: async () => structuredClone(hold), inputs: async () => structuredClone(saved), prepareInputs: async value => {
    if (saved) assert.deepEqual(value, saved); saved = structuredClone(value);
    if (loseReply) { loseReply = false; throw new Error('reply-lost'); }
  } };
  return { catalog, bindings, values, artifacts, store, discover: async () => bindings, loseReply: () => { loseReply = true; }, changeHold: () => { hold = { version: 1, runId: crypto.randomUUID() }; } };
}
test('a lost input-set reply and partial capture resume the same IDs without recopying completed sources', async () => {
  const f = fixture(); f.loseReply();
  await assert.rejects(prepareMigrationInputs(f.catalog, f.discover, f.store), /reply-lost/);
  const fixed = (await f.store.inputs(f.catalog.runId))!;
  const record = await prepareMigrationInputs(f.catalog, f.discover, f.store, () => assert.fail('new IDs after response loss'));
  assert.deepEqual(record, fixed);
  f.artifacts[1].failPublish = true;
  await assert.rejects(captureMigrationInputs(record, f.discover, f.store), /quota/);
  assert.ok(await f.bindings[0].port.load(record.inputs[0].plan.manifest.id));
  assert.equal(await f.bindings[1].port.load(record.inputs[1].plan.manifest.id), undefined);
  f.bindings[0].port.capture = async () => assert.fail('recopied completed backup');
  f.artifacts[1].failPublish = false;
  await captureMigrationInputs(record, f.discover, f.store);
  assert.deepEqual(await f.store.inputs(f.catalog.runId), fixed);
});
test('coverage changes, a changed declaration, wrong source identity and missing admission stop before capture', async () => {
  const f = fixture();
  await assert.rejects(prepareMigrationInputs(f.catalog, async () => f.bindings.slice(0, 1), f.store), /coverage/);
  assert.equal(await f.store.inputs(f.catalog.runId), undefined);
  const original = f.bindings[0].port.inventory;
  f.bindings[0].port.inventory = async id => { const plan = await original(id); plan.manifest.source.id = 'another'; return plan; };
  await assert.rejects(prepareMigrationInputs(f.catalog, f.discover, f.store)); f.bindings[0].port.inventory = original;
  f.bindings[0].port.inventory = async id => { const plan = await original(id); plan.manifest.id = crypto.randomUUID(); return plan; };
  await assert.rejects(prepareMigrationInputs(f.catalog, f.discover, f.store), /plan-identity/); f.bindings[0].port.inventory = original;
  const fixed = await prepareMigrationInputs(f.catalog, f.discover, f.store);
  const changed = structuredClone(f.catalog); changed.identity.accountId = 'other-account';
  await assert.rejects(prepareMigrationInputs(changed, f.discover, f.store), /catalog-changed/);
  await assert.rejects(captureMigrationInputs(fixed, async () => [...f.bindings, f.bindings[0]], f.store), /coverage/);
  f.changeHold(); await assert.rejects(captureMigrationInputs(fixed, f.discover, f.store), /hold-required/);
});
test('late writes to an earlier copied source and corrupted saved bodies prevent input verification', async () => {
  const f = fixture(), record = await prepareMigrationInputs(f.catalog, f.discover, f.store);
  f.artifacts[1].beforeObject = () => f.values[0].set('papeer-late', 'not in the fixed input');
  await assert.rejects(captureMigrationInputs(record, f.discover, f.store), /source-changed/);
  f.values[0].delete('papeer-late'); f.artifacts[1].beforeObject = undefined;
  await captureMigrationInputs(record, f.discover, f.store);
  f.bindings[0].port.object = async () => new Uint8Array([0]);
  await assert.rejects(captureMigrationInputs(record, f.discover, f.store), /object-hash/);
});
