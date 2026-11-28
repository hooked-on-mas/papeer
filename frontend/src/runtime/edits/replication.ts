import type { DatasetManifest, EditRecord, ResourceMetadata, RepositoryCheckpoint } from './contracts.ts';
import { assertBatch, canonicalJson } from './editModel.ts';
import type { ContentRepository, StoredResource } from './ports.ts';
import { batchResourceIds, publicationItem, publicationResourceIds } from './contentPublication.ts';
import { assertEditRecord } from './editRecord.ts';
import { assertDatasetAccess, datasetAccess } from './datasetControl.ts';

export interface EditTransferPort {
  pull(options?: { dataset?: boolean }): Promise<{ edits: EditRecord[]; imports: { batchId: string; peerId: string }[]; resources?: ResourceMetadata[]; checkpoints?: RepositoryCheckpoint[]; manifests?: DatasetManifest[] }>;
  acknowledgePull?(batchIds: string[], receipts: string[], resourceIds: string[]): Promise<void>;
  upload(record: EditRecord): Promise<void>;
  uploadResource(resource: StoredResource): Promise<void>;
  downloadResource(metadata: ResourceMetadata): Promise<StoredResource>;
  imported(batchId: string, peerId: string): Promise<void>;
}
export type ReplicationState = { running: boolean; suspended: boolean; error: string };

/** A scope's sender outlives its views. Suspend on logout; resume only with that scope's credentials. */
export class EditReplication {
  private readonly repository: ContentRepository;
  private readonly transfer: EditTransferPort;
  private readonly peerId: string;
  private flight?: Promise<void>;
  private state: ReplicationState = { running: false, suspended: false, error: '' };
  private listeners = new Set<() => void>();
  constructor(repository: ContentRepository, transfer: EditTransferPort, peerId: string) {
    this.repository = repository; this.transfer = transfer; this.peerId = peerId;
  }
  getSnapshot = () => this.state;
  get scope() { return this.repository.scope; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<ReplicationState>) { this.state = { ...this.state, ...fields }; this.listeners.forEach(listener => listener()); }
  suspend = () => this.update({ suspended: true });
  suspendAndWait = async () => { this.suspend(); await this.flight?.catch(() => undefined); };
  resume = () => { this.update({ suspended: false }); return this.flush(); };
  flush = (): Promise<void> => {
    if (this.flight) return this.flight;
    if (this.state.suspended) return Promise.resolve();
    this.flight = Promise.resolve().then(async () => {
      this.update({ running: true, error: '' });
      try {
        const control = await this.repository.datasetControl();
        if (control) assertDatasetAccess(datasetAccess(control), this.repository.scope, 'edit');
        if (this.state.suspended) return;
        const incoming = await this.transfer.pull();
        if (this.state.suspended) return;
        incoming.edits.forEach(assertEditRecord);
        // Initial content is imported explicitly through its completed dataset manifest.
        // A checkpoint listed before publication completes must not expose a catalog.
        const arrivals = incoming.edits.map(edit => edit.batch);
        arrivals.forEach(batch => {
          assertBatch(batch);
          if (batch.libraryId !== this.repository.scope.libraryId) throw new Error('batch-scope');
        });
        for (const metadata of incoming.resources ?? []) {
          if (this.state.suspended) return;
          const stored = await this.repository.resourceMetadata(metadata.id);
          if (stored) {
            if (canonicalJson(stored) !== canonicalJson(metadata)) throw new Error('resource-id-reused');
            continue;
          }
          const resource = await this.transfer.downloadResource(metadata);
          if (this.state.suspended) return;
          if (canonicalJson(resource.metadata) !== canonicalJson(metadata)) throw new Error('resource-descriptor-changed');
          await this.repository.storeResource({ id: metadata.id, sha256: metadata.sha256, mediaType: metadata.mediaType,
            bytes: resource.bytes, expected: metadata });
        }
        if (this.state.suspended) return;
        await this.repository.receiveRecords(incoming.edits);
        for (const batch of new Map(arrivals.map(batch => [batch.id, batch])).values()) {
          if (this.state.suspended) return;
          // This says durable import, including parent-waiting data. It does not claim adoption/conflict resolution.
          if (!(await this.repository.receipt(batch.id))?.importedBy.includes(this.peerId)) {
            await this.transfer.imported(batch.id, this.peerId);
            await this.repository.acknowledgeImport(batch.id, this.peerId);
          }
        }
        const receivedReceipts: string[] = [];
        for (const receipt of incoming.imports) {
          const local = await this.repository.receipt(receipt.batchId);
          if (local) {
            if (!local.importedBy.includes(receipt.peerId)) await this.repository.acknowledgeImport(receipt.batchId, receipt.peerId);
            receivedReceipts.push(`${receipt.batchId}:${receipt.peerId}`);
          }
        }
        await this.transfer.acknowledgePull?.(arrivals.map(batch => batch.id), receivedReceipts,
          (incoming.resources ?? []).map(resource => resource.id));
        const uploadedResources = new Set<string>();
        const uploadResources = async (ids: string[]) => {
          for (const id of ids) {
            if (this.state.suspended) return;
            if (uploadedResources.has(id)) continue;
            const resource = await this.repository.readResource(id);
            if (!resource) throw new Error('missing-resource');
            if (this.state.suspended) return;
            await this.transfer.uploadResource(resource); uploadedResources.add(id);
          }
        };
        const records = (await this.repository.pendingRecords()).sort((a, b) => Number(!!b.publication) - Number(!!a.publication));
        for (const record of records) {
          assertEditRecord(record);
          if (record.publication) publicationItem(record.publication);
          await uploadResources(record.publication ? publicationResourceIds(record.publication) : batchResourceIds(record.batch));
          if (this.state.suspended) return;
          await this.transfer.upload(record);
          await this.repository.acknowledgeUpload(record.batch.id);
        }
      } catch (error) { this.update({ error: String(error) }); throw error; }
      finally { this.update({ running: false }); this.flight = undefined; }
    });
    return this.flight;
  };
}
