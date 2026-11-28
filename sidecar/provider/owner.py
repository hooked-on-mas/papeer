"""One host-held provider operation backed by the existing SQLite authority."""
from contextlib import contextmanager
from copy import deepcopy
import threading
from typing import cast
from sidecar.canonical_host import AuthorityError, _current_grant, _existing, _require_clear, _schema_state


class ProviderCommitUnknown(AuthorityError):
    """The SQLite commit finished but the provider fence failed on exit."""


class ProviderOperationOwner:
    """Internal host composition only; never accept this object from renderer input.

    The fixed host verifier captures authenticated provider evidence before the
    operation. It must synchronously fence its monotonic generation on commit.
    """
    def __init__(self, registry, authorization, lease_id, verifier, principal, evidence, descriptor):
        self._registry, self._authorization, self._lease_id = registry, authorization, lease_id
        self._verifier, self._principal, self._evidence = verifier, deepcopy(principal), deepcopy(evidence)
        self._descriptor = deepcopy(descriptor)
        self._inside = threading.local()
        self._invalid = threading.Event()
        self._group_lock = threading.Lock()
        self._groups = set()
        with verifier.guard(self._principal):
            with registry._lock:
                lease = registry._lease(authorization, lease_id)
                self._grant = deepcopy(lease['grant']); self._path = lease['path']
                verifier.assert_current(self._principal)
                registry._provider_captured_locked(self)

    @property
    def namespace(self):
        return self._grant['namespaceId']

    def invalidate(self):
        self._invalid.set()
        with self._group_lock: groups = tuple(self._groups)
        for group in groups: group.cancel()

    @property
    def principal_digest(self):
        return self._principal['digest']

    def assert_current(self):
        if getattr(self._inside, 'transaction', False):
            self._check_locked(); return
        with self._verifier.guard(self._principal):
            with self._registry._lock:
                self._check_locked()

    def _verify_descriptor(self):
        if self._evidence is None:
            return
        if self._invalid.is_set(): raise AuthorityError('provider-operation-invalid')
        try:
            with self.io_scope(self._verifier):
                actual = self._verifier.descriptor(self._principal, self._evidence['descriptorId'])
            if (actual['id'] != self._evidence['descriptorId'] or actual['version'] != self._evidence['descriptorVersion']
                    or actual['sha256'] != self._evidence['descriptorSha256'] or actual['folderId'] != self._evidence['folderId']
                    or not actual['owner'] or not actual['writable'] or actual['scope'] != self._descriptor['scope']):
                raise AuthorityError('provider-descriptor-changed')
            return actual
        except Exception as error:
            from papeer.core.providers.drive.request_group import ProviderRequestCancelled
            from papeer.core.providers.drive.transport import DriveProviderHttpError
            if not isinstance(error, ProviderRequestCancelled) and not (isinstance(error, DriveProviderHttpError) and (error.status == 429 or 500 <= error.status <= 599)): self._invalid.set()
            raise

    def _check_locked(self):
        if self._invalid.is_set(): raise AuthorityError('provider-operation-invalid')
        lease = self._registry._lease(self._authorization, self._lease_id)
        if lease['grant'] != self._grant or lease['path'] != self._path: raise AuthorityError('lease-expired')
        _require_clear(); self._verifier.assert_current(self._principal)

    def assert_local_cancel(self):
        """Authenticate a stop request without waiting for the held network lock."""
        with self._registry._lock:
            lease = self._registry._lease(self._authorization, self._lease_id)
            if lease['grant'] != self._grant or lease['path'] != self._path: raise AuthorityError('lease-expired')

    def health_hint(self, host):
        """Non-authoritative loss signal; never use to admit reads or writes."""
        if host is not self._verifier: return False
        self.assert_local_cancel()
        return not self._invalid.is_set() and host.health_current(self._principal)

    def live_evidence(self):
        self.assert_current()
        return deepcopy(self._evidence)

    def descriptor(self):
        self.assert_current()
        return deepcopy(self._descriptor)

    def display_title(self):
        actual = self._verify_descriptor()
        self.assert_current()
        return cast(dict, actual)['title']

    def verify_fresh(self):
        actual = self._verify_descriptor()
        self.assert_current()
        return actual

    def assert_admitted(self):
        from sidecar.canonical_host import _provider_proof
        self.verify_fresh()
        descriptor = self.descriptor()
        if descriptor is None: raise AuthorityError('provider-admission-required')
        with self.transaction('provider-read') as db:
            proof = _provider_proof(db, self, descriptor['scope'])
        return deepcopy(proof['scope'])

    def confirm_committed(self, callback):
        try:
            return callback()
        except Exception as exc:
            raise ProviderCommitUnknown('provider-commit-unknown') from exc

    @contextmanager
    def provider_guard(self, host):
        if host is not self._verifier: raise AuthorityError('provider-host-invalid')
        with self.io_scope(host), host.operation_guard(self._principal):
            self.assert_current()
            yield
            self.assert_current()

    @contextmanager
    def io_scope(self, host):
        if host is not self._verifier: raise AuthorityError('provider-host-invalid')
        current = host._request_group()
        if current is not None:
            current.check(); yield; current.check(); return
        group = host.new_request_group()
        with self._group_lock:
            if self._invalid.is_set(): group.cancel(); group.close(); raise AuthorityError('provider-operation-invalid')
            self._groups.add(group)
        try:
            with host.io_scope(group): yield
        finally:
            with self._group_lock: self._groups.discard(group)
            group.close()

    @contextmanager
    def transaction(self, operation):
        if operation not in {'provider-read', 'provider-write', 'provider-prepare', 'provider-activate', 'provider-ack', 'provider-upgrade'}:
            raise AuthorityError('operation-denied')
        # Provider guard is outermost: it fences credential replacement through
        # SQLite commit. A guard exit error after commit is an unknown outcome.
        committed = False
        try:
            with self._verifier.guard(self._principal):
                with self._registry._lock:
                    self._check_locked()
                    self._inside.transaction = True
                    try:
                        with _existing(self._path, operation != 'provider-read') as db:
                            def check():
                                self._check_locked()
                                if _current_grant(db) != self._grant or _schema_state(db) != 'ready': raise AuthorityError('lease-expired')
                            check(); yield db; check()
                        committed = operation != 'provider-read'
                        self._check_locked()
                    finally:
                        self._inside.transaction = False
        except Exception as exc:
            if committed: raise ProviderCommitUnknown('provider-commit-unknown') from exc
            raise
