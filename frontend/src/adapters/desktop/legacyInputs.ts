import type { LegacyMigrationInputStore } from '../../migrations/legacyInputs.ts';
import { assertMigrationInputSet } from '../../migrations/legacyInputs.ts';
import { validateLegacyMigrationHold, type LegacyMigrationHold, type LegacyMigrationInputSet } from '../../runtime/edits/contracts.ts';
import { EditRejected } from '../../runtime/edits/editModel.ts';
import type { DesktopEditRequest } from './editRepository.ts';

export function createDesktopLegacyInputs(request: DesktopEditRequest): LegacyMigrationInputStore {
  return {
    readHold: async () => {
      const hold = await request<LegacyMigrationHold | null>('/api/edits/legacy-startup/read', {});
      if (hold !== null) validateLegacyMigrationHold(hold); return hold ?? undefined;
    },
    prepareInputs: async value => {
      const stable = structuredClone(value); await assertMigrationInputSet(stable);
      await request('/api/edits/legacy-inputs/prepare', { inputSet: stable });
    },
    inputs: async runId => {
      const value = await request<LegacyMigrationInputSet | null>('/api/edits/legacy-inputs/read', { runId });
      if (value !== null) {
        await assertMigrationInputSet(value);
        if (value.catalog.runId !== runId) throw new EditRejected('migration-input-set-identity');
      }
      return value ?? undefined;
    },
  };
}
