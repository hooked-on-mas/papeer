import { createPlannedRepositoryDraft, type RepositoryOperationHost } from '../../src/runtime/edits/repositoryFacadeDraft.ts';
import type { EditScope, ResourceInspectionPort } from '../../src/runtime/edits/ports.ts';
import { createPlanEvidence } from '../../src/runtime/edits/repositoryExecution.ts';
import { EditPlanMemoryDatabase } from './editPlanMemoryDatabase.ts';

/** Only for Core tests: no host grant, native transaction or durability proof. */
export function createPlanTestRepository(scope: EditScope, database = new EditPlanMemoryDatabase(), inspection?: ResourceInspectionPort) {
  const host: RepositoryOperationHost = {
    createEvidence: (_operation, input) => createPlanEvidence(JSON.stringify(input)),
    run: async (_operation, evidence, action) => {
      const recorder = evidence.bind({});
      return action({
      capture: database.capture.bind(database),
      compareAndApply: async (...args) => {
        const attempt = recorder.startAttempt(); attempt.sent();
        try {
          const result = await database.compareAndApply(...args);
          if (result.status === 'committed') attempt.committed(); else attempt.casNoWrite();
          return result;
        } catch (error) { attempt.aborted(); throw error; }
      },
      });
    },
  };
  return createPlannedRepositoryDraft(scope, host, inspection);
}
