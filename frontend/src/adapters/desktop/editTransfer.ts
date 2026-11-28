import type { EditScope, StoredResource } from '../../runtime/edits/ports.ts';
import type { ResourceMetadata } from '../../runtime/edits/contracts.ts';
import { createDriveEditTransfer, type DriveEditStorage } from '../drive/editTransfer.ts';
import { assertResourceMetadata, resourceHash } from '../../runtime/edits/contentPublication.ts';

/** Python supplies OS credentials and network I/O. Envelopes and sender are shared. */
export function createDesktopEditTransfer(scope: EditScope, folderId: string,
  request: <T>(path: string, body: unknown) => Promise<T>) {
  const stableScope = Object.freeze({ ...scope });
  let lease: Promise<{ leaseId: string }> | undefined;
  const acquire = async () => {
    const attempt = lease ??= request<{ leaseId: string }>('/api/edits/drive/lease', { scope: stableScope, folderId });
    try { return await attempt; }
    catch (error) { if (lease === attempt) lease = undefined; throw error; }
  };
  const call = async <T>(path: string, body: object = {}) => {
    const { leaseId } = await acquire();
    return request<T>(`/api/edits/drive/${path}`, { scope: stableScope, folderId, leaseId, ...body });
  };
  const storage: DriveEditStorage = {
    assertCurrent: () => call<void>('check-lease'),
    bindAccount: async () => {
      await acquire();
      return storage;
    },
    sharedEditFiles: () => call<{ id: string; version?: string; kind?: string }[]>('files'),
    annotation: fileId => call<unknown>('read-json', { fileId }),
    saveSharedEdit: (_namespace, _folder, editId, value) => call<void>('save-json', { editId, value }),
    async sharedResource(_namespace, metadata: ResourceMetadata, blobId: string) {
      const { dataBase64 } = await call<{ dataBase64: string }>('read-resource', { metadata, blobId });
      assertResourceMetadata(metadata);
      const bytes = Uint8Array.from(atob(dataBase64), char => char.charCodeAt(0));
      if (bytes.byteLength !== metadata.byteLength || await resourceHash(bytes) !== metadata.sha256) throw new Error('resource-hash');
      return bytes;
    },
    async saveSharedResource(_namespace, _folder, resource: StoredResource) {
      let data = '';
      for (let start = 0; start < resource.bytes.length; start += 0x8000) data += String.fromCharCode(...resource.bytes.subarray(start, start + 0x8000));
      await call<void>('save-resource', { metadata: resource.metadata, dataBase64: btoa(data) });
    },
  };
  return createDriveEditTransfer(storage, stableScope, folderId);
}
