import { ALL_CANONICAL_STORES, CANONICAL_STORES } from '../canonicalIndexedDbSchema.ts';
import { canonicalHostTransaction } from '../canonicalHostTransaction.ts';
import type { HostOperation, LocalHostAuthority } from '../localHostAuthority.ts';
import { enqueueEditMutations, sameStoredValue } from '../repository/indexedDbMutationWriter.ts';
import type { CanonicalProviderBinding, CanonicalProviderIntent } from '../../../runtime/edits/contracts.ts';
import type { StoredResource } from '../../../runtime/edits/ports.ts';
import type { ProviderOwnerPlan } from '../../../runtime/edits/provider/providerOwnerPlan.ts';
import type { prepareProviderInstall } from '../../../runtime/edits/provider/providerInstallPlan.ts';
import { datasetAccess } from '../../../runtime/edits/datasetControl.ts';

type Row<T = unknown> = { key: string; scope: string; value: T };
export type ProviderActivationFootprint = {
  artifact?: Row<ProviderOwnerPlan>; intent?: Row<CanonicalProviderIntent>; binding?: Row<CanonicalProviderBinding>;
  profile?: Row; peer?: Row; control?: Row; access?: Row;
  stages: (Row<StoredResource> | undefined)[];
  scoped: Record<string, Row[]>;
};
const key = (...parts: string[]) => JSON.stringify(parts);

/** Only the host's captured namespace-owner operation enters this store. */
export async function loadProviderOwnerPlan(authority: LocalHostAuthority, operation: HostOperation, owner: string,
  requestId: string, assertProviderCurrent: () => void): Promise<ProviderOwnerPlan | undefined> {
  return canonicalHostTransaction(authority, operation, ['canonicalProviderArtifacts', 'canonicalProviderIntents'], 'readonly', (tx, tuple, finish) => {
    assertProviderCurrent();
    if (tuple !== null || authority.captureRecord(operation).grant.namespaceId !== owner) throw new Error('provider-owner-invalid');
    const requestKey = key(owner, requestId), artifact = tx.objectStore('canonicalProviderArtifacts').get(requestKey);
    const intent = tx.objectStore('canonicalProviderIntents').get(requestKey);
    let left = 2;
    const ready = () => { if (--left) return; try {
      assertProviderCurrent();
      const a = artifact.result as Row<ProviderOwnerPlan> | undefined, i = intent.result as Row<CanonicalProviderIntent> | undefined;
      if (!a && !i) { finish(undefined); return; }
      if (!a || !i || a.key !== requestKey || i.key !== requestKey || a.scope !== owner || i.scope !== owner
        || a.value.ownerNamespace !== owner || a.value.requestId !== requestId || !sameStoredValue(a.value.intent, i.value))
        throw new Error('provider-plan-incomplete');
      finish(structuredClone(a.value));
    } catch { tx.abort(); } };
    artifact.onsuccess = ready; intent.onsuccess = ready;
  }, undefined, assertProviderCurrent);
}

/** Request-chain only: the same exact reads serve the outside capture and in-transaction CAS. */
function collectFootprint(tx: IDBTransaction, owner: string, plan: ProviderOwnerPlan,
  done: (value: ProviderActivationFootprint) => void): void {
  const scope = plan.intent.scope, identity = key(scope.accountId, scope.libraryId), namespace = key(scope.accountId, scope.libraryId, scope.epoch);
  const requestKey = key(owner, plan.requestId), bindingKey = key(owner, scope.accountId, scope.libraryId, scope.epoch);
  const requests = [
    tx.objectStore('canonicalProviderArtifacts').get(requestKey), tx.objectStore('canonicalProviderIntents').get(requestKey),
    tx.objectStore('canonicalProviderBindings').get(bindingKey), tx.objectStore('canonicalProfiles').get(identity),
    tx.objectStore('canonicalPeers').get(scope.accountId), tx.objectStore('datasetControls').get(identity), tx.objectStore('datasetAccess').get(identity),
  ];
  const stages = plan.resources.map(ref => tx.objectStore('canonicalProviderArtifacts').get(ref.stagingKey));
  const scoped = CANONICAL_STORES.map(name => tx.objectStore(name).index('scope').getAll(namespace));
  let left = requests.length + stages.length + scoped.length;
  const ready = () => { if (--left) return; try {
    const [artifact, intent, binding, profile, peer, control, access] = requests.map(request => request.result);
    done({ artifact, intent, binding, profile, peer, control, access, stages: stages.map(request => request.result),
      scoped: Object.fromEntries(CANONICAL_STORES.map((name, index) => [name, scoped[index].result as Row[]])) });
  } catch { tx.abort(); } };
  [...requests, ...stages, ...scoped].forEach(request => { request.onsuccess = ready; });
}

