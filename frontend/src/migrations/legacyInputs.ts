import { validateLegacyMigrationCatalog, validateLegacyMigrationInputSet, validateLegacyMigrationHold,
  type LegacyBackupSource, type LegacyMigrationCatalog, type LegacyMigrationInputSet, type LegacyMigrationHold } from '../runtime/edits/contracts.ts';
import { canonicalJson, EditRejected } from '../runtime/edits/editModel.ts';
import { assertLegacyBackupPlan, captureLegacyBackup, compareBackupKeys, readLegacyBackupEntry, type LegacyBackupPort } from './legacyBackup.ts';

export interface LegacyMigrationInputStore {
  readHold(): Promise<LegacyMigrationHold | undefined>;
  prepareInputs(value: LegacyMigrationInputSet): Promise<void>;
  inputs(runId: string): Promise<LegacyMigrationInputSet | undefined>;
}
export type LegacyMigrationSourceBinding = { peerId: string; source: LegacyBackupSource; port: LegacyBackupPort };
export type DiscoverLegacySources = () => Promise<LegacyMigrationSourceBinding[]>;
const key = (peerId: string, source: LegacyBackupSource) => [peerId, source.kind, source.id];
const expected = (catalog: LegacyMigrationCatalog) => catalog.peers.flatMap(peer => peer.sources.map(source => key(peer.id, source)));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const ordered = (keys: string[][]) => keys.every((value, index) => !index || compareBackupKeys(keys[index - 1], value) < 0);

export function assertMigrationCatalog(value: unknown): asserts value is LegacyMigrationCatalog {
  validateLegacyMigrationCatalog(value);
  if (!ordered(value.peers.map(peer => [peer.id])) || !ordered(expected(value))) throw new EditRejected('migration-source-order-or-duplicate');
}
/** Coverage is relative to explicit peer declarations. This is never discovery of unknown/offline peers. */
export async function assertMigrationInputSet(value: unknown): Promise<LegacyMigrationInputSet> {
  validateLegacyMigrationInputSet(value); assertMigrationCatalog(value.catalog);
  const keys = value.inputs.map(input => key(input.peerId, input.plan.manifest.source));
  if (!same(keys, expected(value.catalog))) throw new EditRejected('migration-source-coverage');
  const ids = new Set<string>(), shared = new Map<string, string>();
  for (const { plan } of value.inputs) {
    await assertLegacyBackupPlan(plan);
    if (ids.has(plan.manifest.id) || plan.manifest.id === value.catalog.runId) throw new EditRejected('migration-backup-id-reused');
    ids.add(plan.manifest.id);
    // The same Drive dataset seen by two peers must identify the same bytes, even with different observations.
    if (plan.manifest.source.kind === 'drive') {
      const source = canonicalJson(plan.manifest.source), previous = shared.get(source);
      if (previous && previous !== plan.manifest.inventorySha256) throw new EditRejected('migration-shared-source-disagrees');
      shared.set(source, plan.manifest.inventorySha256);
    }
  }
  return value;
}
async function admitted(store: LegacyMigrationInputStore, runId: string) {
  const hold = await store.readHold();
  if (hold !== undefined) validateLegacyMigrationHold(hold);
  if (hold?.runId !== runId) throw new EditRejected('migration-hold-required');
}
async function bindings(catalog: LegacyMigrationCatalog, discover: DiscoverLegacySources) {
  const found = (await discover()).map(binding => ({ ...binding, source: structuredClone(binding.source) }));
  found.sort((a, b) => compareBackupKeys(key(a.peerId, a.source), key(b.peerId, b.source)));
  if (!same(found.map(binding => key(binding.peerId, binding.source)), expected(catalog))) throw new EditRejected('migration-source-coverage');
  return found;
}
/** Persist all fixed input plans before copying any body. A lost reply resumes this exact input set. */
export async function prepareMigrationInputs(catalog: LegacyMigrationCatalog, discover: DiscoverLegacySources,
  store: LegacyMigrationInputStore, makeId: () => string = () => crypto.randomUUID()): Promise<LegacyMigrationInputSet> {
  const stable = structuredClone(catalog); assertMigrationCatalog(stable); await admitted(store, stable.runId);
  const old = structuredClone(await store.inputs(stable.runId));
  if (old) {
    await assertMigrationInputSet(old);
    if (!same(old.catalog, stable)) throw new EditRejected('migration-catalog-changed');
    await bindings(stable, discover); return structuredClone(old);
  }
  const sources = await bindings(stable, discover), inputs: LegacyMigrationInputSet['inputs'] = [];
  for (const binding of sources) {
    const id = makeId(), plan = structuredClone(await binding.port.inventory(id)); await assertLegacyBackupPlan(plan);
    if (plan.manifest.id !== id) throw new EditRejected('backup-plan-identity');
    if (!same(plan.manifest.source, binding.source)) throw new EditRejected('backup-source-identity');
    inputs.push({ peerId: binding.peerId, plan });
  }
  const record = await assertMigrationInputSet({ catalog: stable, inputs });
  await bindings(stable, discover); await admitted(store, stable.runId);
  await store.prepareInputs(structuredClone(record));
  const persisted = await store.inputs(stable.runId);
  if (!same(persisted ?? null, record)) throw new EditRejected('migration-input-set-not-durable');
  return structuredClone(record);
}
/** Verify each immutable artifact and the final source set. No activation or global freeze is inferred. */
export async function captureMigrationInputs(record: LegacyMigrationInputSet, discover: DiscoverLegacySources, store: LegacyMigrationInputStore): Promise<void> {
  const stable = structuredClone(record); await assertMigrationInputSet(stable);
  await admitted(store, stable.catalog.runId);
  if (!same(await store.inputs(stable.catalog.runId) ?? null, stable)) throw new EditRejected('migration-input-set-not-durable');
  const sources = await bindings(stable.catalog, discover);
  for (let index = 0; index < sources.length; index++) {
    const { port } = sources[index], { plan } = stable.inputs[index];
    const oldPlan = await port.plan(plan.manifest.id);
    if (oldPlan && !same(oldPlan, plan)) throw new EditRejected('backup-plan-changed');
    const old = structuredClone(await port.load(plan.manifest.id));
    const manifest = old ?? await captureLegacyBackup(port, plan);
    if (!same(manifest, plan.manifest)) throw new EditRejected('backup-plan-changed');
    for (const entry of manifest.entries) await readLegacyBackupEntry(port, manifest, entry.key);
  }
  // An earlier source may change while a later one is copied. Recheck all, including completed artifacts.
  const current = await bindings(stable.catalog, discover);
  for (let index = 0; index < current.length; index++) await current[index].port.assertCurrent(structuredClone(stable.inputs[index].plan));
  await bindings(stable.catalog, discover); await admitted(store, stable.catalog.runId);
}
