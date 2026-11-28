// Controlled seeding is for read-proof tests only; this is not a normal initialization flow.
import golden from '../../../tests/fixtures/canonical-bootstrap.json';
import { makeInitializationIntent } from '../../src/runtime/edits/canonicalInitializationIntent.ts';
import { checkpointHash } from '../../src/runtime/edits/datasetManifest.ts';
import { admitInitialLibrary } from '../../src/runtime/edits/canonicalBootstrap.ts';
import { openCanonicalDatabase } from '../../src/adapters/browser/canonicalIndexedDbSchema.ts';
import { CanonicalIndexedDbRead } from '../../e2e/support/raw-core/canonicalIndexedDbRead.ts';
import type { CanonicalInitializeRequest, RepositoryCheckpoint } from '../../src/runtime/edits/contracts.ts';
import type { CanonicalPrincipalLease } from '../../src/runtime/edits/canonicalInitializationStorage.ts';
const key = (...parts: string[]) => JSON.stringify(parts);
const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
async function cases() {
 const name = `bootstrap-read-${crypto.randomUUID()}`, account = golden.peer.accountId;
 const lease: CanonicalPrincipalLease = { accountId: account, generation: 'fixture', assertCurrent() {}, async withCommitGuard<T>(fn: () => Promise<T>) { return fn(); } };
 const { initialization: _i, origin: _o, ...rawProfile } = golden.profile;
 const profile = { ...rawProfile, version: 1 as const };
 const checkpoint: RepositoryCheckpoint = { version: 1, libraryId: profile.identity.libraryId, roots: [{ kind: 'library', id: profile.identity.libraryId, version: golden.rootVersion, items: [], folders: [], links: [], deletions: [] }], edits: [] };
 const manifest = { version: 1 as const, id: golden.manifestId, scope: { ...profile.identity, epoch: golden.epoch }, checkpointSha256: await checkpointHash(checkpoint), resources: [] };
 const request: CanonicalInitializeRequest = { expectedPeerId: golden.peer.peerId, profile, control: { version: 1, id: golden.requestId, identity: profile.identity, epochs: [golden.epoch], active: manifest, transition: { id: golden.requestId, mode: 'initialize', source: null, phase: 'activated', publication: { manifest, checkpoint, checkpointObjectId: golden.checkpointObjectId } } } };
 const decision = await admitInitialLibrary(request, account, { peer: { ...golden.peer, version: 1 as const }, profile: null, control: null, root: null, checkpoint: null, manifest: null, otherLibraryState: false, requestIdUsedByOtherIdentity: false });
 if (decision.kind !== 'create') throw new Error('fixture');
 const db = await openCanonicalDatabase(indexedDB, name), reader = new CanonicalIndexedDbRead(indexedDB, name), signal = new AbortController().signal;
 const identity = key(account, profile.identity.libraryId), ns = key(account, profile.identity.libraryId, golden.epoch);
 const intent = await makeInitializationIntent(request, account); if ('retired' in intent) throw new Error('fixture');
 intent.result = { status: 'accepted', receipt: decision.receipt };
 const names = ['canonicalProfiles', 'canonicalInitialArtifacts', 'datasetControls', 'roots', 'datasets', 'checkpoints'];
 const seed = async () => { const tx = db.transaction(names, 'readwrite');
   tx.objectStore(names[0]).put({ key: identity, scope: account, value: decision.profile });
   tx.objectStore(names[1]).put({ key: identity, scope: account, value: { root: checkpoint.roots[0], checkpoint, manifest } });
   tx.objectStore(names[2]).put({ key: identity, scope: identity, value: request.control });
   tx.objectStore(names[3]).put({ key: key(ns, profile.identity.libraryId), scope: ns, value: checkpoint.roots[0] });
   tx.objectStore(names[4]).put({ key: key(ns, manifest.id), scope: ns, value: manifest });
   tx.objectStore(names[5]).put({ key: key(ns, manifest.checkpointSha256), scope: ns, value: true }); await done(tx); };
 const remove = async (store: string, k: string) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(k); await done(tx); };
 const rejects = async () => { try { await reader.query(lease, golden.requestId, signal); return false; } catch { return true; } };
 try {
   await seed(); const accepted = (await reader.query(lease, golden.requestId, signal)).status === 'accepted';
   const other: CanonicalPrincipalLease = { ...lease, accountId: 'other-account' }; const isolated = (await reader.list(other, signal)).profiles.length === 0 && (await reader.query(other, golden.requestId, signal)).status === 'not-found';
   await remove('datasetControls', identity); const missingControl = await rejects(); await seed();
   await remove('checkpoints', key(ns, manifest.checkpointSha256)); const missingCheckpoint = await rejects(); await seed();
   const tx = db.transaction('canonicalInitialArtifacts', 'readwrite'); tx.objectStore('canonicalInitialArtifacts').put({ key: identity, scope: account, value: { root: checkpoint.roots[0], checkpoint: { ...checkpoint, libraryId: 'tampered' }, manifest } }); await done(tx);
   const tampered = await rejects(); await seed();
   const intentTx = db.transaction('canonicalInitialIntents', 'readwrite'); intentTx.objectStore('canonicalInitialIntents').put({ key: key(account, golden.requestId), scope: account, value: intent }); await done(intentTx);
   await remove('canonicalProfiles', identity); const missingProfile = await rejects();
   const installed = { ...decision.profile, origin: { kind: 'activated-installation', source: 'import', controlId: golden.requestId, manifestId: manifest.id, installedScope: manifest.scope }, initialization: null };
   const nullTx = db.transaction('canonicalProfiles', 'readwrite'); nullTx.objectStore('canonicalProfiles').put({ key: identity, scope: account, value: installed }); await done(nullTx);
   const nullProfile = await rejects();
   await remove('canonicalInitialIntents', key(account, golden.requestId));
   const importedList = (await reader.list(lease, signal)).profiles.length === 1;
   await seed(); const queryAfterAck = (await reader.query(lease, golden.requestId, signal)).status === 'accepted';
   return { accepted, isolated, missingControl, missingCheckpoint, tampered, missingProfile, nullProfile, importedList, queryAfterAck };
 } finally { db.close(); await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(name); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); }); }
}
Object.assign(window, { bootstrapReadCases: cases });