export function assertProviderFootprint(owner: string, plan: ProviderOwnerPlan, footprint: ProviderActivationFootprint): void {
  const scope = plan.intent.scope, namespace = key(scope.accountId, scope.libraryId, scope.epoch);
  if (plan.ownerNamespace !== owner || !footprint.artifact || !footprint.intent
    || footprint.artifact.key !== key(owner, plan.requestId) || footprint.artifact.scope !== owner
    || footprint.intent.key !== key(owner, plan.requestId) || footprint.intent.scope !== owner
    || !sameStoredValue(footprint.artifact.value, plan) || !sameStoredValue(footprint.intent.value, plan.intent)
    || !plan.binding || !footprint.binding || footprint.binding.key !== key(owner, scope.accountId, scope.libraryId, scope.epoch)
    || footprint.binding.scope !== owner || !sameStoredValue(footprint.binding.value, plan.binding)
    || footprint.stages.length !== plan.resources.length) throw new Error('provider-plan-changed');
  footprint.stages.forEach((stage, index) => {
    const ref = plan.resources[index];
    if (!stage || stage.key !== ref.stagingKey || stage.scope !== owner || !sameStoredValue(stage.value.metadata, ref.metadata)
      || !(stage.value.bytes instanceof Uint8Array)) throw new Error('provider-staging-incomplete');
  });
  for (const rows of Object.values(footprint.scoped)) if (rows.some(row => row.scope !== namespace)) throw new Error('provider-stored-scope-invalid');
}

export async function captureProviderActivation(authority: LocalHostAuthority, operation: HostOperation, owner: string,
  plan: ProviderOwnerPlan, assertProviderCurrent: () => void): Promise<ProviderActivationFootprint> {
  return canonicalHostTransaction(authority, operation, [...ALL_CANONICAL_STORES], 'readonly', (tx, tuple, finish) => {
    assertProviderCurrent();
    if (tuple !== null || authority.captureRecord(operation).grant.namespaceId !== owner) throw new Error('provider-owner-invalid');
    collectFootprint(tx, owner, plan, value => { assertProviderCurrent(); assertProviderFootprint(owner, plan, value); finish(structuredClone(value)); });
  }, undefined, assertProviderCurrent);
}

export function assertProviderInstallTargetEmpty(footprint: ProviderActivationFootprint, peer: unknown): void {
  if (footprint.profile || footprint.control || footprint.access || Object.values(footprint.scoped).some(rows => rows.length)
    || (footprint.peer && !sameStoredValue(footprint.peer.value, peer))) throw new Error('provider-scope-already-present');
}

export async function commitProviderActivation(authority: LocalHostAuthority, operation: HostOperation, owner: string,
  plan: ProviderOwnerPlan, before: ProviderActivationFootprint, install: Awaited<ReturnType<typeof prepareProviderInstall>>,
  assertProviderCurrent: () => void, evidence: { sent(): void; aborted(): void; completed(result: unknown): void }): Promise<void> {
  return canonicalHostTransaction(authority, operation, [...ALL_CANONICAL_STORES], 'readwrite', (tx, tuple, finish) => {
    assertProviderCurrent();
    if (tuple !== null || authority.captureRecord(operation).grant.namespaceId !== owner) throw new Error('provider-owner-invalid');
    collectFootprint(tx, owner, plan, current => {
      assertProviderCurrent();
      if (!sameStoredValue(current, before)) throw new Error('provider-activation-snapshot-changed');
      assertProviderFootprint(owner, plan, current); assertProviderInstallTargetEmpty(current, install.peer);
      const scope = plan.intent.scope, identity = key(scope.accountId, scope.libraryId);
      const active = install.controls[2], binding: CanonicalProviderBinding = { ...plan.binding!, state: 'active' };
      const intent: CanonicalProviderIntent = { ...plan.intent, phase: 'activated' };
      enqueueEditMutations(tx, scope, install.mutations, () => {
        assertProviderCurrent();
        // Content, bytes, receipts and projections use the shared native writer.
        // Only the owner metadata publication belongs to this activation path.
        tx.objectStore('datasetControls').add({ key: identity, scope: identity, value: active });
        tx.objectStore('datasetAccess').add({ key: identity, scope: identity, value: datasetAccess(active) });
        tx.objectStore('canonicalProfiles').add({ key: identity, scope: scope.accountId, value: install.profile });
        if (!current.peer) tx.objectStore('canonicalPeers').add({ key: scope.accountId, scope: scope.accountId, value: install.peer });
        tx.objectStore('canonicalProviderBindings').put({ key: key(owner, scope.accountId, scope.libraryId, scope.epoch), scope: owner, value: binding });
        tx.objectStore('canonicalProviderIntents').put({ key: key(owner, plan.requestId), scope: owner, value: intent });
        tx.objectStore('canonicalProviderArtifacts').put({ key: key(owner, plan.requestId), scope: owner, value: { ...plan, binding, intent } });
        assertProviderCurrent(); finish();
      });
    });
  }, evidence, assertProviderCurrent);
}
