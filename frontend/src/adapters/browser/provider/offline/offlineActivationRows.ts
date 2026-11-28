import type { HostOperation, LocalHostAuthority, PersistentTuple } from '../../localHostAuthority.ts';
import { canonicalHostTransaction } from '../../canonicalHostTransaction.ts';
import type { ProviderAdmissionRows } from '../providerAdmission.ts';
import { assertProviderOwnerPlan, providerActivationMetadata } from '../../../../runtime/edits/provider/providerOwnerPlan.ts';
import { readProviderDescriptorBytes } from '../../../../runtime/edits/provider/providerDescriptorBytes.ts';
import { assertProviderPlan } from '../../../../runtime/edits/provider/providerBindingDecision.ts';
import { datasetAccess } from '../../../../runtime/edits/datasetControl.ts';
import { sameStoredValue } from '../../repository/indexedDbMutationWriter.ts';
import { validateCanonicalProviderBinding, type CanonicalProviderBinding } from '../../../../runtime/edits/contracts.ts';
import type { EditScope } from '../../../../runtime/edits/ports.ts';

const key = (...parts: string[]) => JSON.stringify(parts);
export type OfflineActivationSelector = { ownerNamespace: string; requestId: string; scope: EditScope;
  binding: CanonicalProviderBinding; manifestId: string; checkpointSha256: string };
export function validateOfflineSelector(value: unknown, owner: string): asserts value is OfflineActivationSelector {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('offline-activation-invalid');
  const s = value as OfflineActivationSelector;
  if (Object.keys(s).sort().join('|') !== 'binding|checkpointSha256|manifestId|ownerNamespace|requestId|scope'
    || s.ownerNamespace !== owner || !uuid.test(s.ownerNamespace) || !uuid.test(s.requestId) || !uuid.test(s.manifestId)
    || !/^[0-9a-f]{64}$/.test(s.checkpointSha256) || !s.scope || typeof s.scope !== 'object'
    || Object.keys(s.scope).sort().join('|') !== 'accountId|epoch|libraryId' || !uuid.test(s.scope.accountId) || !uuid.test(s.scope.libraryId)
    || typeof s.scope.epoch !== 'string' || !s.scope.epoch || s.scope.epoch.length > 200) throw new Error('offline-activation-invalid');
  validateCanonicalProviderBinding(s.binding);
  if (!sameStoredValue(s.binding.scope, s.scope) || s.binding.state !== 'active') throw new Error('offline-activation-invalid');
}
export function offlineSelector(tuple: PersistentTuple): OfflineActivationSelector {
  const linked = tuple.provider, manifest = tuple.manifest as { id: string; checkpointSha256: string };
  if (!linked || !manifest?.id || !manifest.checkpointSha256) throw new Error('offline-activation-invalid');
  return { ownerNamespace: linked.ownerNamespace, requestId: linked.requestId, scope: { ...tuple.scope },
    binding: structuredClone(linked.binding), manifestId: manifest.id, checkpointSha256: manifest.checkpointSha256 };
}

