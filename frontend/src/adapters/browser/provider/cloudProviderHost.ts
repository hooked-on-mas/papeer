import type { ActiveLibraryProof, ProviderGrant, ProviderOwnerFacade, ProviderOfflineFacade, ProviderOperationOutcome, RemoteLibraryHandle } from '../../../features/bootstrap/bootstrapPorts.ts';
import type { CanonicalDevicePeer } from '../../../runtime/edits/contracts.ts';
import type { ResourceInspectionPort, StoredResource } from '../../../runtime/edits/ports.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { readPublishedDataset } from '../../../runtime/edits/datasetPublication.ts';
import { prepareNewProviderLibrary, prepareJoinedProviderLibrary, providerScopeNamespace } from '../../../runtime/edits/provider/prepareProviderOwnerPlan.ts';
import type { ProviderOwnerPlan } from '../../../runtime/edits/provider/providerOwnerPlan.ts';
import { createBoundDriveEditTransfer } from '../../drive/editTransfer.ts';
import { ProviderGrantIssuer } from '../ownership/providerGrantIssuer.ts';
import { canonicalHostTransaction } from '../canonicalHostTransaction.ts';
import { acquireCloudProviderCache } from './cloudProviderCache.ts';
import { createGoogleDriveProviderHost } from './googleDriveProvider.ts';
import { ProviderActivation } from './providerActivation.ts';
import { ProviderOwnerPreparation } from './providerOwnerPreparation.ts';
import { createProviderReplication } from './providerReplication.ts';
import { assembleBrowserBootstrapHostDriver, type BrowserBootstrapHostDriver } from '../bootstrapHostDriver.ts';
import { BrowserMarkdownDraftPort } from '../canonicalMarkdownDrafts.ts';
import { BrowserAnnotationAppendDraftPort } from '../annotationAppendDrafts.ts';
import { BrowserReaderStatePort } from '../readerState.ts';
import { readLegacyHoldReadonly } from '../legacyHoldReadonly.ts';
import { readLegacyWebPresenceReadonly } from '../legacyPresenceReadonly.ts';
import { createOfflineVaultBroker } from './offline/offlineVaultBroker.ts';
import { createOfflineEnrollmentCoordinator } from './offline/offlineEnrollmentCoordinator.ts';

type Cache = Awaited<ReturnType<typeof acquireCloudProviderCache>>;
type Selection = { principal: string; descriptor: { id: string; version: string; sha256: string; scope: ActiveLibraryProof['scope']; folderId?: string; title?: string } };
const outcome = (plan: ProviderOwnerPlan | undefined, requestId: string): ProviderOperationOutcome => ({ requestId,
  status: !plan ? 'not-found' : plan.intent.phase === 'activated' ? 'accepted' : plan.intent.phase === 'rejected' ? 'rejected' : 'pending' });
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
  signal.addEventListener('abort', onAbort, { once: true });
});

