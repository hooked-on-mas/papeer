import type { ContentRepository, StoredResource } from './ports.ts';
import type { RepositoryCheckpoint } from './contracts.ts';
import { checkpointResourceIds } from './datasetManifest.ts';

export interface CheckpointPublicationPort {
  uploadResource(resource: StoredResource): Promise<void>;
  uploadCheckpoint(checkpoint: RepositoryCheckpoint, objectId: string): Promise<void>;
}

/** Freeze once per publication attempt, durable dependencies first, complete checkpoint last.
 * This is a dataset component, not its active/complete manifest or a remote upload receipt.
 */
export async function publishRepositoryCheckpoint(repository: ContentRepository, transfer: CheckpointPublicationPort, objectId: string) {
  const checkpoint = structuredClone(await repository.checkpoint());
  for (const id of checkpointResourceIds(checkpoint)) {
    const resource = await repository.readResource(id);
    if (!resource) throw new Error('missing-resource');
    await transfer.uploadResource(resource);
  }
  await transfer.uploadCheckpoint(checkpoint, objectId);
  return checkpoint;
}
