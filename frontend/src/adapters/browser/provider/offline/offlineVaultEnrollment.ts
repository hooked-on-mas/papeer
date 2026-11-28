import type { ActiveLibraryProof, ProviderGrant, RemoteLibraryHandle } from '../../../../features/bootstrap/bootstrapPorts.ts';
import type { LocalHostAuthority } from '../../localHostAuthority.ts';
import type { ProviderGrantIssuer } from '../../ownership/providerGrantIssuer.ts';
import { canonicalHostTransaction } from '../../canonicalHostTransaction.ts';
import { offlineActivationDigest } from './offlineActivationDigest.ts';
import { sameStoredValue } from '../../repository/indexedDbMutationWriter.ts';
import { readProviderAdmission } from '../providerAdmission.ts';
import { enqueueOfflineActivationRows, offlineSelector, readOfflineActivationRows, validateOfflineSelector } from './offlineActivationRows.ts';
import { createVaultHeader, openVaultGrant, sealVaultGrant, signVaultCounter, unlockVaultHeader, verifyVaultCounter } from './offlineVaultCrypto.ts';

const stores = ['canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts', 'canonicalProfiles', 'canonicalPeers',
  'datasetControls', 'datasetAccess', 'datasets', 'checkpoints'];
const key = (...parts: string[]) => JSON.stringify(parts), tag = 'host-offline-v1';
type Row = { key: string; scope: string; value: unknown };
const fail = (): never => { throw new Error('offline-enrollment-failed'); };
const rowMatches = (actual: Row | undefined, expected: Row | undefined) => sameStoredValue(actual, expected);

/**
 * Enroll only a currently live, host-issued provider grant and selection.
 * Counter reservation and activation comparison commit before encryption;
 * unused reserved nonces are deliberately never returned to the pool.
 * This is not an offline opener or a renderer-facing API.
 */
