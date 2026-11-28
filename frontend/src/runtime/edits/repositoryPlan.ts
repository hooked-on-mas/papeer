import type { DatasetControlRecord, DatasetIdentity, DatasetManifest, EditIntentRecord, ResourceMetadata, Snapshot } from './contracts.ts';
import { datasetAccess, type DatasetAccess, type DatasetScopeState } from './datasetControl.ts';
import type { EditScope, StoredResource } from './ports.ts';
import type { EditTransaction, StoredEdit } from './repository.ts';
import { canonicalJson } from './editModel.ts';

export type RepositoryOperation = 'read' | 'read-intent' | 'pending-intents' | 'replace-intent' | 'checkpoint' | 'install-checkpoint' | 'initialize' | 'dataset-control' | 'datasets' | 'install-dataset' | 'replace-dataset-control' | 'store-resource' | 'read-resource' | 'resource-metadata' | 'commit' | 'publish' | 'receive-records' | 'receipt' | 'pending' | 'pending-records' | 'pending-publications' | 'acknowledge-upload' | 'acknowledge-import';
export type ScopeRead =
  | { kind: 'control'; identity: DatasetIdentity }
  | { kind: 'roots' | 'edits' | 'intents'; scope: EditScope; targetId?: string }
  | { kind: 'edit-by-id'; scope: EditScope; batchId: string }
  | { kind: 'datasets'; scope: EditScope; manifestId?: string }
  | { kind: 'resource'; scope: EditScope; resourceId: string }
  | { kind: 'resource-bytes' | 'checkpoint-marker'; scope: EditScope; sha256: string };
export type EditMutation =
  | { kind: 'put-root'; scope: EditScope; root: Snapshot }
  | { kind: 'put-edit'; scope: EditScope; edit: StoredEdit }
  | { kind: 'put-intent'; scope: EditScope; targetId: string; record: EditIntentRecord | null }
  | { kind: 'put-dataset'; scope: EditScope; manifest: DatasetManifest }
  | { kind: 'put-control'; record: DatasetControlRecord }
  | { kind: 'put-resource'; scope: EditScope; resource: StoredResource }
  | { kind: 'remember-checkpoint'; scope: EditScope; sha256: string }
  | { kind: 'put-projection'; scope: EditScope; snapshot: Snapshot }
  | { kind: 'prune-projections'; scope: EditScope; targetId: string; versions: readonly string[] };
export type SnapshotEntry = { readonly read: ScopeRead; readonly value: unknown };
/** comparison is issued and retained privately by the adapter; callers cannot construct expected values. */
export type CapturedEditSnapshot = { readonly values: readonly SnapshotEntry[]; readonly comparison: object };
export type PreparedEditPlan<T> = { readonly snapshot: CapturedEditSnapshot; readonly mutations: readonly EditMutation[]; readonly result: T };
export type ApplyResult = { status: 'committed' } | { status: 'changed' };
/** A database is bound once to the public call's captured host operation. */
export interface PlanDatabase {
  /** Run post-conflict attempts under one host-local writer lease, if supported. */
  withRetryLease?<T>(action: (database: PlanDatabase) => Promise<T>): Promise<T>;
  capture(operation: RepositoryOperation, reads: readonly ScopeRead[]): Promise<CapturedEditSnapshot>;
  compareAndApply(operation: RepositoryOperation, plan: PreparedEditPlan<unknown>): Promise<ApplyResult>;
}
export const selectorKey = (read: ScopeRead): string => {
  if (read.kind === 'control') return JSON.stringify([read.kind, read.identity.accountId, read.identity.libraryId]);
  const scope = [read.scope.accountId, read.scope.libraryId, read.scope.epoch];
  if (read.kind === 'roots' || read.kind === 'edits' || read.kind === 'intents') return JSON.stringify([read.kind, scope, read.targetId ?? null]);
  if (read.kind === 'edit-by-id') return JSON.stringify([read.kind, scope, read.batchId]);
  if (read.kind === 'datasets') return JSON.stringify([read.kind, scope, read.manifestId ?? null]);
  if (read.kind === 'resource') return JSON.stringify([read.kind, scope, read.resourceId]);
  if ('sha256' in read) return JSON.stringify([read.kind, scope, read.sha256]);
  throw new Error('invalid-repository-selector');
};
const overlayPrefix = (kind: string, scope: EditScope): string => JSON.stringify([kind, scope.accountId, scope.libraryId, scope.epoch]) + ':';
export class NeedSnapshot extends Error {
  readonly reads: readonly ScopeRead[];
  constructor(reads: readonly ScopeRead[]) { super('repository-snapshot-incomplete'); this.reads = reads; }
}
const clone = <T>(value: T): T => structuredClone(value);
const sameScope = (a: EditScope, b: EditScope) => a.accountId === b.accountId && a.libraryId === b.libraryId && a.epoch === b.epoch;

