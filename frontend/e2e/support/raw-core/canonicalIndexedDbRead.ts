// Test-only raw Core/migration fixture; never a production authorization port.
import type { CanonicalPrincipalLease, InitializationOutcome } from '../../../src/runtime/edits/canonicalInitializationStorage.ts';
import { initializationReceipt, validateInitializationRead, type CanonicalStoredRow, type InitializationReadSnapshot } from '../../../src/runtime/edits/canonicalInitializationReadProof.ts';
import { openCanonicalReadonly, CANONICAL_DATABASE_NAME } from '../../../src/adapters/browser/canonicalIndexedDbSchema.ts';
import type { CanonicalLibraryProfile, CanonicalLibraryInitializationIntent } from '../../../src/runtime/edits/contracts.ts';

function current(lease: CanonicalPrincipalLease, signal: AbortSignal) { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); lease.assertCurrent(); }
/** OWNER context only: caller must own the entire local namespace. A library-scoped provider must not use this reader. */
export class CanonicalIndexedDbRead {
  private readonly factory: IDBFactory; private readonly name: string;
  constructor(factory: IDBFactory = indexedDB, name = CANONICAL_DATABASE_NAME) { this.factory = factory; this.name = name; }
  private async snapshot(lease: CanonicalPrincipalLease, signal: AbortSignal): Promise<InitializationReadSnapshot | null> {
    current(lease, signal); const opened = await openCanonicalReadonly(this.factory, this.name);
    try {
      current(lease, signal); if (opened.status === 'uninitialized') return null;
      const names = ['canonicalProfiles', 'canonicalInitialIntents', 'canonicalInitialArtifacts', 'datasetControls', 'roots', 'datasets', 'checkpoints'];
      const tx = opened.database.transaction(names, 'readonly');
      const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new DOMException('Aborted', 'AbortError')); });
      const abort = () => { try { tx.abort(); } catch { /* finished */ } }; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      const rows: CanonicalStoredRow[][] = names.map(() => []); let metadata = 3;
      const afterMetadata = () => {
        if (--metadata) return;
        const libraries = new Set(rows[0].map(row => (row.value as CanonicalLibraryProfile).identity.libraryId));
        for (const library of libraries) {
          const identity = JSON.stringify([lease.accountId, library]), prefix = identity.slice(0, -1) + ',';
          for (let i = 3; i < names.length; i++) {
            const range = i === 3 ? IDBKeyRange.only(identity) : IDBKeyRange.bound(prefix, prefix + '\uffff');
            const cursor = tx.objectStore(names[i]).index('scope').openCursor(range);
            cursor.onsuccess = () => { const item = cursor.result; if (item) { rows[i].push(item.value as CanonicalStoredRow); item.continue(); } };
          }
        }
      };
      for (let i = 0; i < 3; i++) {
        const request = tx.objectStore(names[i]).index('scope').getAll(lease.accountId);
        request.onsuccess = () => { rows[i] = request.result as CanonicalStoredRow[]; afterMetadata(); };
      }
      try { await done; } finally { signal.removeEventListener('abort', abort); }
      current(lease, signal);
      return structuredClone({ profiles: rows[0], intents: rows[1], artifacts: rows[2], controls: rows[3], roots: rows[4], datasets: rows[5], checkpoints: rows[6] });
    } finally { if (opened.status === 'ready') opened.database.close(); }
  }
  async list(lease: CanonicalPrincipalLease, signal: AbortSignal): Promise<{ profiles: CanonicalLibraryProfile[]; intents: CanonicalLibraryInitializationIntent[] }> {
    const snapshot = await this.snapshot(lease, signal); current(lease, signal);
    if (!snapshot) return { profiles: [], intents: [] };
    const result = await validateInitializationRead(snapshot, lease.accountId); current(lease, signal);
    return { profiles: result.profiles, intents: result.intents.filter(intent => !('retired' in intent)) };
  }
  async query(lease: CanonicalPrincipalLease, requestId: string, signal: AbortSignal): Promise<InitializationOutcome> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) throw new Error('invalid-id');
    const snapshot = await this.snapshot(lease, signal); current(lease, signal); if (!snapshot) return { status: 'not-found' };
    const result = await validateInitializationRead(snapshot, lease.accountId); current(lease, signal);
    const profile = result.profiles.find(value => value.initialization?.requestId === requestId);
    const intent = result.intents.find(value => value.requestId === requestId);
    if (profile) return { status: 'accepted', receipt: initializationReceipt(profile) };
    if (!intent) return { status: 'not-found' };
    return intent.result ?? { status: 'pending' };
  }
}
