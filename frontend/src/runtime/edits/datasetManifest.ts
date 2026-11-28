import { validateDatasetManifest, validateRepositoryCheckpoint, type DatasetManifest, type RepositoryCheckpoint } from './contracts.ts';
import { assertResourceBindings, assertResourceMetadata, batchResourceIds, publicationResourceIds, snapshotResourceIds } from './contentPublication.ts';
import { assertSnapshot, canonicalJson, EditRejected } from './editModel.ts';
import { assertEditRecord, validateHistories } from './editRecord.ts';
import { EditGraph } from './editGraph.ts';
import { editContentHash } from './editContentHash.ts';
import type { EditScope } from './ports.ts';

export const checkpointHash = (checkpoint: RepositoryCheckpoint) => editContentHash(checkpoint);
/** Include historical backgrounds, deleted/translated pages and unresolved branches, not just visible heads. */
export function checkpointResourceIds(checkpoint: RepositoryCheckpoint): string[] {
  validateRepositoryCheckpoint(checkpoint);
  const ids = new Set<string>();
  for (const root of checkpoint.roots) {
    assertSnapshot(root);
    for (const id of snapshotResourceIds(root)) ids.add(id);
  }
  for (const record of checkpoint.edits) {
    assertEditRecord(record);
    if (record.batch.libraryId !== checkpoint.libraryId) throw new EditRejected('batch-scope');
    for (const id of batchResourceIds(record.batch)) ids.add(id);
    if (record.publication) for (const id of publicationResourceIds(record.publication)) ids.add(id);
  }
  return [...ids].sort();
}
export function assertDatasetManifest(value: unknown, scope?: EditScope): asserts value is DatasetManifest {
  validateDatasetManifest(value);
  if (scope && canonicalJson(value.scope) !== canonicalJson(scope)) throw new EditRejected('dataset-scope');
  value.resources.forEach(assertResourceMetadata);
  const ids = value.resources.map(resource => resource.id);
  if (new Set(ids).size !== ids.length || canonicalJson(ids) !== canonicalJson([...ids].sort())) throw new EditRejected('dataset-resource-order');
}
export async function assertDatasetCheckpoint(manifest: DatasetManifest, checkpoint: RepositoryCheckpoint, scope: EditScope): Promise<void> {
  assertDatasetManifest(manifest, scope);
  const ids = checkpointResourceIds(checkpoint);
  if (checkpoint.libraryId !== scope.libraryId) throw new EditRejected('dataset-scope');
  if (canonicalJson(ids) !== canonicalJson(manifest.resources.map(resource => resource.id))) throw new EditRejected('dataset-resources');
  if (await checkpointHash(checkpoint) !== manifest.checkpointSha256) throw new EditRejected('dataset-checkpoint-hash');
  const roots = new Map(checkpoint.roots.map(root => [root.id, root]));
  if (roots.size !== checkpoint.roots.length) throw new EditRejected('checkpoint-duplicate-root');
  if (roots.get(scope.libraryId)?.kind !== 'library' || checkpoint.roots.some(root => root.kind === 'library' && root.id !== scope.libraryId)) throw new EditRejected('checkpoint-library');
  if (new Set(checkpoint.edits.map(record => record.batch.id)).size !== checkpoint.edits.length) throw new EditRejected('checkpoint-duplicate-batch');
  const records = new Map(checkpoint.edits.map(record => [record.batch.id, record]));
  validateHistories(records, checkpoint.roots, new Set(records.keys()));
  const resources = new Map(manifest.resources.map(resource => [resource.id, resource]));
  for (const root of roots.values()) {
    const batches = checkpoint.edits.filter(record => record.batch.targetId === root.id).map(record => record.batch);
    const graph = new EditGraph({ version: 1, libraryId: scope.libraryId, root, batches });
    const rejected = Object.values(graph.getView().rejected)[0]; if (rejected) throw new EditRejected(rejected);
    for (const id of [root.version, ...batches.map(batch => batch.id)]) {
      const snapshot = graph.snapshot(id); if (!snapshot) continue;
      await assertResourceBindings(snapshot, async id => resources.get(id));
      if (snapshot.kind === 'library') for (const item of snapshot.items) {
        if (item.kind !== 'attachment' && roots.get(item.id)?.kind !== (item.kind === 'markdown' ? 'markdown' : 'document')) throw new EditRejected('dataset-content-missing');
      }
    }
  }
}
