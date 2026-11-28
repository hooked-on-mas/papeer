import type { ActiveLibraryProof, BootstrapHostDriver, HostLease, LibraryHandle, ScopeResources } from '../../../features/bootstrap/bootstrapPorts.ts';
import type { ResourceInspectionPort } from '../../../runtime/edits/ports.ts';
import { createCloudProviderHost } from './cloudProviderHost.ts';

/** Dispatches genuine capabilities to their issuing host; local DB and cloud DB never share a lease. */
export function createProviderCompositeDriver(local: BootstrapHostDriver, inspection?: ResourceInspectionPort): BootstrapHostDriver {
  const proofDrivers = new WeakMap<ActiveLibraryProof, BootstrapHostDriver>();
  let cloudOpen = 0, localOpen = 0, localOpening = 0, offlineScopes = 0, offlineStarting = false, offlineHeld = false, closed = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  const cloud = createCloudProviderHost(inspection);
  let offlineGeneration = 0;
  const pageHide = () => { offlineGeneration++; offlineHeld = false; };
  globalThis.addEventListener?.('pagehide', pageHide);
  const offline: NonNullable<BootstrapHostDriver['getOffline']> extends () => infer T ? T : never = {
    enroll: (...args) => cloud.offline.enroll(...args),
    recoverEnrollment: (...args) => cloud.offline.recoverEnrollment(...args),
    revokeEnrollment: (...args) => cloud.offline.revokeEnrollment(...args),
    async unlock(secret, signal) {
      if (closed || localOpen || localOpening || offlineStarting || offlineHeld) throw new Error('offline-unlock-failed');
      offlineStarting = true; const generation = offlineGeneration;
      try { const result = await cloud.offline.unlock(secret, signal);
        if (closed || generation !== offlineGeneration) throw new Error('offline-unlock-failed');
        offlineHeld = true; return result; }
      finally { offlineStarting = false; }
    },
    async open(session, handle, signal) {
      if (closed || localOpen || localOpening || !offlineHeld) throw new Error('offline-unlock-failed');
      return cloud.offline.open(session, handle, signal);
    },
    async revoke(session, handle, signal) { await cloud.offline.revoke(session, handle, signal); offlineHeld = false; },
    async lock(session) { await cloud.offline.lock(session); offlineHeld = false; },
  };
  const unsubLocal = local.subscribeInvalidation(() => { if (!cloudOpen) emit(); });
  const unsubCloud = cloud.subscribe(() => { if (offlineHeld) { offlineHeld = false; offlineGeneration++; } if (cloudOpen) emit(); });
  const issuing = (proof: ActiveLibraryProof) => {
    const driver = proofDrivers.get(proof); if (!driver) throw new Error('host-proof-invalid'); return driver;
  };
  return {
    getProvider: () => cloud.facade,
    getOffline: () => offline,
    openReplication: (proof, signal) => { if (issuing(proof) === local) throw new Error('provider-admission-required'); return cloud.openReplication(proof, signal); },
    readHold: signal => local.readHold(signal), readLocalContext: signal => local.readLocalContext(signal),
    provisionLocalContext: signal => local.provisionLocalContext(signal), discover: (lease, signal) => local.discover(lease, signal),
    initialization: lease => local.initialization(lease),
    async inspect(lease: HostLease, handle: LibraryHandle, signal: AbortSignal) {
      if (closed) throw new Error('host-closed');
      const driver = cloud.ownsLease(lease) ? cloud.driver : local;
      if (!driver) throw new Error('provider-host-not-ready');
      const proof = await driver.inspect(lease, handle, signal); proofDrivers.set(proof, driver); return proof;
    },
    async openScope(proof, signal) {
      const driver = issuing(proof);
      if (driver === local && (offlineStarting || offlineHeld || offlineScopes)) throw new Error('host-scope-active');
      if (driver === local) localOpening++;
      let resources: ScopeResources;
      try { resources = await driver.openScope(proof, signal); }
      finally { if (driver === local) localOpening--; }
      if (driver === local) {
        localOpen++; let closing: Promise<void> | undefined;
        return { ...resources, close: () => closing ??= resources.close().finally(() => { localOpen--; }) };
      }
      cloudOpen++; let closing: Promise<void> | undefined;
      let scopeOffline = !!driver.providerOffline?.(proof); if (scopeOffline) offlineScopes++;
      const wrapped: ScopeResources = { ...resources,
        reauthorize: async (next, nextSignal) => { if (issuing(next) !== driver) throw new Error('host-admission-changed');
          await resources.reauthorize(next, nextSignal); const nextOffline = !!driver.providerOffline?.(next);
          if (scopeOffline !== nextOffline) { offlineScopes += nextOffline ? 1 : -1; scopeOffline = nextOffline; }
          if (!nextOffline) offlineHeld = false; },
        close: () => closing ??= resources.close().finally(() => { cloudOpen--; if (scopeOffline) offlineScopes--; }),
      };
      return wrapped;
    },
    revalidate: (proof, signal) => issuing(proof).revalidate(proof, signal),
    sameAdmission: (previous, next) => proofDrivers.get(previous) === proofDrivers.get(next)
      && !!proofDrivers.get(previous)?.sameAdmission(previous, next),
    storageKind: proof => issuing(proof).storageKind?.(proof) ?? 'local',
    providerOffline: proof => issuing(proof).providerOffline?.(proof) ?? false,
    subscribeInvalidation(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() { if (closed) return; closed = true; globalThis.removeEventListener?.('pagehide', pageHide); unsubLocal(); unsubCloud();
      await cloud.close(); await local.close(); listeners.clear(); },
  };
}
