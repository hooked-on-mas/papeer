import type { LegacyBackupManifest, LegacyBackupPlan, LegacyBackupSource, LegacyBackupEntry } from '../runtime/edits/contracts.ts';
import { canonicalJson, EditRejected } from '../runtime/edits/editModel.ts';
import { assertLegacyBackupPlan, type LegacyBackupPort, type LegacyBackupObjectStore } from './legacyBackup.ts';

/** A source awaits persistence before reading the next body; inventory omits the sink. */
export type LegacyBackupSink = (entry: LegacyBackupEntry, bytes: Uint8Array) => Promise<void>;
/** Sources share fixed-plan publication and recovery, independently of their read and persistence mechanisms. */
export abstract class StoredLegacyBackup implements LegacyBackupPort {
  protected readonly source: LegacyBackupSource;
  private readonly store: LegacyBackupObjectStore;
  protected constructor(source: LegacyBackupSource, store: LegacyBackupObjectStore) {
    this.source = structuredClone(source); this.store = store;
  }
  protected abstract snapshot(id: string, sink?: LegacyBackupSink): Promise<LegacyBackupPlan>;
  protected async checkCurrent(plan: LegacyBackupPlan): Promise<void> {
    if (canonicalJson(await this.snapshot(plan.manifest.id)) !== canonicalJson(plan)) throw new EditRejected('backup-source-changed');
  }
  private assertSource(manifest: LegacyBackupManifest) {
    if (canonicalJson(manifest.source) !== canonicalJson(this.source)) throw new EditRejected('backup-source-identity');
  }
  inventory = async (id: string) => this.snapshot(id);
  plan = async (id: string) => {
    const result = await this.store.plan(id); if (result) this.assertSource(result.manifest); return result;
  };
  assertCurrent = async (plan: LegacyBackupPlan) => {
    const stable = structuredClone(plan); await assertLegacyBackupPlan(stable); this.assertSource(stable.manifest);
    await this.checkCurrent(stable);
  };
  capture = async (plan: LegacyBackupPlan) => {
    const stable = structuredClone(plan); await assertLegacyBackupPlan(stable); this.assertSource(stable.manifest);
    await this.store.prepare(structuredClone(stable));
    const expected = new Map(stable.manifest.entries.map(entry => [canonicalJson(entry.key), entry]));
    const captured = await this.snapshot(stable.manifest.id, async (entry, bytes) => {
      const wanted = expected.get(canonicalJson(entry.key));
      if (!wanted || canonicalJson(entry) !== canonicalJson(wanted)) throw new EditRejected('backup-source-changed');
      await this.store.putObject(structuredClone(wanted), bytes);
    });
    if (canonicalJson(captured) !== canonicalJson(stable)) throw new EditRejected('backup-source-changed');
    await this.assertCurrent(stable);
    await this.store.publish(structuredClone(stable.manifest));
    return (await this.load(stable.manifest.id))!;
  };
  load = async (id: string) => { const result = await this.store.manifest(id); if (result) this.assertSource(result); return result; };
  object = async (id: string, entry: LegacyBackupEntry) => {
    const manifest = await this.store.reference(id); if (manifest) this.assertSource(manifest);
    if (!manifest?.entries.some(value => canonicalJson(value) === canonicalJson(entry))) throw new EditRejected('backup-entry-missing');
    return this.store.object(entry);
  };
}
