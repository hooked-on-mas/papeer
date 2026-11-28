import { validateDatasetControlRecord, type DatasetControlRecord, type DatasetIdentity, type DatasetManifest, type DatasetScope, type EditRecord, type RepositoryCheckpoint, type Snapshot } from './contracts.ts';
import { assertDatasetCheckpoint, assertDatasetManifest } from './datasetManifest.ts';
import { canonicalJson, EditRejected } from './editModel.ts';
import type { StoredEdit } from './repository.ts';
import type { PendingEditIntent } from './ports.ts';

export type DatasetAccess = { activeEpoch: string | null; stagingEpoch: string | null; frozen: boolean; epochs: string[] };
export type DatasetScopeState = { roots: Snapshot[]; edits: StoredEdit[]; intents: PendingEditIntent[]; datasets: DatasetManifest[] };
export const datasetIdentity = ({ accountId, libraryId }: DatasetScope): DatasetIdentity => ({ accountId, libraryId });
export const datasetIdentityKey = (scope: DatasetIdentity) => JSON.stringify([scope.accountId, scope.libraryId]);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export const datasetRecord = ({ batch, history, publication }: StoredEdit): EditRecord => ({ batch, ...(history ? { history } : {}), ...(publication ? { publication } : {}) });
export function datasetAccess(record: DatasetControlRecord): DatasetAccess {
  const frozen = ['prepared', 'published'].includes(record.transition.phase);
  return { activeEpoch: record.active?.scope.epoch ?? null, stagingEpoch: frozen ? record.transition.publication.manifest.scope.epoch : null,
    frozen, epochs: [...record.epochs] };
}
export function assertDatasetAccess(access: DatasetAccess | undefined, scope: DatasetScope, mode: 'edit' | 'stage'): void {
  if (!access) return; // Explicit staging before the first control record, never an active composition.
  if (mode === 'edit' ? access.frozen || access.activeEpoch !== scope.epoch
    : access.frozen ? access.stagingEpoch !== scope.epoch : access.activeEpoch !== scope.epoch && access.epochs.includes(scope.epoch)) {
    throw new EditRejected(access.frozen ? 'dataset-frozen' : 'dataset-inactive');
  }
}
export function assertDatasetControl(record: unknown, identity: DatasetIdentity): asserts record is DatasetControlRecord {
  validateDatasetControlRecord(record);
  if (!same(record.identity, identity)) throw new EditRejected('dataset-scope');
  const { transition, active, epochs } = record, target = transition.publication.manifest;
  if (transition.mode === 'initialize' && (transition.source !== null || transition.phase !== 'activated' || record.id !== transition.id || epochs.length !== 1)) throw new EditRejected('dataset-initialize');
  for (const manifest of [target, transition.source, active]) if (manifest) {
    assertDatasetManifest(manifest);
    if (!same(datasetIdentity(manifest.scope), identity)) throw new EditRejected('dataset-scope');
  }
  if (target.id === transition.publication.checkpointObjectId) throw new EditRejected('dataset-object-id-reused');
  if (transition.source && (transition.source.scope.epoch === target.scope.epoch || transition.source.id === target.id)) throw new EditRejected('dataset-epoch-reused');
  if (new Set(epochs).size !== epochs.length || !epochs.includes(target.scope.epoch)
    || (transition.source && !epochs.includes(transition.source.scope.epoch))) throw new EditRejected('dataset-epochs');
  if (!same(active, transition.phase === 'activated' ? target : transition.source)) throw new EditRejected('dataset-active-mismatch');
}
export async function assertDatasetControlPlan(record: DatasetControlRecord, identity: DatasetIdentity) {
  assertDatasetControl(record, identity);
  await assertDatasetCheckpoint(record.transition.publication.manifest, record.transition.publication.checkpoint, record.transition.publication.manifest.scope);
  if (record.transition.mode === 'initialize') assertEmptyInitialPublication(record.transition.publication);
}
export function assertDatasetControlTransition(previous: DatasetControlRecord | undefined, next: DatasetControlRecord): void {
  const run = next.transition, old = previous?.transition;
  if (run.mode === 'initialize') throw new EditRejected('dataset-initialize-requires-bundle');
  if (!previous || old!.id !== run.id) {
    if (previous && !['activated', 'rolled-back'].includes(old!.phase)) throw new EditRejected('dataset-transition-pending');
    if (run.phase !== 'prepared' || !same(run.source, previous?.active ?? null)) throw new EditRejected('dataset-transition-source');
    const epoch = run.publication.manifest.scope.epoch;
    if (previous?.epochs.includes(epoch) || !same(next.epochs, [...(previous?.epochs ?? []), epoch])) throw new EditRejected('dataset-epoch-reused');
    return;
  }
  if (!same(previous.identity, next.identity) || !same(previous.epochs, next.epochs)
    || old!.mode !== run.mode || !same(old!.source, run.source) || !same(old!.publication, run.publication)) throw new EditRejected('dataset-plan-changed');
  const allowed: Record<DatasetControlRecord['transition']['phase'], DatasetControlRecord['transition']['phase'][]> = {
    prepared: ['published', 'rolled-back'], published: ['activated', 'rolled-back'], activated: ['rolled-back'], 'rolled-back': [],
  };
  if (!allowed[old!.phase].includes(run.phase)) throw new EditRejected('dataset-phase');
}
/** A frozen source must be wholly represented; a receiver cannot rely on unrelated local data. */
export function assertDatasetContained(state: DatasetScopeState, checkpoint: RepositoryCheckpoint, exact = false): void {
  if (state.intents.length) throw new EditRejected('dataset-pending-intents');
  const roots = new Map(checkpoint.roots.map(root => [root.id, root])), edits = new Map(checkpoint.edits.map(edit => [edit.batch.id, edit]));
  if (state.roots.some(root => !same(root, roots.get(root.id) ?? null)) || state.edits.some(edit => !same(datasetRecord(edit), edits.get(edit.batch.id) ?? null))
    || (exact && (state.roots.length !== roots.size || state.edits.length !== edits.size))) throw new EditRejected('dataset-content-changed');
}
export function copiedDatasetReceipts(source: DatasetScopeState, target: DatasetScopeState): StoredEdit[] {
  const byId = new Map(target.edits.map(edit => [edit.batch.id, edit]));
  return source.edits.map(edit => {
    const destination = byId.get(edit.batch.id);
    if (!destination || !same(datasetRecord(edit), datasetRecord(destination))) throw new EditRejected('dataset-content-changed');
    return { ...destination, receipt: { ...destination.receipt,
      upload: edit.receipt.upload === 'pending' ? 'pending' : destination.receipt.upload,
      importedBy: [...new Set([...destination.receipt.importedBy, ...edit.receipt.importedBy])] } };
  });
}

/** Call after structural and checkpoint validation; the host must commit the whole bundle atomically. */
export function assertEmptyInitialPublication(publication: DatasetControlRecord['transition']['publication']): void {
  const { checkpoint, manifest } = publication;
  const root = checkpoint.roots[0];
  if (manifest.resources.length || checkpoint.edits.length || checkpoint.roots.length !== 1 || root.kind !== 'library' || root.id !== checkpoint.libraryId || root.items.length || root.folders.length || root.links.length || root.deletions.length) throw new EditRejected('dataset-initialize-content');
}
