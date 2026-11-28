"""Host-owned opaque provider operations; renderer never supplies proof objects."""
from copy import deepcopy
from contextlib import contextmanager
import secrets
import threading

from papeer.core.edits.provider_descriptor_bytes import read_provider_descriptor_bytes
from sidecar.canonical_host import AuthorityError
from sidecar.provider.owner import ProviderOperationOwner


class ProviderOperations:
    def __init__(self, registry, verifier):
        # The only production construction path is create_provider_operations.
        self._registry, self._verifier = registry, verifier
        self._lock = threading.RLock()
        self._operations = {}
        self._closed = False
        self._pending_groups = set()

    @contextmanager
    def _capture_scope(self):
        group = self._verifier.new_request_group()
        with self._lock:
            if self._closed: group.cancel(); group.close(); raise AuthorityError('provider-unavailable')
            self._pending_groups.add(group)
        try:
            with self._verifier.io_scope(group): yield
        finally:
            with self._lock: self._pending_groups.discard(group)
            group.close()

    def capture_owner(self, authorization, lease):
        with self._capture_scope():
            principal = self._verifier.current()
            self._verifier.assert_current(principal)
            owner = ProviderOperationOwner(self._registry, authorization, lease, self._verifier, principal, None, None)
            return self._retain(owner, authorization, lease, principal, None, None)

    def capture_descriptor(self, authorization, lease, selection):
        with self._capture_scope():
            return self._capture_descriptor(authorization, lease, selection)

    def _capture_descriptor(self, authorization, lease, selection):
        principal = self._verifier.current()
        if hasattr(self._verifier, 'capture_descriptor'):
            first, raw = self._verifier.capture_descriptor(principal, selection)
            raw = bytes(raw)
        else:
            first = self._verifier.descriptor(principal, selection)
            raw = bytes(self._verifier.descriptor_bytes(principal, first['id']))
            last = self._verifier.descriptor(principal, selection)
            if first != last: raise AuthorityError('provider-descriptor-changed')
        if not first['owner'] or not first['writable']: raise AuthorityError('provider-descriptor-changed')
        descriptor = read_provider_descriptor_bytes(raw, first['sha256'], first['scope'])['descriptor']
        evidence = {'principalDigest': principal['digest'], 'descriptorId': first['id'], 'descriptorVersion': first['version'],
                    'descriptorSha256': first['sha256'], 'owner': True, 'readable': True, 'writable': True, 'folderId': first['folderId']}
        self._verifier.assert_current(principal)
        owner = ProviderOperationOwner(self._registry, authorization, lease, self._verifier, principal, evidence, descriptor)
        return self._retain(owner, authorization, lease, principal, selection, first)

    def inspect_captured(self, token, authorization, lease):
        with self._lock:
            if self._closed: raise AuthorityError('provider-unavailable')
            row = self._operations.get(token)
        if row is None or row[1] != authorization or row[2] != lease: raise AuthorityError('provider-operation-invalid')
        row[0].assert_current()
        return row[0], deepcopy(row[5])

    def _retain(self, owner, authorization, lease, principal, selection, summary):
        token = secrets.token_urlsafe(32)
        with self._lock:
            if self._closed: raise AuthorityError('provider-unavailable')
            self._operations[token] = (owner, authorization, lease, deepcopy(principal), selection, deepcopy(summary))
        return token

    def resolve(self, token, authorization, lease):
        with self._lock:
            if self._closed: raise AuthorityError('provider-unavailable')
            row = self._operations.get(token)
        if row is None or row[1] != authorization or row[2] != lease: raise AuthorityError('provider-operation-invalid')
        try:
            with row[0].io_scope(self._verifier):
                actual = row[0].verify_fresh()
                if row[4] is not None and actual != row[5]:
                    raise AuthorityError('provider-descriptor-changed')
            row[0].assert_current()
        except Exception as error:
            from papeer.core.providers.drive.request_group import ProviderRequestCancelled
            from papeer.core.providers.drive.transport import DriveProviderHttpError
            if not isinstance(error, ProviderRequestCancelled) and not (isinstance(error, DriveProviderHttpError) and (error.status == 429 or 500 <= error.status <= 599)): self.revoke(token)
            raise
        return row[0]

    def resolve_cancel(self, token, authorization, lease):
        with self._lock:
            if self._closed: raise AuthorityError('provider-unavailable')
            row = self._operations.get(token)
        if row is None or row[1] != authorization or row[2] != lease: raise AuthorityError('provider-operation-invalid')
        row[0].assert_local_cancel()
        return row[0]

    def consume(self, token, authorization, lease, expected_owner):
        # Single winner; invalidate the original capability before re-admission.
        with self._lock:
            row = self._operations.get(token)
            if self._closed or row is None or row[0] is not expected_owner or row[1] != authorization or row[2] != lease:
                raise AuthorityError('provider-operation-invalid')
            del self._operations[token]
        return row[0]

    def revoke_lease(self, authorization, lease):
        with self._lock:
            keys = [key for key, row in self._operations.items() if row[1] == authorization and row[2] == lease]
            rows = [self._operations.pop(key) for key in keys]
        for row in rows: row[0].invalidate()

    def revoke(self, token):
        with self._lock:
            row = self._operations.pop(token, None)
        if row is not None:
            row[0].invalidate()

    def close(self):
        with self._lock:
            self._closed = True
            rows, self._operations = tuple(self._operations.values()), {}
            groups = tuple(self._pending_groups)
        for group in groups:
            group.cancel()
        for row in rows:
            row[0].invalidate()


def create_provider_operations(registry):
    from papeer.core.providers.drive.verifier import create_google_drive_provider_host
    return ProviderOperations(registry, create_google_drive_provider_host())
