// LEGACY-COPY B13-d U5: verbatim copy of the pre-U5 product file editGraph.ts (only the import specifiers are rewritten for tests/support).
// LEGACY-COPY Do not edit: tests/syncPathEquivalence.test.ts maps the specifiers back and checks the sha256 of the original.
import { applyValidatedBatch, assertBatch, assertSnapshot, canonicalJson, EditRejected } from '../../src/runtime/edits/editModel.ts';
import type { EditBatch, Snapshot } from '../../src/runtime/edits/contracts.ts';

export type GraphCheckpoint = { version: 1; libraryId: string; root: Snapshot; batches: EditBatch[] };
export type GraphView = { heads: string[]; waiting: string[]; rejected: Record<string, string> };

/** Keep the immutable batches, not a growing annotation array for every version.
 * Old branches are materialized iteratively from the closest cached ancestor. */
class GraphStates {
  readonly known: Set<string>;
  private readonly cache: Map<string, Snapshot>;
  private readonly root: Snapshot;
  private readonly nodes: Map<string, EditBatch>;
  constructor(root: Snapshot, nodes: Map<string, EditBatch>, previous?: GraphStates) {
    this.root = root; this.nodes = nodes;
    this.known = new Set(previous?.known ?? [root.version]);
    this.cache = new Map(previous?.cache);
  }
  has(version: string): boolean { return this.known.has(version); }
  put(version: string, snapshot: Snapshot): void {
    this.known.add(version);
    this.cache.delete(version); this.cache.set(version, snapshot);
    while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
  }
  get(version: string): Snapshot | undefined {
    if (!this.has(version)) return undefined;
    const path: string[] = [];
    let current = version;
    while (current !== this.root.version && !this.cache.has(current)) {
      path.push(current); current = this.nodes.get(current)!.parents[0];
    }
    let snapshot = this.cache.get(current) ?? this.root;
    for (let index = path.length - 1; index >= 0; index--) {
      const id = path[index]; snapshot = applyValidatedBatch(snapshot, this.nodes.get(id)!); this.put(id, snapshot);
    }
    if (version !== this.root.version) this.put(version, snapshot);
    return snapshot;
  }
}

/** One graph per document, Markdown body, or library catalog. No receiving-order winner. */
export class EditGraph {
  private nodes = new Map<string, EditBatch>();
  private states: GraphStates;
  private view: GraphView = { heads: [], waiting: [], rejected: {} };
  private readonly rootSnapshot: Snapshot;
  get root(): Snapshot { return structuredClone(this.rootSnapshot); }
  readonly libraryId: string;
  constructor(checkpoint: GraphCheckpoint) {
    if (checkpoint.version !== 1) throw new EditRejected('checkpoint-version');
    assertSnapshot(checkpoint.root);
    this.rootSnapshot = structuredClone(checkpoint.root); this.libraryId = checkpoint.libraryId;
    this.states = new GraphStates(this.rootSnapshot, this.nodes);
    this.receive(checkpoint.batches);
  }
  receive(batches: EditBatch[]): void {
    // Validate the whole arrival before changing the in-memory graph.
    const nodes = new Map(this.nodes);
    for (const batch of batches) {
      assertBatch(batch);
      if (batch.libraryId !== this.libraryId || batch.targetId !== this.rootSnapshot.id || batch.id === this.rootSnapshot.version) throw new EditRejected('batch-scope');
      const previous = nodes.get(batch.id);
      if (previous && canonicalJson(previous) !== canonicalJson(batch)) throw new EditRejected('batch-id-reused');
      nodes.set(batch.id, structuredClone(batch));
    }
    // Iterative topological traversal also handles years of history without overflowing a JS/Python call stack.
    const children = new Map<string, string[]>(), degree = new Map<string, number>();
    for (const [id, node] of nodes) {
      degree.set(id, node.parents.filter(parent => nodes.has(parent)).length);
      for (const parent of node.parents) {
        let list = children.get(parent);
        if (!list) { list = []; children.set(parent, list); }
        list.push(id);
      }
    }
    const ordered: string[] = [], ready = [...degree].filter(([, count]) => !count).map(([id]) => id);
    for (let index = 0; index < ready.length; index++) {
      const id = ready[index]; ordered.push(id);
      for (const child of children.get(id) ?? []) { degree.set(child, degree.get(child)! - 1); if (!degree.get(child)) ready.push(child); }
    }
    if (ordered.length !== nodes.size) throw new EditRejected('parent-cycle');
    const states = new GraphStates(this.rootSnapshot, nodes, this.states);
    const pending = new Map(ordered.map(id => [id, nodes.get(id)!]));
    const rejected: Record<string, string> = Object.create(null);
    for (const [id, batch] of pending) {
        if (states.has(id)) { pending.delete(id); continue; }
        if (batch.parents.some(parent => Object.prototype.hasOwnProperty.call(rejected, parent))) {
          rejected[id] = 'rejected-parent'; pending.delete(id); continue;
        }
        if (!batch.parents.every(parent => states.has(parent))) continue;
        try {
          const parent = states.get(batch.parents[0])!;
          if (batch.parents.some(id => states.get(id)!.kind !== parent.kind)) throw new EditRejected('resolution-parent-kind');
          states.put(id, applyValidatedBatch(parent, batch));
        } catch (error) { rejected[id] = error instanceof Error ? error.message : String(error); }
        pending.delete(id);
    }
    const heads = new Set(states.known);
    for (const [id, batch] of nodes) if (states.has(id)) batch.parents.forEach(parent => heads.delete(parent));
    this.nodes = nodes;
    this.states = states;
    this.view = { heads: [...heads].sort(), waiting: [...pending.keys()].sort(), rejected };
  }
  /** Local resolution must compare exactly the current known heads. Remote late heads remain conflicts. */
  assertLocal(batch: EditBatch): void {
    assertBatch(batch);
    if (batch.kind === 'resolution' && canonicalJson([...batch.parents].sort()) !== canonicalJson(this.view.heads)) throw new EditRejected('heads-changed');
    if (batch.parents.some(parent => !this.states.has(parent))) throw new EditRejected('missing-local-parent');
  }
  getView(): GraphView { return structuredClone(this.view); }
  snapshot(version: string): Snapshot | undefined { const state = this.states.get(version); return state ? structuredClone(state) : undefined; }
  checkpoint(): GraphCheckpoint { return { version: 1, libraryId: this.libraryId, root: structuredClone(this.rootSnapshot), batches: structuredClone([...this.nodes.values()]) }; }
  /** Is an observed version an ancestor of this head? Used by deletion recovery queries. */
  descendsFrom(head: string, ancestor: string): boolean {
    const pending = [head], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === ancestor) return this.states.has(id);
      if (seen.has(id)) continue;
      seen.add(id); pending.push(...(this.nodes.get(id)?.parents ?? []));
    }
    return false;
  }
}
