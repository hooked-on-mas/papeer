import { readProviderAdmission } from './provider/providerAdmission.ts';
import type { ProviderGrantIssuer } from './ownership/providerGrantIssuer.ts';
import type { ProviderGrant, RemoteLibraryHandle } from '../../features/bootstrap/bootstrapPorts.ts';
import { discoverLocalGrant, provisionLocalGrant } from './ownership/canonicalLocalGrantIndexedDb.ts';
import { CANONICAL_DATABASE_NAME, PROVIDER_DATABASE_VERSION, supportedCanonicalSchema, openProviderDatabase } from './canonicalIndexedDbSchema.ts';
import type { CanonicalLocalOwnerGrant } from '../../runtime/edits/canonicalLocalGrant.ts';
import type { HostLease, ActiveLibraryProof } from '../../features/bootstrap/bootstrapPorts.ts';
import type { EditScope } from '../../runtime/edits/ports.ts';
import { canonicalJson } from '../../runtime/edits/editModel.ts';
import { assertCanonicalProfile } from '../../runtime/edits/canonicalBootstrap.ts';
import { assertDatasetControlPlan, datasetAccess } from '../../runtime/edits/datasetControl.ts';
import { validateCanonicalDevicePeer, validateCanonicalProviderBinding, type CanonicalLibraryProfile, type CanonicalProviderBinding, type DatasetControlRecord, type DatasetManifest } from '../../runtime/edits/contracts.ts';
import { canonicalHostTransaction, openExisting } from './canonicalHostTransaction.ts';
import { RuntimeIoGate } from '../../runtime/lifecycle/RuntimeIoGate.ts';
import { openVaultGrant, unlockVaultHeader, verifyVaultCounter, type OfflineVaultGrant, type OfflineVaultKeys, type OfflineVaultHeader } from './provider/offline/offlineVaultCrypto.ts';
import { readOfflineActivationRows, enqueueOfflineActivationRows, validateOfflineActivationRows, validateOfflineSelector, offlineSelector, type OfflineActivationSelector } from './provider/offline/offlineActivationRows.ts';
import { offlineActivationDigest } from './provider/offline/offlineActivationDigest.ts';
import { sameStoredValue } from './repository/indexedDbMutationWriter.ts';

function freezeDeep<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freezeDeep); Object.freeze(value); } return value; }

