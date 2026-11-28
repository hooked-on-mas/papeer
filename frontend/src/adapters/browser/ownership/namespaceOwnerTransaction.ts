import { canonicalHostTransaction } from '.././canonicalHostTransaction.ts';
import type { LocalHostAuthority, HostOperation } from '.././localHostAuthority.ts';

/** Each call receives one captured issuer operation, never caller-provided account metadata. */
export function namespaceOwnerAccount(authority: LocalHostAuthority, operation: HostOperation): string {
 const record = authority.captureRecord(operation);
 if (record.family !== 'namespace-owner' || record.tuple !== null) throw new Error('namespace-owner-invalid');
 return record.grant.namespaceId;
}
/** Synchronous IndexedDB request chains only; the grant is checked before and after the chain. */
export function namespaceOwnerTransaction<T>(authority: LocalHostAuthority, operation: HostOperation, stores: readonly string[], mode: IDBTransactionMode,
 enqueue: (tx: IDBTransaction, account: string, finish: (value: T) => void) => void): Promise<T> {
 const account = namespaceOwnerAccount(authority, operation);
 return canonicalHostTransaction<T>(authority, operation, stores, mode, (tx, tuple, finish) => {
  if(tuple !== null || namespaceOwnerAccount(authority, operation) !== account) throw new Error('namespace-owner-invalid');
  enqueue(tx, account, finish);
 });
}
