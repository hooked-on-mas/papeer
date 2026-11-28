import type { ActiveLibraryProof, OfflineLibraryHandle, OfflineUnlockSession, ProviderGrant, ProviderOfflineFacade, RemoteLibraryHandle, HostLease } from '../../../../features/bootstrap/bootstrapPorts.ts';
import type { LocalHostAuthority } from '../../localHostAuthority.ts';
import type { BrowserBootstrapHostDriver } from '../../bootstrapHostDriver.ts';
import type { ProviderGrantIssuer } from '../../ownership/providerGrantIssuer.ts';
import { enrollOfflineLibrary } from './offlineVaultEnrollment.ts';
import { recoverOfflineEnrollment } from './offlineVaultRecovery.ts';
import { reclaimOfflineEnrollment } from './offlineVaultReclaim.ts';
import type { createOfflineEnrollmentCoordinator } from './offlineEnrollmentCoordinator.ts';

type OnlineSelection = { issuer: ProviderGrantIssuer; grant: ProviderGrant; selected: RemoteLibraryHandle };
type SessionRecord = { token: object; active: boolean; handles: WeakMap<object, { id: string }> };

/** Only the owning host may construct this broker or supply its lifecycle guards. */
export function createOfflineVaultBroker(authority: LocalHostAuthority, driver: BrowserBootstrapHostDriver, lease: HostLease,
  beginOffline: () => () => void, onlineSelection: () => OnlineSelection,
  coordinator: ReturnType<typeof createOfflineEnrollmentCoordinator>, coordinationKey: (proof: ActiveLibraryProof, signal: AbortSignal) => string): ProviderOfflineFacade {
  const sessions = new WeakMap<object, SessionRecord>();
  const sessionOf = (session: OfflineUnlockSession) => {
    const record = sessions.get(session); if (!record?.active) throw new Error('offline-unlock-failed'); return record;
  };
  const handleOf = (record: SessionRecord, handle: OfflineLibraryHandle) => {
    const found = record.handles.get(handle); if (!found) throw new Error('offline-unlock-failed'); return found;
  };
  return Object.freeze<ProviderOfflineFacade>({
    async enroll(proof: ActiveLibraryProof, secret, requestId, signal) {
      try {
        const key = coordinationKey(proof, signal);
        return await coordinator.enroll(key, signal, async inner => {
          try { const online = onlineSelection();
            const result = await enrollOfflineLibrary(authority, online.issuer, online.grant, online.selected, proof, requestId, secret, inner);
            return { requestId: result.requestId, status: result.status === 'durable' ? 'accepted' as const : 'unknown' as const };
          } catch (error) { if (inner.aborted) return { requestId, status: 'unknown' as const }; throw error; }
        });
      } catch { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); return { requestId, status: 'rejected' }; }
    },
    async recoverEnrollment(proof, secret, signal) {
      try { const online = onlineSelection();
        return await recoverOfflineEnrollment(authority, online.issuer, online.grant, online.selected, proof, secret, signal);
      } catch { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); throw new Error('offline-recovery-failed'); }
    },
    async revokeEnrollment(proof, secret, signal) {
      const key = coordinationKey(proof, signal), online = onlineSelection();
      return reclaimOfflineEnrollment(authority, online.issuer, online.grant, online.selected, proof, secret, signal, coordinator, key);
    },
    async unlock(secret, signal) {
      try {
        const guard = beginOffline(); guard();
        const token = await authority.unlockOfflineVault(lease, secret, signal); guard();
        const found = await authority.listOfflineVault(lease, token, signal); guard();
        const session = Object.freeze({}) as OfflineUnlockSession, record: SessionRecord = { token, active: true, handles: new WeakMap() };
        const choices = found.map(item => { const handle = Object.freeze({}) as OfflineLibraryHandle;
          record.handles.set(handle, { id: item.id }); return Object.freeze({ handle, title: item.title }); });
        sessions.set(session, record); return { session, choices: Object.freeze(choices) };
      } catch { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); throw new Error('offline-unlock-failed'); }
    },
    async open(session, handle, signal) {
      const guard = beginOffline(); guard(); const record = sessionOf(session), found = handleOf(record, handle);
      const target = await driver.admitOffline(lease, record.token, found.id, signal); guard();
      if (!record.active) throw new Error('offline-unlock-failed'); return target;
    },
    async revoke(session, handle, signal) {
      const record = sessionOf(session), found = handleOf(record, handle);
      const release = driver.reserveOfflineRetirement();
      try { const guard = beginOffline(); guard(); await authority.revokeOffline(lease, record.token, found.id, signal); }
      finally { record.active = false; try { await driver.drainOfflineScopes(); } finally { release(); } }
    },
    async lock(session) {
      const record = sessionOf(session), release = driver.reserveOfflineRetirement(); record.active = false;
      try { let current = false; try { const guard = beginOffline(); guard(); current = true; } catch { /* already retired */ }
        if (current) authority.invalidate(); await driver.drainOfflineScopes();
      } finally { release(); }
    },
  });
}
