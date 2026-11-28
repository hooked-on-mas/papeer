import type { ActiveLibraryProof, ProviderGrant, RemoteLibraryHandle } from '../../../../features/bootstrap/bootstrapPorts.ts';
import type { LocalHostAuthority } from '../../localHostAuthority.ts';
import type { ProviderGrantIssuer } from '../../ownership/providerGrantIssuer.ts';
import { canonicalHostTransaction } from '../../canonicalHostTransaction.ts';
import { sameStoredValue } from '../../repository/indexedDbMutationWriter.ts';
import { readProviderAdmission } from '../providerAdmission.ts';
import { enqueueOfflineActivationRows, offlineSelector, validateOfflineSelector, type OfflineActivationSelector } from './offlineActivationRows.ts';
import { openVaultGrant, unlockVaultHeader, verifyVaultCounter, type OfflineVaultGrant } from './offlineVaultCrypto.ts';
import type { createOfflineEnrollmentCoordinator } from './offlineEnrollmentCoordinator.ts';

type Row = { key: string; scope: string; value: unknown };
const tag = 'host-offline-v1', key = (...parts: string[]) => JSON.stringify(parts);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stores = ['canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts', 'canonicalProfiles', 'canonicalPeers',
  'datasetControls', 'datasetAccess', 'datasets', 'checkpoints'];

/** Only a currently admitted live provider owner can remove its own authenticated offline grants. */
export async function reclaimOfflineEnrollment(authority: LocalHostAuthority, issuer: ProviderGrantIssuer, grant: ProviderGrant,
  selected: RemoteLibraryHandle, proof: ActiveLibraryProof, secret: string, signal: AbortSignal,
  coordinator: ReturnType<typeof createOfflineEnrollmentCoordinator>, coordinationKey: string): Promise<{ status: 'revoked' | 'unknown' }> {
  const operation = await issuer.captureProviderOperation(grant, selected, signal); let barrierStarted = false;
  try {
    const captured = issuer.inspectProviderOperation(operation), host = authority.captureRecord(captured.host);
    if (host.family !== 'namespace-owner' || host.tuple !== null) throw new Error('offline-revoke-failed');
    const activeOperation = authority.capture(host.lease, proof, signal), active = authority.captureRecord(activeOperation);
    if (!active.tuple?.provider || active.offline || !active.providerFence) throw new Error('offline-revoke-failed');
    const admission = await readProviderAdmission(authority, issuer, operation, undefined);
    if (!admission || !sameStoredValue(active.tuple, admission.tuple)) throw new Error('offline-revoke-failed');
    let retirementSignal: AbortSignal | undefined;
    const guard = () => { signal.throwIfAborted(); retirementSignal?.throwIfAborted(); issuer.inspectProviderOperation(operation); authority.captureRecord(captured.host); authority.captureRecord(activeOperation); };
    guard(); const selector = offlineSelector(admission.tuple), context = host.grant.namespaceId, scope = key(tag, context);
    const headerKey = key(tag, context, 'header'), counterKey = key(tag, context, 'counter');
    const read = () => canonicalHostTransaction<Row[]>(authority, captured.host, ['canonicalProviderArtifacts'], 'readonly', (tx, _tuple, finish) => {
      const request = tx.objectStore('canonicalProviderArtifacts').index('scope').getAll(scope); request.onsuccess = () => finish(request.result);
    }, undefined, guard);
    const inspect = async (rows: Row[]) => {
      const header = rows.find(row => row.key === headerKey), counter = rows.find(row => row.key === counterKey);
      if (!header || !counter || rows.some(row => row.scope !== scope)) throw new Error('offline-revoke-failed');
      const vault = await unlockVaultHeader(header.value, context, secret); guard();
      const next = await verifyVaultCounter(vault.header, vault.master, counter.value); guard();
      const targets: string[] = [], seen = new Set<string>();
      for (const row of rows) {
        if (row.key === headerKey || row.key === counterKey) continue;
        const parts: unknown = JSON.parse(row.key);
        if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== tag || parts[1] !== context
          || !['grant', 'pending'].includes(parts[2] as string) || typeof parts[3] !== 'string' || !uuid.test(parts[3]) || seen.has(parts[3])) throw new Error('offline-revoke-failed');
        seen.add(parts[3]); const sealed = row.value as OfflineVaultGrant;
        if (sealed?.id !== parts[3] || typeof sealed.counter !== 'string' || !/^[1-9][0-9]{0,19}$/.test(sealed.counter) || BigInt(sealed.counter) >= next) throw new Error('offline-revoke-failed');
        const decoded = await openVaultGrant(vault.header, vault.master, sealed) as { version?: unknown; selector?: OfflineActivationSelector; activationDigest?: unknown }; guard();
        if (!decoded || typeof decoded !== 'object' || Object.keys(decoded).sort().join('|') !== 'activationDigest|selector|version'
          || decoded.version !== 1 || typeof decoded.activationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(decoded.activationDigest)) throw new Error('offline-revoke-failed');
        validateOfflineSelector(decoded.selector, context);
        if (decoded.selector.scope.accountId === selector.scope.accountId && decoded.selector.scope.libraryId === selector.scope.libraryId
          && decoded.selector.binding.principalDigest === selector.binding.principalDigest) targets.push(row.key);
      }
      return targets;
    };
    // Authenticate before revocation can interrupt another enrollment.
    await inspect(await read()); guard(); barrierStarted = true;
    return await coordinator.retire(coordinationKey, signal, async inner => {
      retirementSignal = inner;
      guard(); const rows = await read(), targets = await inspect(rows); guard();
      await canonicalHostTransaction<void>(authority, captured.host, stores, 'readwrite', (tx, _tuple, finish) => {
        const artifacts = tx.objectStore('canonicalProviderArtifacts'), all = artifacts.index('scope').getAll(scope); let remaining = 2;
        const done = () => { if (--remaining) return; try {
          guard(); if (!sameStoredValue(all.result, rows)) return tx.abort();
          for (const target of targets) artifacts.delete(target); finish();
        } catch { tx.abort(); } };
        all.onsuccess = done;
        enqueueOfflineActivationRows(tx, selector, guard, actual => { if (!sameStoredValue(actual, admission.rows)) { tx.abort(); return; } done(); });
      }, undefined, guard);
      guard(); return { status: 'revoked' as const };
    });
  } catch (error) { if (barrierStarted) return { status: 'unknown' }; throw error; }
  finally { issuer.releaseProviderOperation(operation); }
}
