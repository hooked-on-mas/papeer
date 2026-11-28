import { canonicalJson } from '../../runtime/edits/editModel.ts';
import { validateRepositoryCheckpoint, type DatasetManifest, type EditRecord, type ResourceMetadata, type RepositoryCheckpoint } from '../../runtime/edits/contracts.ts';
import type { EditScope } from '../../runtime/edits/ports.ts';
import { scopeKey } from '../../runtime/edits/repository.ts';
import type { EditTransferPort } from '../../runtime/edits/replication.ts';
import type { StoredResource } from '../../runtime/edits/ports.ts';
import { assertResourceMetadata, resourceHash } from '../../runtime/edits/contentPublication.ts';
import { assertEditRecord } from '../../runtime/edits/editRecord.ts';
import { assertDatasetManifest } from '../../runtime/edits/datasetManifest.ts';

/** Binary/authenticated I/O only. Both hosts use the envelope rules below. */
export interface DriveEditStorage {
  bindAccount(accountId: string): Promise<DriveEditStorage>;
  assertCurrent(): void | Promise<void>;
  sharedEditFiles(namespace: string): Promise<{ id: string; version?: string | null; kind?: string | null }[]>;
  annotation(id: string): Promise<unknown>;
  saveSharedEdit(namespace: string, folderId: string, id: string, value: unknown): Promise<void>;
  sharedResource(namespace: string, metadata: ResourceMetadata, blobId: string): Promise<Uint8Array>;
  saveSharedResource(namespace: string, folderId: string, resource: StoredResource): Promise<void>;
}

/** Drive IDs, query syntax, authentication and upload framing stop at this adapter. */
export function createDriveEditTransfer(session: DriveEditStorage, scope: EditScope, folderId: string): EditTransferPort & {
  uploadCheckpoint(checkpoint: RepositoryCheckpoint, objectId: string): Promise<void>;
  uploadDatasetManifest(manifest: DatasetManifest): Promise<void>;
} {
  scope = Object.freeze({ ...scope });
  let binding: Promise<DriveEditStorage> | undefined = session.bindAccount(scope.accountId);
  void binding.catch(() => undefined); // Preserve rejection for the caller without an idle unhandled rejection.
  const boundSession = async () => {
    const attempt = binding ??= session.bindAccount(scope.accountId);
    try { return await attempt; }
    catch (error) {
      // Failed initial identity lookup sent no scoped payload and may retry.
      // Once acquired, the lease never rebinds after an authentication change.
      if (binding === attempt) binding = undefined;
      throw error;
    }
  };
  return transferWithReceiver(() => boundSession(), scope, folderId);
}

/** Host-private composition: identity was already pinned by the fixed provider host.
 * Canonical account UUIDs never rebind a Google credential receiver.
 */
export function createBoundDriveEditTransfer(session: Omit<DriveEditStorage, 'bindAccount'>, scope: EditScope, folderId: string) {
  return transferWithReceiver(async () => { await session.assertCurrent(); return session; }, scope, folderId);
}

