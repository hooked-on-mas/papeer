import type { EditScope, ResourceInspectionPort, StoredResource } from '../ports.ts';
import { DurableEditRepository } from '../repository.ts';
import { EditPlanView, selectorKey, type EditMutation, type ScopeRead, type SnapshotEntry } from '../repositoryPlan.ts';
import { canonicalJson } from '../editModel.ts';
import { providerActivationMetadata, type ProviderOwnerPlan } from './providerOwnerPlan.ts';

/** Evaluate the existing dataset installer/transition rules before native I/O.
 * The owner adapter must prove the target footprint is still empty in the same
 * native transaction that applies these mutations and publishes the metadata.
 */
export async function prepareProviderInstall(plan: ProviderOwnerPlan, resources: readonly StoredResource[], inspection?: ResourceInspectionPort) {
  const metadata = await providerActivationMetadata(plan), scope: EditScope = { ...plan.publication.manifest.scope };
  if (canonicalJson(resources.map(resource => resource.metadata)) !== canonicalJson(plan.resources.map(ref => ref.metadata)))
    throw new Error('provider-staging-incomplete');
  const entries = new Map<string, SnapshotEntry>();
  const add = (read: ScopeRead, value: unknown) => entries.set(selectorKey(read), { read, value });
  add({ kind: 'control', identity: { accountId: scope.accountId, libraryId: scope.libraryId } }, {});
  for (const kind of ['roots', 'edits', 'intents'] as const) add({ kind, scope }, []);
  add({ kind: 'datasets', scope }, []);
  add({ kind: 'checkpoint-marker', scope, sha256: plan.publication.manifest.checkpointSha256 }, false);
  for (const { metadata: resource } of resources) {
    add({ kind: 'resource', scope, resourceId: resource.id }, undefined);
    add({ kind: 'resource-bytes', scope, sha256: resource.sha256 }, undefined);
  }
  // This object is a memory-only evaluator snapshot. It is never passed to a
  // native PlanDatabase as an adapter-issued CAS token or admission capability.
  const view = new EditPlanView(scope, { values: [...entries.values()], comparison: {} });
  const repository = new DurableEditRepository(scope, { transaction: run => run(view) }, inspection);
  const [prepared, published, active] = metadata.controls;
  if ((await repository.replaceDatasetControl(prepared, null)).status !== 'written') throw new Error('provider-control-conflict');
  for (const resource of resources) {
    await repository.storeResource({ id: resource.metadata.id, sha256: resource.metadata.sha256,
      mediaType: resource.metadata.mediaType, bytes: Uint8Array.from(resource.bytes), expected: resource.metadata });
  }
  await repository.installDataset(plan.publication.manifest, plan.publication.checkpoint);
  if ((await repository.replaceDatasetControl(published, prepared.id)).status !== 'written'
    || (await repository.replaceDatasetControl(active, published.id)).status !== 'written') throw new Error('provider-control-conflict');
  // The owner transaction enqueues the final control/access tuple exactly once,
  // alongside profile/peer/binding/intent. The shared repository writer handles
  // all actual content/resource/receipt/projection mutations below.
  const mutations: EditMutation[] = view.mutations.filter(mutation => mutation.kind !== 'put-control');
  return { ...metadata, mutations: structuredClone(mutations) };
}