/** Fixed production composition. No caller supplies a verifier, Google session, credential or plan. */
export function createCloudProviderHost(inspection?: ResourceInspectionPort) {
  const google = createGoogleDriveProviderHost();
  let cache: Cache | undefined, driver: BrowserBootstrapHostDriver | undefined;
  let acquiring: Promise<void> | undefined, closed = false, activeGrant: ProviderGrant | undefined, connecting = false, offlineUnlocking = false;
  let offlineBroker: ProviderOfflineFacade | undefined;
  let issuer: ProviderGrantIssuer | undefined, preparation: ProviderOwnerPreparation | undefined, activation: ProviderActivation | undefined;
  const draftOwners = new Map<string, { principalDigest: string; payload: string }>();
  const draftPlans = new Map<string, ProviderOwnerPlan>();
  const admittedLeases = new WeakSet<import('../../../features/bootstrap/bootstrapPorts.ts').HostLease>();
  const selections = new WeakMap<RemoteLibraryHandle, Selection>();
  const offlineEnrollments = createOfflineEnrollmentCoordinator();
  const replications = new Set<ReturnType<typeof createProviderReplication>>();
  const listeners = new Set<() => void>();
  let lifecycle = 0;
  const resumedGrants = new WeakSet<ProviderGrant>();
  let admitted: { grant: ProviderGrant; requestId: string; handle: RemoteLibraryHandle } | undefined;
  let parked: { grant: ProviderGrant; requestId: string } | undefined;
  let pendingAdoption: { grant: ProviderGrant; retire(): void; adopt(): void } | undefined;
  const discardParked = () => {
    lifecycle++; if (parked) issuer?.disconnect(parked.grant); parked = undefined;
    pendingAdoption?.retire(); pendingAdoption = undefined;
  };
  const pageHide = () => {
    offlineBroker = undefined;
    discardParked(); const current = admitted; admitted = undefined;
    if (current && current.grant === activeGrant && issuer) {
      try {
        issuer.assertCurrentSelection(current.grant, current.handle);
        issuer.parkForPageHide(current.grant); parked = { grant: current.grant, requestId: current.requestId };
      } catch { issuer.disconnect(current.grant); }
    }
    activeGrant = undefined; for (const replication of replications) replication.suspend();
  };
  // Registered before the acquired driver's pagehide invalidates local leases.
  globalThis.addEventListener?.('pagehide', pageHide);
  let unsubscribeAuthority = () => {};
  const notify = () => listeners.forEach(listener => listener());
  const unsubscribeGoogle = google.verifier.subscribeInvalidation!(() => {
    // A cold offline admission has no Google authority to revoke. SDK preload
    // failure must not destroy an independently unlocked local capability.
    if (!activeGrant && !admitted && !parked && !pendingAdoption) return;
    // The cache stays owned; all existing proofs/gates become unusable immediately.
    discardParked(); admitted = undefined; cache?.authority.invalidate(); activeGrant = undefined;
    for (const replication of replications) replication.suspend();
    if (!cache) notify();
  });
  const assertOpen = () => { if (closed) throw new Error('provider-host-closed'); };
  const acquire = (signal: AbortSignal, mode: 'online' | 'existing-only' = 'online') => acquiring ??= (async () => {
    assertOpen(); cache = await acquireCloudProviderCache(signal, mode);
    if (closed) { await cache.close(); throw new Error('provider-host-closed'); }
    driver = assembleBrowserBootstrapHostDriver(cache.authority, {
      readHold: async signal => {
        if (await readLegacyHoldReadonly(signal) === 'held') return 'held';
        if (await readLegacyWebPresenceReadonly(signal) !== 'clear') throw new Error('legacy-data-present');
        return 'clear';
      },
      draftPorts: scope => ({ drafts: new BrowserMarkdownDraftPort(scope), appends: new BrowserAnnotationAppendDraftPort(scope), reader: new BrowserReaderStatePort(scope) }),
      ...(inspection ? { inspection } : {}),
    }); issuer = new ProviderGrantIssuer(cache.authority, google.verifier);
    preparation = new ProviderOwnerPreparation(cache.authority, issuer);
    activation = new ProviderActivation(cache.authority, issuer, inspection);
    unsubscribeAuthority = cache.authority.subscribe(notify);
  })().catch(error => { acquiring = undefined; throw error; });
  const parts = () => {
    assertOpen(); if (!cache || !driver || !issuer || !preparation || !activation) throw new Error('provider-host-not-ready');
    return { cache, driver, issuer, preparation, activation };
  };
  const newOfflineBroker = (lease: import('../../../features/bootstrap/bootstrapPorts.ts').HostLease) => {
    const { cache, driver } = parts();
    return createOfflineVaultBroker(cache.authority, driver, lease, () => {
      const generation = lifecycle;
      return () => { assertOpen(); if (generation !== lifecycle || activeGrant || admitted || connecting) throw new Error('offline-unlock-failed'); };
    }, () => {
      const current = admitted, issuer = parts().issuer;
      if (!current || current.grant !== activeGrant || connecting) throw new Error('offline-enrollment-failed');
      issuer.assertCurrentSelection(current.grant, current.handle);
      return { issuer, grant: current.grant, selected: current.handle };
    }, offlineEnrollments, (proof, signal) => {
      const captured = cache.authority.captureRecord(cache.authority.captureOnlineProviderProof(proof, signal)), tuple = captured.tuple;
      if (!tuple?.provider || captured.offline || !captured.providerFence) throw new Error('offline-enrollment-failed');
      return canonicalJson([captured.grant.namespaceId, tuple.scope.accountId, tuple.scope.libraryId, tuple.provider.binding.principalDigest]);
    });
  };
  const offline: ProviderOfflineFacade = Object.freeze<ProviderOfflineFacade>({
    async enroll(proof, secret, requestId, signal) {
      const current = admitted; if (!current || current.grant !== activeGrant) throw new Error('offline-enrollment-failed');
      return newOfflineBroker(parts().cache.lease).enroll(proof, secret, requestId, signal);
    },
    async recoverEnrollment(proof, secret, signal) {
      const current = admitted; if (!current || current.grant !== activeGrant) throw new Error('offline-recovery-failed');
      return newOfflineBroker(parts().cache.lease).recoverEnrollment(proof, secret, signal);
    },
    async revokeEnrollment(proof, secret, signal) {
      const current = admitted; if (!current || current.grant !== activeGrant) throw new Error('offline-revoke-failed');
      return newOfflineBroker(parts().cache.lease).revokeEnrollment(proof, secret, signal);
    },
    async unlock(secret, signal) {
      assertOpen(); if (activeGrant || admitted || connecting || offlineUnlocking || offlineBroker) throw new Error('offline-unlock-failed');
      offlineUnlocking = true;
      try {
        await acquire(signal, 'existing-only');
        if (activeGrant || admitted || connecting) throw new Error('offline-unlock-failed');
        const { cache, driver } = parts();
        if (await driver.readHold(signal) !== 'clear') throw new Error('offline-unlock-failed');
        const discovered = await cache.authority.discover(signal);
        if (discovered.status !== 'ready') throw new Error('offline-unlock-failed');
        const broker = newOfflineBroker(discovered.lease), result = await broker.unlock(secret, signal);
        if (await driver.readHold(signal) !== 'clear' || activeGrant || admitted || connecting) {
          cache.authority.invalidate(); throw new Error('offline-unlock-failed');
        }
        offlineBroker = broker; return result;
      } catch {
        if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        throw new Error('offline-unlock-failed');
      } finally { offlineUnlocking = false; }
    },
    async open(session, handle, signal) {
      const broker = offlineBroker; if (!broker) throw new Error('offline-unlock-failed');
      const target = await broker.open(session, handle, signal); admittedLeases.add(target.lease); return target;
    },
    async revoke(session, handle, signal) {
      const broker = offlineBroker; if (!broker) throw new Error('offline-unlock-failed');
      try { await broker.revoke(session, handle, signal); } finally { offlineBroker = undefined; }
    },
    async lock(session) {
      const broker = offlineBroker; if (!broker) return;
      try { await broker.lock(session); } finally { offlineBroker = undefined; }
    },
  });
  const fenceRequest = (grant: ProviderGrant, requestId: string, signal: AbortSignal, payload?: unknown) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) throw new Error('provider-request-id');
    const identity = parts().issuer.currentOwner(grant, signal), draft = draftOwners.get(requestId);
    const bytes = payload === undefined ? undefined : canonicalJson(payload);
    if (draft && (draft.principalDigest !== identity.principalDigest || (bytes !== undefined && bytes !== draft.payload)))
      throw new Error('provider-request-principal-changed');
    if (!draft && bytes !== undefined) draftOwners.set(requestId, { principalDigest: identity.principalDigest, payload: bytes });
    return identity;
  };
  const owner = async (grant: ProviderGrant, signal: AbortSignal, accountId?: string) => {
    const { cache, issuer } = parts(), operation = await issuer.captureProviderOwnerOperation(grant, signal);
    try {
      const captured = issuer.inspectProviderOwnerOperation(operation), host = cache.authority.captureRecord(captured.host);
      const ownerNamespace = host.grant.namespaceId;
      const peer = await canonicalHostTransaction<CanonicalDevicePeer | undefined>(cache.authority, captured.host, ['canonicalPeers'], 'readonly', (tx, _tuple, finish) => {
        const request = tx.objectStore('canonicalPeers').get(accountId ?? ownerNamespace);
        request.onsuccess = () => { const row = request.result;
          if (row && (row.key !== (accountId ?? ownerNamespace) || row.scope !== (accountId ?? ownerNamespace))) { tx.abort(); return; }
          finish(row?.value);
        };
      }, undefined, () => { issuer.inspectProviderOwnerOperation(operation); });
      return { ownerNamespace, principalDigest: captured.principal.digest, peer };
    } finally { issuer.releaseProviderOperation(operation); }
  };
  const selectExact = async (grant: ProviderGrant, selected: Selection, signal: AbortSignal) => {
    const { issuer } = parts(), current = await owner(grant, signal);
    if (current.principalDigest !== selected.principal) throw new Error('provider-principal-changed');
    const handle = await issuer.select(grant, selected.descriptor.id, signal);
    const operation = await issuer.captureProviderOperation(grant, handle, signal);
    try {
      const observed = issuer.inspectProviderOperation(operation).descriptor;
      if (canonicalJson(observed) !== canonicalJson(selected.descriptor)) throw new Error('provider-selection-changed');
      return handle;
    } finally { issuer.releaseProviderOperation(operation); }
  };
  const forPlan = async (grant: ProviderGrant, plan: ProviderOwnerPlan, signal: AbortSignal) => {
    const { issuer } = parts(), handle = await issuer.select(grant, plan.descriptor.id, signal);
    const operation = await issuer.captureProviderOperation(grant, handle, signal);
    try {
      const captured = issuer.inspectProviderOperation(operation);
      if (captured.principal.digest !== plan.principalDigest || captured.descriptor.id !== plan.descriptor.id
        || captured.descriptor.sha256 !== plan.descriptor.sha256 || captured.descriptor.folderId !== plan.folderId
        || captured.descriptor.title !== plan.title || canonicalJson(captured.canonical.scope) !== canonicalJson(plan.intent.scope)
        || (plan.binding && captured.descriptor.version !== plan.binding.descriptorVersion)) throw new Error('provider-retained-selection-changed');
      return handle;
    } finally { issuer.releaseProviderOperation(operation); }
  };
  const facade: ProviderOwnerFacade = Object.freeze<ProviderOwnerFacade>({
    subscribeInvalidation: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async preload(signal) { await google.preload(); if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      return { configured: true }; },
    connect(signal) {
      // GIS starts in the actual click stack; cache/SDK preparation already settled.
      assertOpen(); if (offlineUnlocking) throw new Error('offline-lock-required');
      if (offlineBroker) { offlineBroker = undefined; cache?.authority.invalidate(); }
      discardParked(); admitted = undefined; connecting = true;
      let login: ReturnType<typeof google.connect>;
      try { login = google.connect({ selectAccount: true }, signal); } catch (error) { connecting = false; throw error; }
      return (async () => {
        try { await login; await acquire(signal); const { cache, issuer } = parts();
          const fresh = await cache.authority.discover(signal);
          if (fresh.status !== 'ready') throw new Error('cloud-cache-owner-recovery-required');
          activeGrant = await issuer.connect(fresh.lease, signal); return activeGrant;
        } finally { connecting = false; }
      })();
    },
    recoveries: (grant, signal) => parts().preparation.recoveries(grant, signal),
    async list(grant, signal) {
      const { issuer } = parts(), principal = await owner(grant, signal);
      const entries = await google.list(signal);
      return Promise.all(entries.map(async (entry): Promise<Awaited<ReturnType<ProviderOwnerFacade['list']>>[number]> => {
        signal.throwIfAborted();
        const handle = Object.freeze({}) as RemoteLibraryHandle;
        try {
          const raw = await issuer.select(grant, entry.id, signal);
          const descriptor = issuer.inspectSelection(grant, raw);
          selections.set(handle, { principal: principal.principalDigest, descriptor });
          return { handle, title: descriptor.title!, status: 'available' };
        } catch (error) {
          signal.throwIfAborted(); issuer.assertCurrentGrant(grant);
          const denied = error instanceof Error && (error.message.includes('owner-write-required') || error.message.includes('403'));
          return { handle, title: entry.title, status: denied ? 'owner-write-required' : 'unavailable' };
        }
      }));
    },
    async prepareCreate(grant, title, requestId, signal) {
      fenceRequest(grant, requestId, signal, { action: 'create', title });
      const { preparation } = parts(), retained = await preparation.query(grant, requestId, signal);
      if (retained) {
        if (retained.intent.action !== 'create' || retained.title !== title) throw new Error('provider-request-reused');
        return outcome(retained, requestId);
      }
      const draft = draftPlans.get(requestId);
      if (draft) return preparation.prepare(grant, draft, [], signal);
      const identity = await owner(grant, signal), ids = await google.allocateFileIds(4, signal);
      const plan = await prepareNewProviderLibrary({ ...identity, requestId, title,
        providerIds: { folderId: ids[0], checkpointFileId: ids[1], manifestFileId: ids[2], descriptorFileId: ids[3] } });
      draftPlans.set(requestId, structuredClone(plan));
      return preparation.prepare(grant, plan, [], signal);
    },
    async prepareJoin(grant, handle, requestId, signal) {
      const { issuer, preparation } = parts(), selected = selections.get(handle);
      if (!selected) throw new Error('provider-selection-invalid');
      const identityAtEntry = fenceRequest(grant, requestId, signal, { action: 'join', descriptor: selected.descriptor });
      if (identityAtEntry.principalDigest !== selected.principal) throw new Error('provider-request-principal-changed');
      const raw = await selectExact(grant, selected, signal), retained = await preparation.query(grant, requestId, signal);
      if (retained) {
        if (retained.intent.action !== 'join' || retained.descriptor.id !== selected.descriptor.id
          || retained.descriptor.version !== selected.descriptor.version || retained.descriptor.sha256 !== selected.descriptor.sha256)
          throw new Error('provider-request-reused');
        return outcome(retained, requestId);
      }
      const operation = await issuer.captureProviderOperation(grant, raw, signal);
      try {
        const captured = issuer.inspectProviderOperation(operation), descriptor = captured.descriptor;
        if (!descriptor.folderId || !descriptor.title) throw new Error('provider-location-required');
        const transfer = createBoundDriveEditTransfer(google.boundStorage(), descriptor.scope, descriptor.folderId);
        const published = await readPublishedDataset(descriptor.scope, transfer, captured.canonical.manifestId, signal);
        if (published.manifest.checkpointSha256 !== captured.canonical.checkpointSha256) throw new Error('provider-checkpoint-changed');
        const resources: StoredResource[] = [];
        for (const metadata of published.manifest.resources) { signal.throwIfAborted(); resources.push(await transfer.downloadResource(metadata)); }
        await issuer.resolve(grant, raw, descriptor.scope, signal);
        const identity = await owner(grant, signal, descriptor.scope.accountId);
        const plan = await prepareJoinedProviderLibrary({ ...identity, requestId, title: descriptor.title, folderId: descriptor.folderId,
          descriptor, descriptorBytes: captured.bytes, publication: { ...published, checkpointObjectId: crypto.randomUUID() } });
        return preparation.prepare(grant, plan, resources, signal);
      } finally { issuer.releaseProviderOperation(operation); }
    },
    async query(grant, requestId, signal) { fenceRequest(grant, requestId, signal); return outcome(await parts().preparation.query(grant, requestId, signal), requestId); },
    async execute(grant, requestId, signal) {
      fenceRequest(grant, requestId, signal);
      const { preparation, activation } = parts();
      let plan = await preparation.query(grant, requestId, signal);
      if (!plan || plan.intent.phase === 'rejected') return outcome(plan, requestId);
      const freshlyPublished = plan.intent.action === 'create' && plan.intent.phase === 'prepared';
      if (freshlyPublished) {
        const ids = plan.createObjects!; const namespace = await providerScopeNamespace(plan.intent.scope);
        // This immutable local plan already contains every ID. Interrupted delivery reuses each ID.
        await google.createFolder(ids.folderId, ids.folderObjectId, plan.title, undefined, signal);
        await Promise.all([
          google.writeImmutableJson(ids.checkpointFileId, namespace, plan.folderId, plan.publication.checkpointObjectId,
            'repository-checkpoint', { kind: 'repository-checkpoint', checkpoint: plan.publication.checkpoint }, signal),
          google.writeImmutableJson(ids.manifestFileId, namespace, plan.folderId, plan.publication.manifest.id,
            'dataset-manifest', { kind: 'dataset-manifest', manifest: plan.publication.manifest }, signal),
        ]);
        await google.writeDescriptor(ids.descriptorFileId, plan.intent.descriptorObjectId, plan.folderId, plan.title, plan.descriptorBytes, namespace, signal);
      }
      let selected: RemoteLibraryHandle | undefined;
      for (let attempt = 0; ; attempt++) {
        try { selected = await forPlan(grant, plan, signal); break; }
        catch (error) {
          if (freshlyPublished && attempt < 2 && error instanceof Error && error.message === 'drive-descriptor-version-changed') {
            await sleep(350, signal); continue;
          }
          throw error;
        }
      }
      if (plan.intent.phase === 'prepared') {
        await preparation.markPublished(grant, selected, requestId, signal);
        plan = await preparation.query(grant, requestId, signal);
        if (!plan) throw new Error('provider-retained-request-missing');
      }
      return activation.execute(grant, selected, requestId, signal);
    },
    acknowledge: (grant, requestId, signal) => { fenceRequest(grant, requestId, signal); return parts().preparation.acknowledge(grant, requestId, signal); },
    async openSelected(grant, handle, signal) {
      const { driver, issuer } = parts(), selection = selections.get(handle);
      if (!selection) throw new Error('provider-selection-invalid');
      const selected = await selectExact(grant, selection, signal);
      const target = await driver.admitProvider(issuer, grant, selected, undefined, signal);
      if (target) { admittedLeases.add(target.lease); admitted = { grant, requestId: target.requestId, handle: selected }; } return target;
    },
    async openInstalled(grant, requestId, signal) {
      fenceRequest(grant, requestId, signal);
      const { preparation, driver, issuer } = parts(), plan = await preparation.query(grant, requestId, signal);
      if (!plan || plan.intent.phase !== 'activated') throw new Error('provider-request-not-accepted');
      const selected = await forPlan(grant, plan, signal);
      const target = await driver.admitProvider(issuer, grant, selected, requestId, signal);
      if (!target) throw new Error('provider-installation-missing');
      admittedLeases.add(target.lease); admitted = { grant, requestId, handle: selected }; return target;
    },
    async resumeRetained(requestId, signal) {
      assertOpen(); const expected = parked, epoch = lifecycle;
      if (!expected || expected.requestId !== requestId) return null;
      parked = undefined; let fresh: ProviderGrant | undefined;
      const current = () => { signal.throwIfAborted(); assertOpen(); if (epoch !== lifecycle) throw new Error('provider-resume-stale'); };
      try {
        await Promise.all([...replications].map(replication => replication.suspendAndWait())); current();
        const { cache, issuer } = parts(), discovered = await cache.authority.discover(signal); current();
        if (discovered.status !== 'ready') throw new Error('provider-resume-owner-unavailable');
        fresh = await issuer.resumeParked(expected.grant, discovered.lease, signal); resumedGrants.add(fresh); current(); activeGrant = fresh;
        const target = await facade.openInstalled(fresh, requestId, signal); current(); const owned = fresh;
        const adopt = () => { signal.removeEventListener('abort', retire); };
        const retire = () => {
          adopt(); issuer.disconnect(owned);
          if (activeGrant === owned) activeGrant = undefined;
          if (admitted?.grant === owned) admitted = undefined;
          if (pendingAdoption?.grant === owned) pendingAdoption = undefined;
        };
        pendingAdoption = { grant: owned, retire, adopt }; signal.addEventListener('abort', retire, { once: true });
        current(); return { grant: owned, target };
      } catch {
        if (fresh) {
          if (pendingAdoption?.grant === fresh) pendingAdoption.retire();
          issuer?.disconnect(fresh); if (activeGrant === fresh) activeGrant = undefined;
          if (admitted?.grant === fresh) admitted = undefined;
        }
        issuer?.disconnect(expected.grant); return null;
      }
    },
    settleRetainedResume(grant, accepted) {
      if (!accepted) {
        if (!resumedGrants.has(grant)) return;
        // Rollback remains exact-grant-owned even after ACK, until the caller commits activation.
        if (pendingAdoption?.grant === grant) pendingAdoption.retire();
        issuer?.disconnect(grant); resumedGrants.delete(grant);
        if (activeGrant === grant) activeGrant = undefined;
        if (admitted?.grant === grant) admitted = undefined;
        if (parked?.grant === grant) parked = undefined;
        return;
      }
      const pending = pendingAdoption;
      if (!pending || pending.grant !== grant) throw new Error('provider-resume-stale');
      assertOpen(); parts().issuer.assertCurrentGrant(grant);
      if (activeGrant !== grant || admitted?.grant !== grant) throw new Error('provider-resume-stale');
      pending.adopt(); pendingAdoption = undefined;
    },
    async openReplication(grant, proof, signal) {
      const { cache, issuer } = parts(); issuer.assertCurrentGrant(grant);
      const operation = await issuer.captureProviderOwnerOperation(grant, signal);
      try {
        const ownerLease = cache.authority.captureRecord(issuer.inspectProviderOwnerOperation(operation).host).lease;
        const requestId = cache.authority.providerRequestId(proof);
        if (!requestId) throw new Error('provider-admission-required');
        const plan = await parts().preparation.query(grant, requestId, signal);
        if (!plan) throw new Error('provider-installation-missing');
        let group = new AbortController();
        const io = { signal: () => group.signal, cancel: () => group.abort(), renew: () => { if (group.signal.aborted) group = new AbortController(); } };
        const replication = createProviderReplication(cache.authority, ownerLease, proof,
          createBoundDriveEditTransfer(google.boundStorage(io.signal), proof.scope, plan.folderId), io, inspection);
        replications.add(replication);
        return replication;
      } finally { issuer.releaseProviderOperation(operation); }
    },
    async disconnect(grant, signal) {
      signal.throwIfAborted(); discardParked(); admitted = undefined; parts().issuer.assertCurrentGrant(grant);
      await Promise.all([...replications].map(replication => replication.suspendAndWait()));
      parts().issuer.disconnect(grant); await google.disconnectAndWait(); activeGrant = undefined;
    },
  });
  return { facade, openReplication(proof: ActiveLibraryProof, signal: AbortSignal) {
      if (!activeGrant || parts().cache.authority.isOffline(proof)) throw new Error('provider-grant-invalid'); return facade.openReplication(activeGrant, proof, signal);
    }, offline, ownsLease(lease: import('../../../features/bootstrap/bootstrapPorts.ts').HostLease) { return admittedLeases.has(lease); }, get driver() { return driver; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() { if (closed) return; closed = true; discardParked(); admitted = undefined;
      globalThis.removeEventListener?.('pagehide', pageHide);
      await Promise.allSettled([...replications].map(replication => replication.suspendAndWait()));
      if (activeGrant) issuer?.disconnect(activeGrant);
      unsubscribeGoogle(); unsubscribeAuthority(); await google.disconnectAndWait(); await driver?.close(); await cache?.close(); listeners.clear(); },
  };
}
