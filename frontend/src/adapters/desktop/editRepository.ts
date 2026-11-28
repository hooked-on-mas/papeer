import type { ContentPublication, EditBatch, ResourceMetadata, Snapshot, RepositoryCheckpoint, EditIntentRecord, EditRecord, DatasetManifest, DatasetControlRecord } from '../../runtime/edits/contracts.ts';
import type { BatchReceipt, CommitResult, ContentRepository, EditScope, HistoryRecord, RepositoryState, IntentWriteResult, PendingEditIntent } from '../../runtime/edits/ports.ts';
import { assertResourceMetadata, publicationItem, resourceHash } from '../../runtime/edits/contentPublication.ts';

/** Host supplies the authenticated HTTP transport; all writes remain idempotent by batch ID. */
export type DesktopEditRequest = <T>(path: string, body: unknown) => Promise<T>;
export function createDesktopEditRepository(scope: EditScope, request: DesktopEditRequest): ContentRepository {
  const stableScope = Object.freeze({ ...scope });
  const call = <T>(path: string, body: object) => request<T>(`/api/edits/${path}`, { scope: stableScope, ...body });
  const commitRemote = async (path: 'commit' | 'publish', payload: object, batch: EditBatch): Promise<CommitResult> => {
    try {
      const result = await call<CommitResult>(path, payload);
      if (result?.status === 'durable') {
        const receipt = result.receipt;
        if (receipt?.durable === true && receipt.id === batch.id && receipt.targetId === batch.targetId
          && ['pending', 'accepted'].includes(receipt.upload) && Array.isArray(receipt.importedBy)
          && receipt.importedBy.every(peer => typeof peer === 'string')) return result;
      } else if (['aborted', 'unknown'].includes(result?.status) && typeof result.reason === 'string') return result;
      return { status: 'unknown', reason: 'invalid-commit-response' };
    } catch (error) { return { status: 'unknown', reason: String(error) }; }
  };
  return {
    scope: stableScope,
    datasetControl: () => request<DatasetControlRecord | null>('/api/edits/dataset-control', stableScope).then(value => value ?? undefined),
    replaceDatasetControl: (record, expectedId) => call<{ status: 'written' | 'conflict' }>('replace-dataset-control', { record: structuredClone(record), expectedId }),
    installedDatasets: () => request<DatasetManifest[]>('/api/edits/datasets', stableScope),
    installDataset: (manifest, checkpoint) => call<void>('install-dataset', structuredClone({ manifest, checkpoint })),
    readIntent: targetId => call<EditIntentRecord | null>('intent', { targetId }).then(value => value ?? undefined),
    pendingIntents: () => request<PendingEditIntent[]>('/api/edits/pending-intents', stableScope),
    pendingRecords: () => request<EditRecord[]>('/api/edits/pending-records', stableScope),
    receiveRecords: records => call<void>('receive-records', { records: structuredClone(records) }),
    replaceIntent: (targetId, record, expectedId) => call<IntentWriteResult>('replace-intent', { targetId, record: structuredClone(record), expectedId }),
    checkpoint: () => request<RepositoryCheckpoint>('/api/edits/checkpoint', stableScope),
    installCheckpoint: checkpoint => call<void>('install-checkpoint', { checkpoint: structuredClone(checkpoint) }),
    initialize: (root: Snapshot) => call<void>('initialize', { root }),
    read: (targetId: string) => call<RepositoryState>('read', { targetId }),
    async commit(batch: EditBatch, history?: HistoryRecord): Promise<CommitResult> {
      // Capture at invocation: UI mutation while a request waits must not change the retry payload.
      const payload = structuredClone({ batch, ...(history ? { history } : {}) });
      return commitRemote('commit', payload, payload.batch);
    },
    async publish(publication, history) {
      const payload = structuredClone({ publication, ...(history ? { history } : {}) });
      try { publicationItem(payload.publication); }
      catch (error) { return { status: 'aborted', reason: String(error) }; }
      return commitRemote('publish', payload, payload.publication.libraryBatch);
    },
    async storeResource(input) {
      const stable = structuredClone(input);
      let dataBase64 = '';
      for (let start = 0; start < stable.bytes.length; start += 0x8000) dataBase64 += String.fromCharCode(...stable.bytes.subarray(start, start + 0x8000));
      const metadata = await call<ResourceMetadata>('store-resource', { resourceId: stable.id, sha256: stable.sha256, mediaType: stable.mediaType, dataBase64: btoa(dataBase64), ...(stable.expected ? { expected: stable.expected } : {}) });
      assertResourceMetadata(metadata);
      if (metadata.id !== stable.id || metadata.sha256 !== stable.sha256 || metadata.mediaType !== stable.mediaType
        || metadata.byteLength !== stable.bytes.byteLength || await resourceHash(stable.bytes) !== metadata.sha256) throw new Error('invalid-resource-response');
      return metadata;
    },
    async readResource(resourceId) {
      const value = await call<{ metadata: ResourceMetadata; dataBase64: string } | null>('read-resource', { resourceId });
      if (!value) return undefined;
      assertResourceMetadata(value.metadata);
      const bytes = Uint8Array.from(atob(value.dataBase64), char => char.charCodeAt(0));
      if (value.metadata.id !== resourceId || value.metadata.byteLength !== bytes.byteLength
        || await resourceHash(bytes) !== value.metadata.sha256) throw new Error('invalid-resource-response');
      return { metadata: value.metadata, bytes };
    },
    async resourceMetadata(resourceId) {
      const metadata = await call<ResourceMetadata | null>('resource-metadata', { resourceId });
      if (!metadata) return undefined;
      assertResourceMetadata(metadata);
      if (metadata.id !== resourceId) throw new Error('invalid-resource-response');
      return metadata;
    },
    receive: (batches: EditBatch[]) => call<void>('receive', { batches }),
    receivePublications: (publications, batches = []) => call<void>('receive-publications', { publications, batches }),
    receipt: (batchId: string) => call<BatchReceipt | undefined>('receipt', { batchId }).then(value => value ?? undefined),
    pending: () => request<EditBatch[]>('/api/edits/pending', stableScope),
    pendingPublications: () => request<ContentPublication[]>('/api/edits/pending-publications', stableScope),
    acknowledgeUpload: (batchId: string) => call<void>('acknowledge-upload', { batchId }),
    acknowledgeImport: (batchId: string, peerId: string) => call<void>('acknowledge-import', { batchId, peerId }),
  };
}
