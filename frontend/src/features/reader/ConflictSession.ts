import type { Snapshot } from '../../runtime/edits/contracts.ts';
import { EditGraph } from '../../runtime/edits/editGraph.ts';
import type { CommitResult, EditRepository } from '../../runtime/edits/ports.ts';

export type ConflictState = { heads: string[]; compared: string[]; checkout: string | null; error: string };
/** Comparing/checking out is local view state. Only an all-head conditional resolution adopts content. */
export class ConflictSession {
  private readonly repository: Pick<EditRepository, 'read'>;
  private readonly resolve?: (snapshot: Snapshot, id: string, heads: readonly string[]) => Promise<CommitResult>;
  private readonly targetId: string;
  private state: ConflictState = { heads: [], compared: [], checkout: null, error: '' };
  private graph?: EditGraph;
  private listeners = new Set<() => void>();
  constructor(repository: Pick<EditRepository, 'read'>, targetId: string,
    resolve?: (snapshot: Snapshot, id: string, heads: readonly string[]) => Promise<CommitResult>) {
    this.repository = repository; this.targetId = targetId; this.resolve = resolve;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<ConflictState>) { this.state = { ...this.state, ...fields }; this.listeners.forEach(listener => listener()); }
  refresh = async () => {
    const value = await this.repository.read(this.targetId);
    this.graph = new EditGraph(value.checkpoint); this.update({ heads: value.heads });
  };
  compare = () => {
    if (!this.graph) throw new Error('not-loaded');
    this.update({ compared: [...this.state.heads], error: '' });
    return this.state.heads.map(head => this.graph!.snapshot(head)!);
  };
  checkout = (version: string) => {
    const value = this.graph?.snapshot(version); if (!value) throw new Error('missing-checkout');
    this.update({ checkout: version }); return value;
  };
  keepBoth = () => { this.update({ compared: [], error: '' }); };
  adopt = async (snapshot: Snapshot, id: string) => {
    const parents = [...this.state.compared];
    if (parents.length < 2) throw new Error('compare-required');
    if (!this.resolve) throw new Error('resolution-authority-required');
    const result = await this.resolve(structuredClone(snapshot), id, parents);
    if (result.status !== 'durable') { this.update({ error: result.reason }); return result; }
    await this.refresh(); this.update({ checkout: id, compared: [], error: '' }); return result;
  };
}
