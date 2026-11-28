import { validateLegacyBackupSource, type LegacyBackupManifest, type LegacyBackupPlan, type LegacyBackupSource } from '../../runtime/edits/contracts.ts';
import { assertLegacyBackupManifest, assertLegacyBackupPlan, type LegacyBackupObjectStore } from '../../migrations/legacyBackup.ts';
import type { DesktopEditRequest } from './editRepository.ts';
import { canonicalJson, EditRejected } from '../../runtime/edits/editModel.ts';

/** The same source reader/publication procedure can persist artifacts in native files or browser IndexedDB. */
export function createDesktopLegacyBackupStore(source: LegacyBackupSource, request: DesktopEditRequest): LegacyBackupObjectStore {
  const stable = structuredClone(source); validateLegacyBackupSource(stable);
  const call = <T>(path: string, body: object) => request<T>('/api/edits/backup-artifacts/' + path, structuredClone({ source: stable, ...body })).then(value => structuredClone(value));
  const sameSource = (value: LegacyBackupManifest) => {
    if (canonicalJson(value.source) !== canonicalJson(stable)) throw new EditRejected('backup-source-identity');
  };
  const manifest = async (path: string, id: string) => {
    const value = await call<LegacyBackupManifest | null>(path, { id });
    if (value) { await assertLegacyBackupManifest(value); sameSource(value); if (value.id !== id) throw new EditRejected('backup-manifest-identity'); }
    return value ?? undefined;
  };
  return {
    prepare: async plan => { await call('prepare', { plan }); },
    putObject: async (entry, bytes) => {
      let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await call('put-object', { entry, dataBase64: btoa(text) });
    },
    publish: async manifest => { await call('publish', { manifest }); },
    plan: async id => {
      const value = await call<LegacyBackupPlan | null>('plan', { id });
      if (value) { await assertLegacyBackupPlan(value); sameSource(value.manifest); if (value.manifest.id !== id) throw new EditRejected('backup-plan-identity'); }
      return value ?? undefined;
    },
    reference: id => manifest('reference', id),
    manifest: id => manifest('manifest', id),
    object: async entry => {
      const { dataBase64 } = await call<{ dataBase64: string }>('object', { entry });
      return Uint8Array.from(atob(dataBase64), value => value.charCodeAt(0));
    },
  };
}
