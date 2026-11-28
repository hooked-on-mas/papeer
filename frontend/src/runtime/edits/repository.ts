import { validateResourceMetadata, validateRepositoryCheckpoint, type ContentPublication, type EditBatch, type LibraryItem, type ResourceMetadata, type Snapshot, type RepositoryCheckpoint, type EditIntentRecord, type EditRecord, type DatasetManifest, type DatasetControlRecord } from './contracts.ts';
import { EditGraph, type GraphCheckpoint } from './editGraph.ts';
import { assertSnapshot, canonicalJson, EditRejected } from './editModel.ts';
import type { BatchReceipt, CommitResult, ContentRepository, EditScope, HistoryRecord, RepositoryState, ResourceInput, ResourceInspectionPort, StoredResource, IntentWriteResult } from './ports.ts';
import { assertResourceBindings, assertResourceMetadata, inspectedResource, publicationItem, resourceHash } from './contentPublication.ts';
import { assertEditIntent, assertIntentTransition } from './editIntent.ts';
import { assertEditRecord, mergeEditRecord, historyStatus, validateHistories } from './editRecord.ts';
import { assertDatasetCheckpoint, assertDatasetManifest, checkpointHash } from './datasetManifest.ts';
import { assertDatasetAccess, assertDatasetContained, assertDatasetControl, assertDatasetControlPlan, assertDatasetControlTransition, copiedDatasetReceipts, datasetIdentity, type DatasetAccess, type DatasetScopeState } from './datasetControl.ts';

export type StoredEdit = { batch: EditBatch; receipt: BatchReceipt; history?: HistoryRecord; publication?: ContentPublication };
/** Implementations run this finite edit transaction under one native database transaction. */
export interface EditTransaction {
  access(): Promise<DatasetAccess | undefined>;
  control(): Promise<DatasetControlRecord | undefined>;
  putControl(record: DatasetControlRecord): void;
  scopedState(scope: EditScope): Promise<DatasetScopeState>;
  putScopedEdit(scope: EditScope, edit: StoredEdit): void;
  datasets(): Promise<DatasetManifest[]>;
  putDataset(manifest: DatasetManifest): void;
  root(targetId: string): Promise<Snapshot | undefined>;
  roots(): Promise<Snapshot[]>;
  edits(targetId?: string): Promise<StoredEdit[]>;
  editById(batchId: string): Promise<StoredEdit | undefined>;
  putRoot(root: Snapshot): void;
  putEdit(edit: StoredEdit): void;
  putProjection(snapshot: Snapshot): void;
  pruneProjections(targetId: string, versions: string[]): Promise<void>;
  resource(id: string, scope?: EditScope): Promise<ResourceMetadata | undefined>;
  resourceBytes(sha256: string, scope?: EditScope): Promise<Uint8Array | undefined>;
  putResource(resource: StoredResource): void;
  hasCheckpoint(sha256: string): Promise<boolean>;
  rememberCheckpoint(sha256: string): void;
  intent(targetId: string): Promise<EditIntentRecord | undefined>;
  intents(): Promise<{ targetId: string; record: EditIntentRecord }[]>;
  putIntent(targetId: string, record: EditIntentRecord | null): void;
}
export interface EditDatabase {
  transaction<T>(run: (transaction: EditTransaction) => Promise<T>): Promise<T>;
}
export function scopeKey(scope: EditScope): string { return JSON.stringify([scope.accountId, scope.libraryId, scope.epoch]); }
/** The reads of a bindings check (a transaction, or the per-pass memo of the sync loops). */
type BindingReads = Pick<EditTransaction, 'root' | 'resource'>;
/** `publication-item-exists`: the publication's parent already has the item or is not a library. One definition for both sync passes. */
const publicationParentConflict = (parent: Snapshot | undefined, item: LibraryItem): boolean =>
  !!parent && (parent.kind !== 'library' || parent.items.some(value => value.id === item.id));