/** Recheck the enrolled activation data; this is not a live provider check. */
export async function validateOfflineActivationRows(rows: ProviderAdmissionRows, tuple: PersistentTuple): Promise<void> {
  const linked = tuple.provider, plan = rows.artifact?.value, intent = rows.intent;
  if (!linked || !plan || !intent || !rows.binding || !rows.artifact || !(plan.descriptorBytes instanceof Uint8Array)) throw new Error('offline-activation-invalid');
  const scope = tuple.scope, owner = linked.ownerNamespace, identity = key(scope.accountId, scope.libraryId);
  const ns = key(scope.accountId, scope.libraryId, scope.epoch), requestId = linked.requestId;
  await assertProviderOwnerPlan(plan);
  const expected = await providerActivationMetadata(plan);
  const descriptor = await readProviderDescriptorBytes(plan.descriptorBytes, linked.binding.descriptorSha256, scope);
  assertProviderPlan(linked.binding, descriptor.descriptor, intent.value);
  if (plan.ownerNamespace !== owner || plan.requestId !== requestId || plan.intent.phase !== 'activated'
    || plan.binding?.state !== 'active' || linked.binding.state !== 'active'
    || plan.principalDigest !== linked.binding.principalDigest || plan.descriptor.id !== linked.binding.descriptorId
    || plan.descriptor.sha256 !== linked.binding.descriptorSha256 || !sameStoredValue(plan.binding, linked.binding)
    || !sameStoredValue(plan.intent, intent.value) || !sameStoredValue(plan.intent.scope, scope)
    || !sameStoredValue(rows.binding.value, linked.binding) || rows.binding.key !== key(owner, scope.accountId, scope.libraryId, scope.epoch)
    || rows.binding.scope !== owner || rows.artifact.key !== key(owner, requestId) || rows.artifact.scope !== owner
    || intent.key !== key(owner, requestId) || intent.scope !== owner
    || rows.profile?.key !== identity || rows.profile.scope !== scope.accountId || !sameStoredValue(rows.profile.value, expected.profile)
    || !sameStoredValue(rows.profile.value, tuple.profile)
    || rows.peer?.key !== scope.accountId || rows.peer.scope !== scope.accountId || !sameStoredValue(rows.peer.value, expected.peer)
    || !sameStoredValue(rows.peer.value, tuple.peer)
    || rows.control?.key !== identity || rows.control.scope !== identity || !sameStoredValue(rows.control.value, expected.controls[2])
    || !sameStoredValue(rows.control.value, tuple.control)
    || rows.access?.key !== identity || rows.access.scope !== identity || !sameStoredValue(rows.access.value, datasetAccess(expected.controls[2]))
    || rows.manifest?.key !== key(ns, plan.publication.manifest.id) || rows.manifest.scope !== ns
    || !sameStoredValue(rows.manifest.value, plan.publication.manifest) || !sameStoredValue(rows.manifest.value, tuple.manifest)
    || rows.marker?.key !== key(ns, plan.publication.manifest.checkpointSha256) || rows.marker.scope !== ns || rows.marker.value !== true)
    throw new Error('offline-activation-invalid');
}

/**
 * Capture the same activation footprint as provider admission. The caller must
 * establish the authority separately; this function never issues a proof.
 * The intent scan matters: a second activated intent for the binding is not a
 * valid replacement for the unique request originally enrolled.
 */
export function readOfflineActivationRows(authority: LocalHostAuthority, operation: HostOperation,
  selector: OfflineActivationSelector, guard: () => void): Promise<ProviderAdmissionRows> {
  return canonicalHostTransaction(authority, operation,
    ['canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts', 'canonicalProfiles', 'canonicalPeers',
      'datasetControls', 'datasetAccess', 'datasets', 'checkpoints'], 'readonly', (tx, _current, finish) => {
      enqueueOfflineActivationRows(tx, selector, guard, finish);
    }, undefined, guard);
}

export function enqueueOfflineActivationRows(tx: IDBTransaction, selector: OfflineActivationSelector, guard: () => void,
  finish: (rows: ProviderAdmissionRows) => void): void {
  const scope = selector.scope, owner = selector.ownerNamespace, requestId = selector.requestId;
  const identity = key(scope.accountId, scope.libraryId), ns = key(scope.accountId, scope.libraryId, scope.epoch);
  const binding = tx.objectStore('canonicalProviderBindings').get(key(owner, scope.accountId, scope.libraryId, scope.epoch));
      const profile = tx.objectStore('canonicalProfiles').get(identity), peer = tx.objectStore('canonicalPeers').get(scope.accountId);
      const control = tx.objectStore('datasetControls').get(identity), access = tx.objectStore('datasetAccess').get(identity);
      const dataset = tx.objectStore('datasets').get(key(ns, selector.manifestId));
      const marker = tx.objectStore('checkpoints').get(key(ns, selector.checkpointSha256));
      const artifact = tx.objectStore('canonicalProviderArtifacts').get(key(owner, requestId));
      const intents = tx.objectStore('canonicalProviderIntents').index('scope').getAll(owner);
      let remaining = 9;
      const done = () => { if (--remaining) return; try {
        guard();
        const selected = intents.result.filter((row: { value?: { bindingId?: unknown; phase?: unknown } }) =>
          row.value?.bindingId === selector.binding.id && row.value.phase === 'activated');
        if (selected.length !== 1 || selected[0].value.requestId !== requestId) throw new Error('offline-activation-invalid');
        finish({ binding: binding.result, profile: profile.result, peer: peer.result, control: control.result,
          access: access.result, manifest: dataset.result, marker: marker.result, artifact: artifact.result, intent: selected[0] });
      } catch { tx.abort(); } };
  for (const request of [binding, profile, peer, control, access, dataset, marker, artifact, intents]) request.onsuccess = done;
}
