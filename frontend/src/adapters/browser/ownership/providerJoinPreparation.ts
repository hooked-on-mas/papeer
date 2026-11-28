import type { CanonicalProviderBinding, CanonicalProviderIntent, DatasetPublication, ResourceMetadata } from '../../../runtime/edits/contracts.ts';
import { validateCanonicalProviderBinding, validateCanonicalProviderIntent } from '../../../runtime/edits/contracts.ts';
import type { ProviderGrant, RemoteLibraryHandle } from '../../../features/bootstrap/bootstrapPorts.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { resourceHash } from '../../../runtime/edits/contentPublication.ts';
import { assertDatasetCheckpoint } from '../../../runtime/edits/datasetManifest.ts';
import { assertProviderPlan } from '../../../runtime/edits/provider/providerBindingDecision.ts';
import type { LocalHostAuthority } from '../localHostAuthority.ts';
import { canonicalHostTransaction } from '../canonicalHostTransaction.ts';
import { CANONICAL_STORES } from '../canonicalIndexedDbSchema.ts';
import { ProviderGrantIssuer, type ProviderHostOperation } from './providerGrantIssuer.ts';

const key = (...parts: string[]) => JSON.stringify(parts);
type ResourceStage = { metadata: ResourceMetadata; bytes: Uint8Array };
type Reference = { metadata: ResourceMetadata; stagingKey: string };
type Plan = { ownerNamespace: string; requestId: string; descriptor: { id: string; version: string; sha256: string };
  descriptorBytes: Uint8Array; publication: DatasetPublication; resources: Reference[]; binding: CanonicalProviderBinding; intent: CanonicalProviderIntent };