/** Memory-only logical transaction. No method here opens a native transaction. */
export class EditPlanView implements EditTransaction {
  readonly mutations: EditMutation[] = [];
  private readonly overlay = new Map<string, unknown>();
  private controlOverlay: DatasetControlRecord | undefined;
  readonly scope: EditScope;
  readonly snapshot: CapturedEditSnapshot;
  constructor(scope: EditScope, snapshot: CapturedEditSnapshot) { this.scope = scope; this.snapshot = snapshot; }
  private value<T>(read: ScopeRead): T {
    const found = this.snapshot.values.find(entry => selectorKey(entry.read) === selectorKey(read));
    if (!found) throw new NeedSnapshot([read]);
    return clone(found.value) as T;
  }
  private collection<T>(kind: 'roots' | 'edits' | 'intents', scope: EditScope, targetId?: string): T[] {
    const full: ScopeRead = { kind, scope };
    const exact: ScopeRead = targetId === undefined ? full : { kind, scope, targetId };
    const fullEntry = this.snapshot.values.find(entry => selectorKey(entry.read) === selectorKey(full));
    const data = fullEntry ? clone(fullEntry.value) as T[] : this.value<T[]>(exact);
    const id = (v: T): string => kind === 'roots' ? (v as unknown as Snapshot).id : kind === 'edits' ? (v as unknown as StoredEdit).batch.id : (v as unknown as { targetId: string }).targetId;
    const target = (v: T): string => kind === 'edits' ? (v as unknown as StoredEdit).batch.targetId : id(v);
    const map = new Map(data.map(v => [id(v), v]));
    for (const [key, value] of this.overlay) {
      const prefix = overlayPrefix(kind, scope);
      if (!key.startsWith(prefix)) continue;
      const keyId = key.slice(prefix.length);
      if (value === null) map.delete(keyId); else map.set(keyId, clone(value) as T);
    }
    return [...map.values()].filter(v => targetId === undefined || target(v) === targetId);
  }
  private set(kind: string, scope: EditScope, id: string, value: unknown) { this.overlay.set(overlayPrefix(kind, scope) + id, clone(value)); }
  private identity() { return { accountId: this.scope.accountId, libraryId: this.scope.libraryId }; }
  private controlValue() {
    const value = this.value<{ control?: DatasetControlRecord; access?: DatasetAccess }>({ kind: 'control', identity: this.identity() });
    if (value.control ? !value.access || canonicalJson(datasetAccess(value.control)) !== canonicalJson(value.access) : value.access !== undefined)
      throw new Error('dataset-control-access-mismatch');
    return value;
  }
  async control() { const before = this.controlValue(); return clone(this.controlOverlay ?? before.control); }
  async access() { const before = this.controlValue(); return this.controlOverlay ? datasetAccess(this.controlOverlay) : before.access; }
  putControl(record: DatasetControlRecord) { this.controlValue(); this.controlOverlay = clone(record); this.mutations.push({ kind: 'put-control', record: clone(record) }); }
  async scopedState(scope: EditScope): Promise<DatasetScopeState> { return { roots: this.collection<Snapshot>('roots', scope), edits: this.collection<StoredEdit>('edits', scope), intents: this.collection<{ targetId: string; record: EditIntentRecord }>('intents', scope), datasets: this.datasetValues(scope) }; }
  putScopedEdit(scope: EditScope, edit: StoredEdit) { this.collection('edits', scope, edit.batch.targetId); this.set('edits', scope, edit.batch.id, edit); this.mutations.push({ kind: 'put-edit', scope: clone(scope), edit: clone(edit) }); }
  private datasetValues(scope: EditScope): DatasetManifest[] { const values = this.value<DatasetManifest[]>({ kind: 'datasets', scope }); const map = new Map(values.map(x => [x.id, x])); for (const mutation of this.mutations) if (mutation.kind === 'put-dataset' && sameScope(mutation.scope, scope)) map.set(mutation.manifest.id, clone(mutation.manifest)); return [...map.values()]; }
  async datasets() { return this.datasetValues(this.scope); }
  putDataset(manifest: DatasetManifest) { this.datasetValues(this.scope); this.mutations.push({ kind: 'put-dataset', scope: clone(this.scope), manifest: clone(manifest) }); }
  async root(targetId: string) { return this.collection<Snapshot>('roots', this.scope, targetId)[0]; }
  async roots() { return this.collection<Snapshot>('roots', this.scope); }
  async edits(targetId?: string) { return this.collection<StoredEdit>('edits', this.scope, targetId); }
  async editById(batchId: string) {
    const overlay = overlayPrefix('edits', this.scope) + batchId;
    if (this.overlay.has(overlay)) return clone(this.overlay.get(overlay)) as StoredEdit | undefined;
    const full: ScopeRead = { kind: 'edits', scope: this.scope };
    const found = this.snapshot.values.find(entry => selectorKey(entry.read) === selectorKey(full));
    return found ? (clone(found.value) as StoredEdit[]).find(edit => edit.batch.id === batchId)
      : this.value<StoredEdit | undefined>({ kind: 'edit-by-id', scope: this.scope, batchId });
  }
  putRoot(root: Snapshot) { this.collection('roots', this.scope, root.id); this.set('roots', this.scope, root.id, root); this.mutations.push({ kind: 'put-root', scope: clone(this.scope), root: clone(root) }); }
  putEdit(edit: StoredEdit) { this.putScopedEdit(this.scope, edit); }
  putProjection(snapshot: Snapshot) { this.mutations.push({ kind: 'put-projection', scope: clone(this.scope), snapshot: clone(snapshot) }); }
  async pruneProjections(targetId: string, versions: string[]) { this.mutations.push({ kind: 'prune-projections', scope: clone(this.scope), targetId, versions: clone(versions) }); }
  resource = async (id: string, scope = this.scope) => { const key = overlayPrefix('resource', scope) + id; if (this.overlay.has(key)) return clone(this.overlay.get(key)) as ResourceMetadata; return this.value<ResourceMetadata | undefined>({ kind: 'resource', scope, resourceId: id }); };
  async resourceBytes(sha256: string, scope = this.scope) { const key = overlayPrefix('resource-bytes', scope) + sha256; if (this.overlay.has(key)) return clone(this.overlay.get(key)) as Uint8Array; return this.value<Uint8Array | undefined>({ kind: 'resource-bytes', scope, sha256 }); }
  putResource(resource: StoredResource) { this.value({ kind: 'resource', scope: this.scope, resourceId: resource.metadata.id }); this.value({ kind: 'resource-bytes', scope: this.scope, sha256: resource.metadata.sha256 }); this.set('resource', this.scope, resource.metadata.id, resource.metadata); this.set('resource-bytes', this.scope, resource.metadata.sha256, resource.bytes); this.mutations.push({ kind: 'put-resource', scope: clone(this.scope), resource: clone(resource) }); }
  async hasCheckpoint(sha256: string) { return this.overlay.has(overlayPrefix('checkpoint-marker', this.scope) + sha256) || this.value<boolean>({ kind: 'checkpoint-marker', scope: this.scope, sha256 }); }
  rememberCheckpoint(sha256: string) { this.value({ kind: 'checkpoint-marker', scope: this.scope, sha256 }); this.set('checkpoint-marker', this.scope, sha256, true); this.mutations.push({ kind: 'remember-checkpoint', scope: clone(this.scope), sha256 }); }
  async intent(targetId: string) { return this.collection<{ targetId: string; record: EditIntentRecord }>('intents', this.scope, targetId)[0]?.record; }
  async intents() { return this.collection<{ targetId: string; record: EditIntentRecord }>('intents', this.scope); }
  putIntent(targetId: string, record: EditIntentRecord | null) { this.collection('intents', this.scope, targetId); this.set('intents', this.scope, targetId, record ? { targetId, record } : null); this.mutations.push({ kind: 'put-intent', scope: clone(this.scope), targetId, record: clone(record) }); }
}
