// Fake OWNER lease and random local database are fixture-only; production requires a host-issued lease.
import golden from '../../../tests/fixtures/canonical-bootstrap.json';
import { checkpointHash } from '../../src/runtime/edits/datasetManifest.ts';
import { CanonicalIndexedDbStorage } from '../../e2e/support/raw-core/canonicalIndexedDbStorage.ts';
import { createIndexedDbEditRepository } from '../../e2e/support/raw-core/indexedDbEdits.ts';
import type { CanonicalInitializeRequest, RepositoryCheckpoint } from '../../src/runtime/edits/contracts.ts';
import type { CanonicalPrincipalLease } from '../../src/runtime/edits/canonicalInitializationStorage.ts';
async function cases() {
 const name = `bootstrap-execute-${crypto.randomUUID()}`, account = golden.peer.accountId;
 const lease: CanonicalPrincipalLease = { accountId: account, generation: 'fixture', assertCurrent() {}, async withCommitGuard<T>(fn: () => Promise<T>) { return fn(); } };
 const signal = new AbortController().signal, storage = new CanonicalIndexedDbStorage(indexedDB, name);
 try {
  const peer = await storage.getOrCreatePeer(lease, golden.peer.peerId, signal);
  const one = async () => {
   const libraryId = crypto.randomUUID(), requestId = crypto.randomUUID(), rootVersion = crypto.randomUUID();
   const identity = { accountId: account, libraryId }, scope = { ...identity, epoch: crypto.randomUUID() };
   const checkpoint: RepositoryCheckpoint = { version: 1, libraryId, roots: [{ kind: 'library', id: libraryId, version: rootVersion, items: [], folders: [], links: [], deletions: [] }], edits: [] };
   const manifest = { version: 1 as const, id: crypto.randomUUID(), scope, checkpointSha256: await checkpointHash(checkpoint), resources: [] };
   const request: CanonicalInitializeRequest = { expectedPeerId: peer.peerId, profile: { version: 1, revision: crypto.randomUUID(), identity, title: 'Fixture library', remote: null }, control: { version: 1, id: requestId, identity, epochs: [scope.epoch], active: manifest, transition: { id: requestId, mode: 'initialize', source: null, phase: 'activated', publication: { manifest, checkpoint, checkpointObjectId: crypto.randomUUID() } } } };
   const pending = await storage.prepare(lease, request, signal);
   let pendingRetained = false; try { await storage.acknowledge(lease, requestId, signal); } catch { pendingRetained = (await storage.query(lease, requestId, signal)).status === 'pending'; }
   const canceled = new AbortController(); canceled.abort(); let cancelRetained = false;
   try { await storage.acknowledge(lease, requestId, canceled.signal); } catch { cancelRetained = (await storage.query(lease, requestId, signal)).status === 'pending'; }
   const accepted = await storage.execute(lease, requestId, signal), replay = await storage.execute(lease, requestId, signal);
   await storage.acknowledge(lease, requestId, signal);
   const fresh = new CanonicalIndexedDbStorage(indexedDB, name), query = await fresh.query(lease, requestId, signal), afterAck = await fresh.execute(lease, requestId, signal), prepareAgain = await fresh.prepare(lease, request, signal);
   const receiptStable = JSON.stringify(accepted) === JSON.stringify(query) && JSON.stringify(accepted) === JSON.stringify(afterAck) && JSON.stringify(accepted) === JSON.stringify(prepareAgain);
   const opened = createIndexedDbEditRepository(scope, name, indexedDB);
   try { const read = await opened.repository.read(libraryId), datasets = await opened.repository.installedDatasets();
    return { pending: pending.status, accepted: accepted.status, replay: replay.status, pendingRetained, cancelRetained, receiptStable, root: read.checkpoint.root.id === libraryId,
      head: read.heads.length === 1 && read.heads[0] === rootVersion, history: read.history.length === 0, batches: read.checkpoint.batches.length === 0,
      manifest: datasets.length === 1 && datasets[0].id === manifest.id }; }
   finally { await opened.close(); }
  };
  return { first: await one(), second: await one() };
 } finally { await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(name); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); }); }
}
Object.assign(window, { bootstrapExecuteCases: cases });
