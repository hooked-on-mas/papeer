import { editSchema, type DatasetManifest, type DatasetPublication, type RepositoryCheckpoint } from './contracts.ts';
import { assertDatasetCheckpoint, assertDatasetManifest, checkpointHash, checkpointResourceIds } from './datasetManifest.ts';
import { canonicalJson, EditRejected } from './editModel.ts';
import { resourceHash } from './contentPublication.ts';
import type { ContentRepository, EditScope } from './ports.ts';
import type { EditTransferPort } from './replication.ts';
import type { CheckpointPublicationPort } from './checkpointPublication.ts';
import { validateStructure } from './schemaValidator.ts';

export type { DatasetPublication } from './contracts.ts';
export interface DatasetPublicationPort extends CheckpointPublicationPort {
  uploadDatasetManifest(manifest: DatasetManifest): Promise<void>;
}

/** Capture once. The caller retains this plan across an uncertain upload and reuses its IDs. */
export async function prepareDatasetPublication(repository: ContentRepository, manifestId: string, checkpointObjectId = crypto.randomUUID()): Promise<DatasetPublication> {
  const checkpoint = structuredClone(await repository.checkpoint()), resources: DatasetManifest['resources'] = [];
  for (const id of checkpointResourceIds(checkpoint)) {
    const resource = await repository.resourceMetadata(id);
    if (!resource) throw new EditRejected('dataset-resource-missing');
    resources.push(structuredClone(resource));
  }
  const manifest: DatasetManifest = { version: 1, id: manifestId, scope: { ...repository.scope },
    checkpointSha256: await checkpointHash(checkpoint), resources };
  await assertDatasetCheckpoint(manifest, checkpoint, repository.scope);
  return { manifest, checkpoint, checkpointObjectId };
}

/** Complete manifest is the final remote write. Partial resources/checkpoints are never publication. */
export async function publishDataset(publication: DatasetPublication, repository: Pick<ContentRepository, 'scope' | 'readResource'>,
  transfer: DatasetPublicationPort, signal?: AbortSignal): Promise<void> {
  const stable = structuredClone(publication);
  validateStructure(editSchema, 'Id', stable.checkpointObjectId);
  if (stable.checkpointObjectId === stable.manifest.id) throw new EditRejected('dataset-object-id-reused');
  await assertDatasetCheckpoint(stable.manifest, stable.checkpoint, repository.scope);
  // Immutable IDs/digests freeze dependencies without retaining every PDF body in memory.
  for (const expected of stable.manifest.resources) {
    signal?.throwIfAborted();
    const resource = await repository.readResource(expected.id); signal?.throwIfAborted();
    if (!resource) throw new EditRejected('dataset-resource-missing');
    if (canonicalJson(resource.metadata) !== canonicalJson(expected)) throw new EditRejected('resource-descriptor-changed');
    if (resource.bytes.byteLength !== resource.metadata.byteLength || await resourceHash(resource.bytes) !== resource.metadata.sha256) throw new EditRejected('resource-hash');
    signal?.throwIfAborted(); await transfer.uploadResource(resource);
  }
  signal?.throwIfAborted(); await transfer.uploadCheckpoint(stable.checkpoint, stable.checkpointObjectId);
  signal?.throwIfAborted(); await transfer.uploadDatasetManifest(stable.manifest);
}

/** Explicit manifest selection; listing order never chooses a dataset or a conflict winner. */
export async function readPublishedDataset(scope: EditScope, transfer: Pick<EditTransferPort, 'pull'>, manifestId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const incoming = await transfer.pull({ dataset: true }); signal?.throwIfAborted();
  const candidates = incoming.manifests?.filter(value => value.id === manifestId) ?? [];
  if (!candidates.length) throw new EditRejected('dataset-manifest-missing');
  const manifest = structuredClone(candidates[0]); assertDatasetManifest(manifest, scope);
  if (candidates.some(value => canonicalJson(value) !== canonicalJson(manifest))) throw new EditRejected('dataset-id-reused');
  let checkpoint: RepositoryCheckpoint | undefined;
  for (const value of incoming.checkpoints ?? []) {
    if (await checkpointHash(value) === manifest.checkpointSha256) { checkpoint = structuredClone(value); break; }
  }
  if (!checkpoint) throw new EditRejected('dataset-checkpoint-missing');
  await assertDatasetCheckpoint(manifest, checkpoint, scope);
  return { manifest, checkpoint };
}

export async function importPublishedDataset(repository: ContentRepository,
  transfer: Pick<EditTransferPort, 'pull' | 'downloadResource' | 'imported'>, manifestId: string, peerId: string, signal?: AbortSignal): Promise<DatasetManifest> {
  const { manifest, checkpoint } = await readPublishedDataset(repository.scope, transfer, manifestId, signal);
  for (const expected of manifest.resources) {
    signal?.throwIfAborted();
    const stored = await repository.resourceMetadata(expected.id);
    if (stored) {
      if (canonicalJson(stored) !== canonicalJson(expected)) throw new EditRejected('resource-id-reused');
      const resource = await repository.readResource(expected.id);
      if (!resource || resource.bytes.byteLength !== expected.byteLength || await resourceHash(resource.bytes) !== expected.sha256) throw new EditRejected('resource-hash');
      continue;
    }
    const resource = await transfer.downloadResource(expected); signal?.throwIfAborted();
    if (canonicalJson(resource.metadata) !== canonicalJson(expected)) throw new EditRejected('resource-descriptor-changed');
    await repository.storeResource({ id: expected.id, sha256: expected.sha256, mediaType: expected.mediaType, bytes: resource.bytes, expected });
  }
  signal?.throwIfAborted(); await repository.installDataset(manifest, checkpoint);
  for (const { batch } of checkpoint.edits) {
    signal?.throwIfAborted();
    if (!(await repository.receipt(batch.id))?.importedBy.includes(peerId)) {
      await transfer.imported(batch.id, peerId);
      await repository.acknowledgeImport(batch.id, peerId);
    }
  }
  return manifest;
}
