import type { ContentPublication, EditBatch, LibraryItem, PdfResourcePage, ResourceMetadata, Snapshot, HistoryRecord, RepositoryCheckpoint, EditIntentRecord, EditRecord, DatasetManifest, DatasetControlRecord } from './contracts.ts';
import type { GraphCheckpoint, GraphView } from './editGraph.ts';

/** Account + library + dataset epoch. An adapter never falls back to another namespace. */
export type EditScope = { accountId: string; libraryId: string; epoch: string };
export type { HistoryRecord } from './contracts.ts';
export type BatchReceipt = { id: string; targetId: string; durable: true; upload: 'pending' | 'accepted'; importedBy: string[] };
export type CommitResult = { status: 'durable'; receipt: BatchReceipt }
  | { status: 'aborted'; reason: string } | { status: 'unknown'; reason: string };
/** Local read projection of a validated immutable publication, retained after upload acknowledgment. */
export type PublicationOrigin = { batchId: string; itemId: string; kind: LibraryItem['kind']; contentVersion: string | null };
export type RepositoryState = GraphView & { checkpoint: GraphCheckpoint; receipts: BatchReceipt[]; history: HistoryRecord[]; publicationOrigins?: PublicationOrigin[] };
export interface EditRepository {
  readonly scope: EditScope;
  initialize(root: Snapshot): Promise<void>;
  read(targetId: string): Promise<RepositoryState>;
  commit(batch: EditBatch, history?: HistoryRecord): Promise<CommitResult>;
  receive(batches: EditBatch[]): Promise<void>;
  receipt(batchId: string): Promise<BatchReceipt | undefined>;
  pending(): Promise<EditBatch[]>;
  acknowledgeUpload(batchId: string): Promise<void>;
  acknowledgeImport(batchId: string, peerId: string): Promise<void>;
}

export type IntentWriteResult = { status: 'written' | 'cleared' } | { status: 'conflict' };
export type PendingEditIntent = { targetId: string; record: EditIntentRecord };
/** Device-local recovery journal. CAS prevents a stale tab from replacing or clearing another operation. */
export interface EditIntentRepository extends EditRepository {
  readIntent(targetId: string): Promise<EditIntentRecord | undefined>;
  pendingIntents(): Promise<PendingEditIntent[]>;
  replaceIntent(targetId: string, record: EditIntentRecord | null, expectedId: string | null): Promise<IntentWriteResult>;
}

export type ResourceInput = { id: string; sha256: string; mediaType: string; bytes: Uint8Array; expected?: ResourceMetadata };
export type StoredResource = { metadata: ResourceMetadata; bytes: Uint8Array };
export interface ResourceInspectionPort { inspectPdf(bytes: Uint8Array): Promise<PdfResourcePage[]> }
/** Creation/import publishes metadata and initial content together after resource durability. */
export interface ContentRepository extends EditIntentRepository {
  datasetControl(): Promise<DatasetControlRecord | undefined>;
  replaceDatasetControl(record: DatasetControlRecord, expectedId: string | null): Promise<{ status: 'written' | 'conflict' }>;
  installedDatasets(): Promise<DatasetManifest[]>;
  installDataset(manifest: DatasetManifest, checkpoint: RepositoryCheckpoint): Promise<void>;
  pendingRecords(): Promise<EditRecord[]>;
  receiveRecords(records: EditRecord[]): Promise<void>;
  checkpoint(): Promise<RepositoryCheckpoint>;
  installCheckpoint(checkpoint: RepositoryCheckpoint): Promise<void>;
  storeResource(input: ResourceInput): Promise<ResourceMetadata>;
  readResource(id: string): Promise<StoredResource | undefined>;
  resourceMetadata(id: string): Promise<ResourceMetadata | undefined>;
  publish(publication: ContentPublication, history?: HistoryRecord): Promise<CommitResult>;
  pendingPublications(): Promise<ContentPublication[]>;
  receivePublications(publications: ContentPublication[], batches?: EditBatch[]): Promise<void>;
}
