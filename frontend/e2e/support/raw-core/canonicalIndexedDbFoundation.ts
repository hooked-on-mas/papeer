// Test-only raw Core/migration fixture; never a production authorization port.
import { validateCanonicalDevicePeer, type CanonicalDevicePeer, type CanonicalLibraryProfile, type CanonicalLibraryInitializationIntent } from '../../../src/runtime/edits/contracts.ts';
import { assertCanonicalProfile } from '../../../src/runtime/edits/canonicalBootstrap.ts';
import { assertInitializationIntent } from '../../../src/runtime/edits/canonicalInitializationIntent.ts';
import type { CanonicalPrincipalLease } from '../../../src/runtime/edits/canonicalInitializationStorage.ts';
import { openCanonicalDatabase, openCanonicalReadonly, CANONICAL_DATABASE_NAME } from '../../../src/adapters/browser/canonicalIndexedDbSchema.ts';

type Row<T> = { key: string; scope: string; value: T };
const key = (...parts: string[]) => JSON.stringify(parts);
function assertLease(lease: CanonicalPrincipalLease, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  lease.assertCurrent();
}
function waitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => { /* abort is authoritative */ };
  });
}
function abortOnSignal(tx: IDBTransaction, signal: AbortSignal): () => void {
  const abort = () => { try { tx.abort(); } catch { /* already finished */ } };
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  return () => signal.removeEventListener('abort', abort);
}
/** Readonly metadata snapshot is not accepted-receipt proof and must not be exposed as list(). */
export type MetadataSnapshot = { profiles: CanonicalLibraryProfile[]; intents: CanonicalLibraryInitializationIntent[] };
export class CanonicalIndexedDbFoundation {
  private readonly factory: IDBFactory;
  private readonly name: string;
  constructor(factory: IDBFactory = indexedDB, name = CANONICAL_DATABASE_NAME) { this.factory = factory; this.name = name; }
  async readMetadataSnapshot(lease: CanonicalPrincipalLease, signal: AbortSignal): Promise<{ status: 'uninitialized' } | { status: 'ready'; snapshot: MetadataSnapshot }> {
    assertLease(lease, signal); const opened = await openCanonicalReadonly(this.factory, this.name);
    try {
      assertLease(lease, signal); if (opened.status === 'uninitialized') return opened;
      const tx = opened.database.transaction(['canonicalProfiles', 'canonicalInitialIntents'], 'readonly');
      const done = waitTransaction(tx), unbind = abortOnSignal(tx, signal);
      const profiles = tx.objectStore('canonicalProfiles').index('scope').getAll(lease.accountId);
      const intents = tx.objectStore('canonicalInitialIntents').index('scope').getAll(lease.accountId);
      try { await done; } finally { unbind(); }
      assertLease(lease, signal);
      const p = profiles.result as Row<CanonicalLibraryProfile>[], i = intents.result as Row<CanonicalLibraryInitializationIntent>[];
      const validatedProfiles: CanonicalLibraryProfile[] = [];
      for (const row of p) {
        assertCanonicalProfile(row.value);
        if (row.scope !== lease.accountId || row.value.identity.accountId !== lease.accountId || row.key !== key(lease.accountId, row.value.identity.libraryId)) throw new Error('recovery-required');
        validatedProfiles.push(row.value);
      }
      const validatedIntents: CanonicalLibraryInitializationIntent[] = [];
      for (const row of i) {
        const value = await assertInitializationIntent(row.value);
        if (row.scope !== lease.accountId || value.accountId !== lease.accountId || row.key !== key(lease.accountId, value.requestId)) throw new Error('recovery-required');
        validatedIntents.push(value);
      }
      assertLease(lease, signal); return { status: 'ready', snapshot: { profiles: validatedProfiles, intents: validatedIntents } };
    } finally { if (opened.status === 'ready') opened.database.close(); }
  }
  /** Host lease guard is mandatory and spans actual commit. Winner is keyed by account. */
  async getOrCreatePeer(lease: CanonicalPrincipalLease, candidatePeerId: string, signal: AbortSignal): Promise<CanonicalDevicePeer> {
    const candidate: CanonicalDevicePeer = { version: 1, accountId: lease.accountId, peerId: candidatePeerId };
    validateCanonicalDevicePeer(candidate); assertLease(lease, signal);
    const db = await openCanonicalDatabase(this.factory, this.name);
    try {
      assertLease(lease, signal);
      const peer = await lease.withCommitGuard(async () => {
        assertLease(lease, signal);
        const tx = db.transaction(['canonicalPeers'], 'readwrite', { durability: 'strict' });
        const done = waitTransaction(tx), unbind = abortOnSignal(tx, signal); let winner: CanonicalDevicePeer | undefined, failure: unknown;
        const get = tx.objectStore('canonicalPeers').get(lease.accountId);
        get.onsuccess = () => {
          try {
            assertLease(lease, signal); const row = get.result as Row<CanonicalDevicePeer> | undefined;
            if (row) {
              validateCanonicalDevicePeer(row.value);
              if (row.key !== lease.accountId || row.scope !== lease.accountId || row.value.accountId !== lease.accountId) throw new Error('recovery-required');
              winner = structuredClone(row.value);
            } else {
              winner = candidate;
              tx.objectStore('canonicalPeers').add({ key: lease.accountId, scope: lease.accountId, value: candidate } satisfies Row<CanonicalDevicePeer>);
            }
            assertLease(lease, signal);
          } catch (error) { failure = error; try { tx.abort(); } catch { /* completed */ } }
        };
        try { await done; } catch (error) { throw failure ?? error; } finally { unbind(); }
        assertLease(lease, signal); if (!winner) throw new Error('canonical-peer-missing'); return winner;
      });
      assertLease(lease, signal); return peer;
    } finally { db.close(); }
  }
}
