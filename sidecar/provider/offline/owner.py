"""Opaque host-created offline owner; every operation fences the same SQLite transaction."""
from contextlib import contextmanager
from copy import deepcopy
from sidecar.canonical_host import AuthorityError, _READ, _WRITE, _existing, _current_grant, _require_clear, _schema_state
from sidecar.provider.owner import ProviderCommitUnknown
from . import snapshot, storage

_CREATED = object()


class OfflineOperationOwner:
    def __init__(self, created, service, session, record_id, payload):
        if created is not _CREATED: raise AuthorityError('offline-unlock-failed')
        self._service, self._session, self._record_id = service, session, record_id
        self._registry, self._authorization, self._lease_id = service.registry, session['authorization'], session['leaseId']
        self._payload = deepcopy(payload)
        self._selector = self._payload['selector']
        self._expected_proof = deepcopy(session['proofs'][record_id])
        self._context = session['lease']['grant']['contextId']
        self._scope = deepcopy(self._selector['scope'])

    @property
    def scope(self): return deepcopy(self._scope)

    def _memory(self):
        self._service._check_session(self._session)

    def _check(self, db):
        self._memory(); _require_clear()
        if _current_grant(db) != self._session['lease']['grant'] or _schema_state(db) != 'ready': raise AuthorityError('offline-unlock-failed')
        rows = storage.read(db, self._context)
        if rows['header'] != self._session['headerRaw'] or rows['grants'].get(self._record_id) != self._session['grants'][self._record_id]:
            raise AuthorityError('offline-permission-changed')
        proof = snapshot.current_proof(db, self._context, self._selector)
        if proof != self._expected_proof: raise AuthorityError('offline-permission-changed')
        return proof

    def assert_current(self):
        with self.transaction('read'): pass

    @contextmanager
    def transaction(self, operation):
        if operation not in _READ | _WRITE: raise AuthorityError('operation-denied')
        write, committed = operation in _WRITE, False
        try:
            with self._registry._lock:
                self._memory()
                path = self._session['lease']['path']
                with _existing(path, write) as db:
                    self._check(db); yield db; self._check(db)
                committed = write
                self._memory()
        except Exception as error:
            if committed: raise ProviderCommitUnknown('provider-commit-unknown') from error
            raise


def create(service, session, record_id, payload):
    return OfflineOperationOwner(_CREATED, service, session, record_id, payload)
