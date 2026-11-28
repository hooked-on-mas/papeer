import { editSchema, type LegacyBackupEntry, type LegacyBackupKey, type LegacyBackupManifest, type LegacyBackupPlan } from '../runtime/edits/contracts.ts';
import { EditRejected } from '../runtime/edits/editModel.ts';
import { editContentHash } from '../runtime/edits/editContentHash.ts';
import { resourceHash } from '../runtime/edits/contentPublication.ts';
import { validateStructure } from '../runtime/edits/schemaValidator.ts';

/** Unicode scalar order, matching Python tuple/string ordering (not UTF-16 sort). */
export function compareBackupKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = Array.from(a[i], char => char.codePointAt(0)!), right = Array.from(b[i], char => char.codePointAt(0)!);
    for (let j = 0; j < Math.min(left.length, right.length); j++) if (left[j] !== right[j]) return left[j] - right[j];
    if (left.length !== right.length) return left.length - right.length;
  }
  return a.length - b.length;
}
export const legacyInventoryHash = (manifest: Pick<LegacyBackupManifest, 'source' | 'entries' | 'containers'>) =>
  editContentHash({ source: manifest.source, entries: manifest.entries, containers: manifest.containers });
export async function assertLegacyBackupManifest(value: unknown): Promise<LegacyBackupManifest> {
  validateStructure(editSchema, 'LegacyBackupManifest', value);
  const manifest = value as LegacyBackupManifest, keys = manifest.entries.map(entry => entry.key), containers = manifest.containers;
  for (const group of [keys, containers]) for (let i = 1; i < group.length; i++) {
    if (compareBackupKeys(group[i - 1], group[i]) >= 0) throw new EditRejected('backup-key-order-or-duplicate');
  }
  const directories = new Set(containers.map(key => JSON.stringify(key))), files = new Set(keys.map(key => JSON.stringify(key)));
  for (const key of [...keys, ...containers]) {
    if (key.length > 1 && !directories.has(JSON.stringify(key.slice(0, -1)))) throw new EditRejected('backup-parent-missing');
  }
  if (containers.some(key => files.has(JSON.stringify(key)))) throw new EditRejected('backup-file-container-collision');
  if (await legacyInventoryHash(manifest) !== manifest.inventorySha256) throw new EditRejected('backup-inventory-hash');
  return manifest;
}
export async function assertLegacyBackupPlan(value: unknown): Promise<LegacyBackupPlan> {
  validateStructure(editSchema, 'LegacyBackupPlan', value);
  const plan = value as LegacyBackupPlan; await assertLegacyBackupManifest(plan.manifest); return plan;
}

/** Native storage may stream bodies without sending them through the UI. Semantics stay common. */
export interface LegacyBackupPort {
  inventory(id: string): Promise<LegacyBackupPlan>;
  plan(id: string): Promise<LegacyBackupPlan | undefined>;
  capture(plan: LegacyBackupPlan): Promise<LegacyBackupManifest>;
  load(id: string): Promise<LegacyBackupManifest | undefined>;
  assertCurrent(plan: LegacyBackupPlan): Promise<void>;
  object(manifestId: string, entry: LegacyBackupEntry): Promise<Uint8Array>;
}
/** Immutable artifact persistence; source readers never decide where or how these bodies are stored. */
export interface LegacyBackupObjectStore {
  prepare(plan: LegacyBackupPlan): Promise<void>;
  putObject(entry: LegacyBackupEntry, bytes: Uint8Array): Promise<void>;
  publish(manifest: LegacyBackupManifest): Promise<void>;
  plan(id: string): Promise<LegacyBackupPlan | undefined>;
  object(entry: LegacyBackupEntry): Promise<Uint8Array>;
  reference(id: string): Promise<LegacyBackupManifest | undefined>;
  manifest(id: string): Promise<LegacyBackupManifest | undefined>;
}
export async function captureLegacyBackup(port: LegacyBackupPort, plan: LegacyBackupPlan): Promise<LegacyBackupManifest> {
  const stable = structuredClone(plan); await assertLegacyBackupPlan(stable);
  // A completed backup is an immutable input, never an active-dataset marker or proof that writers stopped.
  const result = structuredClone(await port.capture(structuredClone(stable))); await assertLegacyBackupManifest(result);
  if (await editContentHash(result) !== await editContentHash(stable.manifest)) throw new EditRejected('backup-plan-changed');
  return result;
}
export async function readLegacyBackupEntry(port: LegacyBackupPort, manifest: LegacyBackupManifest, key: LegacyBackupKey): Promise<Uint8Array> {
  const stable = structuredClone(manifest), wanted = [...key]; await assertLegacyBackupManifest(stable);
  const entry = stable.entries.find(value => compareBackupKeys(value.key, wanted) === 0);
  if (!entry) throw new EditRejected('backup-entry-missing');
  const bytes = Uint8Array.from(await port.object(stable.id, structuredClone(entry)));
  if (bytes.byteLength !== entry.byteLength || await resourceHash(bytes) !== entry.sha256) throw new EditRejected('backup-object-hash');
  return bytes;
}
