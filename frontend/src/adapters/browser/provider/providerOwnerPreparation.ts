import type { ProviderGrant, RemoteLibraryHandle, ProviderOperationOutcome, ProviderRecoveryRequest } from '../../../features/bootstrap/bootstrapPorts.ts';
import type { CanonicalProviderBinding, CanonicalProviderIntent } from '../../../runtime/edits/contracts.ts';
import type { StoredResource } from '../../../runtime/edits/ports.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { resourceHash } from '../../../runtime/edits/contentPublication.ts';
import { assertProviderIntentRetry } from '../../../runtime/edits/provider/providerBindingDecision.ts';
import { assertProviderOwnerPlan, providerOwnerCommitment, type ProviderOwnerPlan } from '../../../runtime/edits/provider/providerOwnerPlan.ts';
import type { LocalHostAuthority } from '../localHostAuthority.ts';
import { canonicalHostTransaction } from '../canonicalHostTransaction.ts';
import { CANONICAL_STORES } from '../canonicalIndexedDbSchema.ts';
import { ProviderGrantIssuer, type ProviderHostOperation } from '../ownership/providerGrantIssuer.ts';
import { sameStoredValue } from '../repository/indexedDbMutationWriter.ts';
import { loadProviderOwnerPlan } from './providerActivationStore.ts';

type Row<T> = { key: string; scope: string; value: T };
const key = (...parts: string[]) => JSON.stringify(parts);

/** The same retained request drives pre-POST CREATE, verified JOIN, publication and activation. */
export class ProviderOwnerPreparation {
  private readonly authority: LocalHostAuthority;
  private readonly issuer: ProviderGrantIssuer;

  constructor(authority: LocalHostAuthority, issuer: ProviderGrantIssuer) {
    this.authority = authority;
    this.issuer = issuer;
  }

  private owner(operation: ProviderHostOperation) {
    const captured = this.issuer.inspectProviderOwnerOperation(operation), local = this.authority.captureRecord(captured.host);
    if (local.family !== 'namespace-owner' || local.tuple !== null) throw new Error('provider-owner-invalid');
    return { captured, namespace: local.grant.namespaceId };
  }

  async query(grant: ProviderGrant, requestId: string, signal: AbortSignal): Promise<ProviderOwnerPlan | undefined> {
    const operation = await this.issuer.captureProviderOwnerOperation(grant, signal);
    try {
      const { captured, namespace } = this.owner(operation), guard = () => { this.owner(operation); };
      const plan = await loadProviderOwnerPlan(this.authority, captured.host, namespace, requestId, guard);
      if (plan) {
        await assertProviderOwnerPlan(plan); guard();
        if (plan.principalDigest !== captured.principal.digest) throw new Error('provider-principal-changed');
      }
      return plan;
    } finally { this.issuer.releaseProviderOperation(operation); }
  }

  async recoveries(grant: ProviderGrant, signal: AbortSignal): Promise<readonly ProviderRecoveryRequest[]> {
    const operation = await this.issuer.captureProviderOwnerOperation(grant, signal);
    try {
      const { captured, namespace } = this.owner(operation), guard = () => { this.owner(operation); };
      const rows = await canonicalHostTransaction<Row<ProviderOwnerPlan>[]>(this.authority, captured.host, ['canonicalProviderArtifacts'], 'readonly',
        (tx, tuple, finish) => {
          guard(); if (tuple !== null) throw new Error('provider-owner-invalid');
          const request = tx.objectStore('canonicalProviderArtifacts').index('scope').getAll(namespace);
          request.onsuccess = () => { try { guard(); finish(structuredClone(request.result)); } catch { tx.abort(); } };
        }, undefined, guard);
      const result: ProviderRecoveryRequest[] = [];
      for (const row of rows) {
        const parts: unknown = JSON.parse(row.key);
        if (!Array.isArray(parts) || parts[0] !== namespace || row.scope !== namespace) throw new Error('provider-artifact-key-invalid');
        if (parts.length !== 2) continue; // Resource staging rows are not UI requests.
        const plan = row.value;
        if (!plan || plan.principalDigest !== captured.principal.digest) continue;
        await assertProviderOwnerPlan(plan); guard();
        if (row.key !== key(namespace, plan.requestId) || plan.ownerNamespace !== namespace) throw new Error('provider-artifact-key-invalid');
        if (plan.acknowledged) continue;
        result.push({ requestId: plan.requestId, action: plan.intent.action, title: plan.title,
          status: plan.intent.phase === 'activated' ? 'accepted' : plan.intent.phase === 'rejected' ? 'rejected' : 'pending' });
      }
      guard(); return result.sort((left, right) => left.requestId.localeCompare(right.requestId));
    } finally { this.issuer.releaseProviderOperation(operation); }
  }

