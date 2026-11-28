import type { LegacyBackupEntry, LegacyBackupManifest, LegacyBackupPlan } from '../../runtime/edits/contracts.ts';
import { resourceHash } from '../../runtime/edits/contentPublication.ts';
import { EditRejected } from '../../runtime/edits/editModel.ts';
import { assertLegacyBackupPlan, compareBackupKeys, legacyInventoryHash, type LegacyBackupObjectStore } from '../../migrations/legacyBackup.ts';
import { IndexedDbLegacyBackupStore } from './legacyBackupStore.ts';
import { StoredLegacyBackup, type LegacyBackupSink } from '../../migrations/storedLegacyBackup.ts';
import { readLegacyLocalStorageEntries } from './legacySourceNames.ts';

/** Read durable app input before starting any legacy stores, which may clear/rewrite acknowledged records. */
export class LegacyLocalStorageBackup extends StoredLegacyBackup {
  private storage: Storage;
  constructor(sourceId: string, storage: Storage = localStorage, store: LegacyBackupObjectStore = new IndexedDbLegacyBackupStore()) {
    super({ kind: 'browser-local-storage', id: sourceId }, store); this.storage = storage;
  }
  private raw(): [string, string][] {
    return readLegacyLocalStorageEntries(this.storage);
  }
  protected async snapshot(id: string, sink?: LegacyBackupSink): Promise<LegacyBackupPlan> {
    const raw = this.raw(), encoded = JSON.stringify(raw), encoder = new TextEncoder();
    const entries: LegacyBackupEntry[] = [];
    for (const [key, value] of raw) {
      // JSON escaping preserves even damaged UTF-16 drafts. Metadata keys stay scalar and unambiguous.
      const units = new Uint8Array(key.length * 2), view = new DataView(units.buffer);
      for (let i = 0; i < key.length; i++) view.setUint16(i * 2, key.charCodeAt(i), true);
      const bytes = encoder.encode(JSON.stringify([key, value])), hash = await resourceHash(bytes);
      const entry = { key: [await resourceHash(units)], sha256: hash, byteLength: bytes.byteLength };
      entries.push(entry); await sink?.(entry, bytes);
    }
    if (JSON.stringify(this.raw()) !== encoded) throw new EditRejected('backup-source-changed');
    entries.sort((a, b) => compareBackupKeys(a.key, b.key));
    const manifest: LegacyBackupManifest = { version: 1, id, source: structuredClone(this.source), entries, containers: [], inventorySha256: '' };
    manifest.inventorySha256 = await legacyInventoryHash(manifest);
    const plan = { manifest, observationSha256: await resourceHash(encoder.encode(encoded)) }; await assertLegacyBackupPlan(plan);
    return plan;
  }
}