function transferWithReceiver(boundSession: () => Promise<Omit<DriveEditStorage, 'bindAccount'>>, scope: EditScope, folderId: string): EditTransferPort & {
  uploadCheckpoint(checkpoint: RepositoryCheckpoint, objectId: string): Promise<void>; uploadDatasetManifest(manifest: DatasetManifest): Promise<void>;
} {
  scope = Object.freeze({ ...scope });
  const namespace = crypto.subtle.digest('SHA-256', new TextEncoder().encode(scopeKey(scope))).then(value =>
    [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
  const seen = new Map<string, { version?: string | null; digest: string; kind: string }>();
  const pending = new Map<string, Record<string, unknown>>();
  const references = new Map<string, { metadata: ResourceMetadata; blobIds: string[] }>();
  return {
    async pull(options) {
      const session = await boundSession();
      const edits: EditRecord[] = [], imports: { batchId: string; peerId: string }[] = [];
      const checkpoints: RepositoryCheckpoint[] = [];
      const manifests: DatasetManifest[] = [];
      const resources = new Map<string, ResourceMetadata>();
      for (const file of await session.sharedEditFiles(await namespace)) {
        const previous = seen.get(file.id);
        const kind = file.kind ?? previous?.kind;
        const datasetObject = kind === 'dataset-manifest' || kind === 'repository-checkpoint';
        if (datasetObject && !options?.dataset) continue;
        let value: unknown;
        let digest = previous?.digest;
        if (previous && previous.version === file.version && !datasetObject) {
          value = pending.get(file.id);
          if (!value) continue;
        } else {
          value = await session.annotation(file.id);
          digest = await resourceHash(new TextEncoder().encode(canonicalJson(value)));
          if (previous && digest !== previous.digest) throw new Error('immutable-drive-file-changed');
        }
        const data = value as { kind?: string; batchId?: unknown; peerId?: unknown; record?: EditRecord; metadata?: ResourceMetadata; blobId?: unknown; checkpoint?: RepositoryCheckpoint; manifest?: DatasetManifest };
        if (data?.kind === 'import-receipt') {
          if (typeof data.batchId !== 'string' || !/^[0-9a-f-]{36}$/.test(data.batchId)
            || typeof data.peerId !== 'string' || !/^[0-9a-f-]{36}$/.test(data.peerId)
            || Object.keys(data).sort().join(',') !== 'batchId,kind,peerId') throw new Error('invalid-import-receipt');
          imports.push({ batchId: data.batchId, peerId: data.peerId });
        } else if (data?.kind === 'dataset-manifest') {
          if (Object.keys(data).sort().join(',') !== 'kind,manifest') throw new Error('invalid-dataset-envelope');
          assertDatasetManifest(data.manifest, scope); if (options?.dataset) manifests.push(data.manifest);
        } else if (data?.kind === 'repository-checkpoint') {
          if (Object.keys(data).sort().join(',') !== 'checkpoint,kind') throw new Error('invalid-checkpoint-envelope');
          validateRepositoryCheckpoint(data.checkpoint);
          if (data.checkpoint.libraryId !== scope.libraryId) throw new Error('batch-scope');
          if (options?.dataset) checkpoints.push(data.checkpoint);
        } else if (data?.kind === 'edit-record') {
          if (Object.keys(data).sort().join(',') !== 'kind,record') throw new Error('invalid-edit-envelope');
          assertEditRecord(data.record);
          if (data.record.batch.libraryId !== scope.libraryId) throw new Error('batch-scope');
          edits.push(data.record);
        } else if (data?.kind === 'resource') {
          if (Object.keys(data).sort().join(',') !== 'blobId,kind,metadata' || typeof data.blobId !== 'string') throw new Error('invalid-resource-envelope');
          assertResourceMetadata(data.metadata);
          const old = references.get(data.metadata.id)?.metadata;
          if (old && canonicalJson(old) !== canonicalJson(data.metadata)) throw new Error('resource-id-reused');
          resources.set(data.metadata.id, data.metadata);
          const reference = references.get(data.metadata.id) ?? { metadata: data.metadata, blobIds: [] };
          if (!reference.blobIds.includes(data.blobId)) reference.blobIds.push(data.blobId);
          references.set(data.metadata.id, reference);
        } else throw new Error('invalid-edit-envelope');
        seen.set(file.id, { version: file.version, digest: digest!, kind: data.kind });
        if (data.kind !== 'dataset-manifest' && data.kind !== 'repository-checkpoint') pending.set(file.id, data);
      }
      await session.assertCurrent();
      return structuredClone({ edits, imports, resources: [...resources.values()], checkpoints, manifests });
    },
    acknowledgePull: async (batchIds, receipts, resourceIds) => {
      await (await boundSession()).assertCurrent();
      const batches = new Set(batchIds), imports = new Set(receipts), resources = new Set(resourceIds);
      for (const [id, data] of pending) {
        const handled = data.kind === 'edit-record' ? batches.has((data.record as EditRecord).batch.id)
          : data.kind === 'import-receipt' ? imports.has(`${data.batchId}:${data.peerId}`)
          : data.kind === 'resource' && resources.has((data.metadata as ResourceMetadata).id);
        if (handled) pending.delete(id);
      }
    },
    uploadDatasetManifest: async manifest => {
      const stable = structuredClone(manifest);
      const session = await boundSession(); assertDatasetManifest(stable, scope);
      await session.saveSharedEdit(await namespace, folderId, stable.id, { kind: 'dataset-manifest', manifest: stable });
      await session.assertCurrent();
    },
    uploadCheckpoint: async (checkpoint, objectId) => {
      checkpoint = structuredClone(checkpoint);
      const session = await boundSession();
      validateRepositoryCheckpoint(checkpoint);
      if (checkpoint.libraryId !== scope.libraryId) throw new Error('batch-scope');
      await session.saveSharedEdit(await namespace, folderId, objectId, { kind: 'repository-checkpoint', checkpoint });
      await session.assertCurrent();
    },
    upload: async record => {
      const stable = structuredClone(record);
      const session = await boundSession();
      assertEditRecord(stable); if (stable.batch.libraryId !== scope.libraryId) throw new Error('batch-scope');
      await session.saveSharedEdit(await namespace, folderId, stable.batch.id, { kind: 'edit-record', record: stable });
      await session.assertCurrent();
    },
    uploadResource: async resource => {
      resource = structuredClone(resource);
      const session = await boundSession();
      assertResourceMetadata(resource.metadata);
      if (resource.bytes.byteLength !== resource.metadata.byteLength || await resourceHash(resource.bytes) !== resource.metadata.sha256) throw new Error('resource-hash');
      await session.saveSharedResource(await namespace, folderId, resource);
      await session.assertCurrent();
    },
    downloadResource: async metadata => {
      metadata = structuredClone(metadata);
      const session = await boundSession();
      const reference = references.get(metadata.id);
      if (!reference || canonicalJson(reference.metadata) !== canonicalJson(metadata)) throw new Error('resource-descriptor-changed');
      let failure: unknown = new Error('resource-unavailable');
      for (const blobId of reference.blobIds) {
        try {
          const bytes = await session.sharedResource(await namespace, metadata, blobId);
          await session.assertCurrent();
          return { metadata, bytes };
        }
        catch (error) { failure = error; }
      }
      throw failure;
    },
    imported: async (batchId, peerId) => {
      const session = await boundSession();
      await session.saveSharedEdit(await namespace, folderId, `${batchId}-${peerId}`, { kind: 'import-receipt', batchId, peerId });
      await session.assertCurrent();
    },
  };
}