  async acknowledge(grant: ProviderGrant, requestId: string, signal: AbortSignal): Promise<void> {
    const operation = await this.issuer.captureProviderOwnerOperation(grant, signal);
    try {
      const { captured, namespace } = this.owner(operation), guard = () => { this.owner(operation); };
      const plan = await loadProviderOwnerPlan(this.authority, captured.host, namespace, requestId, guard);
      if (!plan) throw new Error('provider-request-missing');
      await assertProviderOwnerPlan(plan); guard();
      if (plan.principalDigest !== captured.principal.digest || plan.intent.phase !== 'activated' || plan.binding?.state !== 'active')
        throw new Error('provider-request-not-accepted');
      if (plan.acknowledged) return;
      const requestKey = key(namespace, requestId);
      await canonicalHostTransaction<void>(this.authority, captured.host, ['canonicalProviderArtifacts', 'canonicalProviderIntents'], 'readwrite',
        (tx, tuple, finish) => {
          guard(); if (tuple !== null) throw new Error('provider-owner-invalid');
          const artifact = tx.objectStore('canonicalProviderArtifacts').get(requestKey), intent = tx.objectStore('canonicalProviderIntents').get(requestKey);
          let left = 2;
          const ready = () => { if (--left) return; try {
            guard();
            if (artifact.result?.scope !== namespace || intent.result?.scope !== namespace
              || !sameStoredValue(artifact.result?.value, plan) || !sameStoredValue(intent.result?.value, plan.intent))
              throw new Error('provider-request-changed');
            tx.objectStore('canonicalProviderArtifacts').put({ key: requestKey, scope: namespace, value: { ...plan, acknowledged: true } });
            guard(); finish();
          } catch { tx.abort(); } };
          artifact.onsuccess = ready; intent.onsuccess = ready;
        }, undefined, guard);
    } finally { this.issuer.releaseProviderOperation(operation); }
  }

