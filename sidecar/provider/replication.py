"""One admitted provider scope's private finite sync lifecycle."""
from copy import deepcopy
import threading
from papeer.core.edit_repository import SqliteEditRepository
from sidecar.canonical_host import AuthorityError
from sidecar.provider.sync_authority import SyncAuthority
from sidecar.provider.sync_once import sync_once
from sidecar.provider.transfer_ids import TransferIds
from papeer.core.providers.drive.request_group import ProviderRequestCancelled


class ProviderReplicationOwner:
    def __init__(self, registry, authorization, lease, admission_id, host):
        with registry._lock:
            registry._lease(authorization, lease)
            admission = registry._admissions.get(admission_id)
            if not admission or admission['lease_id'] != lease or admission.get('provider_owner') is None:
                raise AuthorityError('provider-admission-invalid')
            owner, proof = admission['provider_owner'], deepcopy(admission['proof'])
        scope = owner.assert_admitted()
        if scope != proof['scope']: raise AuthorityError('provider-admission-invalid')
        self._owner, self._scope, self._peer = owner, scope, proof['peer']['peerId']
        self._repository = SqliteEditRepository(SyncAuthority(registry, authorization, lease, admission_id, owner, scope), scope)
        self._storage = host.edit_storage(owner)
        self._transfer_ids = TransferIds(owner, host)
        self._lock = threading.RLock(); self._flight = threading.Lock(); self._stopped = threading.Event()
        self._idle = threading.Event(); self._idle.set()
        self._suspend_generation = 0
        self._state = {'running': False, 'suspended': False, 'error': ''}

    @property
    def scope(self): return deepcopy(self._scope)

    def snapshot(self):
        with self._lock: return dict(self._state)

    def suspend(self):
        with self._lock:
            self._suspend_generation += 1
            self._stopped.set(); self._storage.cancel()
            self._state['suspended'] = True

    def suspend_and_wait(self):
        self.suspend()
        if not self.wait_drained(5): raise AuthorityError('provider-drain-incomplete')

    def wait_drained(self, timeout):
        return self._idle.wait(timeout)

    def resume(self):
        # Drain the old pass before replacing its request group; never revive
        # a cancelled in-flight request with a new generation.
        with self._lock: generation = self._suspend_generation
        if not self.wait_drained(5): raise AuthorityError('provider-drain-incomplete')
        with self._flight:
            with self._lock:
                if generation != self._suspend_generation: return
                self._storage.renew()
                self._stopped.clear(); self._state['suspended'] = False
        self.flush()

    def flush(self):
        with self._lock: generation = self._suspend_generation
        with self._flight:
            with self._lock:
                if generation != self._suspend_generation or self._stopped.is_set(): return
                self._idle.clear(); self._state.update(running=True, error='')
            try:
                with self._storage.pass_scope():
                    sync_once(self._owner, self._repository, self._storage, self._peer, self._stopped.is_set, self._transfer_ids)
            except ProviderRequestCancelled:
                if not self._stopped.is_set():
                    with self._lock: self._state['error'] = 'provider-sync-failed'
                    raise
            except Exception:
                with self._lock: self._state['error'] = 'provider-sync-failed'
                raise
            finally:
                try: self._storage.finish()
                finally:
                    with self._lock: self._state['running'] = False; self._idle.set()