/** The adapter owns durability. Batch/branch/receipt meaning is shared across hosts. */
export class DurableEditRepository implements ContentRepository {
  readonly scope: EditScope;
  private readonly database: EditDatabase;
  private readonly inspection?: ResourceInspectionPort;
  private write<T>(mode: 'edit' | 'stage', run: (tx: EditTransaction) => Promise<T>) {
    return this.database.transaction(async tx => { assertDatasetAccess(await tx.access(), this.scope, mode); return run(tx); });
  }
  datasetControl = () => this.database.transaction(async tx => {
    const record = await tx.control(); if (record) assertDatasetControl(record, datasetIdentity(this.scope)); return record ? structuredClone(record) : undefined;
  });
  replaceDatasetControl = async (record: DatasetControlRecord, expectedId: string | null): Promise<{ status: 'written' | 'conflict' }> => {
    const stable = structuredClone(record); await assertDatasetControlPlan(stable, datasetIdentity(this.scope));
    return this.database.transaction(async tx => {
      const old = await tx.control();
      if (old?.id === stable.id) {
        if (canonicalJson(old) !== canonicalJson(stable)) throw new EditRejected('dataset-control-id-reused');
        if (stable.transition.phase !== 'prepared' && stable.transition.phase !== 'rolled-back') await this.verifyDatasetResources(tx, stable.transition.publication.manifest);
        return { status: 'written' };
      }
      if ((old?.id ?? null) !== expectedId) return { status: 'conflict' };
      assertDatasetControlTransition(old, stable);
      const run = stable.transition, scope = run.publication.manifest.scope;
      const target = await tx.scopedState(scope), source = run.source ? await tx.scopedState(run.source.scope) : undefined;
      if (run.phase !== 'rolled-back') {
        if (source) assertDatasetContained(source, run.publication.checkpoint);
        assertDatasetContained(target, run.publication.checkpoint, run.phase !== 'prepared');
        if (run.phase !== 'prepared' && !target.datasets.some(value => canonicalJson(value) === canonicalJson(run.publication.manifest))) throw new EditRejected('dataset-not-installed');
        if (run.phase !== 'prepared') await this.verifyDatasetResources(tx, run.publication.manifest);
      } else if (target.intents.length || source?.intents.length) throw new EditRejected('dataset-pending-intents');
      if (run.phase === 'activated' && source) for (const edit of copiedDatasetReceipts(source, target)) tx.putScopedEdit(scope, edit);
      tx.putControl(stable);
      return { status: 'written' };
    });
  };
  installedDatasets = () => this.database.transaction(async tx => {
    const datasets = await tx.datasets(); datasets.forEach(value => assertDatasetManifest(value, this.scope));
    return datasets.sort((a, b) => a.id.localeCompare(b.id));
  });
  /** A completed import marker and all catalog/content/history projections commit together. */
  installDataset = async (manifest: DatasetManifest, checkpoint: RepositoryCheckpoint): Promise<void> => {
    const stable = structuredClone({ manifest, checkpoint });
    await assertDatasetCheckpoint(stable.manifest, stable.checkpoint, this.scope);
    await this.write('stage', async tx => {
      const previous = (await tx.datasets()).find(value => value.id === stable.manifest.id);
      if (previous) {
        if (canonicalJson(previous) !== canonicalJson(stable.manifest)) throw new EditRejected('dataset-id-reused');
        await this.verifyDatasetResources(tx, stable.manifest);
        return;
      }
      await this.verifyDatasetResources(tx, stable.manifest);
      await this.installCheckpointIn(tx, stable.checkpoint, stable.manifest.checkpointSha256);
      tx.putDataset(stable.manifest);
    });
  };
  private async verifyDatasetResources(tx: EditTransaction, manifest: DatasetManifest): Promise<void> {
    for (const expected of manifest.resources) {
      const actual = await tx.resource(expected.id, manifest.scope), bytes = await tx.resourceBytes(expected.sha256, manifest.scope);
      if (!actual || canonicalJson(actual) !== canonicalJson(expected) || !bytes) throw new EditRejected('dataset-resource-missing');
      if (bytes.byteLength !== expected.byteLength || await resourceHash(bytes) !== expected.sha256) throw new EditRejected('resource-hash');
    }
  }
  constructor(scope: EditScope, database: EditDatabase, inspection?: ResourceInspectionPort) {
    this.scope = Object.freeze({ ...scope }); this.database = database;
    this.inspection = inspection;
    if (!scope.accountId || !scope.libraryId || !scope.epoch) throw new EditRejected('empty-scope');
  }
  readIntent = (targetId: string) => this.database.transaction(async tx => {
    const record = await tx.intent(targetId);
    if (record) assertEditIntent(record, this.scope.libraryId, targetId);
    return record ? structuredClone(record) : undefined;
  });
  pendingIntents = () => this.database.transaction(async tx => {
    const pending = await tx.intents();
    for (const { targetId, record } of pending) assertEditIntent(record, this.scope.libraryId, targetId);
    return structuredClone(pending.sort((a, b) => a.targetId.localeCompare(b.targetId)));
  });
  replaceIntent = async (targetId: string, record: EditIntentRecord | null, expectedId: string | null): Promise<IntentWriteResult> => {
    const stable = record ? structuredClone(record) : null;
    if (stable) assertEditIntent(stable, this.scope.libraryId, targetId);
    return this.write('edit', async tx => {
      const old = await tx.intent(targetId);
      if (stable && old?.id === stable.id) {
        if (canonicalJson(old) !== canonicalJson(stable)) throw new EditRejected('intent-id-reused');
        return { status: 'written' };
      }
      if (!stable && !old) return { status: 'cleared' };
      if ((old?.id ?? null) !== expectedId) return { status: 'conflict' };
      if (old && stable) assertIntentTransition(old, stable);
      tx.putIntent(targetId, stable);
      return { status: stable ? 'written' : 'cleared' };
    });
  };
  initialize = async (root: Snapshot): Promise<void> => {
    assertSnapshot(root);
    const stable = structuredClone(root);
    await this.write('stage', async tx => {
      const existing = await tx.root(stable.id);
      if (existing && canonicalJson(existing) !== canonicalJson(stable)) throw new EditRejected('root-already-initialized');
      if (!existing) await this.installRoot(tx, stable);
    });
  };
  /** One consistent read: immutable genesis roots and full edits, never projections alone. */
  checkpoint = (): Promise<RepositoryCheckpoint> => this.database.transaction(async tx => ({
    version: 1, libraryId: this.scope.libraryId,
    roots: (await tx.roots()).sort((a, b) => a.id.localeCompare(b.id)),
    edits: (await tx.edits()).sort((a, b) => a.batch.id.localeCompare(b.batch.id))
      .map(({ batch, history, publication }) => ({ batch, ...(history ? { history } : {}), ...(publication ? { publication } : {}) })),
  }));
  /** A bootstrap/import merges with local pending data; it never replaces its journal or receipts. */
  installCheckpoint = async (checkpoint: RepositoryCheckpoint): Promise<void> => {
    validateRepositoryCheckpoint(checkpoint);
    const stable = structuredClone(checkpoint);
    if (stable.libraryId !== this.scope.libraryId) throw new EditRejected('batch-scope');
    const hash = await checkpointHash(stable);
    await this.write('stage', tx => this.installCheckpointIn(tx, stable, hash));
  };
  private async installCheckpointIn(tx: EditTransaction, stable: RepositoryCheckpoint, hash: string): Promise<void> {
    if (await tx.hasCheckpoint(hash)) return;
    const roots = new Map((await tx.roots()).map(root => [root.id, root]));
    const incomingRootIds = new Set<string>();
    for (const root of stable.roots) {
      assertSnapshot(root);
      if (incomingRootIds.has(root.id)) throw new EditRejected('checkpoint-duplicate-root');
      incomingRootIds.add(root.id);
      if ((root.kind === 'library') !== (root.id === this.scope.libraryId)) throw new EditRejected('checkpoint-library');
      const old = roots.get(root.id);
      if (old && canonicalJson(old) !== canonicalJson(root)) throw new EditRejected('root-already-initialized');
      roots.set(root.id, root);
    }
    if (!roots.has(this.scope.libraryId)) throw new EditRejected('checkpoint-library');
    const edits = new Map((await tx.edits()).map(edit => [edit.batch.id, edit]));
    const context = new Map(stable.edits.map(edit => [edit.batch.id, edit]));
    for (const edit of edits.values()) context.set(edit.batch.id, edit);
    for (const [id, old] of edits) if (historyStatus(old, [...context.values()], [...roots.values()]) === 'invalid') {
      const cleaned = { ...old }; delete cleaned.history; edits.set(id, cleaned);
    }
    const incomingIds = new Set<string>();
    for (const value of stable.edits) {
      assertEditRecord(value);
      const { batch } = value;
      if (batch.libraryId !== this.scope.libraryId) throw new EditRejected('batch-scope');
      if (incomingIds.has(batch.id)) throw new EditRejected('checkpoint-duplicate-batch');
      incomingIds.add(batch.id);
      const old = edits.get(batch.id);
      // Preserve an existing pending upload and all local import acknowledgements.
      edits.set(batch.id, old ? { ...mergeEditRecord(old, value), receipt: old.receipt } : { ...value, receipt: {
        id: batch.id, targetId: batch.targetId, durable: true, upload: 'accepted', importedBy: [],
      } });
    }
    for (const root of roots.values()) tx.putRoot(root);
    validateHistories(edits, [...roots.values()], new Set(stable.edits.filter(edit => edit.history).map(edit => edit.batch.id)));
    const publications = new Map<string, string>();
    for (const edit of edits.values()) if (edit.publication) {
      const item = publicationItem(edit.publication), root = roots.get(item.id);
      if (publications.has(item.id) && publications.get(item.id) !== edit.batch.id) throw new EditRejected('publication-item-reused');
      publications.set(item.id, edit.batch.id);
      if (edit.publication.content && (!root || canonicalJson(root) !== canonicalJson(edit.publication.content))) throw new EditRejected('publication-content-exists');
      if (item.kind === 'pdf' && (await tx.resource(item.resourceId!))?.mediaType !== 'application/pdf') throw new EditRejected('publication-pdf-required');
    }
    for (const root of roots.values()) {
      const targetEdits = [...edits.values()].filter(edit => edit.batch.targetId === root.id);
      const graph = new EditGraph({ version: 1, libraryId: this.scope.libraryId, root, batches: targetEdits.map(edit => edit.batch) });
      const rejected = Object.values(graph.getView().rejected)[0];
      if (rejected) throw new EditRejected(rejected);
      await this.assertBindings(tx, root); tx.putProjection(root);
      // Same order, statements and writes as checking every edit; only the versions that provably pass skip the (O(B) replay) re-check.
      const passed = await this.passedChecks(tx, graph, root.version, targetEdits), heads = graph.getView().heads;
      for (const edit of targetEdits) {
        if (edit.publication && !passed.publications.has(edit.batch.id)) {
          const parent = graph.snapshot(edit.batch.parents[0]), item = publicationItem(edit.publication);
          if (publicationParentConflict(parent, item)) throw new EditRejected('publication-item-exists');
        }
        if (passed.bindings.has(edit.batch.id)) { if (heads.includes(edit.batch.id)) tx.putProjection(graph.snapshot(edit.batch.id)!); continue; }
        const snapshot = graph.snapshot(edit.batch.id);
        if (snapshot) { await this.assertBindings(tx, snapshot); if (heads.includes(snapshot.version)) tx.putProjection(snapshot); }
      }
      await tx.pruneProjections(root.id, [root.version, ...graph.getView().heads]);
    }
    for (const edit of edits.values()) tx.putEdit(edit);
    tx.rememberCheckpoint(hash);
  }
  private async installRoot(tx: EditTransaction, root: Snapshot): Promise<void> {
    await this.assertBindings(tx, root);
    tx.putRoot(root); tx.putProjection(root);
    const waiting = await tx.edits(root.id);
    if (!waiting.length) return;
    const records = new Map(waiting.map(edit => [edit.batch.id, edit]));
    validateHistories(records, [root], new Set());
    for (const record of records.values()) tx.putEdit(record);
    const graph = new EditGraph({ version: 1, libraryId: this.scope.libraryId, root, batches: waiting.map(edit => edit.batch) });
    for (const edit of waiting) {
      const snapshot = graph.snapshot(edit.batch.id);
      if (snapshot) { await this.assertBindings(tx, snapshot); if (graph.getView().heads.includes(snapshot.version)) tx.putProjection(snapshot); }
    }
    await tx.pruneProjections(root.id, [root.version, ...graph.getView().heads]);
  }
  /** B13-d U5: which versions pass the per-version checks of the sync loops, found in ONE pass over the graph (each batch applied once)
   * instead of `graph.snapshot(version)` per record in key order (a replay from the closest of 16 cached versions: O(B²) for random UUID
   * keys). It only reads (roots and resources through a memo of this pass), never writes and never throws: a check that failed, threw or
   * was not reached is simply absent, and the caller runs its original statements for that version, so every exception still comes from
   * the original code at the original position. Valid while the roots and resources do not change during the loop (no putRoot/putResource). */
  private async passedChecks(tx: EditTransaction, graph: EditGraph, rootVersion: string, edits: StoredEdit[]): Promise<{ bindings: Set<string>; publications: Set<string> }> {
    const roots = new Map<string, Promise<Snapshot | undefined>>(), resources = new Map<string, Promise<ResourceMetadata | undefined>>();
    const reads: BindingReads = {
      root: id => { let value = roots.get(id); if (!value) roots.set(id, value = tx.root(id)); return value; },
      resource: id => { let value = resources.get(id); if (!value) resources.set(id, value = tx.resource(id)); return value; },
    };
    const byParent = new Map<string, StoredEdit[]>();
    for (const edit of edits) if (edit.publication) {
      const list = byParent.get(edit.batch.parents[0]);
      if (list) list.push(edit); else byParent.set(edit.batch.parents[0], [edit]);
    }
    const bindings = new Set<string>(), publications = new Set<string>();
    await graph.visitMaterialized(async (version, snapshot) => {
      for (const edit of byParent.get(version) ?? []) {
        try { if (!publicationParentConflict(snapshot, publicationItem(edit.publication!))) publications.add(edit.batch.id); } catch { /* not passed */ }
      }
      if (version === rootVersion || snapshot.version !== version) return;
      try { await this.assertBindings(reads, snapshot); bindings.add(version); } catch { /* not passed: the caller re-runs the original check */ }
    });
    return { bindings, publications };
  }
  private async assertBindings(tx: BindingReads, snapshot: Snapshot): Promise<void> {
    await assertResourceBindings(snapshot, tx.resource);
    if (snapshot.kind === 'library') for (const item of snapshot.items) {
      if (item.kind === 'attachment') continue;
      const root = await tx.root(item.id);
      if (!root || (item.kind === 'markdown' ? root.kind !== 'markdown' : root.kind !== 'document')) throw new EditRejected('missing-or-wrong-content');
    }
  }
  storeResource = async (input: ResourceInput): Promise<ResourceMetadata> => {
    if (!(input.bytes instanceof Uint8Array)) throw new EditRejected('resource-bytes');
    const bytes = Uint8Array.from(input.bytes);
    const expected = input.expected ? structuredClone(input.expected) : undefined;
    let metadata: ResourceMetadata = { id: input.id, sha256: input.sha256, mediaType: input.mediaType, byteLength: bytes.byteLength };
    validateResourceMetadata(metadata);
    if (await resourceHash(bytes) !== metadata.sha256) throw new EditRejected('resource-hash');
    if (metadata.mediaType === 'application/pdf') {
      if (!this.inspection) throw new EditRejected('pdf-inspector-required');
      metadata.pdfPages = await this.inspection.inspectPdf(Uint8Array.from(bytes));
    }
    metadata = inspectedResource(metadata, expected);
    await this.write('stage', async tx => {
      const existing = await tx.resource(metadata.id);
      if (existing && canonicalJson(existing) !== canonicalJson(metadata)) throw new EditRejected('resource-id-reused');
      const existingBytes = await tx.resourceBytes(metadata.sha256);
      if (existing && !existingBytes) throw new EditRejected('resource-bytes-missing');
      if (existingBytes && (existingBytes.byteLength !== bytes.byteLength || existingBytes.some((byte, index) => byte !== bytes[index]))) throw new EditRejected('resource-hash');
      tx.putResource({ metadata, bytes });
    });
    return structuredClone(metadata);
  };
  readResource = async (id: string): Promise<StoredResource | undefined> => {
    const stored = await this.database.transaction(async tx => {
      const metadata = await tx.resource(id);
      if (!metadata) return undefined;
      const bytes = await tx.resourceBytes(metadata.sha256);
      if (!bytes) throw new EditRejected('resource-bytes-missing');
      return { metadata, bytes };
    });
    if (stored) {
      assertResourceMetadata(stored.metadata);
      if (stored.metadata.byteLength !== stored.bytes.byteLength || await resourceHash(stored.bytes) !== stored.metadata.sha256) throw new EditRejected('resource-hash');
    }
    return stored;
  };
  resourceMetadata = (id: string): Promise<ResourceMetadata | undefined> => this.database.transaction(async tx => {
    const metadata = await tx.resource(id);
    if (metadata) assertResourceMetadata(metadata);
    return metadata;
  });
  private async graph(tx: EditTransaction, targetId: string): Promise<{ graph: EditGraph; edits: StoredEdit[] }> {
    const root = await tx.root(targetId);
    if (!root) throw new EditRejected('missing-target');
    const edits = await tx.edits(targetId);
    const graph = new EditGraph({ version: 1, libraryId: this.scope.libraryId, root, batches: edits.map(edit => edit.batch) });
    return { graph, edits };
  }
  read = (targetId: string): Promise<RepositoryState> => this.database.transaction(async tx => {
    const { graph, edits } = await this.graph(tx, targetId);
    return { ...graph.getView(), checkpoint: graph.checkpoint(), receipts: edits.map(edit => edit.receipt),
      publicationOrigins: edits.flatMap(edit => {
        const publication = edit.publication, item = publication?.libraryBatch.changes.find(change => change.type === 'put-item');
        return publication && item?.type === 'put-item' ? [{ batchId: edit.batch.id, itemId: item.item.id,
          kind: item.item.kind, contentVersion: publication.content?.version ?? null }] : [];
      }),
      history: edits.flatMap(edit => edit.history && historyStatus(edit, edits, [graph.root]) !== 'invalid' ? [edit.history] : []) };
  });
  private async commitIn(tx: EditTransaction, stable: EditBatch, stableHistory?: HistoryRecord, publication?: ContentPublication): Promise<CommitResult> {
    const all = await tx.edits();
    const duplicate = all.find(edit => edit.batch.id === stable.id);
    if (duplicate) {
      if (canonicalJson(duplicate.batch) !== canonicalJson(stable)) throw new EditRejected('batch-id-reused');
      if (stableHistory && (!duplicate.history || canonicalJson(duplicate.history) !== canonicalJson(stableHistory))) throw new EditRejected('history-id-reused');
      return { status: 'durable', receipt: duplicate.receipt };
    }
    const { graph } = await this.graph(tx, stable.targetId);
    if (stableHistory && historyStatus({ batch: stable, history: stableHistory }, all, [graph.root]) === 'invalid') throw new EditRejected('history-action-order');
    graph.assertLocal(stable); graph.receive([stable]);
    const projection = graph.snapshot(stable.id);
    if (!projection) throw new EditRejected(graph.getView().rejected[stable.id] ?? 'unresolved-batch');
    await this.assertBindings(tx, projection);
    const receipt: BatchReceipt = { id: stable.id, targetId: stable.targetId, durable: true, upload: 'pending', importedBy: [] };
    tx.putEdit({ batch: stable, receipt, ...(stableHistory ? { history: stableHistory } : {}), ...(publication ? { publication } : {}) });
    tx.putProjection(projection);
    await tx.pruneProjections(stable.targetId, [graph.root.version, ...graph.getView().heads]);
    return { status: 'durable', receipt };
  }
  publish = async (publication: ContentPublication, history?: HistoryRecord): Promise<CommitResult> => {
    let stable: ContentPublication, stableHistory: HistoryRecord | undefined;
    let item: ReturnType<typeof publicationItem>, batch: EditBatch;
    try {
      stable = structuredClone(publication);
      stableHistory = history ? structuredClone(history) : undefined;
      item = publicationItem(stable);
      batch = stable.libraryBatch;
      if (batch.libraryId !== this.scope.libraryId) throw new EditRejected('batch-scope');
      assertEditRecord({ batch, ...(stableHistory ? { history: stableHistory } : {}), publication: stable });
    } catch (error) { return { status: 'aborted', reason: String(error) }; }
    try {
      return await this.write('edit', async tx => {
        const edits = await tx.edits(), existing = edits.find(edit => edit.batch.id === batch.id);
        if (existing) {
          if (!existing.publication || canonicalJson(existing.publication) !== canonicalJson(stable)) throw new EditRejected('publication-id-reused');
          if (stableHistory && (!existing.history || canonicalJson(existing.history) !== canonicalJson(stableHistory))) throw new EditRejected('history-id-reused');
          return { status: 'durable', receipt: existing.receipt };
        }
        if (edits.some(edit => edit.publication && publicationItem(edit.publication).id === item.id)) throw new EditRejected('publication-item-reused');
        const { graph } = await this.graph(tx, batch.targetId);
        const parent = graph.snapshot(batch.parents[0]);
        if (parent?.kind !== 'library' || parent.items.some(value => value.id === item.id)) throw new EditRejected('publication-item-exists');
        if (await tx.root(item.id)) throw new EditRejected('publication-content-exists');
        if (item.kind === 'pdf' && (await tx.resource(item.resourceId!))?.mediaType !== 'application/pdf') throw new EditRejected('publication-pdf-required');
        if (stable.content) {
          await this.installRoot(tx, stable.content);
        }
        return this.commitIn(tx, batch, stableHistory, stable);
      });
    } catch (error) {
      if (error instanceof CommitOutcomeUnknown) return { status: 'unknown', reason: error.message };
      if (error instanceof EditRejected) return { status: 'aborted', reason: String(error) };
      throw error;
    }
  };
  commit = async (batch: EditBatch, history?: HistoryRecord): Promise<CommitResult> => {
    // Invalid input is a proven local abort. Storage exceptions must be classified by the adapter.
    try { assertEditRecord({ batch, ...(history ? { history } : {}) }); if (batch.libraryId !== this.scope.libraryId) throw new EditRejected('batch-scope'); }
    catch (error) { return { status: 'aborted', reason: String(error) }; }
    const stable = structuredClone(batch), stableHistory = history ? structuredClone(history) : undefined;
    try {
      return await this.write('edit', tx => this.commitIn(tx, stable, stableHistory));
    } catch (error) {
      if (error instanceof CommitOutcomeUnknown) return { status: 'unknown', reason: error.message };
      if (error instanceof EditRejected) return { status: 'aborted', reason: String(error) };
      throw error;
    }
  };
  receive = (batches: EditBatch[]): Promise<void> => this.receiveRecords(batches.map(batch => ({ batch })));
  receivePublications = (publications: ContentPublication[], batches: EditBatch[] = []): Promise<void> => this.receiveRecords([
    ...publications.map(publication => ({ batch: publication.libraryBatch, publication })), ...batches.map(batch => ({ batch })),
  ]);
  receiveRecords = async (records: EditRecord[]): Promise<void> => {
    const stableRecords = structuredClone(records);
    stableRecords.forEach(record => {
      assertEditRecord(record);
      if (record.batch.libraryId !== this.scope.libraryId) throw new EditRejected('batch-scope');
    });
    const stablePublications = stableRecords.flatMap(record => record.publication ? [record.publication] : []);
    const stable = stableRecords.map(record => record.batch);
    await this.write('edit', async tx => {
      const all = await tx.edits();
      const existingIds = new Set(all.map(edit => edit.batch.id));
      const original = new Map(all.map(edit => [edit.batch.id, edit]));
      const ids = new Map(original);
      const publishedIds = new Map(all.filter(edit => edit.publication).map(edit => [publicationItem(edit.publication!).id, edit.batch.id]));
      for (const publication of stablePublications) {
        const batch = publication.libraryBatch, item = publicationItem(publication), old = ids.get(batch.id);
        if (old && (!old.publication || canonicalJson(old.publication) !== canonicalJson(publication))) throw new EditRejected('publication-id-reused');
        if (publishedIds.has(item.id) && publishedIds.get(item.id) !== batch.id) throw new EditRejected('publication-item-reused');
        publishedIds.set(item.id, batch.id);
        const root = await tx.root(item.id);
        if (root && (!old?.publication || !publication.content || canonicalJson(root) !== canonicalJson(publication.content))) throw new EditRejected('publication-content-exists');
        if (item.kind === 'pdf' && (await tx.resource(item.resourceId!))?.mediaType !== 'application/pdf') throw new EditRejected('publication-pdf-required');
        if (publication.content && !root) {
          await this.installRoot(tx, publication.content);
        }
        if (!old) ids.set(batch.id, { batch, publication, receipt: { id: batch.id, targetId: batch.targetId, durable: true, upload: 'accepted', importedBy: [] } });
      }
      for (const batch of stable) {
        const duplicate = ids.get(batch.id);
        if (duplicate && canonicalJson(duplicate.batch) !== canonicalJson(batch)) throw new EditRejected('batch-id-reused');
        if (!duplicate) ids.set(batch.id, { batch, receipt: { id: batch.id, targetId: batch.targetId, durable: true, upload: 'accepted', importedBy: [] } });
      }
      for (const record of stableRecords) {
        let old = ids.get(record.batch.id)!;
        if (historyStatus(old, [...ids.values()], await tx.roots()) === 'invalid') { old = { ...old }; delete old.history; }
        ids.set(record.batch.id, { ...mergeEditRecord(old, record), receipt: old.receipt });
      }
      validateHistories(ids, await tx.roots(), new Set(stableRecords.filter(record => record.history).map(record => record.batch.id)));
      for (const targetId of new Set([...stable.map(batch => batch.targetId), ...stablePublications.flatMap(value => value.content ? [value.content.id] : [])])) {
        const root = await tx.root(targetId);
        if (!root) {
          if (targetId === this.scope.libraryId) throw new EditRejected('missing-target');
          // Immutable edits may be listed before their creation/checkpoint. Retain them privately.
          continue;
        }
        const graph = new EditGraph({ version: 1, libraryId: this.scope.libraryId, root,
          batches: [...ids.values()].filter(edit => edit.batch.targetId === targetId).map(edit => edit.batch) });
        for (const [id, reason] of Object.entries(graph.getView().rejected)) {
          if (!existingIds.has(id)) throw new EditRejected(reason);
        }
        // Same order, statements and writes as before; only the versions that provably pass skip the (O(B) replay) re-check.
        const published = [...ids.values()].filter(edit => edit.publication && edit.batch.targetId === targetId);
        const passed = await this.passedChecks(tx, graph, root.version, published);
        for (const edit of published) if (!passed.publications.has(edit.batch.id)) {
          const parent = graph.snapshot(edit.batch.parents[0]), item = publicationItem(edit.publication!);
          if (publicationParentConflict(parent, item)) throw new EditRejected('publication-item-exists');
        }
        const heads = graph.getView().heads;
        for (const version of graph.checkpoint().batches.map(batch => batch.id)) {
          if (passed.bindings.has(version)) { if (heads.includes(version)) tx.putProjection(graph.snapshot(version)!); continue; }
          const projection = graph.snapshot(version);
          if (projection) { await this.assertBindings(tx, projection); if (heads.includes(version)) tx.putProjection(projection); }
        }
        await tx.pruneProjections(targetId, [root.version, ...graph.getView().heads]);
      }
      // Entire arrivals commit atomically, including parent-waiting entries and receipts.
      for (const [id, edit] of ids) if (original.get(id) !== edit) tx.putEdit(edit);
    });
  };
  receipt = (batchId: string) => this.database.transaction(async tx => (await tx.editById(batchId))?.receipt);
  pending = () => this.database.transaction(async tx => (await tx.edits()).filter(edit => edit.receipt.upload === 'pending').map(edit => edit.batch));
  pendingRecords = () => this.database.transaction(async tx => (await tx.edits()).filter(edit => edit.receipt.upload === 'pending')
    .map(({ batch, history, publication }): EditRecord => ({ batch, ...(history ? { history } : {}), ...(publication ? { publication } : {}) })));
  pendingPublications = () => this.database.transaction(async tx => (await tx.edits())
    .filter(edit => edit.receipt.upload === 'pending' && edit.publication).map(edit => edit.publication!));
  private acknowledge(batchId: string, peerId?: string) {
    return this.write(peerId === undefined ? 'edit' : 'stage', async tx => {
      const edit = (await tx.edits()).find(edit => edit.batch.id === batchId);
      if (!edit) throw new EditRejected('unknown-receipt');
      const receipt = { ...edit.receipt, importedBy: [...edit.receipt.importedBy] };
      if (peerId === undefined) receipt.upload = 'accepted';
      else if (!receipt.importedBy.includes(peerId)) receipt.importedBy.push(peerId);
      tx.putEdit({ ...edit, receipt });
    });
  }
  acknowledgeUpload = (batchId: string) => this.acknowledge(batchId);
  acknowledgeImport = (batchId: string, peerId: string) => this.acknowledge(batchId, peerId);
}

/** Only network-facing adapters use this. A native transaction abort is not an unknown outcome. */
export class CommitOutcomeUnknown extends Error {}
export function graphFromState(state: RepositoryState): EditGraph { return new EditGraph(state.checkpoint); }
export function validateCheckpoint(checkpoint: GraphCheckpoint): void { new EditGraph(checkpoint); }