  /** Caller is the fixed host composition; no plan or staged bytes enter from the product view. */
  async prepare(grant: ProviderGrant, plan: ProviderOwnerPlan, resources: readonly StoredResource[], signal: AbortSignal): Promise<ProviderOperationOutcome> {
    await assertProviderOwnerPlan(plan);
    if (plan.intent.phase !== 'prepared' || (plan.binding && plan.binding.state !== 'preparing')) throw new Error('provider-prepare-phase');
    if (new TextEncoder().encode(canonicalJson(plan.publication)).byteLength > 16 * 1024 * 1024
      || resources.reduce((total, resource) => total + resource.bytes.byteLength, 0) > 128 * 1024 * 1024
      || !sameStoredValue(resources.map(resource => resource.metadata), plan.resources.map(ref => ref.metadata)))
      throw new Error('provider-staging-invalid');
    for (const resource of resources) if (!(resource.bytes instanceof Uint8Array) || resource.bytes.byteLength !== resource.metadata.byteLength
      || await resourceHash(resource.bytes) !== resource.metadata.sha256) throw new Error('provider-resource-hash');
    const operation = await this.issuer.captureProviderOwnerOperation(grant, signal);
    let sent = false, aborted = false, committed = false;
    try {
      const { captured, namespace } = this.owner(operation), guard = () => { this.owner(operation); };
      if (plan.ownerNamespace !== namespace || plan.principalDigest !== captured.principal.digest) throw new Error('provider-owner-invalid');
      const retained = await loadProviderOwnerPlan(this.authority, captured.host, namespace, plan.requestId, guard);
      if (retained) {
        await assertProviderOwnerPlan(retained); guard();
        if (!sameStoredValue(providerOwnerCommitment(retained), providerOwnerCommitment(plan))) throw new Error('provider-request-reused');
        return { requestId: retained.requestId, status: retained.intent.phase === 'activated' ? 'accepted' : 'pending' };
      }
      const scope = plan.intent.scope, identity = key(scope.accountId, scope.libraryId), ns = key(scope.accountId, scope.libraryId, scope.epoch);
      const requestKey = key(namespace, plan.requestId), bindingKey = key(namespace, scope.accountId, scope.libraryId, scope.epoch);
      await canonicalHostTransaction<void>(this.authority, captured.host,
        [...CANONICAL_STORES, 'canonicalProfiles', 'canonicalPeers', 'canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts'],
        'readwrite', (tx, tuple, finish) => {
          guard(); if (tuple !== null) throw new Error('provider-owner-invalid');
          const artifacts = tx.objectStore('canonicalProviderArtifacts'), intents = tx.objectStore('canonicalProviderIntents');
          const requests = [artifacts.get(requestKey), intents.get(requestKey), tx.objectStore('canonicalProviderBindings').get(bindingKey),
            tx.objectStore('canonicalProfiles').get(identity), tx.objectStore('datasetControls').get(identity),
            tx.objectStore('canonicalPeers').get(scope.accountId), intents.index('scope').getAll(namespace)];
          const occupied = CANONICAL_STORES.map(name => tx.objectStore(name).index('scope').count(ns));
          let left = requests.length + occupied.length;
          const ready = () => { if (--left) return; try {
            guard();
            const [oldArtifact, oldIntent, binding, profile, control, peer, pending] = requests.map(request => request.result);
            if (oldArtifact || oldIntent || binding || profile || control || occupied.some(request => request.result !== 0))
              throw new Error('provider-scope-or-request-already-present');
            if (peer && (peer.key !== scope.accountId || peer.scope !== scope.accountId
              || !sameStoredValue(peer.value, { version: 1, accountId: scope.accountId, peerId: plan.intent.peerId })))
              throw new Error('provider-peer-changed');
            if ((pending as Row<CanonicalProviderIntent>[]).some(row => row.value.phase !== 'rejected'
              && row.value.requestId !== plan.requestId && sameStoredValue(row.value.scope, scope))) throw new Error('provider-scope-reserved');
            artifacts.add({ key: requestKey, scope: namespace, value: structuredClone(plan) });
            intents.add({ key: requestKey, scope: namespace, value: structuredClone(plan.intent) });
            if (plan.binding) tx.objectStore('canonicalProviderBindings').add({ key: bindingKey, scope: namespace, value: structuredClone(plan.binding) });
            resources.forEach((resource, index) => artifacts.add({ key: plan.resources[index].stagingKey, scope: namespace,
              value: { metadata: structuredClone(resource.metadata), bytes: Uint8Array.from(resource.bytes) } }));
            guard(); finish();
          } catch { tx.abort(); } };
          [...requests, ...occupied].forEach(request => { request.onsuccess = ready; });
        }, { sent: () => { sent = true; }, aborted: () => { aborted = true; }, completed: () => { committed = true; } }, guard);
      return { requestId: plan.requestId, status: 'pending' };
    } catch (error) {
      if (committed || (sent && !aborted)) return { requestId: plan.requestId, status: 'unknown' };
      throw error;
    } finally { this.issuer.releaseProviderOperation(operation); }
  }

