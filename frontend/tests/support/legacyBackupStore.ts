import type { LegacyBackupPlan, LegacyBackupEntry, LegacyBackupManifest } from '../../src/runtime/edits/contracts.ts';
import type { LegacyBackupObjectStore } from '../../src/migrations/legacyBackup.ts';
import { canonicalJson } from '../../src/runtime/edits/editModel.ts';

export class MemoryBackupStore implements LegacyBackupObjectStore {
  plans = new Map<string, LegacyBackupPlan>(); manifests = new Map<string, LegacyBackupManifest>(); bodies = new Map<string, Uint8Array>();
  beforeObject?: () => void; failPublish = false;
  async prepare(value: LegacyBackupPlan) {
    const old = this.plans.get(value.manifest.id); if (old && canonicalJson(old) !== canonicalJson(value)) throw new Error('backup-id-reused');
    this.plans.set(value.manifest.id, structuredClone(value));
  }
  async putObject(entry: LegacyBackupEntry, bytes: Uint8Array) { this.beforeObject?.(); this.bodies.set(entry.sha256, Uint8Array.from(bytes)); }
  async publish(value: LegacyBackupManifest) { if (this.failPublish) throw new Error('quota'); this.manifests.set(value.id, structuredClone(value)); }
  async plan(id: string) { return structuredClone(this.plans.get(id)); }
  async object(entry: LegacyBackupEntry) { return Uint8Array.from(this.bodies.get(entry.sha256)!); }
  async reference(id: string) { return structuredClone(this.manifests.get(id)); }
  async manifest(id: string) { return this.reference(id); }
}
