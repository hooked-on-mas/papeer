import type { ActiveLibraryProof, ProviderGrant, RemoteLibraryHandle } from '../../../../features/bootstrap/bootstrapPorts.ts';
import type { LocalHostAuthority } from '../../localHostAuthority.ts';
import type { ProviderGrantIssuer } from '../../ownership/providerGrantIssuer.ts';
import { canonicalHostTransaction } from '../../canonicalHostTransaction.ts';
import { sameStoredValue } from '../../repository/indexedDbMutationWriter.ts';
import { canonicalJson } from '../../../../runtime/edits/editModel.ts';
import { readProviderAdmission } from '../providerAdmission.ts';
import { enqueueOfflineActivationRows, offlineSelector, readOfflineActivationRows, validateOfflineSelector, type OfflineActivationSelector } from './offlineActivationRows.ts';
import { offlineActivationDigest } from './offlineActivationDigest.ts';
import { openVaultGrant, unlockVaultHeader, verifyVaultCounter, type OfflineVaultGrant } from './offlineVaultCrypto.ts';

const stores = ['canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts', 'canonicalProfiles', 'canonicalPeers',
  'datasetControls', 'datasetAccess', 'datasets', 'checkpoints'];
const key = (...parts: string[]) => JSON.stringify(parts), tag = 'host-offline-v1';
type Row = { key: string; scope: string; value: unknown };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Read-only cold enrollment recovery, only for the exact currently admitted live provider Library. */
export async function recoverOfflineEnrollment(authority: LocalHostAuthority, issuer: ProviderGrantIssuer, grant: ProviderGrant,
  selected: RemoteLibraryHandle, activeProof: ActiveLibraryProof, secret: string, signal: AbortSignal): Promise<{ requestId: string; status: 'accepted' | 'pending' | 'unknown' } | null> {
  const operation = await issuer.captureProviderOperation(grant, selected, signal);
  try {
    const captured = issuer.inspectProviderOperation(operation), host = authority.captureRecord(captured.host);
    if (host.family !== 'namespace-owner' || host.tuple !== null) throw new Error('offline-recovery-failed');
    const activeOperation = authority.capture(host.lease, activeProof, signal), active = authority.captureRecord(activeOperation);
    if (!active.tuple?.provider || active.offline || !active.providerFence) throw new Error('offline-recovery-failed');
    const admission = await readProviderAdmission(authority, issuer, operation, undefined);
    if (!admission || !sameStoredValue(active.tuple, admission.tuple)) throw new Error('offline-recovery-failed');
    const guard = () => { signal.throwIfAborted(); issuer.inspectProviderOperation(operation); authority.captureRecord(captured.host); authority.captureRecord(activeOperation); };
    guard();
    const selector = offlineSelector(admission.tuple), activation = await readOfflineActivationRows(authority, captured.host, selector, guard);
    if (!sameStoredValue(activation, admission.rows)) throw new Error('offline-recovery-failed');
    const digest = await offlineActivationDigest(activation); guard();
    const context = host.grant.namespaceId, scope = key(tag, context), headerKey = key(tag, context, 'header'), counterKey = key(tag, context, 'counter');
    const read = () => canonicalHostTransaction<Row[]>(authority, captured.host, ['canonicalProviderArtifacts'], 'readonly', (tx, _tuple, finish) => {
      const request = tx.objectStore('canonicalProviderArtifacts').index('scope').getAll(scope); request.onsuccess = () => finish(request.result);
    }, undefined, guard);
    const rows = await read(); guard();
    const header = rows.find(row => row.key === headerKey), counter = rows.find(row => row.key === counterKey);
    if (!!header !== !!counter || rows.some(row => row.scope !== scope) || (!header && rows.length)) throw new Error('offline-recovery-failed');
    let result: { requestId: string; status: 'accepted' | 'pending' } | null = null;
    if (header && counter) {
      const vault = await unlockVaultHeader(header.value, context, secret); guard();
      const next = await verifyVaultCounter(vault.header, vault.master, counter.value); guard();
      const seen = new Set<string>(), identities = new Set<string>();
      for (const row of rows) {
        if (row.key === headerKey || row.key === counterKey) continue;
        const parts: unknown = JSON.parse(row.key);
        if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== tag || parts[1] !== context || !['grant', 'pending'].includes(parts[2])
          || typeof parts[3] !== 'string' || !uuid.test(parts[3]) || seen.has(parts[3])) throw new Error('offline-recovery-failed');
        seen.add(parts[3]); const sealed = row.value as OfflineVaultGrant;
        if (sealed?.id !== parts[3] || typeof sealed.counter !== 'string' || !/^[1-9][0-9]{0,19}$/.test(sealed.counter)
          || BigInt(sealed.counter) >= next) throw new Error('offline-recovery-failed');
        const decoded = await openVaultGrant(vault.header, vault.master, sealed) as { version?: unknown; selector?: OfflineActivationSelector; activationDigest?: unknown }; guard();
        if (!decoded || typeof decoded !== 'object' || Object.keys(decoded).sort().join('|') !== 'activationDigest|selector|version'
          || decoded.version !== 1 || !decoded.selector?.scope || !decoded.selector.binding || typeof decoded.activationDigest !== 'string') throw new Error('offline-recovery-failed');
        validateOfflineSelector(decoded.selector, context);
        if (!/^[0-9a-f]{64}$/.test(decoded.activationDigest)) throw new Error('offline-recovery-failed');
        const identity = canonicalJson([decoded.selector.scope, decoded.selector.binding.id]);
        if (identities.has(identity)) throw new Error('offline-recovery-failed'); identities.add(identity);
        if (decoded.selector.scope.accountId === selector.scope.accountId && decoded.selector.scope.libraryId === selector.scope.libraryId) {
          if (!sameStoredValue(decoded.selector, selector) || decoded.activationDigest !== digest || result) throw new Error('offline-recovery-failed');
          result = { requestId: parts[3], status: parts[2] === 'grant' ? 'accepted' : 'pending' };
        }
      }
    }
    await canonicalHostTransaction<void>(authority, captured.host, stores, 'readonly', (tx, _tuple, finish) => {
      const all = tx.objectStore('canonicalProviderArtifacts').index('scope').getAll(scope); let remaining = 2;
      const done = () => { if (--remaining) return; try { guard(); if (!sameStoredValue(all.result, rows)) return tx.abort(); finish(); } catch { tx.abort(); } };
      all.onsuccess = done;
      enqueueOfflineActivationRows(tx, selector, guard, actual => { if (!sameStoredValue(actual, admission.rows)) { tx.abort(); return; } done(); });
    }, undefined, guard);
    guard(); return result;
  } finally { issuer.releaseProviderOperation(operation); }
}