type LeaseRecord = { grant: CanonicalLocalOwnerGrant; generation: number };
export type PersistentTuple = Readonly<{ grant: CanonicalLocalOwnerGrant; profile: unknown; control: unknown; peer: unknown; manifest: unknown; scope: Readonly<EditScope>; provider?: Readonly<{ ownerNamespace: string; requestId: string; binding: CanonicalProviderBinding }> }>; 
export type OfflineFence = Readonly<{ header: Readonly<{ key: string; scope: string; value: unknown }>; grant: Readonly<{ key: string; scope: string; value: unknown }> }>;
type VaultRow = { key: string; scope: string; value: unknown };
type VaultSession = { lease: HostLease; generation: number; context: string; header: VaultRow; counter: VaultRow; keys: OfflineVaultKeys; decoded: OfflineVaultHeader; next: bigint };
type ProofRecord = { lease: HostLease; generation: number; tuple: PersistentTuple; offline?: OfflineFence; providerFence?: () => void; providerSync?: (signal: AbortSignal) => Promise<{ assertCurrent(): void; release(): void }>; providerRefresh?: (signal: AbortSignal) => Promise<void> };
export type HostOperation = Readonly<{ signal: AbortSignal }>;
type OperationDatabaseScope = { active: boolean; transactions: Set<IDBTransaction>; database?: IDBDatabase; opening?: Promise<IDBDatabase> };
type OperationRecord = { family: 'library' | 'namespace-owner'; providerReplication?: true; lease: HostLease; generation: number; grant: CanonicalLocalOwnerGrant; tuple: PersistentTuple | null; signal: AbortSignal; offline?: OfflineFence; providerFence?: () => void };
/** Same-origin storage authorization; not a secret against arbitrary same-origin script. */
export class LocalHostAuthority {
 private readonly factory: IDBFactory; private readonly name: string; private generation = 0; private closed = false; private watcher: IDBDatabase | null = null;
 private readonly leases = new WeakMap<object, LeaseRecord>(); private readonly proofs = new WeakMap<object, ProofRecord>();
 private vaultSessions = new WeakMap<object, VaultSession>();
 private readonly operations = new WeakMap<object, OperationRecord>(); private readonly transactions = new Set<IDBTransaction>();
 private readonly listeners = new Set<() => void>();
 private readonly databaseScopes = new WeakMap<HostOperation, OperationDatabaseScope>();
 private readonly activeDatabaseScopes = new Set<OperationDatabaseScope>();
 constructor(factory: IDBFactory = indexedDB, name = CANONICAL_DATABASE_NAME) { this.factory = factory; this.name = name; }
 private async watch(signal: AbortSignal, generation: number): Promise<void> {
  if (this.watcher) return;
  await new Promise<void>((resolve, reject) => {
   const request = this.factory.open(this.name); let failed = false;
   request.onupgradeneeded = () => { request.transaction?.abort(); };
   request.onblocked = () => { failed = true; reject(new Error('canonical-database-blocked')); };
   request.onerror = () => { if (!failed) reject(request.error ?? new Error('canonical-database-open')); };
   request.onsuccess = () => {
    const db = request.result;
    if (failed || signal.aborted || this.closed || generation !== this.generation) { db.close(); if (!failed) reject(new DOMException('Cancelled', 'AbortError')); return; }
    if (!supportedCanonicalSchema(db)) { db.close(); reject(new Error('canonical-schema-invalid')); return; }
    if (this.watcher) { db.close(); resolve(); return; }
    this.watcher = db; db.onversionchange = () => { db.close(); if (this.watcher === db) this.watcher = null; this.invalidate(); }; resolve();
   };
  });
 }
 private issue(grant: CanonicalLocalOwnerGrant): HostLease {
  if (this.closed) throw new Error('host-closed');
  const lease = Object.freeze({}) as HostLease; this.leases.set(lease, { grant: Object.freeze(structuredClone(grant)), generation: this.generation }); return lease;
 }
 async discover(signal: AbortSignal): Promise<{ status: 'ready'; lease: HostLease } | { status: 'setup-required'; reason: 'absent' | 'schema-upgrade' } | { status: 'recovery-required' | 'blocked'; reason: string }> {
  if (this.closed || signal.aborted) throw new DOMException('Cancelled', 'AbortError'); const generation = this.generation;
  const result = await discoverLocalGrant(this.factory, this.name, signal);
  if (this.closed || signal.aborted || generation !== this.generation) throw new DOMException('Cancelled', 'AbortError');
  if (result.status !== 'ready') return result; await this.watch(signal, generation);
  if (this.closed || signal.aborted || generation !== this.generation) throw new DOMException('Cancelled', 'AbortError'); return { status: 'ready', lease: this.issue(result.grant) };
 }
 async provision(signal: AbortSignal): Promise<HostLease> {
  if (this.closed || signal.aborted) throw new DOMException('Cancelled', 'AbortError'); const generation = this.generation;
  const grant = await provisionLocalGrant(this.factory, this.name, signal);
  if (this.closed || signal.aborted || generation !== this.generation) throw new DOMException('Cancelled', 'AbortError'); await this.watch(signal, generation);
  if (this.closed || signal.aborted || generation !== this.generation) throw new DOMException('Cancelled', 'AbortError'); return this.issue(grant);
 }
 /** Explicit host-owner upgrade; old leases and in-flight operations are revoked, never rebound. */
 async upgradeProviderStorage(lease: HostLease, signal: AbortSignal): Promise<HostLease> {
  const original = this.captureNamespaceOwner(lease, signal), grant = this.captureRecord(original).grant;
  this.watcher?.close(); this.watcher = null; this.invalidate();
  const generation = this.generation, upgrading = this.captureNamespaceOwner(this.issue(grant), signal);
  const db = await openProviderDatabase(this.factory, this.name, this, upgrading);
  try { if (db.version !== PROVIDER_DATABASE_VERSION) throw new Error('provider-schema-invalid'); } finally { db.close(); }
  const current = await discoverLocalGrant(this.factory, this.name, signal);
  if (this.closed || signal.aborted || generation !== this.generation || current.status !== 'ready'
   || canonicalJson(current.grant) !== canonicalJson(grant)) throw new Error('provider-upgrade-owner-changed');
  await this.watch(signal, generation); this.captureRecord(upgrading);
  return this.issue(current.grant);
 }
 subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
 /** Release a retired scoped connection only after real native transactions settle. */
 private closeRetiredDatabase(scope: OperationDatabaseScope): void {
  if (scope.active || scope.transactions.size) return;
  scope.database?.close(); scope.database = undefined; scope.opening = undefined;
 }
 private retireDatabaseScope(scope: OperationDatabaseScope): void {
  scope.active = false; this.activeDatabaseScopes.delete(scope);
  for (const tx of scope.transactions) { try { tx.abort(); } catch { /* already settled or committed */ } }
  this.closeRetiredDatabase(scope);
 }
 invalidate(): void { this.generation++; this.vaultSessions = new WeakMap<object, VaultSession>();
  // Revoke every scope before issuing aborts so no other operation can start.
  const scopes = [...this.activeDatabaseScopes];
  for (const scope of scopes) scope.active = false;
  this.activeDatabaseScopes.clear();
  for (const tx of this.transactions) { try { tx.abort(); } catch { /* completed */ } }
  for (const scope of scopes) this.closeRetiredDatabase(scope);
  this.listeners.forEach(fn => fn()); }
 close(): void { if (this.closed) return; this.closed = true; this.watcher?.close(); this.watcher = null; this.invalidate(); }
 /** Context records are private and immutable per operation; caller cannot supply a grant or scope. */
 capture(lease: HostLease, proof: ActiveLibraryProof, signal: AbortSignal): HostOperation {
  const record = this.leases.get(lease); if (!record || this.closed || record.generation !== this.generation || signal.aborted) throw new Error('host-lease-invalid');
  const accepted = this.proofs.get(proof);
  if (!accepted || accepted.lease !== lease || accepted.generation !== this.generation) throw new Error('host-proof-invalid');
  accepted.providerFence?.();
  const operation = Object.freeze({ signal }); this.operations.set(operation, Object.freeze({ family: 'library', lease, generation: this.generation, grant: record.grant, tuple: accepted.tuple, signal, offline: accepted.offline, providerFence: accepted.providerFence })); return operation;
 }
 /** Host-only synchronous capture of a currently live online provider proof and its own issued lease. */
 captureOnlineProviderProof(proof: ActiveLibraryProof, signal: AbortSignal): HostOperation {
  const accepted = this.proofs.get(proof);
  if (!accepted?.tuple.provider || accepted.offline || !accepted.providerFence) throw new Error('provider-admission-required');
  return this.capture(accepted.lease, proof, signal);
 }
 /** Host-private replication capture. Ordinary scope resources never receive this collaborator. */
 captureProviderReplication(lease: HostLease, proof: ActiveLibraryProof, signal: AbortSignal): HostOperation {
  const ordinary = this.capture(lease, proof, signal), captured = this.captureRecord(ordinary);
  if (!captured.tuple?.provider || captured.offline) throw new Error('provider-admission-required');
  const operation = Object.freeze({ signal });
  this.operations.set(operation, Object.freeze({ ...captured, providerReplication: true })); return operation;
 }
 /** Namespace-owner context comes only from a real issuer lease; it is not a library proof. */
 captureNamespaceOwner(lease: HostLease, signal: AbortSignal): HostOperation {
  const record = this.leases.get(lease); if (!record || this.closed || record.generation !== this.generation || signal.aborted) throw new Error('host-lease-invalid');
  const operation = Object.freeze({ signal }); this.operations.set(operation, Object.freeze({ family: 'namespace-owner', lease, generation: this.generation, grant: record.grant, tuple: null, signal })); return operation;
 }
 /** A fresh, host-private connection scope for one already captured operation. */
 async withOperationDatabase<T>(operation: HostOperation, action: () => Promise<T>): Promise<T> {
  this.captureRecord(operation);
  if (this.databaseScopes.has(operation)) throw new Error('host-operation-database-already-scoped');
  const scope: OperationDatabaseScope = { active: true, transactions: new Set() };
  this.databaseScopes.set(operation, scope); this.activeDatabaseScopes.add(scope);
  const cancel = () => { this.retireDatabaseScope(scope); };
  operation.signal.addEventListener('abort', cancel, { once: true });
  if (operation.signal.aborted) cancel();
  try {
   this.captureRecord(operation);
   const value = await action();
   if (scope.transactions.size) throw new Error('host-operation-database-transactions-outstanding');
   this.captureRecord(operation);
   if (!scope.active) throw new Error('host-operation-database-closed');
   return value;
  } finally {
   cancel(); operation.signal.removeEventListener('abort', cancel);
   // Retain the closed scope as a WeakMap tombstone while this opaque operation lives.
  }
 }
 /** The authority selects its own fixed database; callers cannot override storage per operation. */
 async openOperation(operation: HostOperation): Promise<IDBDatabase> {
  this.captureRecord(operation);
  const scope = this.databaseScopes.get(operation);
  if (!scope) {
   const db = await openExisting(this.factory, this.name, operation.signal, () => { this.captureRecord(operation); });
   try { this.captureRecord(operation); return db; } catch (error) { db.close(); throw error; }
  }
  if (!scope.active) throw new Error('host-operation-database-closed');
  if (!scope.opening) scope.opening = openExisting(this.factory, this.name, operation.signal, () => {
   if (!scope.active) throw new Error('host-operation-database-closed');
   this.captureRecord(operation);
  }).then(db => {
   try {
    if (!scope.active) throw new Error('host-operation-database-closed');
    this.captureRecord(operation);
    this.watchOperationDatabase(operation, db);
    db.onclose = () => { scope.active = false; this.activeDatabaseScopes.delete(scope); };
    scope.database = db;
    return db;
   } catch (error) { db.close(); throw error; }
  });
  const db = await scope.opening;
  if (!scope.active) { this.closeRetiredDatabase(scope); throw new Error('host-operation-database-closed'); }
  try { this.captureRecord(operation); return db; } catch (error) { this.retireDatabaseScope(scope); throw error; }
 }
 /** Preserve a scoped connection's generation guard even if a late event was queued. */
 watchOperationDatabase(operation: HostOperation, db: IDBDatabase): void {
  const scope = this.databaseScopes.get(operation);
  db.onversionchange = () => {
   if (!scope) { db.close(); this.invalidate(); return; }
   // A retired generation must neither reclose a pending transaction nor revoke a new owner.
   if (scope.active) this.invalidate(); else this.closeRetiredDatabase(scope);
  };
 }
 /** Only the currently scoped operation can retain its own connection. */
 releaseOperationDatabase(operation: HostOperation, db: IDBDatabase): void {
  const scope = this.databaseScopes.get(operation);
  if (!scope) { db.close(); return; }
  if (scope.database === db) this.closeRetiredDatabase(scope);
  else if (!scope.transactions.size) db.close();
 }
 /** Module-private transaction collaborator calls this only after in-transaction proof validation. */
 captureRecord(operation: HostOperation): OperationRecord {
  const record = this.operations.get(operation); if (!record || this.closed || record.generation !== this.generation || record.signal.aborted || this.leases.get(record.lease)?.generation !== record.generation) throw new Error('host-operation-invalid');
  record.providerFence?.(); return record;
 }
 register(operation: HostOperation, tx: IDBTransaction): () => void {
  const scope = this.databaseScopes.get(operation);
  const forget = () => {
   this.transactions.delete(tx);
   if (scope) { scope.transactions.delete(tx); this.closeRetiredDatabase(scope); }
  };
  this.captureRecord(operation);
  if (scope && !scope.active) throw new Error('host-operation-database-closed');
  this.transactions.add(tx); scope?.transactions.add(tx);
  return forget;
 }
 /** Inspect exact stored values, validate outside IDB, then reread before issuing an opaque proof. */
 async inspect(lease: HostLease, libraryId: string, signal: AbortSignal): Promise<ActiveLibraryProof> {
  const operation = this.captureNamespaceOwner(lease, signal), record = this.captureRecord(operation), account = record.grant.namespaceId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(libraryId)) throw new Error('invalid-id');
  const read = () => canonicalHostTransaction<PersistentTuple>(this, operation, [], 'readonly', (tx, _tuple, finish) => {
   const identity = JSON.stringify([account, libraryId]);
   const p = tx.objectStore('canonicalProfiles').get(identity), c = tx.objectStore('datasetControls').get(identity), d = tx.objectStore('canonicalPeers').get(account);
   let left = 3; const ready = () => { if (--left) return;
    const profile = p.result as { key: string; scope: string; value: CanonicalLibraryProfile } | undefined;
    const control = c.result as { key: string; scope: string; value: DatasetControlRecord } | undefined;
    const peer = d.result as { key: string; scope: string; value: unknown } | undefined;
    if (!profile || profile.key !== identity || profile.scope !== account || !control || control.key !== identity || control.scope !== identity || !peer || peer.key !== account || peer.scope !== account || !control.value.active) { tx.abort(); return; }
    const scope = control.value.active.scope, ns = JSON.stringify([scope.accountId, scope.libraryId, scope.epoch]);
    const m = tx.objectStore('datasets').get(JSON.stringify([ns, control.value.active.id]));
    m.onsuccess = () => { const manifest = m.result as { key: string; scope: string; value: DatasetManifest } | undefined;
     if (!manifest || manifest.scope !== ns) { tx.abort(); return; }
     finish({ grant: record.grant, profile: profile.value, control: control.value, peer: peer.value, manifest: manifest.value, scope }); };
   };
   p.onsuccess = ready; c.onsuccess = ready; d.onsuccess = ready;
  });
  const tuple = await read(), profile = tuple.profile as CanonicalLibraryProfile, control = tuple.control as DatasetControlRecord;
  assertCanonicalProfile(profile); validateCanonicalDevicePeer(tuple.peer);
  if (profile.remote !== null || profile.identity.accountId !== account || profile.identity.libraryId !== libraryId || tuple.peer.accountId !== account
    || tuple.scope.accountId !== account || tuple.scope.libraryId !== libraryId || datasetAccess(control).frozen
    || !control.active || canonicalJson(control.active) !== canonicalJson(tuple.manifest)) throw new Error('host-admission-invalid');
  await assertDatasetControlPlan(control, profile.identity); this.captureRecord(operation);
  const second = await read(); this.captureRecord(operation); if (canonicalJson(tuple) !== canonicalJson(second)) throw new Error('host-admission-changed');
  const proof = Object.freeze({ scope: Object.freeze({ ...tuple.scope }) }) as ActiveLibraryProof;
  this.proofs.set(proof, { lease, generation: this.generation, tuple: freezeDeep(structuredClone(tuple)) }); return proof;
 }
 /** Active provider binding admits the original remote canonical namespace without rewriting the local grant. */
 async inspectProvider(issuer: ProviderGrantIssuer, grant: ProviderGrant, handle: RemoteLibraryHandle, requestId: string | undefined,
  signal: AbortSignal): Promise<{ lease: HostLease; proof: ActiveLibraryProof; requestId: string } | null> {
  const providerOperation = await issuer.captureProviderOperation(grant, handle, signal);
  try {
   const captured = issuer.inspectProviderOperation(providerOperation), local = this.captureRecord(captured.host);
   if (local.family !== 'namespace-owner' || local.tuple !== null) throw new Error('provider-owner-invalid');
   const admitted = await readProviderAdmission(this, issuer, providerOperation, requestId);
   if (!admitted) return null;
   await issuer.resolve(grant, handle, admitted.tuple.scope, signal); this.captureRecord(captured.host); issuer.assertCurrentGrant(grant);
   const proof = Object.freeze({ scope: Object.freeze({ ...admitted.tuple.scope }) }) as ActiveLibraryProof;
   this.proofs.set(proof, { lease: local.lease, generation: this.generation, tuple: freezeDeep(structuredClone(admitted.tuple)),
    providerFence: () => issuer.assertCurrentSelection(grant, handle),
    providerRefresh: async freshSignal => { await issuer.resolve(grant, handle, admitted.tuple.scope, freshSignal); },
    providerSync: async freshSignal => {
     const fresh = await issuer.captureProviderOperation(grant, handle, freshSignal);
     return { assertCurrent: () => { issuer.inspectProviderOperation(fresh); }, release: () => issuer.releaseProviderOperation(fresh) };
    } });
   return { lease: local.lease, proof, requestId: admitted.requestId };
  } finally { issuer.releaseProviderOperation(providerOperation); }
 }
 /** Verify one vault passphrase; the resulting token owns keys only in this generation. */
 async unlockOfflineVault(lease: HostLease, secret: string, signal: AbortSignal): Promise<object> {
  try {
   const operation = this.captureNamespaceOwner(lease, signal), owner = this.captureRecord(operation), context = owner.grant.namespaceId;
   const key = (...parts: string[]) => JSON.stringify(parts), tag = 'host-offline-v1', scope = key(tag, context);
   const headerKey = key(tag, context, 'header'), counterKey = key(tag, context, 'counter');
   const read = () => canonicalHostTransaction<{ header?: VaultRow; counter?: VaultRow }>(this, operation,
    ['canonicalProviderArtifacts'], 'readonly', (tx, _tuple, finish) => {
     const store = tx.objectStore('canonicalProviderArtifacts'), h = store.get(headerKey), c = store.get(counterKey);
     let left = 2; const done = () => { if (--left === 0) finish({ header: h.result, counter: c.result }); };
     h.onsuccess = done; c.onsuccess = done;
    });
   const initial = await read(); this.captureRecord(operation);
   if (!initial.header || !initial.counter || initial.header.key !== headerKey || initial.counter.key !== counterKey
    || initial.header.scope !== scope || initial.counter.scope !== scope) throw new Error('offline-unlock-failed');
   const vault = await unlockVaultHeader(initial.header.value, context, secret); this.captureRecord(operation);
   const next = await verifyVaultCounter(vault.header, vault.master, initial.counter.value); this.captureRecord(operation);
   const current = await read(); this.captureRecord(operation);
   if (!sameStoredValue(current, initial)) throw new Error('offline-unlock-failed');
   const token = Object.freeze({});
   this.vaultSessions.set(token, { lease, generation: this.generation, context, header: structuredClone(initial.header),
    counter: structuredClone(initial.counter), keys: vault.master, decoded: vault.header, next });
   return token;
  } catch { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); throw new Error('offline-unlock-failed'); }
 }
 /** Cold local authorization: the caller must already own the cloud cache lock. */
 async unlockOffline(lease: HostLease, vaultToken: object, grantId: string, signal: AbortSignal): Promise<ActiveLibraryProof> {
  try {
   const session = this.vaultSessions.get(vaultToken);
   if (!session || session.lease !== lease || session.generation !== this.generation || this.closed) throw new Error('offline-unlock-failed');
   if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(grantId)) throw new Error('offline-unlock-failed');
   const operation = this.captureNamespaceOwner(lease, signal), owner = this.captureRecord(operation), context = owner.grant.namespaceId;
   const key = (...parts: string[]) => JSON.stringify(parts), tag = 'host-offline-v1', scope = key(tag, context);
   const headerKey = key(tag, context, 'header'), counterKey = key(tag, context, 'counter'), grantKey = key(tag, context, 'grant', grantId);
   const initial = await canonicalHostTransaction<{ header?: VaultRow; counter?: VaultRow; grant?: VaultRow }>(this, operation,
    ['canonicalProviderArtifacts'], 'readonly', (tx, _tuple, finish) => {
     const store = tx.objectStore('canonicalProviderArtifacts'), h = store.get(headerKey), c = store.get(counterKey), g = store.get(grantKey);
     let left = 3; const done = () => { if (--left === 0) finish({ header: h.result, counter: c.result, grant: g.result }); };
     h.onsuccess = done; c.onsuccess = done; g.onsuccess = done;
    });
   this.captureRecord(operation);
   if (!initial.header || !initial.counter || !initial.grant || initial.header.key !== headerKey || initial.counter.key !== counterKey
    || initial.grant.key !== grantKey || [initial.header, initial.counter, initial.grant].some(row => row.scope !== scope)) throw new Error('offline-unlock-failed');
   if (session.context !== context || !sameStoredValue(initial.header, session.header) || !sameStoredValue(initial.counter, session.counter)) throw new Error('offline-unlock-failed');
   const vault = { header: session.decoded, master: session.keys }, next = session.next;
   const sealed = initial.grant.value as OfflineVaultGrant;
   if (sealed?.id !== grantId || typeof sealed.counter !== 'string' || !/^[1-9][0-9]{0,19}$/.test(sealed.counter)
    || BigInt(sealed.counter) >= next) throw new Error('offline-unlock-failed');
   const plaintext = await openVaultGrant(vault.header, vault.master, sealed); this.captureRecord(operation);
   if (!plaintext || typeof plaintext !== 'object' || Array.isArray(plaintext)) throw new Error('offline-unlock-failed');
   const record = plaintext as { version: unknown; selector: OfflineActivationSelector; activationDigest: unknown };
   if (Object.keys(record).sort().join('|') !== 'activationDigest|selector|version' || record.version !== 1
    || typeof record.activationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.activationDigest)
    || !record.selector || typeof record.selector !== 'object' || Object.keys(record.selector).sort().join('|') !== 'binding|checkpointSha256|manifestId|ownerNamespace|requestId|scope'
    || record.selector.ownerNamespace !== context || !record.selector.scope || !record.selector.binding
    || typeof record.selector.manifestId !== 'string' || typeof record.selector.checkpointSha256 !== 'string'
    || typeof record.selector.requestId !== 'string') throw new Error('offline-unlock-failed');
   validateCanonicalProviderBinding(record.selector.binding);
   validateOfflineSelector(record.selector, context);
   if (canonicalJson(record.selector.binding.scope) !== canonicalJson(record.selector.scope)) throw new Error('offline-unlock-failed');
   const guard = () => { signal.throwIfAborted(); this.captureRecord(operation); };
   const rows = await readOfflineActivationRows(this, operation, record.selector, guard); guard();
   if (!rows.profile || !rows.peer || !rows.control || !rows.manifest || !rows.binding) throw new Error('offline-unlock-failed');
   const tuple: PersistentTuple = { grant: owner.grant, profile: rows.profile.value, peer: rows.peer.value,
    control: rows.control.value, manifest: rows.manifest.value, scope: record.selector.scope,
    provider: { ownerNamespace: context, requestId: record.selector.requestId, binding: rows.binding.value } };
   if (canonicalJson(offlineSelector(tuple)) !== canonicalJson(record.selector)) throw new Error('offline-unlock-failed');
   await validateOfflineActivationRows(rows, tuple); guard();
   if (await offlineActivationDigest(rows) !== record.activationDigest) throw new Error('offline-unlock-failed');
   guard();
   await canonicalHostTransaction<void>(this, operation,
    ['canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts', 'canonicalProfiles', 'canonicalPeers',
     'datasetControls', 'datasetAccess', 'datasets', 'checkpoints'], 'readonly', (tx, _tuple, finish) => {
     const store = tx.objectStore('canonicalProviderArtifacts'), h = store.get(headerKey), c = store.get(counterKey), g = store.get(grantKey);
     let left = 4; const done = () => { if (--left) return; try {
      guard(); if (!sameStoredValue(h.result, initial.header) || !sameStoredValue(c.result, initial.counter)
       || !sameStoredValue(g.result, initial.grant)) return tx.abort(); finish();
     } catch { tx.abort(); } };
     h.onsuccess = done; c.onsuccess = done; g.onsuccess = done;
     enqueueOfflineActivationRows(tx, record.selector, guard, actual => { if (!sameStoredValue(actual, rows)) { tx.abort(); return; } done(); });
    }, undefined, guard);
   guard();
   const proof = Object.freeze({ scope: Object.freeze({ ...tuple.scope }) }) as ActiveLibraryProof;
   this.proofs.set(proof, { lease, generation: this.generation, tuple: freezeDeep(structuredClone(tuple)),
    offline: freezeDeep({ header: structuredClone(initial.header), grant: structuredClone(initial.grant) }) });
   return proof;
  } catch { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); throw new Error('offline-unlock-failed'); }
 }
 isOffline(proof: ActiveLibraryProof): boolean {
  const record = this.proofs.get(proof); if (!record) throw new Error('host-proof-invalid'); return !!record.offline;
 }
 /** All titles are obtained only after the vault passphrase and each grant validate. */
 async listOfflineVault(lease: HostLease, vaultToken: object, signal: AbortSignal): Promise<{ id: string; proof: ActiveLibraryProof; title: string }[]> {
  try {
   const session = this.vaultSessions.get(vaultToken);
   if (!session || session.lease !== lease || session.generation !== this.generation || this.closed) throw new Error('offline-unlock-failed');
   const operation = this.captureNamespaceOwner(lease, signal), context = session.context;
   const key = (...parts: string[]) => JSON.stringify(parts), tag = 'host-offline-v1', scope = key(tag, context);
   const read = () => canonicalHostTransaction<VaultRow[]>(this, operation, ['canonicalProviderArtifacts'], 'readonly', (tx, _tuple, finish) => {
    const request = tx.objectStore('canonicalProviderArtifacts').index('scope').getAll(scope);
    request.onsuccess = () => finish(request.result);
   });
   const rows = await read(); this.captureRecord(operation);
   if (!rows.some(row => sameStoredValue(row, session.header)) || !rows.some(row => sameStoredValue(row, session.counter)))
    throw new Error('offline-unlock-failed');
   const items: { id: string; proof: ActiveLibraryProof; title: string }[] = [], seen = new Set<string>(), ids = new Set<string>();
   for (const row of rows) {
    if (row.scope !== scope || typeof row.key !== 'string') throw new Error('offline-unlock-failed');
    if (row.key === session.header.key || row.key === session.counter.key) continue;
    const parts: unknown = JSON.parse(row.key);
    if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== tag || parts[1] !== context || !['grant', 'pending'].includes(parts[2])
     || typeof parts[3] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parts[3])) throw new Error('offline-unlock-failed');
    if (ids.has(parts[3])) throw new Error('offline-unlock-failed'); ids.add(parts[3]);
    if (parts[2] === 'pending') {
     const encrypted = row.value as OfflineVaultGrant;
     if (encrypted?.id !== parts[3] || typeof encrypted.counter !== 'string' || !/^[1-9][0-9]{0,19}$/.test(encrypted.counter)
      || BigInt(encrypted.counter) >= session.next) throw new Error('offline-unlock-failed');
     const pending = await openVaultGrant(session.decoded, session.keys, encrypted) as { version?: unknown; selector?: OfflineActivationSelector; activationDigest?: unknown };
     this.captureRecord(operation);
     if (!pending || typeof pending !== 'object' || Object.keys(pending).sort().join('|') !== 'activationDigest|selector|version'
      || pending.version !== 1 || typeof pending.activationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(pending.activationDigest)) throw new Error('offline-unlock-failed');
     validateOfflineSelector(pending.selector, context);
     const identity = canonicalJson([pending.selector.scope, pending.selector.binding.id]);
     if (seen.has(identity)) throw new Error('offline-unlock-failed'); seen.add(identity); continue;
    }
    const proof = await this.unlockOffline(lease, vaultToken, parts[3], signal); this.captureRecord(operation);
    const record = this.proofs.get(proof)!, identity = canonicalJson([record.tuple.scope, record.tuple.provider?.binding.id]);
    if (seen.has(identity)) throw new Error('offline-unlock-failed'); seen.add(identity);
    const title = (record.tuple.profile as CanonicalLibraryProfile).title;
    if (typeof title !== 'string' || !title) throw new Error('offline-unlock-failed');
    items.push({ id: parts[3], proof, title });
   }
   const after = await read(); this.captureRecord(operation);
   if (!sameStoredValue(rows, after)) throw new Error('offline-unlock-failed');
   return items;
  } catch { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); throw new Error('offline-unlock-failed'); }
 }
 /** Revoke a validated exact grant under the same owner transaction; keep the nonce high-water mark. */
 async revokeOffline(lease: HostLease, vaultToken: object, grantId: string, signal: AbortSignal): Promise<void> {
  const proof = await this.unlockOffline(lease, vaultToken, grantId, signal);
  const record = this.proofs.get(proof); if (!record?.offline) throw new Error('offline-unlock-failed');
  const admitted = this.capture(lease, proof, signal), owner = this.captureNamespaceOwner(lease, signal);
  let sent = false, aborted = false;
  try {
   await canonicalHostTransaction<void>(this, owner, ['canonicalProviderArtifacts'], 'readwrite', (tx, _tuple, finish) => {
    const store = tx.objectStore('canonicalProviderArtifacts'), header = store.get(record.offline!.header.key), grant = store.get(record.offline!.grant.key);
    let left = 2; const done = () => { if (--left) return; try {
     this.captureRecord(admitted);
     if (!sameStoredValue(header.result, record.offline!.header) || !sameStoredValue(grant.result, record.offline!.grant)) return tx.abort();
     store.delete(record.offline!.grant.key); finish();
    } catch { tx.abort(); } };
    header.onsuccess = done; grant.onsuccess = done;
   }, { sent: () => { sent = true; }, aborted: () => { aborted = true; }, completed: () => {} }, () => { this.captureRecord(admitted); });
   this.invalidate();
  } catch (error) {
   if (sent && !aborted) { this.invalidate(); throw new Error('offline-revoke-unknown'); }
   throw error;
  }
 }
 /** Keep the original selected operation live through an entire host-owned sync pass. */
 async beginProviderSync(proof: ActiveLibraryProof, signal: AbortSignal) {
  const record = this.proofs.get(proof);
  if (!record?.providerSync || !record.providerFence) throw new Error('provider-admission-required');
  let captured: { assertCurrent(): void; release(): void } | undefined;
  try { record.providerFence(); captured = await record.providerSync(signal); captured.assertCurrent(); return captured; }
  catch (error) { captured?.release(); if (!signal.aborted) this.invalidate(); throw error; }
 }
 /** Remote ownership is observed at these boundaries; ordinary strokes and reads do not fetch. */
 async refreshProvider(proof: ActiveLibraryProof, signal: AbortSignal): Promise<void> {
  const record = this.proofs.get(proof);
  if (!record?.providerRefresh || !record.providerFence) throw new Error('provider-admission-required');
  try { record.providerFence(); await record.providerRefresh(signal); record.providerFence(); }
  catch (error) { if (!signal.aborted) this.invalidate(); throw error; }
 }
 storageKind(proof: ActiveLibraryProof): 'local' | 'google-drive' {
  const record = this.proofs.get(proof); if (!record) throw new Error('host-proof-invalid');
  return record.tuple.provider ? 'google-drive' : 'local';
 }
 providerRequestId(proof: ActiveLibraryProof): string | null {
  const record = this.proofs.get(proof); if (!record) throw new Error('host-proof-invalid');
  return record.tuple.provider?.requestId ?? null;
 }
 /** Peer observed by the same transactions that admitted this authentic proof; it is never caller-selected. */
 admittedPeerId(proof: ActiveLibraryProof): string {
  const record = this.proofs.get(proof); if (!record) throw new Error('host-proof-invalid');
  const peer = record.tuple.peer as { peerId?: unknown }; if (typeof peer?.peerId !== 'string') throw new Error('host-admission-invalid'); return peer.peerId;
 }
 /** Persistent equality does not resurrect old authority. */
 sameAdmission(a: ActiveLibraryProof, b: ActiveLibraryProof): boolean {
  const old = this.proofs.get(a), next = this.proofs.get(b); return !!old && !!next && canonicalJson(old.tuple) === canonicalJson(next.tuple);
 }
}

/** Browser authorization stays in this adapter; generic lifetime belongs to RuntimeIoGate. */
export function createLocalHostGate(authority: LocalHostAuthority, lease: HostLease, proof: ActiveLibraryProof): RuntimeIoGate<HostLease, ActiveLibraryProof, HostOperation> {
 return new RuntimeIoGate(lease, proof, {
  capture: (binding, admitted, signal) => authority.capture(binding, admitted, signal),
  assertCurrent: operation => { authority.captureRecord(operation); },
  sameAdmission: (previous, next) => authority.sameAdmission(previous, next),
  validateCandidate: async (binding, candidate, signal) => {
   const operation = authority.capture(binding, candidate, signal);
   await canonicalHostTransaction<void>(authority, operation, [], 'readonly', (_tx, _tuple, finish) => finish());
  },
  subscribeInvalidation: listener => authority.subscribe(listener),
 });
}
