import type { LegacyBackupEntry, LegacyBackupManifest, LegacyBackupPlan } from '../../runtime/edits/contracts.ts';
import { assertLegacyBackupManifest, assertLegacyBackupPlan, type LegacyBackupPort } from '../../migrations/legacyBackup.ts';
import type { DesktopEditRequest } from './editRepository.ts';

export function createDesktopLegacyBackup(request: DesktopEditRequest, area: 'legacy' | 'canonical' | 'device' = 'legacy'): LegacyBackupPort {
  const call = <T>(path: string, body: object) => request<T>('/api/edits/legacy-backup/' + path, { ...body, area });
  return {
    inventory: async id => {
      const result = await call<LegacyBackupPlan>('inventory', { id }); await assertLegacyBackupPlan(result); return result;
    },
    capture: async plan => {
      const result = await call<LegacyBackupManifest>('capture', { plan }); await assertLegacyBackupManifest(result); return result;
    },
    plan: async id => {
      const result = await call<LegacyBackupPlan | null>('plan', { id });
      if (result) await assertLegacyBackupPlan(result); return result ?? undefined;
    },
    load: async id => {
      const result = await call<LegacyBackupManifest | null>('load', { id });
      if (result) await assertLegacyBackupManifest(result); return result ?? undefined;
    },
    assertCurrent: async plan => { await call('assert-current', { plan }); },
    object: async (id: string, entry: LegacyBackupEntry) => {
      const result = await call<{ dataBase64: string }>('object', { id, entry });
      return Uint8Array.from(atob(result.dataBase64), char => char.charCodeAt(0));
    },
  };
}
