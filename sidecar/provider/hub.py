"""Stable host-owned entry. Constructing and preloading do not provision data."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from papeer.core.bootstrap.canonical_local_grant_sqlite import discover_local_grant
import secrets
import threading
import re
import time
from sidecar.canonical_host import AuthorityError, _bearer, _require_clear
from sidecar.provider.create_service import ProviderCreateService
from sidecar.provider.operations import ProviderOperations
from sidecar.provider.join_service import ProviderJoinService
from sidecar.provider.replication import ProviderReplicationOwner


class NativeProviderHub:
    def __init__(self, authority, host):
        self._authority, self._host = authority, host
        self._operations = ProviderOperations(authority, host)
        self._create = ProviderCreateService(self._operations, host)
        self._join = ProviderJoinService(self._operations, host, self._create)
        self._lock = threading.RLock()
        self._selections = {}
        self._replications = {}
        self._closed = False
        self._closing_replications = ()
        self._shutdown_failed = False
        self._disconnecting = False
        self._auth_attempt = None
        self._resume_epoch = 0
        self._resume_attempts = {}

    def _assert_open(self):
        if self._closed or self._disconnecting: raise AuthorityError('provider-unavailable')

    def preload(self):
        self._assert_open()
        from papeer.core.cloud_drive_auth import desktop_oauth
        return {'configured': bool(desktop_oauth().configured)}

    def connect(self, authorization, attempt_id):
        with self._lock:
            self._assert_open()
            bearer = _bearer(authorization); _require_clear()
            if not isinstance(attempt_id, str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', attempt_id):
                raise AuthorityError('provider-attempt-invalid')
            if self._auth_attempt is not None: raise AuthorityError('provider-attempt-active')
            self._resume_epoch += 1
            self._auth_attempt = (attempt_id, bearer)
        # Do not hold the hub lock while launching a browser: exact-attempt
        # cancellation must remain able to run even if launch blocks.
        try:
            if not self._cancel_outstanding_resumes():
                raise AuthorityError('provider-resume-cleanup-incomplete')
            result = self._host.connect()
        except Exception:
            with self._lock:
                if self._auth_attempt == (attempt_id, bearer): self._auth_attempt = None
            raise
        with self._lock:
            if self._auth_attempt != (attempt_id, bearer): raise AuthorityError('provider-attempt-invalid')
        return result

    def _check_attempt(self, authorization, attempt_id):
        self._assert_open()
        if self._auth_attempt != (attempt_id, _bearer(authorization)): raise AuthorityError('provider-attempt-invalid')

    def status(self, authorization, attempt_id):
        with self._lock:
            self._check_attempt(authorization, attempt_id)
            from papeer.core.cloud_drive_auth import status
            return status()

    def cancel_connect(self, authorization, attempt_id):
        with self._lock:
            self._check_attempt(authorization, attempt_id)
            cancelled = self._host.cancel_connect()
            self._auth_attempt = None
            return {'cancelled': cancelled}

    def _provision_connected_owner(self, authorization, verify_fn, *, clear_attempt=False):
        with self._lock:
            verify_fn()
            from sidecar import deps
            state = discover_local_grant(deps.get_canonical_storage_path())
            if state['status'] == 'ready':
                try:
                    lease = self._authority.issue(authorization)
                except AuthorityError as error:
                    if str(error) != 'setup-required': raise
                    lease = self._authority.provision(authorization)
            elif state['status'] == 'setup-required' and state.get('reason') in {'absent', 'schema-upgrade'}:
                lease = self._authority.provision(authorization)
            else:
                raise AuthorityError('provider-owner-unavailable')
            operations = self._operations
        operation = operations.capture_owner(authorization, lease)
        try:
            owner = operations.resolve(operation, authorization, lease)
            from papeer.core.edits.provider.activation import upgrade_provider_metadata
            with self._lock:
                verify_fn()
                if operations is not self._operations: raise AuthorityError('provider-attempt-invalid')
                with owner.transaction('provider-upgrade') as db:
                    upgrade_provider_metadata(db)
                if clear_attempt: self._auth_attempt = None
                return {'leaseId': lease, 'operationId': operation}
        except Exception:
            operations.revoke(operation)
            with suppress(Exception):
                self._authority.release(authorization, lease)
            raise

    def finish_connect(self, authorization, attempt_id):
        with self._lock:
            self._check_attempt(authorization, attempt_id)
        _require_clear()
        # The network phase must not hold the attempt lock: cancellation and
        # shutdown can retire this exact attempt and interrupt its owned I/O.
        self._host.finish_connect()
        return self._provision_connected_owner(authorization, lambda: self._check_attempt(authorization, attempt_id), clear_attempt=True)

    def reconnect_saved(self, authorization):
        with self._lock:
            self._assert_open()
            _bearer(authorization); _require_clear()
            if self._auth_attempt is not None: raise AuthorityError('provider-attempt-active')
            from papeer.core import cloud_drive_auth
            saved_status = cloud_drive_auth.status()
            if saved_status.get('connecting') or not saved_status.get('connected'):
                return None
            self._resume_epoch += 1
            epoch = self._resume_epoch
        if not self._cancel_outstanding_resumes():
            raise AuthorityError('provider-resume-cleanup-incomplete')
        self._host.reconnect_saved()
        def verify():
            self._assert_open()
            if self._auth_attempt is not None or self._resume_epoch != epoch: raise AuthorityError('provider-attempt-invalid')
        return self._provision_connected_owner(authorization, verify)

    def _cancel_outstanding_resumes(self):
        with self._lock: entries = tuple(self._resume_attempts.items())
        complete = True
        for key, row in entries:
            try: self._cancel_owned_resume(key, row)
            except Exception: complete = False  # noqa: BLE001 - retain failed cleanup for retry
        with self._lock:
            return complete and all(row['done'].is_set() and row['cleaned']
                                    for row in self._resume_attempts.values())

    def _resume_key(self, authorization, lease, operation, attempt_id):
        _bearer(authorization)
        if not isinstance(attempt_id, str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', attempt_id):
            raise AuthorityError('provider-attempt-invalid')
        return (authorization, lease, operation, attempt_id)

    def _purge_resume(self, retiring=None):
        now = time.monotonic()
        for key, row in list(self._resume_attempts.items()):
            if row['state'] == 'cancelled' and row['cleaned'] and row['done'].is_set() and row['deadline'] < now:
                del self._resume_attempts[key]
        if len(self._resume_attempts) >= 64:
            eligible = retiring is not None and any(
                row['state'] == 'adopted' and (row['lease'], row['token']) == retiring
                for row in self._resume_attempts.values())
            if not eligible or len(self._resume_attempts) >= 65:
                raise AuthorityError('provider-attempt-capacity')

    def _cancel_owned_resume(self, key, row):
        # Called only with an internally owned row; no bearer is needed to retire
        # an exact previously captured lease identity after bearer rotation.
        with self._lock:
            if self._resume_attempts.get(key) is not row: return
            row['state'] = 'cancelled'; row['cleaned'] = False; row['deadline'] = time.monotonic()+120
            if row['timer'] is not None: row['timer'].cancel(); row['timer'] = None
            operations, token = row['operations'], row['token']
            old_retire, new_retire = row['old_retire'], row['new_retire']
            owner, selected = row['owner'], row['selected']
        owner.invalidate(); operations.revoke_lease(key[0], key[1])
        for replication in selected: replication.suspend()
        old_retire()
        if token is not None: operations.revoke(token)
        if new_retire is not None: new_retire()
        with self._lock:
            if self._resume_attempts.get(key) is row:
                # If the worker is still creating a lease it will perform a
                # second cleanup in its finally block before marking done.
                row['cleaned'] = row['done'].is_set()

    def _expire_resume(self, key, expected):
        with self._lock:
            if self._resume_attempts.get(key) is not expected: return
        try: self._cancel_owned_resume(key, expected)
        except Exception: pass  # noqa: BLE001, S110 - retain row; no unproven cleanup claim

    def cancel_resume(self, authorization, lease, operation, attempt_id):
        key = self._resume_key(authorization, lease, operation, attempt_id)
        with self._lock:
            row = self._resume_attempts.get(key)
            if row is None:
                self._assert_open(); self._purge_resume()
                owner = self._operations.resolve_cancel(operation, authorization, lease)
                old_retire = self._authority._lease_retirement(authorization, lease)
                self._operations.consume(operation, authorization, lease, owner)
                selected = [value[2] for value in self._replications.values() if value[0] == lease]
                self._replications = {k: value for k, value in self._replications.items() if value[0] != lease}
                self._selections = {k: value for k, value in self._selections.items() if value[0] != lease}
                done = threading.Event(); done.set()
                row = {'state':'cancelled', 'deadline':time.monotonic()+120, 'epoch':self._resume_epoch,
                       'operations':self._operations, 'lease':None, 'token':None, 'owner':owner,
                       'selected':selected, 'timer':None, 'old_retire':old_retire, 'new_retire':None,
                       'cleaned':False, 'done':done}
                self._resume_attempts[key] = row
        self._cancel_owned_resume(key, row)
        return {'cancelled': True, 'settled':row['done'].is_set() and row['cleaned']}

    def acknowledge_resume(self, authorization, lease, operation, attempt_id):
        key = self._resume_key(authorization, lease, operation, attempt_id)
        with self._lock:
            self._assert_open(); row = self._resume_attempts.get(key)
            if not row or row['state'] != 'ready' or row['epoch'] != self._resume_epoch or row['operations'] is not self._operations:
                raise AuthorityError('provider-attempt-invalid')
            operations, fresh_lease, fresh_token = row['operations'], row['lease'], row['token']
        operations.resolve(fresh_token, authorization, fresh_lease)
        with self._lock:
            self._assert_open()
            if self._resume_attempts.get(key) is not row or row['state'] != 'ready' or row['epoch'] != self._resume_epoch or operations is not self._operations:
                raise AuthorityError('provider-attempt-invalid')
            # Keep exact cleanup ownership until the adopted operation retires.
            row['state'] = 'adopted'
            if row['timer'] is not None: row['timer'].cancel(); row['timer'] = None
        return {'acknowledged': True}

    def resume_retained(self, authorization, lease, operation, request_id, attempt_id):
        key = self._resume_key(authorization, lease, operation, attempt_id)
        with self._lock:
            self._assert_open(); self._purge_resume((lease, operation))
            if self._auth_attempt is not None: raise AuthorityError('provider-attempt-active')
            if key in self._resume_attempts: raise AuthorityError('provider-attempt-invalid')
            operations = self._operations
            owner = operations.resolve_cancel(operation, authorization, lease)
            principal, namespace = dict(owner._principal), owner.namespace
            old_retire = self._authority._lease_retirement(authorization, lease)
            operations.consume(operation, authorization, lease, owner)
            selected = [value[2] for value in self._replications.values() if value[0] == lease]
            self._replications = {k: value for k, value in self._replications.items() if value[0] != lease}
            self._selections = {k: value for k, value in self._selections.items() if value[0] != lease}
            row = {'state':'running', 'deadline':time.monotonic()+120, 'epoch':self._resume_epoch,
                   'operations':operations, 'lease':None, 'token':None, 'owner':owner, 'selected':selected,
                   'timer':None, 'old_retire':old_retire, 'new_retire':None, 'cleaned':False, 'done':threading.Event()}
            self._resume_attempts[key] = row
        new_retire = None
        try:
            owner.invalidate(); operations.revoke_lease(authorization, lease)
            old_retire()
            for replication in selected: replication.suspend()
            for replication in selected:
                if not replication.wait_drained(5): raise AuthorityError('provider-drain-incomplete')
            # Only an exact retired, consumed and drained lease permits pruning.
            with self._lock:
                for previous_key, previous in list(self._resume_attempts.items()):
                    if (previous is not row and previous['state'] == 'adopted'
                            and previous['lease'] == lease and previous['token'] == operation
                            and previous['done'].is_set()):
                        del self._resume_attempts[previous_key]
            self._host.assert_current(principal)
            with self._lock:
                self._assert_open()
                if row['state'] != 'running' or row['epoch'] != self._resume_epoch or operations is not self._operations:
                    raise AuthorityError('provider-attempt-invalid')
                timer = threading.Timer(120, self._expire_resume, args=(key, row))
                timer.daemon = True; row['timer'] = timer; timer.start()
            new_lease, new_retire = self._authority._issue_with_retirement(authorization)
            with self._lock:
                row['lease'], row['new_retire'] = new_lease, new_retire
                if row['state'] != 'running': raise AuthorityError('provider-attempt-invalid')
            token = operations.capture_owner(authorization, new_lease)
            with self._lock:
                row['token'] = token
                if row['state'] != 'running': raise AuthorityError('provider-attempt-invalid')
            current = operations.resolve(token, authorization, new_lease)
            if current.namespace != namespace or current._principal != principal: raise AuthorityError('provider-principal-changed')
            installed = self._create.open_installed(token, authorization, new_lease, request_id)
            self._host.assert_current(principal)
            with self._lock:
                self._assert_open()
                if row['state'] != 'running' or row['epoch'] != self._resume_epoch or operations is not self._operations:
                    raise AuthorityError('provider-attempt-invalid')
                row['state'] = 'ready'
            return {'leaseId': new_lease, 'operationId': token, 'installed': installed}
        except Exception:
            with self._lock: row['state'] = 'cancelled'
            raise
        finally:
            row['done'].set()
            with self._lock: cancelled = row['state'] == 'cancelled'
            if cancelled:
                try: self._cancel_owned_resume(key, row)
                except Exception: pass  # noqa: BLE001, S110 - retain row until cleanup can be proven

    def discard_resumed(self, authorization, lease, operation):
        # Release only the exact stale result, never disconnect a later login.
        self._operations.resolve_cancel(operation, authorization, lease)
        with self._lock:
            match = next(((key, row) for key, row in self._resume_attempts.items()
                          if row['lease'] == lease and row['token'] == operation), None)
        if match is None: raise AuthorityError('provider-attempt-invalid')
        self._cancel_owned_resume(*match)

    def list(self, authorization, lease, operation):
        self._assert_open()
        owner = self._operations.resolve(operation, authorization, lease)
        with owner.provider_guard(self._host):
            entries = self._host.list()
        def inspect_entry(entry):
            token = None
            try:
                token = self._operations.capture_descriptor(authorization, lease, entry['id'])
                selected, summary = self._operations.inspect_captured(token, authorization, lease)
                if selected.principal_digest != owner.principal_digest: raise AuthorityError('provider-principal-changed')
                key = secrets.token_urlsafe(32)
                with self._lock:
                    self._selections[key] = (lease, operation, entry['id'], token, selected.principal_digest,
                                              selected.live_evidence(), selected.descriptor()['scope'])
                return {'handleId': key, 'title': summary['title'], 'status': 'available'}
            except (ValueError, AuthorityError):
                if token is not None: self._operations.revoke(token)
                owner.assert_current()
                # A denied file does not invalidate unrelated available choices.
                return {'handleId': secrets.token_urlsafe(32), 'title': entry['title'], 'status': 'unavailable'}
        if len(entries) <= 1:
            return [inspect_entry(entry) for entry in entries]
        with ThreadPoolExecutor(max_workers=min(4, len(entries))) as pool:
            return list(pool.map(inspect_entry, entries))

    def health(self, authorization, lease, operation):
        owner = self._operations.resolve_cancel(operation, authorization, lease)
        return {'active': owner.health_hint(self._host)}

    def resolve_selection(self, authorization, lease, operation, handle):
        self._assert_open()
        owner = self._operations.resolve(operation, authorization, lease)
        with self._lock: row = self._selections.get(handle)
        if not row or row[4] != owner.principal_digest: raise AuthorityError('provider-selection-invalid')
        if row[0] == lease and row[1] == operation:
            selected = self._operations.resolve(row[3], authorization, lease)
            if selected.principal_digest != owner.principal_digest: raise AuthorityError('provider-principal-changed')
            return row[2]
        # A reconnect may reselect only the original exact descriptor and same
        # authenticated principal, never a title-based match or a changed file.
        token = self._operations.capture_descriptor(authorization, lease, row[2])
        try:
            selected = self._operations.resolve(token, authorization, lease)
            if (selected.principal_digest != row[4] or selected.live_evidence() != row[5]
                    or selected.descriptor()['scope'] != row[6]): raise AuthorityError('provider-selection-changed')
            with self._lock:
                if self._selections.get(handle) is not row: raise AuthorityError('provider-selection-changed')
                self._selections[handle] = (lease, operation, row[2], token, row[4], row[5], row[6])
            self._operations.revoke(row[3])
            return row[2]
        except Exception:
            self._operations.revoke(token)
            raise

    def prepare_join(self, authorization, lease, operation, handle, request_id):
        descriptor = self.resolve_selection(authorization, lease, operation, handle)
        return self._join.prepare(operation, authorization, lease, descriptor, request_id)

    def execute(self, authorization, lease, operation, request_id):
        owner = self._operations.resolve(operation, authorization, lease)
        plan = self._create._plan(owner, request_id)
        if not plan: raise AuthorityError('provider-plan-missing')
        if plan['intent']['action'] == 'create':
            return self._create.execute(operation, authorization, lease, request_id)
        if plan['intent']['action'] == 'join':
            return self._join.execute(operation, authorization, lease, request_id)
        raise AuthorityError('provider-plan-invalid')

    def open_replication(self, authorization, lease, operation, admission):
        grant_owner = self._operations.resolve(operation, authorization, lease)
        replication = ProviderReplicationOwner(self._authority, authorization, lease, admission, self._host)
        if (replication._owner.namespace != grant_owner.namespace
                or replication._owner.principal_digest != grant_owner.principal_digest): raise AuthorityError('provider-principal-changed')
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._assert_open(); self._replications[token] = (lease, operation, replication)
        return {'replicationId': token}

    def replication(self, authorization, lease, operation, token):
        self._operations.resolve(operation, authorization, lease)
        with self._lock:
            self._assert_open(); row = self._replications.get(token)
        if not row or row[0] != lease or row[1] != operation: raise AuthorityError('provider-replication-invalid')
        return row[2]

    def replication_for_cancel(self, authorization, lease, operation, token):
        # Stop requests must not wait on the host lock held by the HTTP request
        # they are about to cancel. This path never admits reads or writes.
        self._operations.resolve_cancel(operation, authorization, lease)
        with self._lock:
            self._assert_open(); row = self._replications.get(token)
        if not row or row[0] != lease or row[1] != operation: raise AuthorityError('provider-replication-invalid')
        return row[2]

    def begin_shutdown(self):
        with self._lock:
            if self._closed: return
            self._closed = True
            self._resume_epoch += 1
            attempt, self._auth_attempt = self._auth_attempt, None
            selections, self._selections = self._selections, {}
            replications, self._replications = self._replications, {}
            self._closing_replications = tuple(row[2] for row in replications.values())
            # Retire owner tokens before any potentially blocking drain. A
            # transaction already past COMMIT remains an unknown outcome.
            self._operations.close()
        failures = []
        if not self._cancel_outstanding_resumes():
            failures.append(AuthorityError('provider-resume-cleanup-incomplete'))
        self._create.close()
        # Signal every scope before any potentially blocking cleanup.
        for replication in self._closing_replications:
            try: replication.suspend()
            except Exception as error: failures.append(error)  # noqa: BLE001 - preserve unknown outcome or complete cleanup
        if attempt is not None:
            try: self._host.cancel_connect()
            except Exception as error: failures.append(error)  # noqa: BLE001 - preserve unknown outcome or complete cleanup
        for row in selections.values(): self._operations.revoke(row[3])
        self._shutdown_failed = bool(failures)

    def finish_shutdown(self, timeout, *, close_host=True):
        deadline = time.monotonic() + max(0, timeout)
        for replication in self._closing_replications:
            if not replication.wait_drained(max(0, deadline - time.monotonic())): return False
        if self._shutdown_failed: return False
        if close_host: self._host.close()
        return True

    def close(self):
        self.begin_shutdown()
        if not self.finish_shutdown(5): raise AuthorityError('provider-close-incomplete')

    def disconnect(self, authorization, lease, operation, *, clear_credentials=True):
        with self._lock:
            self._assert_open()
            self._operations.resolve_cancel(operation, authorization, lease)
            self._disconnecting = True
            self._resume_epoch += 1
            replications, self._replications = self._replications, {}
            self._operations.close()
        completed = False
        try:
            cleanup_complete = self._cancel_outstanding_resumes()
            self._create.close()
            failures: list[Exception] = [] if cleanup_complete else [AuthorityError('provider-resume-cleanup-incomplete')]
            for row in replications.values():
                try: row[2].suspend()
                except Exception as error: failures.append(error)  # noqa: BLE001 - preserve unknown outcome or complete cleanup
            for row in replications.values():
                try: row[2].suspend_and_wait()
                except Exception as error: failures.append(error)  # noqa: BLE001 - preserve unknown outcome or complete cleanup
            if failures: raise AuthorityError('provider-disconnect-incomplete')
            if clear_credentials: self._host.disconnect_and_wait()
            else: self._host.release_and_wait()
            completed = True
        finally:
            with self._lock:
                if completed and not self._closed:
                    self._operations = ProviderOperations(self._authority, self._host)
                    self._create = ProviderCreateService(self._operations, self._host)
                    self._join = ProviderJoinService(self._operations, self._host, self._create)
                elif not completed:
                    self._closed = True
                    self._closing_replications = tuple(row[2] for row in replications.values())
                self._disconnecting = False

    def release(self, authorization, lease, operation):
        self.disconnect(authorization, lease, operation, clear_credentials=False)


def create_native_provider_hub():
    from papeer.core.providers.drive.verifier import create_google_drive_provider_host
    from sidecar.canonical_host import authority
    return NativeProviderHub(authority, create_google_drive_provider_host())
