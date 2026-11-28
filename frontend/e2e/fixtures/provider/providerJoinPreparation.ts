import { DocumentEditSessions } from '../../../src/features/reader/DocumentEditSessions.ts';
// Explicit host composition fixture, real LocalHostAuthority/IndexedDB; synthetic provider stays outside public factory options.
import { assembleBrowserBootstrapHostDriver, type BrowserBootstrapHostDriver } from '../../../src/adapters/browser/bootstrapHostDriver.ts';
import { LocalHostAuthority } from '../../../src/adapters/browser/localHostAuthority.ts';
import { readLegacyHoldReadonly } from '../../../src/adapters/browser/legacyHoldReadonly.ts';
import { readLegacyWebPresenceReadonly } from '../../../src/adapters/browser/legacyPresenceReadonly.ts';
import { BrowserMarkdownDraftPort } from '../../../src/adapters/browser/canonicalMarkdownDrafts.ts';
import { BrowserAnnotationAppendDraftPort } from '../../../src/adapters/browser/annotationAppendDrafts.ts';
import { BrowserReaderStatePort } from '../../../src/adapters/browser/readerState.ts';
import { initialRequest } from '../../../src/features/bootstrap/initialRequest.ts';
import type { ProviderGrant } from '../../../src/features/bootstrap/bootstrapPorts.ts';
import type { DatasetPublication, ResourceMetadata } from '../../../src/runtime/edits/contracts.ts';
import { canonicalJson } from '../../../src/runtime/edits/editModel.ts';
import { checkpointHash } from '../../../src/runtime/edits/datasetManifest.ts';
import { resourceHash } from '../../../src/runtime/edits/contentPublication.ts';
const generation = crypto.randomUUID();
let driver: BrowserBootstrapHostDriver | undefined;
let expected: DatasetPublication; let bytes: Uint8Array; let digest: string; let identityGeneration = 1;
const identityListeners = new Set<() => void>();
const revokeIdentity = () => { identityGeneration++; for (const listener of [...identityListeners]) listener(); };
const scope = { accountId: crypto.randomUUID(), libraryId: crypto.randomUUID(), epoch: crypto.randomUUID() };
const ensure = (ok: unknown, reason: string) => { if (!ok) throw new Error(reason); };
async function inventory(name: string) {
 const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onerror = () => reject(request.error);request.onsuccess = () => resolve(request.result); });
 try { return await new Promise<{ version: number; rows: Record<string, unknown[]> }>((resolve, reject) => {
  const names = Array.from(db.objectStoreNames), tx = db.transaction(names, 'readonly'), requests = names.map(name => tx.objectStore(name).getAll());
  tx.onabort = () => reject(tx.error);tx.oncomplete = () => resolve({ version: db.version, rows: Object.fromEntries(names.map((name, index) => [name, requests[index].result])) });
 }); } finally { db.close(); }
}
async function observe(name: string) {
 const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name);
  request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing DB required')); };
  request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
 try { return await new Promise<Record<string, unknown[]>>((resolve, reject) => {
  const names = ['canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts', 'canonicalProfiles'];
  const tx = db.transaction(names, 'readonly'), requests = names.map(name => tx.objectStore(name).getAll());
  tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve(Object.fromEntries(names.map((name, index) => [name, requests[index].result])));
 }); } finally { db.close(); }
}
export async function close() { const current = driver; driver = undefined; await current?.close(); }
type InputData = { publication: DatasetPublication; bytes: number[]; digest: string; resources: { metadata: ResourceMetadata; bytes: number[] }[] };
const stages = (data: InputData) => data.resources.map(value => ({ metadata: value.metadata, bytes: Uint8Array.from(value.bytes) }));
async function owner(name: string, data: InputData) {
 expected = structuredClone(data.publication); bytes = Uint8Array.from(data.bytes); digest = data.digest;
 const selectedScope = expected.manifest.scope;
 driver = assembleBrowserBootstrapHostDriver(new LocalHostAuthority(indexedDB, name), {
  async readHold(signal) { if (await readLegacyHoldReadonly(signal, indexedDB, name + '-legacy') === 'held') return 'held';
   if (await readLegacyWebPresenceReadonly(signal, indexedDB) !== 'clear') throw new Error('legacy-data-present'); return 'clear'; },
  draftPorts(scope) { return { drafts: new BrowserMarkdownDraftPort(scope), appends: new BrowserAnnotationAppendDraftPort(scope), reader: new BrowserReaderStatePort(scope) }; },
  providerVerifier: {
  subscribeInvalidation(listener) { identityListeners.add(listener);return () => { identityListeners.delete(listener); }; },
  async current() { return { digest: 'a'.repeat(64), generation: identityGeneration }; },
  assertCurrent(principal) { if (principal.generation !== identityGeneration || principal.digest !== 'a'.repeat(64)) throw new Error('provider-identity-stale'); },
  async descriptor(_principal, id) { return { id, version: 'v1', sha256: digest, scope: selectedScope, owner: true, writable: true }; },
  async descriptorBytes() { return Uint8Array.from(bytes); },
 } });
 const signal = new AbortController().signal, context = await driver.readLocalContext(signal);
 const lease = context.status === 'ready' ? context.lease : await driver.provisionLocalContext(signal);
 if (context.status !== 'ready') {
  const initialization = driver.initialization(lease), peer = await initialization.getOrCreatePeer(signal), request = await initialRequest('Untouched local Library', peer);
  ensure((await initialization.prepare(request, signal)).status === 'pending', 'local initialization prepare failed');
  ensure((await initialization.execute(request.control.id, signal)).status === 'accepted', 'local initialization execute failed');
  await initialization.acknowledge(request.control.id, signal);
 }
 const beforeUpgrade = await inventory(name);
 const provider = await driver.prepareProviderOwner(lease, signal);
 const afterUpgrade = await inventory(name);
 ensure(afterUpgrade.version === 9 && Object.keys(beforeUpgrade.rows).every(key => canonicalJson(beforeUpgrade.rows[key]) === canonicalJson(afterUpgrade.rows[key])), 'provider upgrade changed existing local rows');
 let stale = false;
 // A promise-returning stale lease call must also reject, never silently issue a peer.
 try { await driver.initialization(lease).getOrCreatePeer(signal); } catch { stale = true; }
 ensure(stale, 'old lease survived explicit provider upgrade');
 const listing = await driver.discover(provider.lease, signal), locals = listing.libraries.filter(item => item.title === 'Untouched local Library' && item.status === 'available');
 ensure(locals.length === 1, 'upgraded local Library not discoverable');
 const proof = await driver.inspect(provider.lease, locals[0].handle, signal), resources = await driver.openScope(proof, signal);
 let localEvidence;
 try {
  const sessions = new DocumentEditSessions(resources.repository, resources.markdownDrafts, resources.markdownImages, resources.appendDrafts, resources.queryPreferences);
  await sessions.initialize(); const library = sessions.getLibrary();ensure(await library.refresh(), 'upgraded local Library not readable');
  if (context.status !== 'ready') ensure(await library.create({ kind: 'markdown', title: 'Post-upgrade local write' }), 'post-upgrade ordinary local write failed');
  const snapshot = library.getSelectedSnapshot();ensure(snapshot, 'upgraded local snapshot absent');
  const items = snapshot!.items.filter(item => item.title === 'Post-upgrade local write');ensure(items.length === 1 && items[0].kind === 'markdown', 'post-upgrade exact Markdown absent');
  const receipt = await resources.repository.receipt(snapshot!.version);ensure(receipt?.durable, 'post-upgrade local write durable receipt absent');
  const body = await resources.repository.read(items[0].id);ensure(body.checkpoint.root.kind === 'markdown', 'post-upgrade local Markdown body unreadable');
  ensure((await sessions.prepareLeave()).status === 'allowed', 'post-upgrade local work remained pending');
  localEvidence = { scope: resources.repository.scope, catalog: snapshot, itemId: items[0].id, receipt, body };
 } finally { await resources.close(); }
 const grant = await provider.issuer.connect(provider.lease, signal), handle = await provider.issuer.select(grant, 'selected-descriptor', signal);
 return { ...provider, grant, handle, signal, beforeUpgradeVersion: beforeUpgrade.version, localProfiles: afterUpgrade.rows.canonicalProfiles, localEvidence };
}
export async function prepare(name: string) {
 const resourceBytes = new TextEncoder().encode('Immutable provider preparation attachment 日本語'), resourceId = crypto.randomUUID(), ownerId = crypto.randomUUID();
 const metadata: ResourceMetadata = { id: resourceId, mediaType: 'text/plain', byteLength: resourceBytes.length, sha256: await resourceHash(resourceBytes) };
 const checkpoint = { version: 1 as const, libraryId: scope.libraryId, roots: [{ kind: 'library' as const, id: scope.libraryId,
  version: crypto.randomUUID(), items: [{ id: ownerId, kind: 'markdown' as const, title: 'Staged attachment owner', ownerId: null, folderId: null,
   position: 0, tags: [], read: false, metadata: {} }, { id: crypto.randomUUID(), kind: 'attachment' as const, title: 'Staged immutable attachment', ownerId, folderId: null,
   position: 0, tags: [], read: false, resourceId, metadata: {} }], folders: [], links: [], deletions: [] },
  { kind: 'markdown' as const, id: ownerId, version: crypto.randomUUID(), content: 'Owned attachment source', appendIds: [], imageResources: [] }], edits: [] };
 const publication: DatasetPublication = { manifest: { version: 1, id: crypto.randomUUID(), scope, checkpointSha256: await checkpointHash(checkpoint), resources: [metadata] }, checkpoint, checkpointObjectId: crypto.randomUUID() };
 const descriptor = { version: 1, scope, manifestId: publication.manifest.id, checkpointSha256: publication.manifest.checkpointSha256 };
 const descriptorRaw = new TextEncoder().encode(canonicalJson(descriptor)), data = { publication, bytes: [...descriptorRaw], digest: await resourceHash(descriptorRaw), resources: [{ metadata, bytes: [...resourceBytes] }] };
 const p = await owner(name, data), requestId = crypto.randomUUID();
 let forged = false; try { await p.preparation.prepareJoin({} as ProviderGrant, p.handle, requestId, publication, stages(data), p.signal); } catch { forged = true; } ensure(forged, 'forged grant accepted');
 const corrupt = stages(data); corrupt[0].bytes[0] ^= 1;
 let corruptError: string | null = null;
 let rejected = false; try { await p.preparation.prepareJoin(p.grant, p.handle, requestId, publication, corrupt, p.signal); } catch (error) { rejected = true;corruptError = String(error); }
 ensure(rejected && corruptError === 'Error: provider-staging-invalid', 'corrupt resource must reach exact byte/hash rejection: ' + corruptError);
 ensure((await observe(name)).canonicalProviderIntents.length === 0, 'failed resource validation wrote a partial intent');
 // A synchronous provider revocation while a real write transaction is live MUST abort, not merely reject delivery after commit.
 const addBeforeAbort = IDBObjectStore.prototype.add; let revokedDuringWrite = false;
 const emptyBeforeAbort = await observe(name);
 IDBObjectStore.prototype.add = function(value: unknown, key?: IDBValidKey) {
  if (this.name === 'canonicalProviderIntents' && !revokedDuringWrite) { revokedDuringWrite = true;revokeIdentity(); }
  return key === undefined ? addBeforeAbort.call(this, value) : addBeforeAbort.call(this, value, key);
 };
 let revocationOutcome: unknown, revocationError: string | null = null;
 rejected = false;try { revocationOutcome = await p.preparation.prepareJoin(p.grant, p.handle, requestId, publication, stages(data), p.signal); } catch (error) { rejected = true;revocationError = String(error); }
 finally { IDBObjectStore.prototype.add = addBeforeAbort; }
 const revocationAfter = await observe(name);
 ensure(rejected && revokedDuringWrite, 'provider revocation did not abort the live transaction: ' + JSON.stringify({ hookTriggered: revokedDuringWrite, rejected, outcome: revocationOutcome, error: revocationError, before: emptyBeforeAbort, after: revocationAfter }));
 ensure(canonicalJson(await observe(name)) === canonicalJson(emptyBeforeAbort), 'revoked transaction committed partial provider rows');
 p.grant = await p.issuer.connect(p.lease, p.signal);p.handle = await p.issuer.select(p.grant, 'selected-descriptor', p.signal);
 // Interrupt delivery only after the actual IDB write transaction completed. No fake stored receipt or authority.
 const marked = new WeakSet<IDBTransaction>(), add = IDBObjectStore.prototype.add, complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
 IDBObjectStore.prototype.add = function(value: unknown, key?: IDBValidKey) {
  if (this.name === 'canonicalProviderIntents') marked.add(this.transaction);
  return key === undefined ? add.call(this, value) : add.call(this, value, key);
 };
 Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...complete, set(handler: ((event: Event) => unknown) | null) {
  const tx = this as IDBTransaction; complete.set!.call(tx, handler ? function(this: IDBTransaction, event: Event) {
   if (marked.has(tx)) { marked.delete(tx); void driver?.close(); } handler.call(tx, event);
  } : null);
 } });
 let outcome;
 try { outcome = await p.preparation.prepareJoin(p.grant, p.handle, requestId, publication, stages(data), p.signal); }
 finally { IDBObjectStore.prototype.add = add; Object.defineProperty(IDBTransaction.prototype, 'oncomplete', complete); }
 ensure(outcome.status === 'unknown', 'postcommit owner loss must retain unknown');
 const raw = await observe(name);
 ensure(raw.canonicalProviderBindings.length === 1 && raw.canonicalProviderIntents.length === 1
  && raw.canonicalProviderArtifacts.length === 2 && raw.canonicalProfiles.length === 1, 'atomic durable plan absent or provider profile activated');
 ensure(canonicalJson(raw.canonicalProfiles) === canonicalJson(p.localProfiles), 'provider prepare changed existing local Library profile');
 ensure(p.beforeUpgradeVersion === 8, 'initial populated schema8 upgrade not exercised');
 await close(); return { generation, name, data, requestId, outcome, raw, beforeUpgradeVersion: p.beforeUpgradeVersion, localEvidence: p.localEvidence };
}
export async function recover(input: Awaited<ReturnType<typeof prepare>>) {
 const p = await owner(input.name, input.data);
 ensure(canonicalJson(p.localEvidence) === canonicalJson(input.localEvidence), 'cold local Library catalog/body/receipt changed');
 const first = await p.preparation.query(p.grant, p.handle, input.requestId, p.signal); ensure(first.status === 'pending', 'durable immutable plan not recoverable');
 const retry = await p.preparation.prepareJoin(p.grant, p.handle, input.requestId, input.data.publication, stages(input.data), p.signal);
 ensure(canonicalJson(first) === canonicalJson(retry), 'same-ID retry changed complete plan or generated IDs');
 const changed = structuredClone(input.data.publication); changed.checkpointObjectId = crypto.randomUUID();
 let refused = false; try { await p.preparation.prepareJoin(p.grant, p.handle, input.requestId, changed, stages(input.data), p.signal); } catch { refused = true; }
 ensure(refused, 'same request accepted changed publication');
 p.issuer.disconnect(p.grant); refused = false; try { await p.preparation.query(p.grant, p.handle, input.requestId, p.signal); } catch { refused = true; }
 ensure(refused, 'revoked grant queried persistent data');
 const raw = await observe(input.name); ensure(canonicalJson(raw) === canonicalJson(input.raw), 'retry changed physical immutable rows');
 await close(); return { generation, first, retry, raw };
}
export async function lateGeneration(input: Awaited<ReturnType<typeof prepare>>) {
 const p = await owner(input.name, input.data);
 ensure(canonicalJson(p.localEvidence) === canonicalJson(input.localEvidence), 'cold local Library catalog/body/receipt changed');
 const confirmed = await p.preparation.query(p.grant, p.handle, input.requestId, p.signal);
 const get = IDBObjectStore.prototype.get; let invalidatedDuringTransaction = false;
 IDBObjectStore.prototype.get = function(key: IDBValidKey | IDBKeyRange) {
  if (this.name === 'canonicalProviderIntents' && !invalidatedDuringTransaction) { invalidatedDuringTransaction = true; revokeIdentity(); }
  return get.call(this, key);
 };
 let refused = false;
 try { await p.preparation.query(p.grant, p.handle, input.requestId, p.signal); } catch { refused = true; }
 finally { IDBObjectStore.prototype.get = get; }
 ensure(invalidatedDuringTransaction, 'real provider transaction was not entered');
 ensure(refused, 'late generation queried persistent plan'); const raw = await observe(input.name);
 ensure(canonicalJson(raw) === canonicalJson(input.raw), 'late generation changed physical rows');
 await close(); return { generation, refused, confirmed, raw };
}