  /** A real selected descriptor is required before the persisted prepared→published transition. */
  async markPublished(grant: ProviderGrant, handle: RemoteLibraryHandle, requestId: string, signal: AbortSignal): Promise<ProviderOperationOutcome> {
    const operation = await this.issuer.captureProviderOperation(grant, handle, signal);
    let sent = false, aborted = false, committed = false;
    try {
      const { captured, namespace } = this.owner(operation), selected = this.issuer.inspectProviderOperation(operation);
      const guard = () => { this.issuer.inspectProviderOperation(operation); this.owner(operation); };
      const before = await loadProviderOwnerPlan(this.authority, captured.host, namespace, requestId, guard);
      if (!before) return { requestId, status: 'not-found' };
      await assertProviderOwnerPlan(before); guard();
      if (before.principalDigest !== selected.principal.digest || before.descriptor.id !== selected.descriptor.id
        || before.folderId !== selected.descriptor.folderId || before.title !== selected.descriptor.title
        || before.descriptor.sha256 !== selected.descriptor.sha256 || !sameStoredValue(before.descriptorBytes, selected.bytes)
        || !sameStoredValue(before.intent.scope, selected.canonical.scope)
        || (before.descriptor.version !== null && before.descriptor.version !== selected.descriptor.version))
        throw new Error('provider-published-descriptor-changed');
      if (before.intent.phase === 'activated') return { requestId, status: 'accepted' };
      if (!['prepared', 'published'].includes(before.intent.phase)) throw new Error('provider-publish-phase');
      const binding: CanonicalProviderBinding = { version: 1, id: before.intent.bindingId, provider: 'google-drive',
        principalDigest: before.principalDigest, scope: { ...before.intent.scope }, descriptorId: selected.descriptor.id,
        descriptorVersion: selected.descriptor.version, descriptorSha256: selected.descriptor.sha256, state: 'preparing' };
      if (before.binding && !sameStoredValue(before.binding, binding)) throw new Error('provider-binding-changed');
      const intent: CanonicalProviderIntent = { ...before.intent, phase: 'published' };
      assertProviderIntentRetry(before.intent, intent);
      const after: ProviderOwnerPlan = { ...before, binding, intent };
      await assertProviderOwnerPlan(after); guard();
      const scope = before.intent.scope, requestKey = key(namespace, requestId), bindingKey = key(namespace, scope.accountId, scope.libraryId, scope.epoch);
      await canonicalHostTransaction<void>(this.authority, captured.host, ['canonicalProviderArtifacts', 'canonicalProviderIntents', 'canonicalProviderBindings'],
        'readwrite', (tx, tuple, finish) => {
          guard(); if (tuple !== null) throw new Error('provider-owner-invalid');
          const a = tx.objectStore('canonicalProviderArtifacts').get(requestKey), i = tx.objectStore('canonicalProviderIntents').get(requestKey);
          const b = tx.objectStore('canonicalProviderBindings').get(bindingKey);
          let left = 3;
          const ready = () => { if (--left) return; try {
            guard();
            if (a.result?.scope !== namespace || i.result?.scope !== namespace
              || !sameStoredValue(a.result?.value, before) || !sameStoredValue(i.result?.value, before.intent)
              || (before.binding ? b.result?.scope !== namespace || !sameStoredValue(b.result?.value, before.binding) : b.result !== undefined))
              throw new Error('provider-plan-changed');
            tx.objectStore('canonicalProviderArtifacts').put({ key: requestKey, scope: namespace, value: after });
            tx.objectStore('canonicalProviderIntents').put({ key: requestKey, scope: namespace, value: intent });
            tx.objectStore('canonicalProviderBindings').put({ key: bindingKey, scope: namespace, value: binding });
            guard(); finish();
          } catch { tx.abort(); } };
          a.onsuccess = ready; i.onsuccess = ready; b.onsuccess = ready;
        }, { sent: () => { sent = true; }, aborted: () => { aborted = true; }, completed: () => { committed = true; } }, guard);
      return { requestId, status: 'pending' };
    } catch (error) {
      if (committed || (sent && !aborted)) return { requestId, status: 'unknown' };
      throw error;
    } finally { this.issuer.releaseProviderOperation(operation); }
  }
}