type Row<T> = { key: string; scope: string; value: T };
export type ProviderPreparedQuery = { status: 'not-found'; requestId: string } | { status: 'pending'; requestId: string; plan: Plan };
export type ProviderPreparedOutcome = ProviderPreparedQuery | { status: 'unknown'; requestId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const fail = (reason: string): never => { throw new Error(reason); };
function body(plan: Plan) {
 return { ownerNamespace: plan.ownerNamespace, requestId: plan.requestId, descriptor: plan.descriptor,
  publication: plan.publication, resources: plan.resources };
}
function commitment(plan: Plan) { return { ...body(plan), binding: plan.binding, intent: { ...plan.intent, requestSha256: '' } }; }

/** Host-private JOIN preparation only. No profile activation, admission, transport or replacement writer. */
export class ProviderJoinPreparation {
 private readonly authority: LocalHostAuthority; private readonly issuer: ProviderGrantIssuer;
 constructor(authority: LocalHostAuthority, issuer: ProviderGrantIssuer) { this.authority = authority; this.issuer = issuer; }
 private capture(grant: ProviderGrant, handle: RemoteLibraryHandle, signal: AbortSignal) {
  return this.issuer.captureProviderOperation(grant, handle, signal);
 }
 private owner(operation: ProviderHostOperation) {
  const captured = this.issuer.inspectProviderOperation(operation), local = this.authority.captureRecord(captured.host);
  if (local.family !== 'namespace-owner' || local.tuple !== null) fail('provider-owner-invalid');
  return { captured, namespace: local.grant.namespaceId };
 }
 /** All fetch/hash/schema work completes before IDB; only synchronous request chains execute in transaction. */
 async prepareJoin(grant: ProviderGrant, handle: RemoteLibraryHandle, requestId: string, publicationInput: DatasetPublication,
  resourceInput: readonly ResourceStage[], signal: AbortSignal): Promise<ProviderPreparedOutcome> {
  if (!uuid.test(requestId)) fail('provider-request-invalid');
  const operation = await this.capture(grant, handle, signal);
  try {
  const { captured, namespace } = this.owner(operation);
  if (resourceInput.reduce((sum, value) => sum + value.bytes.byteLength, 0) > 128 * 1024 * 1024) fail('provider-staging-too-large');
  const publication = structuredClone(publicationInput), resources = resourceInput.map(value => ({ metadata: structuredClone(value.metadata), bytes: Uint8Array.from(value.bytes) }));
  if (new TextEncoder().encode(canonicalJson(publication)).byteLength > 16 * 1024 * 1024) fail('provider-plan-too-large');
  await assertDatasetCheckpoint(publication.manifest, publication.checkpoint, captured.canonical.scope);
  if (publication.manifest.id !== captured.canonical.manifestId || publication.manifest.checkpointSha256 !== captured.canonical.checkpointSha256) fail('provider-publication-descriptor-mismatch');
  if (!uuid.test(publication.checkpointObjectId) || publication.checkpointObjectId === publication.manifest.id) fail('provider-object-id-reused');
  if (resources.length !== publication.manifest.resources.length || new Set(resources.map(item => item.metadata.id)).size !== resources.length) fail('provider-staging-incomplete');
  let total = 0;
  for (let index = 0; index < resources.length; index++) {
   const resource = resources[index], expected = publication.manifest.resources[index]; total += resource.bytes.byteLength;
   if (total > 128 * 1024 * 1024 || !same(resource.metadata, expected) || resource.bytes.byteLength !== expected.byteLength
    || await resourceHash(resource.bytes) !== expected.sha256) fail('provider-staging-invalid');
  }
  this.owner(operation);
  const scope = captured.canonical.scope, bindingId = crypto.randomUUID(), peerId = crypto.randomUUID(), descriptorObjectId = crypto.randomUUID();
  const binding: CanonicalProviderBinding = { version: 1, id: bindingId, provider: 'google-drive', principalDigest: captured.principal.digest,
   scope: { ...scope }, descriptorId: captured.descriptor.id, descriptorVersion: captured.descriptor.version, descriptorSha256: captured.descriptor.sha256, state: 'preparing' };
  const references = resources.map(resource => ({ metadata: resource.metadata, stagingKey: key(namespace, requestId, 'resource', resource.metadata.id) }));
  const plan: Plan = { ownerNamespace: namespace, requestId, descriptor: { id: captured.descriptor.id, version: captured.descriptor.version, sha256: captured.descriptor.sha256 },
   descriptorBytes: Uint8Array.from(captured.bytes), publication, resources: references, binding,
   intent: { version: 1, requestId, bindingId, action: 'join', scope: { ...scope }, requestSha256: '', descriptorObjectId,
    descriptorSha256: captured.descriptor.sha256, manifestId: publication.manifest.id, checkpointObjectId: publication.checkpointObjectId,
    checkpointSha256: publication.manifest.checkpointSha256, peerId, phase: 'prepared' } };
  plan.intent.requestSha256 = await resourceHash(new TextEncoder().encode(canonicalJson(commitment(plan))));
  validateCanonicalProviderBinding(binding); validateCanonicalProviderIntent(plan.intent); assertProviderPlan(binding, captured.canonical, plan.intent); this.owner(operation);
  let sent = false, aborted = false;
  try {
   await canonicalHostTransaction<void>(this.authority, captured.host,
    [...CANONICAL_STORES, 'canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts'], 'readwrite', (tx, tuple, finish) => {
     this.owner(operation); if (tuple !== null) fail('provider-owner-invalid');
     const bindingKey = key(namespace, scope.accountId, scope.libraryId, scope.epoch), requestKey = key(namespace, requestId);
     const intents = tx.objectStore('canonicalProviderIntents'), artifacts = tx.objectStore('canonicalProviderArtifacts'), bindings = tx.objectStore('canonicalProviderBindings');
     const existingIntent = intents.get(requestKey), existingPlan = artifacts.get(requestKey), reservation = bindings.get(bindingKey);
     const profile = tx.objectStore('canonicalProfiles').get(key(scope.accountId, scope.libraryId));
     const control = tx.objectStore('datasetControls').get(key(scope.accountId, scope.libraryId));
     const occupied = CANONICAL_STORES.map(name => tx.objectStore(name).index('scope').count(key(scope.accountId, scope.libraryId, scope.epoch)));
     let left = 5 + occupied.length; const ready = () => { if (--left) return; try {
      this.owner(operation);
      const oldIntent = existingIntent.result as Row<CanonicalProviderIntent> | undefined, oldPlan = existingPlan.result as Row<Plan> | undefined;
      if (oldIntent || oldPlan) {
       if (!oldIntent || !oldPlan) throw new Error('provider-request-reused');
       if (oldIntent.scope !== namespace || oldPlan.scope !== namespace || !same(oldPlan.value.intent, oldIntent.value)
        || !same(body(oldPlan.value), body(plan))) fail('provider-request-reused');
       if (!reservation.result || !same(reservation.result.value, oldPlan.value.binding)) fail('provider-binding-changed');
      } else {
       if (profile.result || control.result || reservation.result || occupied.some(request => request.result !== 0)) fail('provider-scope-already-present');
       bindings.add({ key: bindingKey, scope: namespace, value: binding });
       artifacts.add({ key: requestKey, scope: namespace, value: plan }); intents.add({ key: requestKey, scope: namespace, value: plan.intent });
       for (let index = 0; index < resources.length; index++) artifacts.add({ key: references[index].stagingKey, scope: namespace, value: resources[index] });
      }
      this.owner(operation); finish();
     } catch { try { tx.abort(); } catch { /* already aborted by live revocation */ } } };
     existingIntent.onsuccess = ready; existingPlan.onsuccess = ready; reservation.onsuccess = ready; profile.onsuccess = ready; control.onsuccess = ready; occupied.forEach(request => { request.onsuccess = ready; });
    }, { sent: () => { sent = true; }, aborted: () => { aborted = true; }, completed: () => {} }, () => { this.owner(operation); });
   return await this.queryCaptured(operation, requestId);
  } catch (error) { if (sent && !aborted) return { status: 'unknown', requestId }; throw error; }
  } finally { this.issuer.releaseProviderOperation(operation); }
 }
 async query(grant: ProviderGrant, handle: RemoteLibraryHandle, requestId: string, signal: AbortSignal): Promise<ProviderPreparedQuery> {
  if (!uuid.test(requestId)) fail('provider-request-invalid');
  const operation = await this.capture(grant, handle, signal);
  try { return await this.queryCaptured(operation, requestId); } finally { this.issuer.releaseProviderOperation(operation); }
 }
 private async queryCaptured(operation: ProviderHostOperation, requestId: string): Promise<ProviderPreparedQuery> {
  const { captured, namespace } = this.owner(operation);
  const records = await canonicalHostTransaction<{ plan?: Plan; intent?: CanonicalProviderIntent; binding?: CanonicalProviderBinding; stages: ResourceStage[] }>(this.authority,
   captured.host, ['canonicalProviderBindings', 'canonicalProviderIntents', 'canonicalProviderArtifacts'], 'readonly', (tx, _tuple, finish) => {
    this.owner(operation); const requestKey = key(namespace, requestId), artifacts = tx.objectStore('canonicalProviderArtifacts');
    const planRequest = artifacts.get(requestKey), intentRequest = tx.objectStore('canonicalProviderIntents').get(requestKey);
    let left = 2; const ready = () => { if (--left) return; try {
     this.owner(operation); const plan = (planRequest.result as Row<Plan> | undefined)?.value, intent = (intentRequest.result as Row<CanonicalProviderIntent> | undefined)?.value;
     if (!plan && !intent) { finish({ stages: [] }); return; } if (!plan || !intent) throw new Error('provider-plan-incomplete');
     const binding = tx.objectStore('canonicalProviderBindings').get(key(namespace, plan.binding.scope.accountId, plan.binding.scope.libraryId, plan.binding.scope.epoch));
     const stages = plan.resources.map(ref => artifacts.get(ref.stagingKey)); let remaining = stages.length + 1;
     const done = () => { if (--remaining) return; try { this.owner(operation); finish({ plan, intent, binding: binding.result?.value, stages: stages.map(row => row.result?.value) }); } catch { try { tx.abort(); } catch { /* already aborted by live revocation */ } } };
     binding.onsuccess = done; stages.forEach(request => { request.onsuccess = done; });
    } catch { try { tx.abort(); } catch { /* already aborted by live revocation */ } } }; planRequest.onsuccess = ready; intentRequest.onsuccess = ready;
   }, undefined, () => { this.owner(operation); });
  if (!records.plan) return { status: 'not-found', requestId };
  const { plan, intent, binding, stages } = records;
  validateCanonicalProviderBinding(plan.binding); validateCanonicalProviderIntent(plan.intent);
  assertProviderPlan(plan.binding, captured.canonical, plan.intent);
  if (!intent || !binding || plan.ownerNamespace !== namespace || !same(intent, plan.intent) || !same(binding, plan.binding)
   || binding.state !== 'preparing' || intent.phase !== 'prepared' || binding.principalDigest !== captured.principal.digest
   || !same(binding.scope, captured.canonical.scope) || !same(plan.descriptor, { id: captured.descriptor.id, version: captured.descriptor.version, sha256: captured.descriptor.sha256 })
   || await resourceHash(plan.descriptorBytes) !== captured.descriptor.sha256
   || await resourceHash(new TextEncoder().encode(canonicalJson(commitment(plan)))) !== intent.requestSha256) fail('provider-persisted-plan-invalid');
  await assertDatasetCheckpoint(plan.publication.manifest, plan.publication.checkpoint, captured.canonical.scope);
  if (stages.length !== plan.resources.length || !same(plan.resources.map(ref => ref.metadata), plan.publication.manifest.resources)) fail('provider-staging-incomplete');
  for (let index = 0; index < stages.length; index++) {
   const stage = stages[index], ref = plan.resources[index];
   if (!stage || !same(stage.metadata, ref.metadata) || stage.bytes.byteLength !== ref.metadata.byteLength || await resourceHash(stage.bytes) !== ref.metadata.sha256) fail('provider-staging-invalid');
  }
  this.owner(operation); return { status: 'pending', requestId, plan: structuredClone(plan) };
 }
}
