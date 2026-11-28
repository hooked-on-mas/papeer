import type { EditScope } from './ports.ts';
import { EditRejected } from './editModel.ts';
import { EditPlanView, NeedSnapshot, selectorKey, type PlanDatabase, type PreparedEditPlan, type RepositoryOperation, type ScopeRead } from './repositoryPlan.ts';

/** Storage failures are retryable, never a Core semantic rejection. */
export class RepositorySnapshotChanged extends Error { constructor() { super('repository-snapshot-changed'); } }
export type NativeAttemptEvidence = 'not-sent' | 'cas-no-write' | 'sent' | 'aborted' | 'committed' | 'unknown';
/** Owned by the host-bound call and retained until the outer gate has classified delivery. */
export interface RepositoryExecutionEvidence {
  readonly requestFingerprint: string;
  readonly attempts: readonly NativeAttemptEvidence[];
}
/** Issued only to the native adapter bound to one captured operation. */
export interface NativeAttemptRecorder {
  sent(): void;
  casNoWrite(): void;
  aborted(): void;
  unknown(): void;
  committed(): void;
}
export interface BoundPlanEvidence { startAttempt(): NativeAttemptRecorder }
export interface PlanEvidence {
  readonly view: RepositoryExecutionEvidence;
  bind(operation: object): BoundPlanEvidence;
}
const operationOwners = new WeakMap<object, object>();
export function fingerprintPlanInput(operation: RepositoryOperation, fixed: readonly unknown[]): string {
  return JSON.stringify([operation, fixed], (_key, value) =>
    value instanceof Uint8Array ? { __bytes: value.byteLength }
      : value instanceof ArrayBuffer ? { __bytes: value.byteLength }
        : value);
}
/** The host holds this capability privately until outer delivery is classified. */
export function createPlanEvidence(requestFingerprint: string, prior: readonly NativeAttemptEvidence[] = []): PlanEvidence {
  const attempts = [...prior];
  const identity = {};
  let bound = false;
  const view: RepositoryExecutionEvidence = Object.freeze({
    requestFingerprint,
    get attempts(): readonly NativeAttemptEvidence[] { return Object.freeze([...attempts]); },
  });
  const bind = (operation: object): BoundPlanEvidence => {
    if (!operation || typeof operation !== 'object' || bound || operationOwners.has(operation)) throw new Error('repository-evidence-already-bound');
    bound = true; operationOwners.set(operation, identity);
    return Object.freeze({ startAttempt(): NativeAttemptRecorder {
      const index = attempts.push('not-sent') - 1;
      const set = (next: NativeAttemptEvidence, allowed: readonly NativeAttemptEvidence[]) => {
        if (!allowed.includes(attempts[index])) throw new Error('repository-evidence-invalid-transition');
        attempts[index] = next;
      };
      return Object.freeze({
        sent: () => set('sent', ['not-sent']),
        casNoWrite: () => set('cas-no-write', ['not-sent', 'sent', 'unknown']),
        aborted: () => set('aborted', ['not-sent', 'sent', 'unknown']),
        unknown: () => set('unknown', ['sent']),
        committed: () => set('committed', ['sent', 'unknown']),
      });
    } });
  };
  return Object.freeze({ view, bind });
}
export async function executeRepositoryPlan<T>(args: {
  operation: RepositoryOperation; scope: EditScope; database: PlanDatabase; reads: readonly ScopeRead[]; write: boolean;
  /** Called once per new snapshot; fixed request values must be captured by the caller. */
  plan: (view: EditPlanView) => Promise<T>;
  /** Batch dependency enumeration before invoking validators. */
  dependencies?: (view: EditPlanView) => Promise<readonly ScopeRead[]>;
}): Promise<T> {
  const reads = new Map(args.reads.map(read => [selectorKey(read), structuredClone(read)]));
  const execute = async (start: number, end: number, database: PlanDatabase): Promise<{ done: true; value: T } | { done: false; changed: boolean }> => {
  let changed = false;
  for (let attempt = start; attempt < end; attempt++) {
    // Selector closure shares the same bound operation. Each capture replaces the whole snapshot.
    for (let closure = 0; closure < 3; closure++) {
      const snapshot = await database.capture(args.operation, [...reads.values()]);
      const view = new EditPlanView(args.scope, snapshot);
      try {
        const dependencies = await args.dependencies?.(view) ?? [];
        let added = false;
        for (const read of dependencies) if (!reads.has(selectorKey(read))) { reads.set(selectorKey(read), structuredClone(read)); added = true; }
        if (added) continue;
        let result: T;
        try { result = await args.plan(view); }
        catch (error) {
          // Schema validation here is pure Core work against the closed snapshot;
          // storage and host failures originate outside this callback.
          if (error instanceof Error && error.message.startsWith('Invalid edit data:')) throw new EditRejected(error.message);
          throw error;
        }
        if (!args.write) return { done: true, value: structuredClone(result) };
        const plan: PreparedEditPlan<T> = { snapshot, mutations: structuredClone(view.mutations), result: structuredClone(result) };
        if ((await database.compareAndApply(args.operation, plan)).status === 'committed') return { done: true, value: structuredClone(result) };
        changed = true;
        break;
      } catch (error) {
        if (!(error instanceof NeedSnapshot)) throw error;
        let added = false;
        for (const read of error.reads) if (!reads.has(selectorKey(read))) { reads.set(selectorKey(read), structuredClone(read)); added = true; }
        if (!added) throw error;
      }
    }
  }
  return { done: false, changed };
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await execute(attempt, attempt + 1, args.database);
    if (current.done) return current.value;
    if (current.changed && attempt < 2 && args.database.withRetryLease) {
      const remaining = await args.database.withRetryLease(database => execute(attempt + 1, 3, database));
      if (remaining.done) return remaining.value;
      throw new RepositorySnapshotChanged();
    }
  }
  throw new RepositorySnapshotChanged();
}
