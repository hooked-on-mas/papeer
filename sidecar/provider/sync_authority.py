"""Private sync-only adapter to the existing canonical SQLite writer."""
from contextlib import contextmanager
from copy import deepcopy
from sidecar.canonical_host import AuthorityError, _provider_proof

_READ = frozenset({'receipt', 'pending-records', 'dataset-control', 'read-resource', 'resource-metadata'})
_WRITE = frozenset({'receive-records', 'acknowledge-upload', 'store-resource'})


class SyncAuthority:
    def __init__(self, registry, authorization, lease, admission, owner, scope):
        self._registry, self._authorization, self._lease, self._admission = registry, authorization, lease, admission
        self._owner, self._scope = owner, deepcopy(scope)
        self.assert_current()

    def _check(self, db):
        self._registry._lease(self._authorization, self._lease)
        admission = self._registry._admissions.get(self._admission)
        if (not admission or admission['lease_id'] != self._lease or admission.get('provider_owner') is not self._owner
                or admission['proof']['scope'] != self._scope or _provider_proof(db, self._owner, self._scope) != admission['proof']):
            raise AuthorityError('provider-admission-invalid')
        return admission['proof']

    def _check_snapshot_live(self, proof):
        # Only the five fixed SqliteEditRepository sync-read bodies use this
        # context. They do not end/change its transaction or write this connection.
        # Persisted rows were fully checked by _check in this same read snapshot.
        from papeer.core.edits.provider_binding_decision import assert_live_provider_binding
        self._registry._lease(self._authorization, self._lease)
        admission = self._registry._admissions.get(self._admission)
        if (not admission or admission['lease_id'] != self._lease or admission.get('provider_owner') is not self._owner
                or admission['proof']['scope'] != self._scope):
            raise AuthorityError('provider-admission-invalid')
        binding = proof['providerBinding']; descriptor = self._owner.descriptor()
        assert_live_provider_binding(binding, descriptor, self._owner.live_evidence())
        if binding['scope'] != self._scope: raise AuthorityError('provider-scope-mismatch')
        if (proof['scope'] != self._scope
                or proof['profile']['remote'] != {'kind': 'drive', 'folderId': self._owner.live_evidence()['folderId']}):
            raise AuthorityError('provider-scope-mismatch')
        if proof != admission['proof']: raise AuthorityError('provider-admission-invalid')

    def assert_current(self):
        with self._owner.transaction('provider-read') as db:
            self._check(db)

    @contextmanager
    def transaction(self, operation, scope):
        if operation not in _READ | _WRITE or scope != self._scope: raise AuthorityError('operation-denied')
        with self._owner.transaction('provider-write' if operation in _WRITE else 'provider-read') as db:
            if operation in _WRITE:
                self._check(db)
                yield db
                self._check(db)
            else:
                proof = deepcopy(self._check(db))
                yield db
                self._check_snapshot_live(proof)
