import { DurableEditRepository, type EditDatabase } from './repository.ts';
import { executeRepositoryPlan, type PlanEvidence } from './repositoryExecution.ts';
import type { PlanDatabase, RepositoryOperation } from './repositoryPlan.ts';
import { seedRepositoryReads, repositoryDependencies, type RepositoryMethod } from './repositoryDependencies.ts';
import type { ContentRepository, EditScope, ResourceInspectionPort } from './ports.ts';

/** The host owns the gate and the private evidence until final delivery has been classified. */
export interface RepositoryOperationHost {
  createEvidence(operation: RepositoryOperation, fixedInput: readonly unknown[]): PlanEvidence;
  run<T>(operation: RepositoryOperation, evidence: PlanEvidence, action: (database: PlanDatabase) => Promise<T>): Promise<T>;
}
const operations: Record<RepositoryMethod, { operation: RepositoryOperation; write: boolean }> = {
  datasetControl: { operation: 'dataset-control', write: false }, replaceDatasetControl: { operation: 'replace-dataset-control', write: true },
  installedDatasets: { operation: 'datasets', write: false }, installDataset: { operation: 'install-dataset', write: true },
  readIntent: { operation: 'read-intent', write: false }, pendingIntents: { operation: 'pending-intents', write: false }, replaceIntent: { operation: 'replace-intent', write: true },
  initialize: { operation: 'initialize', write: true }, read: { operation: 'read', write: false }, checkpoint: { operation: 'checkpoint', write: false }, installCheckpoint: { operation: 'install-checkpoint', write: true },
  storeResource: { operation: 'store-resource', write: true }, readResource: { operation: 'read-resource', write: false }, resourceMetadata: { operation: 'resource-metadata', write: false },
  commit: { operation: 'commit', write: true }, publish: { operation: 'publish', write: true }, receive: { operation: 'receive-records', write: true },
  receiveRecords: { operation: 'receive-records', write: true }, receivePublications: { operation: 'receive-records', write: true }, receipt: { operation: 'receipt', write: false },
  pending: { operation: 'pending', write: false }, pendingRecords: { operation: 'pending-records', write: false }, pendingPublications: { operation: 'pending-publications', write: false },
  acknowledgeUpload: { operation: 'acknowledge-upload', write: true }, acknowledgeImport: { operation: 'acknowledge-import', write: true },
};
/** Construct a fresh evaluator and database closure per public call; no mutable current-operation field. */
export function createPlannedRepositoryDraft(scope: EditScope, host: RepositoryOperationHost, inspection?: ResourceInspectionPort): ContentRepository {
  const stableScope = Object.freeze(structuredClone(scope));
  const facade: Partial<ContentRepository> & { scope: EditScope } = { scope: stableScope };
  for (const method of Object.keys(operations) as RepositoryMethod[]) {
    const config = operations[method];
    const invoke = (...values: unknown[]) => {
      const fixed = structuredClone(values);
      return (async () => {
        let evidence: PlanEvidence | undefined;
        try {
          evidence = host.createEvidence(config.operation, structuredClone(fixed));
          const value = await host.run(config.operation, evidence, async database => {
            const bound: EditDatabase = { transaction: run => executeRepositoryPlan({ operation: config.operation, scope: stableScope, database,
              reads: seedRepositoryReads(stableScope, method, fixed), write: config.write, dependencies: view => Promise.resolve(repositoryDependencies(view, method, fixed)), plan: run }) };
            const evaluator = new DurableEditRepository(stableScope, bound, inspection);
            return (evaluator[method] as unknown as (...args: unknown[]) => Promise<unknown>)(...fixed);
          });
          // The same private evidence survives action completion and the gate's delivery fence.
          if ((method === 'commit' || method === 'publish') && value && typeof value === 'object' && 'status' in value && value.status === 'aborted'
              && evidence.view.attempts.some(attempt => attempt === 'sent' || attempt === 'unknown' || attempt === 'committed'))
            return { status: 'unknown', reason: 'repository-outcome-unknown' };
          return value;
        } catch (error) {
          if (method === 'commit' || method === 'publish') return { status: 'unknown', reason: String(error) };
          throw error;
        }
      })();
    };
    Object.defineProperty(facade, method, { value: invoke, enumerable: true, writable: false });
  }
  return facade as ContentRepository;
}
