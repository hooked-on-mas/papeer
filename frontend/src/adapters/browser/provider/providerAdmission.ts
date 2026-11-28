import type { CanonicalProviderBinding, CanonicalProviderIntent } from '../../../runtime/edits/contracts.ts';
import { assertProviderOwnerPlan, providerActivationMetadata, type ProviderOwnerPlan } from '../../../runtime/edits/provider/providerOwnerPlan.ts';
import { assertLiveProviderBinding } from '../../../runtime/edits/provider/providerBindingDecision.ts';
import { datasetAccess } from '../../../runtime/edits/datasetControl.ts';
import type { LocalHostAuthority, PersistentTuple } from '../localHostAuthority.ts';
import type { ProviderGrantIssuer, ProviderHostOperation } from '../ownership/providerGrantIssuer.ts';
import { canonicalHostTransaction } from '../canonicalHostTransaction.ts';
import { sameStoredValue } from '../repository/indexedDbMutationWriter.ts';

type Row<T = unknown> = { key: string; scope: string; value: T };
export type ProviderAdmissionRows = { binding?: Row<CanonicalProviderBinding>; profile?: Row; peer?: Row; control?: Row; access?: Row;
  manifest?: Row; marker?: Row; artifact?: Row<ProviderOwnerPlan>; intent?: Row<CanonicalProviderIntent> };
const key = (...parts: string[]) => JSON.stringify(parts);

/** Read only host-selected active binding data. A missing binding may mean this remote choice is not installed. */
export async function readProviderAdmission(authority: LocalHostAuthority, issuer: ProviderGrantIssuer,
  providerOperation: ProviderHostOperation, requestId: string | undefined): Promise<{ tuple: PersistentTuple; requestId: string; rows: ProviderAdmissionRows } | null> {
  const captured = issuer.inspectProviderOperation(providerOperation), local = authority.captureRecord(captured.host);
  if (local.family !== 'namespace-owner' || local.tuple !== null) throw new Error('provider-owner-invalid');
  const owner = local.grant.namespaceId, scope = captured.canonical.scope;
  const identity = key(scope.accountId, scope.libraryId), namespace = key(scope.accountId, scope.libraryId, scope.epoch);
  const guard = () => { issuer.inspectProviderOperation(providerOperation); authority.captureRecord(captured.host); };
  const read = async (): Promise<ProviderAdmissionRows> =>
    canonicalHostTransaction(authority, captured.host,
      ['canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts', 'canonicalProfiles', 'canonicalPeers',
        'datasetControls', 'datasetAccess', 'datasets', 'checkpoints'], 'readonly', (tx, tuple, finish) => {
        guard(); if (tuple !== null) throw new Error('provider-owner-invalid');
        const binding = tx.objectStore('canonicalProviderBindings').get(key(owner, scope.accountId, scope.libraryId, scope.epoch));
        const profile = tx.objectStore('canonicalProfiles').get(identity), peer = tx.objectStore('canonicalPeers').get(scope.accountId);
        const control = tx.objectStore('datasetControls').get(identity), access = tx.objectStore('datasetAccess').get(identity);
        const manifest = tx.objectStore('datasets').get(key(namespace, captured.canonical.manifestId));
        const marker = tx.objectStore('checkpoints').get(key(namespace, captured.canonical.checkpointSha256));
        let left = 7;
        const ready = () => { if (--left) return; try {
          guard();
          const b = binding.result as Row<CanonicalProviderBinding> | undefined;
          if (!b || b.value.state !== 'active') {
            if (requestId) throw new Error('provider-binding-not-active');
            finish({}); return;
          }
          const intents = tx.objectStore('canonicalProviderIntents').index('scope').getAll(owner);
          intents.onsuccess = () => { try {
            guard();
            const candidates = (intents.result as Row<CanonicalProviderIntent>[]).filter(row => row.value.bindingId === b.value.id
              && row.value.phase === 'activated' && (!requestId || row.value.requestId === requestId));
            if (candidates.length !== 1) throw new Error('provider-activation-intent-missing');
            const intent = candidates[0], artifact = tx.objectStore('canonicalProviderArtifacts').get(key(owner, intent.value.requestId));
            artifact.onsuccess = () => { try { guard(); finish({ binding: b, profile: profile.result, peer: peer.result,
              control: control.result, access: access.result, manifest: manifest.result, marker: marker.result, artifact: artifact.result, intent });
            } catch { tx.abort(); } };
          } catch { tx.abort(); } };
        } catch { tx.abort(); } };
        [binding, profile, peer, control, access, manifest, marker].forEach(request => { request.onsuccess = ready; });
      }, undefined, guard);
  const first = await read(); guard();
  if (!first.binding) return null;
  const plan = first.artifact?.value;
  if (!plan || !first.intent || first.artifact?.key !== key(owner, first.intent.value.requestId) || first.artifact.scope !== owner
    || first.intent.key !== key(owner, first.intent.value.requestId) || first.intent.scope !== owner
    || !sameStoredValue(first.intent.value, plan.intent)) throw new Error('provider-activation-incomplete');
  await assertProviderOwnerPlan(plan); guard();
  const expected = await providerActivationMetadata(plan); guard();
  const binding = first.binding.value;
  assertLiveProviderBinding(binding, captured.canonical, { principalDigest: captured.principal.digest,
    descriptorId: captured.descriptor.id, descriptorVersion: captured.descriptor.version, descriptorSha256: captured.descriptor.sha256,
    owner: captured.descriptor.owner, readable: captured.bytes.byteLength > 0, writable: captured.descriptor.writable });
  if (plan.ownerNamespace !== owner || plan.intent.phase !== 'activated' || plan.binding?.state !== 'active'
    || !sameStoredValue(plan.binding, binding) || !sameStoredValue(scope, plan.intent.scope)
    || plan.folderId !== captured.descriptor.folderId || plan.title !== captured.descriptor.title
    || !sameStoredValue(plan.descriptorBytes, captured.bytes)
    || first.binding.key !== key(owner, scope.accountId, scope.libraryId, scope.epoch) || first.binding.scope !== owner
    || first.profile?.key !== identity || first.profile.scope !== scope.accountId || !sameStoredValue(first.profile.value, expected.profile)
    || first.peer?.key !== scope.accountId || first.peer.scope !== scope.accountId || !sameStoredValue(first.peer.value, expected.peer)
    || first.control?.key !== identity || first.control.scope !== identity || !sameStoredValue(first.control.value, expected.controls[2])
    || first.access?.key !== identity || first.access.scope !== identity || !sameStoredValue(first.access.value, datasetAccess(expected.controls[2]))
    || first.manifest?.key !== key(namespace, plan.publication.manifest.id) || first.manifest.scope !== namespace
    || !sameStoredValue(first.manifest.value, plan.publication.manifest)
    || first.marker?.key !== key(namespace, plan.publication.manifest.checkpointSha256) || first.marker.scope !== namespace || first.marker.value !== true)
    throw new Error('provider-admission-invalid');
  const second = await read(); guard();
  if (!sameStoredValue(first, second)) throw new Error('provider-admission-changed');
  return { requestId: plan.requestId, rows: first, tuple: { grant: local.grant, profile: first.profile.value, peer: first.peer.value,
    control: first.control.value, manifest: first.manifest.value, scope,
    provider: { ownerNamespace: owner, requestId: plan.requestId, binding } } };
}

