import { createRoot } from 'react-dom/client';
import { createWebBootstrap } from '../../../src/web/bootstrapComposition.ts';
import { BootstrapConnection } from '../../../src/features/bootstrap/BootstrapConnection.tsx';
import { DocumentEditSessions } from '../../../src/features/reader/DocumentEditSessions.ts';
import type { ActiveLibraryProof, OfflineLibraryHandle, OfflineUnlockSession, ScopeResources } from '../../../src/features/bootstrap/bootstrapPorts.ts';
import { openVaultGrant, sealVaultGrant, signVaultCounter, unlockVaultHeader, verifyVaultCounter } from '../../../src/adapters/browser/provider/offline/offlineVaultCrypto.ts';

// The online phase uses the real factory/chooser and synthetic Google transport.
// Cold mode deliberately exercises the actual host driver without claiming normal UI.
const { driver, session } = createWebBootstrap();
if (!new URL(location.href).searchParams.has('cold')) createRoot(document.getElementById('root')!).render(
  <BootstrapConnection session={session} renderDocument={() => <p>Document selected</p>} renderMarkdown={() => <p>Markdown selected</p>} />);
const facade = () => { const value = driver.getOffline?.(); if (!value) throw new Error('offline-facade-missing'); return value; };
const runtime = () => { const value = session.getActiveRuntime(); if (!value) throw new Error('online-runtime-missing'); return value; };
let unlocked: OfflineUnlockSession | undefined, chosen: OfflineLibraryHandle | undefined, resources: ScopeResources | undefined, sessions: DocumentEditSessions | undefined, activeProof: ActiveLibraryProof | undefined;
let restoreGrantAbort: (() => boolean) | undefined;
let releaseSeal: (() => void) | undefined, sealReached: Promise<void> | undefined, restoreSeal: (() => void) | undefined;
const signal = () => new AbortController().signal;
const fixture = {
  ready() { return session.getSnapshot().phase === 'ready'; },
  async createNote(title: string, body: string) {
    const active = runtime(), library = active.binding.sessions.getLibrary();
    if (!await library.create({ kind: 'markdown', title })) throw new Error('create-failed');
    const id = library.getSnapshot().createdId; if (!id) throw new Error('create-id-missing');
    const markdown = active.binding.sessions.getMarkdown(id);
    if (!await markdown.refresh() || !markdown.editText(body)) throw new Error('edit-failed');
    await markdown.flush(); await active.binding.replication.flush(); return id;
  },
  async enroll(secret: string, requestId: string) { return facade().enroll(runtime().proof, secret, requestId, signal()); },
  async recover(secret: string) { return facade().recoverEnrollment(runtime().proof, secret, signal()); },
  async reclaim(secret: string) { return facade().revokeEnrollment(runtime().proof, secret, signal()); },
  holdNextGrantSeal() {
    if (restoreSeal) throw new Error('seal-hold-already-armed');
    const subtle = crypto.subtle, own = Object.getOwnPropertyDescriptor(subtle, 'encrypt'), original = subtle.encrypt.bind(subtle);
    let entered!: () => void, release!: () => void, armed = true;
    sealReached = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    releaseSeal = release;
    Object.defineProperty(subtle, 'encrypt', { configurable: true, value: async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      const result = await original(...args); if (armed) { armed = false; entered(); await gate; } return result;
    } });
    restoreSeal = () => { release(); if (own) Object.defineProperty(subtle, 'encrypt', own); else Reflect.deleteProperty(subtle, 'encrypt');
      releaseSeal = undefined; sealReached = undefined; restoreSeal = undefined; };
  },
  async waitSeal() { if (!sealReached) throw new Error('seal-hold-not-armed'); await sealReached; },
  releaseSeal() { if (!restoreSeal || !releaseSeal) throw new Error('seal-hold-not-armed'); restoreSeal(); },
  /** Lose the real completion signal after an actual vault deletion transaction commits. */
  async reclaimAfterCommitSignalLoss(secret: string) {
    const controller = new AbortController(), marked = new WeakSet<IDBTransaction>(), originalDelete = IDBObjectStore.prototype.delete;
    const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    if (!descriptor?.configurable || !descriptor.set) throw new Error('completion-hook-unavailable');
    let observed = false;
    IDBObjectStore.prototype.delete = function(key: IDBValidKey | IDBKeyRange) {
      if (this.name === 'canonicalProviderArtifacts' && typeof key === 'string') {
        try { const parts: unknown = JSON.parse(key); if (Array.isArray(parts) && parts[0] === 'host-offline-v1' && ['grant', 'pending'].includes(parts[2] as string)) marked.add(this.transaction); } catch { /* not a vault key */ }
      }
      return originalDelete.call(this, key);
    };
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...descriptor, set(handler: ((this: IDBTransaction, event: Event) => unknown) | null) {
      descriptor.set!.call(this, handler && function(this: IDBTransaction, event: Event) {
        if (marked.has(this)) { observed = true; controller.abort(); } return handler.call(this, event);
      });
    } });
    try { const result = await facade().revokeEnrollment(runtime().proof, secret, controller.signal); return { result, observed }; }
    finally { IDBObjectStore.prototype.delete = originalDelete; Object.defineProperty(IDBTransaction.prototype, 'oncomplete', descriptor); }
  },
  async onlineRead(id: string) { const markdown = runtime().binding.sessions.getMarkdown(id);
    if (!await markdown.refresh()) throw new Error('read-failed'); return markdown.getSnapshot().accepted; },
  /** Fixture-only controlled provider suspension; the actual session creates the durable outbox batch. */
  async onlinePendingEdit(id: string, content: string) {
    const active = runtime(); await active.binding.replication.suspendAndWait();
    const markdown = active.binding.sessions.getMarkdown(id);
    if (!await markdown.refresh() || !markdown.editText(content)) throw new Error('edit-failed');
    await markdown.flush(); const version = markdown.getSnapshot().accepted?.version; if (!version) throw new Error('version-missing');
    return { version, receipt: await active.resources.repository.receipt(version), pending: await active.resources.repository.pendingRecords() };
  },
  async onlinePending(id: string) { return (await runtime().resources.repository.pendingRecords()).filter(record => record.batch.id === id); },
  async vaultCounter() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('papeer-shared-cloud-v1');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing-cache-required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
    try { return await new Promise<string>((resolve, reject) => {
      const tx = db.transaction('canonicalProviderArtifacts', 'readonly'), request = tx.objectStore('canonicalProviderArtifacts').getAll();
      tx.onabort = () => reject(tx.error); tx.oncomplete = () => {
        const rows = request.result.filter((row: { key?: unknown }) => { try { const key = JSON.parse(String(row.key)); return Array.isArray(key) && key[0] === 'host-offline-v1' && key[2] === 'counter'; } catch { return false; } });
        if (rows.length !== 1 || typeof rows[0].value?.next !== 'string') reject(new Error('counter-missing')); else resolve(rows[0].value.next);
      };
    }); } finally { db.close(); }
  },
  /** Synthetic fixture-only vault records; no historical provider admission is fabricated. */
  async seedRetiredVaultRow(secret: string, sourceId: string, kind: 'grant' | 'pending', variant: 'same' | 'other-account' | 'other-library' | 'other-principal') {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('papeer-shared-cloud-v1');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing-cache-required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
    try {
      const rows = await new Promise<{ key: string; scope: string; value: unknown }[]>((resolve, reject) => {
        const tx = db.transaction('canonicalProviderArtifacts', 'readonly'), request = tx.objectStore('canonicalProviderArtifacts').getAll();
        tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve(request.result);
      });
      const parsed = rows.flatMap(row => { try { const parts: unknown = JSON.parse(row.key); return Array.isArray(parts) && parts[0] === 'host-offline-v1' ? [{ row, parts }] : []; } catch { return []; } });
      const headers = parsed.filter(x => x.parts[2] === 'header'), counters = parsed.filter(x => x.parts[2] === 'counter'), grants = parsed.filter(x => x.parts[2] === 'grant' && x.parts[3] === sourceId);
      if (headers.length !== 1 || counters.length !== 1 || grants.length !== 1) throw new Error('synthetic-seed-requires-one-grant');
      const owner = headers[0].parts[1] as string, vault = await unlockVaultHeader(headers[0].row.value, owner, secret);
      const current = await verifyVaultCounter(vault.header, vault.master, counters[0].row.value);
      const payload = await openVaultGrant(vault.header, vault.master, grants[0].row.value) as { selector: { scope: { accountId: string; libraryId: string; epoch: string }; binding: { id: string; scope: { accountId: string; libraryId: string; epoch: string }; principalDigest: string }; requestId: string; manifestId: string }; activationDigest: string };
      payload.selector.scope.epoch = 'synthetic-retired-epoch';
      if (variant === 'other-account') payload.selector.scope.accountId = crypto.randomUUID();
      if (variant === 'other-library') payload.selector.scope.libraryId = crypto.randomUUID();
      payload.selector.binding.scope = structuredClone(payload.selector.scope); payload.selector.binding.id = crypto.randomUUID();
      if (variant === 'other-principal') payload.selector.binding.principalDigest = 'b'.repeat(64);
      payload.selector.requestId = crypto.randomUUID(); payload.selector.manifestId = crypto.randomUUID(); payload.activationDigest = 'e'.repeat(64);
      const id = crypto.randomUUID(), value = await sealVaultGrant(vault.header, vault.master, id, String(current), payload);
      const next = await signVaultCounter(vault.header, vault.master, String(current + 1n));
      await new Promise<void>((resolve, reject) => { const tx = db.transaction('canonicalProviderArtifacts', 'readwrite'), store = tx.objectStore('canonicalProviderArtifacts');
        store.put({ ...counters[0].row, value: next }); store.add({ key: JSON.stringify(['host-offline-v1', owner, kind, id]), scope: headers[0].row.scope, value });
        tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve(); });
      return id;
    } finally { db.close(); }
  },
  async hasVaultRow(id: string, kind: 'grant' | 'pending') {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('papeer-shared-cloud-v1');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing-cache-required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
    try { return await new Promise<boolean>((resolve, reject) => { const tx = db.transaction('canonicalProviderArtifacts', 'readonly'), request = tx.objectStore('canonicalProviderArtifacts').getAll();
      tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve(request.result.some((row: { key: string }) => { try { const key = JSON.parse(row.key); return Array.isArray(key) && key[0] === 'host-offline-v1' && key[2] === kind && key[3] === id; } catch { return false; } })); }); }
    finally { db.close(); }
  },
  async vaultRowHash(id: string) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('papeer-shared-cloud-v1');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing-cache-required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
    try {
      const row = await new Promise<unknown>((resolve, reject) => { const tx = db.transaction('canonicalProviderArtifacts', 'readonly'), request = tx.objectStore('canonicalProviderArtifacts').getAll();
        tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve(request.result.find((value: { key: string }) => { try { const key = JSON.parse(value.key); return Array.isArray(key) && key[0] === 'host-offline-v1' && key[2] === 'grant' && key[3] === id; } catch { return false; } })); });
      if (!row) throw new Error('vault-row-missing');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(row)));
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    } finally { db.close(); }
  },
  abortNextGrantAdd() {
    if (restoreGrantAbort) throw new Error('grant-abort-already-armed');
    const original = IDBObjectStore.prototype.add; let fired = false;
    IDBObjectStore.prototype.add = function(value: unknown, key?: IDBValidKey) {
      const candidate = value as { key?: unknown } | null;
      if (!fired && this.name === 'canonicalProviderArtifacts' && typeof candidate?.key === 'string') {
        try { const parts = JSON.parse(candidate.key) as unknown;
          if (Array.isArray(parts) && parts[0] === 'host-offline-v1' && parts[2] === 'grant') {
            fired = true; throw new DOMException('synthetic grant commit abort', 'AbortError');
          }
        } catch (error) { if (fired) throw error; }
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
    restoreGrantAbort = () => { IDBObjectStore.prototype.add = original; return fired; };
  },
  restoreGrantAdd() { const restore = restoreGrantAbort; restoreGrantAbort = undefined; return restore?.() ?? false; },
  async unlock(secret: string) {
    const result = await facade().unlock(secret, signal()); unlocked = result.session;
    if (result.choices.length !== 1) throw new Error('expected-one-synthetic-choice'); chosen = result.choices[0].handle;
    return { title: result.choices[0].title, count: result.choices.length };
  },
  async unlockCount(secret: string) { const result = await facade().unlock(secret, signal()); unlocked = result.session; chosen = undefined; return result.choices.length; },
  async open() {
    if (!unlocked || !chosen) throw new Error('fixture-vault-locked');
    const target = await facade().open(unlocked, chosen, signal());
    const proof = await driver.inspect(target.lease, target.handle, signal());
    if (driver.providerOffline?.(proof) !== true || driver.storageKind?.(proof) !== 'google-drive') throw new Error('wrong-offline-mode');
    activeProof = proof; resources = await driver.openScope(proof, signal());
    sessions = new DocumentEditSessions(resources.repository, resources.markdownDrafts, resources.markdownImages, resources.appendDrafts, resources.queryPreferences);
    await sessions.initialize(); if (!sessions.getSnapshot().ready) throw new Error('sessions-not-ready');
    return { scope: proof.scope, peer: resources.peerId };
  },
  async edit(id: string, content: string) {
    if (!sessions || !resources) throw new Error('fixture-offline-not-open');
    const markdown = sessions.getMarkdown(id); if (!await markdown.refresh() || !markdown.editText(content)) throw new Error('edit-failed');
    await markdown.flush(); const snapshot = markdown.getSnapshot(), version = snapshot.accepted?.version;
    if (!version) throw new Error('version-missing');
    return { version, accepted: snapshot.accepted, pending: await resources.repository.pendingRecords(), receipt: await resources.repository.receipt(version) };
  },
  async read(id: string) {
    if (!sessions || !resources) throw new Error('fixture-offline-not-open');
    const markdown = sessions.getMarkdown(id); if (!await markdown.refresh()) throw new Error('read-failed');
    return { accepted: markdown.getSnapshot().accepted, pending: await resources.repository.pendingRecords(), state: await resources.repository.read(id) };
  },
  async lock() { if (!unlocked) throw new Error('fixture-vault-locked'); sessions?.deactivateForHostLoss(); await resources?.close(); resources = undefined; await facade().lock(unlocked); },
  async revoke() { if (!unlocked || !chosen) throw new Error('fixture-vault-locked'); sessions?.deactivateForHostLoss();
    await resources?.close(); resources = undefined; await facade().revoke(unlocked, chosen, signal()); },
  async rawBatchCount(id: string) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('papeer-shared-cloud-v1');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('existing-cache-required')); };
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
    try { return await new Promise<number>((resolve, reject) => { const tx = db.transaction('edits', 'readonly'), request = tx.objectStore('edits').getAll();
      tx.onabort = () => reject(tx.error); tx.oncomplete = () => resolve(request.result.filter((row: { value?: { batch?: { id?: string } } }) => row.value?.batch?.id === id).length); }); }
    finally { db.close(); }
  },
  async replicationDenied() {
    if (!activeProof || !driver.openReplication) throw new Error('fixture-offline-not-open');
    try { await driver.openReplication(activeProof, signal()); return false; } catch { return true; }
  },
  async close() { restoreSeal?.(); restoreGrantAbort?.(); restoreGrantAbort = undefined; await resources?.close(); await driver.close(); },
};
(window as unknown as { offlineOwner: typeof fixture }).offlineOwner = fixture;
export type OfflineOwnerFixture = typeof fixture;
