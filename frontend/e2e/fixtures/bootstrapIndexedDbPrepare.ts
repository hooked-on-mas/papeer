// Controlled fake OWNER lease is test-only. The real storage API persists the fixed request.
import golden from '../../../tests/fixtures/canonical-bootstrap.json';
import { checkpointHash } from '../../src/runtime/edits/datasetManifest.ts';
import { CanonicalIndexedDbPrepare } from '../../e2e/support/raw-core/canonicalIndexedDbPrepare.ts';
import { CanonicalIndexedDbRead } from '../../e2e/support/raw-core/canonicalIndexedDbRead.ts';
import type { CanonicalInitializeRequest, RepositoryCheckpoint } from '../../src/runtime/edits/contracts.ts';
import type { CanonicalPrincipalLease } from '../../src/runtime/edits/canonicalInitializationStorage.ts';
async function cases() {
 const name = `bootstrap-prepare-${crypto.randomUUID()}`; const account = golden.peer.accountId;
 const lease: CanonicalPrincipalLease = { accountId: account, generation: 'fixture', assertCurrent() {}, async withCommitGuard<T>(fn: () => Promise<T>) { return fn(); } };
 const signal = new AbortController().signal, { initialization: _i, origin: _o, ...rawProfile } = golden.profile;
 const profile = { ...rawProfile, version: 1 as const };
 const checkpoint: RepositoryCheckpoint = { version: 1, libraryId: profile.identity.libraryId, roots: [{ kind: 'library', id: profile.identity.libraryId, version: golden.rootVersion, items: [], folders: [], links: [], deletions: [] }], edits: [] };
 const manifest = { version: 1 as const, id: golden.manifestId, scope: { ...profile.identity, epoch: golden.epoch }, checkpointSha256: await checkpointHash(checkpoint), resources: [] };
 const request: CanonicalInitializeRequest = { expectedPeerId: golden.peer.peerId, profile, control: { version: 1, id: golden.requestId, identity: profile.identity, epochs: [golden.epoch], active: manifest, transition: { id: golden.requestId, mode: 'initialize', source: null, phase: 'activated', publication: { manifest, checkpoint, checkpointObjectId: golden.checkpointObjectId } } } };
 const writer = new CanonicalIndexedDbPrepare(indexedDB, name), reader = new CanonicalIndexedDbRead(indexedDB, name);
 try {
  const first = await writer.prepare(lease, request, signal), replay = await writer.prepare(lease, request, signal);
  const persisted = await reader.query(lease, golden.requestId, signal);
  let collision = false; try { await writer.prepare(lease, { ...request, profile: { ...profile, title: profile.title + ' changed' } }, signal); } catch { collision = true; }
  const snapshot = await reader.list(lease, signal);
  return { first: first.status, replay: replay.status, persisted: persisted.status, collision, count: snapshot.intents.length,
   originalTitle: !('retired' in snapshot.intents[0]) && snapshot.intents[0].request.profile.title === profile.title };
 } finally { await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(name); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); }); }
}
Object.assign(window, { bootstrapPrepareCases: cases });
