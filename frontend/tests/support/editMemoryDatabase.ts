import type { ResourceMetadata, Snapshot, EditIntentRecord, DatasetManifest, DatasetControlRecord } from '../../src/runtime/edits/contracts.ts';
import { scopeKey, type EditDatabase, type EditTransaction, type StoredEdit } from '../../src/runtime/edits/repository.ts';
import type { EditScope } from '../../src/runtime/edits/ports.ts';
import { datasetAccess, datasetIdentityKey } from '../../src/runtime/edits/datasetControl.ts';

type MemoryScope = { roots: Map<string, Snapshot>; edits: Map<string, StoredEdit>; resources: Map<string, ResourceMetadata>;
  resourceBytes: Map<string, Uint8Array>; checkpoints: Set<string>; intents: Map<string, EditIntentRecord>; datasets: Map<string, DatasetManifest> };
type MemoryState = { scopes: Map<string, MemoryScope>; controls: Map<string, DatasetControlRecord>; tail: Promise<void> };
const empty = (): MemoryScope => ({ roots: new Map(), edits: new Map(), resources: new Map(), resourceBytes: new Map(), checkpoints: new Set(), intents: new Map(), datasets: new Map() });
/** Session tests only. Native scope/control atomicity is verified in SQLite and actual browsers. */
export class EditMemoryDatabase implements EditDatabase {
  private readonly state: MemoryState;
  private readonly namespace: string;
  private readonly identity: string;
  constructor(scope?: EditScope, shared?: EditMemoryDatabase) {
    this.namespace = scope ? scopeKey(scope) : 'default'; this.identity = scope ? datasetIdentityKey(scope) : 'default';
    this.state = shared?.state ?? { scopes: new Map(), controls: new Map(), tail: Promise.resolve() };
  }
  fork(scope: EditScope) { return new EditMemoryDatabase(scope, this); }
  async transaction<T>(run: (transaction: EditTransaction) => Promise<T>): Promise<T> {
    const previous = this.state.tail; let release!: () => void;
    this.state.tail = new Promise(resolve => { release = resolve; }); await previous;
    const scopes = structuredClone(this.state.scopes), controls = structuredClone(this.state.controls);
    const at = (namespace: string) => { if (!scopes.has(namespace)) scopes.set(namespace, empty()); return scopes.get(namespace)!; };
    const current = at(this.namespace);
    const scoped = (scope: EditScope) => {
      if (datasetIdentityKey(scope) !== this.identity) throw new Error('dataset-scope');
      return at(scopeKey(scope));
    };
    try {
      const result = await run({
        control: async () => controls.get(this.identity), access: async () => { const value = controls.get(this.identity); return value ? datasetAccess(value) : undefined; },
        putControl: record => { controls.set(this.identity, record); },
        scopedState: async scope => { const value = scoped(scope); return { roots: [...value.roots.values()], edits: [...value.edits.values()],
          intents: [...value.intents].map(([targetId, record]) => ({ targetId, record })), datasets: [...value.datasets.values()] }; },
        putScopedEdit: (scope, edit) => { scoped(scope).edits.set(edit.batch.id, edit); },
        datasets: async () => [...current.datasets.values()], putDataset: manifest => { current.datasets.set(manifest.id, manifest); },
        root: async targetId => current.roots.get(targetId), roots: async () => [...current.roots.values()],
        edits: async targetId => [...current.edits.values()].filter(edit => !targetId || edit.batch.targetId === targetId),
        editById: async batchId => current.edits.get(batchId),
        intent: async targetId => current.intents.get(targetId), putIntent: (targetId, record) => { if (record) current.intents.set(targetId, record); else current.intents.delete(targetId); },
        intents: async () => [...current.intents].map(([targetId, record]) => ({ targetId, record })),
        putRoot: root => { current.roots.set(root.id, root); }, putEdit: edit => { current.edits.set(edit.batch.id, edit); }, putProjection: () => undefined,
        pruneProjections: async () => undefined,
        resource: async (id, scope) => (scope && this.namespace !== 'default' ? scoped(scope) : current).resources.get(id),
        resourceBytes: async (hash, scope) => (scope && this.namespace !== 'default' ? scoped(scope) : current).resourceBytes.get(hash),
        hasCheckpoint: async hash => current.checkpoints.has(hash), rememberCheckpoint: hash => { current.checkpoints.add(hash); },
        putResource: resource => { current.resources.set(resource.metadata.id, resource.metadata); current.resourceBytes.set(resource.metadata.sha256, resource.bytes); },
      });
      this.state.scopes = scopes; this.state.controls = controls; return result;
    } finally { release(); }
  }
}
