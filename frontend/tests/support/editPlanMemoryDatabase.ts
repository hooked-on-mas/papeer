import { datasetAccess, datasetIdentityKey } from '../../src/runtime/edits/datasetControl.ts';
import type { DatasetControlRecord, DatasetManifest, EditIntentRecord, ResourceMetadata, Snapshot } from '../../src/runtime/edits/contracts.ts';
import type { EditScope } from '../../src/runtime/edits/ports.ts';
import type { StoredEdit } from '../../src/runtime/edits/repository.ts';
import { scopeKey } from '../../src/runtime/edits/repository.ts';
import { type CapturedEditSnapshot, type EditMutation, type PlanDatabase, type PreparedEditPlan, type RepositoryOperation, type ScopeRead } from '../../src/runtime/edits/repositoryPlan.ts';

type ScopeState = { roots: Map<string, Snapshot>; edits: Map<string, StoredEdit>; intents: Map<string, EditIntentRecord>; datasets: Map<string, DatasetManifest>; resources: Map<string, ResourceMetadata>; bytes: Map<string, Uint8Array>; markers: Set<string> };
const empty = (): ScopeState => ({ roots: new Map(), edits: new Map(), intents: new Map(), datasets: new Map(), resources: new Map(), bytes: new Map(), markers: new Set() });
const copy = <T>(x: T): T => structuredClone(x);
const canonical = (value: unknown): unknown => {
  if (value === undefined) return { absent: true };
  if (value instanceof Uint8Array) return { bytes: [...value] };
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
};
const comparable = (value: unknown): string => JSON.stringify(canonical(value));
type Token = { operation: RepositoryOperation; reads: ScopeRead[]; values: unknown[]; used: boolean };
/** A fake authority for Core tests only; it does not establish host permission or durability. */
export class EditPlanMemoryDatabase implements PlanDatabase {
  private scopes = new Map<string, ScopeState>();
  private controls = new Map<string, DatasetControlRecord>();
  private tokens = new WeakMap<object, Token>();
  private at(scope: EditScope): ScopeState { const key = scopeKey(scope); let value = this.scopes.get(key); if (!value) { value = empty(); this.scopes.set(key, value); } return value; }
  private read(read: ScopeRead): unknown {
    if (read.kind === 'control') { const control = this.controls.get(datasetIdentityKey(read.identity)); return { control, access: control ? datasetAccess(control) : undefined }; }
    const state = this.at(read.scope);
    switch (read.kind) {
      case 'roots': return [...state.roots.values()].filter(x => read.targetId === undefined || x.id === read.targetId).sort((a, b) => a.id.localeCompare(b.id));
      case 'edit-by-id': return state.edits.get(read.batchId);
      case 'edits': return [...state.edits.values()].filter(x => read.targetId === undefined || x.batch.targetId === read.targetId).sort((a, b) => a.batch.id.localeCompare(b.batch.id));
      case 'intents': return [...state.intents].filter(([id]) => read.targetId === undefined || id === read.targetId).map(([targetId, record]) => ({ targetId, record })).sort((a, b) => a.targetId.localeCompare(b.targetId));
      case 'datasets': return [...state.datasets.values()].filter(x => read.manifestId === undefined || x.id === read.manifestId).sort((a, b) => a.id.localeCompare(b.id));
      case 'resource': return state.resources.get(read.resourceId);
      case 'resource-bytes': return state.bytes.get(read.sha256);
      case 'checkpoint-marker': return state.markers.has(read.sha256);
    }
  }
  async capture(operation: RepositoryOperation, reads: readonly ScopeRead[]): Promise<CapturedEditSnapshot> {
    const stableReads = copy([...reads]); if (operation !== 'receipt' && stableReads.some(read => read.kind === 'edit-by-id')) throw new Error('host-operation-forbidden'); const values = stableReads.map(read => copy(this.read(read))); const comparison = {};
    this.tokens.set(comparison, { operation, reads: stableReads, values: copy(values), used: false });
    return { values: stableReads.map((read, i) => ({ read: copy(read), value: copy(values[i]) })), comparison };
  }
  async compareAndApply(operation: RepositoryOperation, plan: PreparedEditPlan<unknown>) {
    const token = this.tokens.get(plan.snapshot.comparison);
    if (!token || token.used || token.operation !== operation) throw new Error('invalid-snapshot-token');
    token.used = true;
    if (token.reads.some((read, i) => comparable(this.read(read)) !== comparable(token.values[i]))) return { status: 'changed' as const };
    // This test fake still refuses blind authoritative overwrites.
    const mutations = copy([...plan.mutations]);
    for (const mutation of mutations) {
      const contains = (kind: ScopeRead['kind'], scope?: EditScope, target?: string) => token.reads.some(read => {
        if (read.kind !== kind) return false;
        if (read.kind === 'control') return mutation.kind === 'put-control' && datasetIdentityKey(read.identity) === datasetIdentityKey(mutation.record.identity);
        if (!scope || scopeKey(read.scope) !== scopeKey(scope)) return false;
        if (read.kind === 'roots' || read.kind === 'edits' || read.kind === 'intents') return read.targetId === undefined || read.targetId === target;
        if (read.kind === 'datasets') return read.manifestId === undefined || read.manifestId === target;
        if (read.kind === 'resource') return read.resourceId === target;
        return 'sha256' in read && read.sha256 === target;
      });
      let covered = true;
      switch (mutation.kind) {
        case 'put-control': covered = contains('control'); break;
        case 'put-root': covered = contains('roots', mutation.scope, mutation.root.id); break;
        case 'put-edit': covered = contains('edits', mutation.scope, mutation.edit.batch.targetId); break;
        case 'put-intent': covered = contains('intents', mutation.scope, mutation.targetId); break;
        case 'put-dataset': covered = contains('datasets', mutation.scope, mutation.manifest.id); break;
        case 'put-resource': covered = contains('resource', mutation.scope, mutation.resource.metadata.id) && contains('resource-bytes', mutation.scope, mutation.resource.metadata.sha256); break;
        case 'remember-checkpoint': covered = contains('checkpoint-marker', mutation.scope, mutation.sha256); break;
        case 'put-projection': case 'prune-projections': covered = token.reads.length > 0; break;
      }
      if (!covered) throw new Error('mutation-prestate-not-captured');
    }
    for (const mutation of mutations) this.apply(mutation);
    return { status: 'committed' as const };
  }
  private apply(mutation: EditMutation): void {
    if (mutation.kind === 'put-control') { this.controls.set(datasetIdentityKey(mutation.record.identity), mutation.record); return; }
    const state = this.at(mutation.scope);
    switch (mutation.kind) {
      case 'put-root': state.roots.set(mutation.root.id, mutation.root); break;
      case 'put-edit': state.edits.set(mutation.edit.batch.id, mutation.edit); break;
      case 'put-intent': if (mutation.record) state.intents.set(mutation.targetId, mutation.record); else state.intents.delete(mutation.targetId); break;
      case 'put-dataset': state.datasets.set(mutation.manifest.id, mutation.manifest); break;
      case 'put-resource': state.resources.set(mutation.resource.metadata.id, mutation.resource.metadata); state.bytes.set(mutation.resource.metadata.sha256, mutation.resource.bytes); break;
      case 'remember-checkpoint': state.markers.add(mutation.sha256); break;
      case 'put-projection': case 'prune-projections': break;
    }
  }
  /** Test-only controlled concurrent change, bypassing plans; no host authority is simulated. */
  mutate(mutation: EditMutation): void { this.apply(copy(mutation)); }
}