export async function enrollOfflineLibrary(authority: LocalHostAuthority, issuer: ProviderGrantIssuer,
  grant: ProviderGrant, selected: RemoteLibraryHandle, activeProof: ActiveLibraryProof, requestId: string, secret: string,
  signal: AbortSignal): Promise<{ status: 'durable' | 'unknown'; requestId: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) return fail();
  const operation = await issuer.captureProviderOperation(grant, selected, signal);
  let existingMayBeCommitted = false;
  try {
    const current = issuer.inspectProviderOperation(operation), host = authority.captureRecord(current.host);
    if (host.family !== 'namespace-owner' || host.tuple !== null) return fail();
    const activeOperation = authority.capture(host.lease, activeProof, signal), active = authority.captureRecord(activeOperation);
    if (!active.tuple?.provider || active.offline || !active.providerFence) return fail();
    const admitted = await readProviderAdmission(authority, issuer, operation, undefined);
    if (!admitted || !sameStoredValue(active.tuple, admitted.tuple)) return fail();
    const guard = () => { issuer.inspectProviderOperation(operation); authority.captureRecord(current.host); authority.captureRecord(activeOperation); signal.throwIfAborted(); };
    guard();
    const selector = offlineSelector(admitted.tuple);
    const rows = await readOfflineActivationRows(authority, current.host, selector, guard);
    if (!sameStoredValue(rows, admitted.rows)) return fail();
    const context = host.grant.namespaceId, scope = key(tag, context);
    const headerKey = key(tag, context, 'header'), counterKey = key(tag, context, 'counter'), grantKey = key(tag, context, 'grant', requestId), pendingKey = key(tag, context, 'pending', requestId);
    const old = await canonicalHostTransaction<{ header?: Row; counter?: Row; existing?: Row; pending?: Row; rows: Row[] }>(authority, current.host,
      ['canonicalProviderArtifacts'], 'readonly', (tx, _tuple, finish) => {
        const store = tx.objectStore('canonicalProviderArtifacts'), header = store.get(headerKey), counter = store.get(counterKey), existing = store.get(grantKey), pending = store.get(pendingKey), rows = store.index('scope').getAll(scope);
        let left = 5; const done = () => { if (--left === 0) finish({ header: header.result, counter: counter.result, existing: existing.result, pending: pending.result, rows: rows.result }); };
        header.onsuccess = done; counter.onsuccess = done; existing.onsuccess = done; pending.onsuccess = done; rows.onsuccess = done;
      }, undefined, guard);
    guard();
    if (!!old.header !== !!old.counter || (old.header && (old.header.key !== headerKey || old.header.scope !== scope))
      || (old.counter && (old.counter.key !== counterKey || old.counter.scope !== scope))
      || (old.existing && (old.existing.key !== grantKey || old.existing.scope !== scope || !old.header))
      || (old.pending && (old.pending.key !== pendingKey || old.pending.scope !== scope || !old.header)) || (old.pending && old.existing)) return fail();
    const vault = old.header ? await unlockVaultHeader(old.header.value, context, secret) : await createVaultHeader(context, secret);
    existingMayBeCommitted = !!(old.existing || old.pending);
    guard();
    const reserved = old.counter ? await verifyVaultCounter(vault.header, vault.master, old.counter.value) : 1n;
    guard();
    for (const row of old.rows) {
      if (row.scope !== scope || typeof row.key !== 'string') return fail();
      if (row.key === headerKey || row.key === counterKey) continue;
      let parts: unknown;
      try { parts = JSON.parse(row.key); } catch { return fail(); }
      if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== tag || parts[1] !== context || !['grant', 'pending'].includes(parts[2] as string)
        || typeof parts[3] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parts[3])) return fail();
      if (!row.value || typeof row.value !== 'object' || (row.value as { id?: unknown }).id !== parts[3]) return fail();
      const sealedValue = row.value as { counter?: unknown };
      if (typeof sealedValue.counter !== 'string' || !/^[1-9][0-9]{0,19}$/.test(sealedValue.counter) || BigInt(sealedValue.counter) >= reserved) return fail();
      const decoded = await openVaultGrant(vault.header, vault.master, row.value) as { version?: unknown; activationDigest?: unknown; selector?: { scope?: { accountId?: string; libraryId?: string; epoch?: string }; binding?: { id?: string } } };
      guard();
      if (!decoded || typeof decoded !== 'object' || Object.keys(decoded).sort().join('|') !== 'activationDigest|selector|version'
        || decoded.version !== 1 || typeof decoded.activationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(decoded.activationDigest)
        || !decoded.selector?.scope || !decoded.selector.binding?.id) return fail();
      validateOfflineSelector(decoded.selector, context);
      if (parts[3] !== requestId && decoded.selector.scope.accountId === selector.scope.accountId
        && decoded.selector.scope.libraryId === selector.scope.libraryId) return fail();
    }
    const activationDigest = await offlineActivationDigest(admitted.rows), value = { version: 1, selector, activationDigest };
    guard();
    if (old.existing) {
      if (!sameStoredValue(await openVaultGrant(vault.header, vault.master, old.existing.value), value)) { existingMayBeCommitted = false; return fail(); }
      try { guard();
        await canonicalHostTransaction<void>(authority, current.host, stores, 'readonly', (tx, _tuple, finish) => {
        const artifacts = tx.objectStore('canonicalProviderArtifacts'), h = artifacts.get(headerKey), existing = artifacts.get(grantKey);
        let left = 3; const done = () => { if (--left) return; try {
          guard(); if (!rowMatches(h.result, old.header) || !rowMatches(existing.result, old.existing)) return tx.abort(); finish();
        } catch { tx.abort(); } };
        h.onsuccess = done; existing.onsuccess = done;
        enqueueOfflineActivationRows(tx, selector, guard, actual => {
          if (!sameStoredValue(actual, admitted.rows)) { tx.abort(); return; } done();
        });
        }, undefined, guard);
        guard(); return { status: 'durable', requestId };
      } catch { return { status: 'unknown', requestId }; }
    }
    const header: Row = old.header ?? { key: headerKey, scope, value: vault.header };
    const finalize = async (pending: Row, expectedRows: Row[]): Promise<{ status: 'durable' | 'unknown'; requestId: string }> => {
      try {
        await canonicalHostTransaction<void>(authority, current.host, stores, 'readwrite', (tx, _tuple, finish) => {
          const artifacts = tx.objectStore('canonicalProviderArtifacts'), h = artifacts.get(headerKey), all = artifacts.index('scope').getAll(scope), source = artifacts.get(pendingKey), target = artifacts.get(grantKey);
          let left = 5; const done = () => { if (--left) return; try {
            guard(); if (!rowMatches(h.result, header) || !sameStoredValue(all.result, expectedRows) || !rowMatches(source.result, pending) || target.result) return tx.abort();
            artifacts.add({ key: grantKey, scope, value: pending.value }); artifacts.delete(pendingKey); finish();
          } catch { tx.abort(); } };
          h.onsuccess = done; all.onsuccess = done; source.onsuccess = done; target.onsuccess = done;
          enqueueOfflineActivationRows(tx, selector, guard, actual => { if (!sameStoredValue(actual, admitted.rows)) { tx.abort(); return; } done(); });
        }, undefined, guard);
        guard(); return { status: 'durable', requestId };
      } catch { return { status: 'unknown', requestId }; }
    };
    if (old.pending) {
      if (!sameStoredValue(await openVaultGrant(vault.header, vault.master, old.pending.value), value)) { existingMayBeCommitted = false; return fail(); }
      guard(); return await finalize(old.pending, old.rows);
    }
    if (reserved >= 0xffffffffffffffffn) return fail();
    const next = await signVaultCounter(vault.header, vault.master, String(reserved + 1n));
    guard();
    await canonicalHostTransaction<void>(authority, current.host, stores, 'readwrite', (tx, _tuple, finish) => {
      const artifacts = tx.objectStore('canonicalProviderArtifacts'), h = artifacts.get(headerKey), c = artifacts.get(counterKey), all = artifacts.index('scope').getAll(scope);
      let left = 4; const done = () => { if (--left) return; try {
        guard(); if (!rowMatches(h.result, old.header) || !rowMatches(c.result, old.counter) || !sameStoredValue(all.result, old.rows)) return tx.abort();
        if (!old.header) artifacts.add(header);
        artifacts.put({ key: counterKey, scope, value: next });
        finish();
      } catch { tx.abort(); } };
      h.onsuccess = done; c.onsuccess = done; all.onsuccess = done;
      enqueueOfflineActivationRows(tx, selector, guard, actual => {
        if (!sameStoredValue(actual, admitted.rows)) { tx.abort(); return; } done();
      });
    }, undefined, guard);
    guard();
    const sealed = await sealVaultGrant(vault.header, vault.master, requestId, String(reserved), value);
    guard();
    const reservedRows = [...old.rows.filter(row => row.key !== headerKey && row.key !== counterKey), header,
      { key: counterKey, scope, value: next }].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const pending: Row = { key: pendingKey, scope, value: sealed };
    let sent = false, aborted = false;
    try { await canonicalHostTransaction<void>(authority, current.host, stores, 'readwrite', (tx, _tuple, finish) => {
      const artifacts = tx.objectStore('canonicalProviderArtifacts'), h = artifacts.get(headerKey), all = artifacts.index('scope').getAll(scope);
      let left = 3; const done = () => { if (--left) return; try {
        guard(); if (!rowMatches(h.result, header) || !sameStoredValue(all.result, reservedRows)) return tx.abort();
        artifacts.add(pending); finish();
      } catch { tx.abort(); } };
      h.onsuccess = done; all.onsuccess = done;
      enqueueOfflineActivationRows(tx, selector, guard, actual => {
        if (!sameStoredValue(actual, admitted.rows)) { tx.abort(); return; } done();
      });
    }, { sent: () => { sent = true; }, aborted: () => { aborted = true; }, completed: () => {} }, guard);
    guard(); existingMayBeCommitted = true;
    const pendingRows = [...reservedRows, pending].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return await finalize(pending, pendingRows);
    } catch (error) { if (sent && !aborted) return { status: 'unknown', requestId }; throw error; }
  } catch (error) { if (existingMayBeCommitted && !signal.aborted) return { status: 'unknown', requestId }; throw error; }
  finally { issuer.releaseProviderOperation(operation); }
}
