"""Configured Native Google verifier. No renderer-selected principal, client, token or permission callback.

All methods are synchronous. guard(principal) may enclose a SQLite transaction through COMMIT;
an exception after COMMIT is unknown delivery and must retain/query the original intent.
"""
from contextlib import contextmanager
import copy
import hashlib
import json
import re
import threading

from papeer.core import cloud_drive_auth
from papeer.core.edit_model import canonical_json
from papeer.core.edit_contracts import EDIT_LIMITS
from papeer.core.edits.provider_descriptor_bytes import read_provider_descriptor_bytes
from papeer.core.providers.drive.principal import google_drive_principal_digest
from papeer.core.providers.drive.request_group import ProviderRequestGroup
from papeer.core.providers.drive.transport import GoogleDriveProviderTransport, DriveProviderHttpError, _id

FIELDS = 'id,name,mimeType,version,size,sha256Checksum,ownedByMe,trashed,capabilities(canEdit,canDownload),properties,parents,driveId'
_UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def _validated_metadata(value, file_id, downloadable=True):
    capabilities = value.get('capabilities') if isinstance(value, dict) else None
    if (not isinstance(value, dict) or not isinstance(capabilities, dict) or value.get('id') != file_id or not isinstance(value.get('version'), str)
            or not re.fullmatch(r'[1-9][0-9]{0,39}', value['version']) or value.get('trashed') is not False
            or value.get('ownedByMe') is not True or 'driveId' in value or capabilities.get('canEdit') is not True
            or (downloadable and capabilities.get('canDownload') is not True)):
        raise ValueError('drive-owner-write-required')
    return copy.deepcopy(value)

class GoogleDriveProviderHost:
    def __init__(self):
        self._lock = threading.RLock()
        self._io_local = threading.local()
        self._io_groups_lock = threading.Lock(); self._io_groups = set()
        self._generation = 0
        self._transport: GoogleDriveProviderTransport | None = None
        self._principal = None
        self._blocked = True
        self._expecting_auth = False
        self._attempt_state_lock = threading.Lock()
        self._auth_attempt = None
        self._connect_io_group = None
        self._connecting = False
        self._connect_ticket = None
        self._cancel_connect_requested = False
        self._listeners = set()
        self._selected = {}
        self._unsubscribe = cloud_drive_auth.subscribe_invalidation(self._invalidate)

    def health_current(self, principal):
        """Nonblocking negative health hint, never used to issue a capability."""
        transport, current, blocked = self._transport, self._principal, self._blocked
        return (not blocked and current is not None and principal == current and transport is not None
                and cloud_drive_auth.transfer_current_hint(transport.generation))

    def new_request_group(self):
        return ProviderRequestGroup()  # Fixed 120s pass budget, never renderer-configurable.

    def _request_group(self):
        return getattr(self._io_local, 'group', None)

    def _check_io(self):
        group = self._request_group()
        if group is not None: group.check()

    @contextmanager
    def io_scope(self, group):
        previous = self._request_group()
        if previous is not None and previous is not group: raise ValueError('provider-io-group-changed')
        group.check(); self._io_local.group = group
        if previous is None:
            with self._io_groups_lock: self._io_groups.add(group)
        try:
            yield
            group.check()
        finally:
            self._io_local.group = previous
            if previous is None:
                with self._io_groups_lock: self._io_groups.discard(group)

    def _receiver(self):
        with self._lock:
            transport = self._transport
            expected = getattr(self._io_local, 'principal', None)
            if transport is None: raise ValueError('drive-provider-not-connected')
            if expected is not None and expected != self._principal: raise ValueError('drive-provider-auth-changed')
            return transport

    def _invalidate(self):
        # Cancellation never waits for the commit/host lock or a blocked DNS call.
        with self._io_groups_lock: groups = tuple(self._io_groups)
        for group in groups: group.cancel()
        with self._lock:
            self._generation += 1
            self._blocked = True
            self._principal = None
            self._selected.clear()
            for listener in tuple(self._listeners):
                try:
                    listener()
                except Exception:  # noqa: BLE001, S110 - do not suppress other owner operation invalidations.
                    pass

    def subscribe_invalidation(self, listener):
        with self._lock:
            self._listeners.add(listener)
        def unsubscribe():
            with self._lock:
                self._listeners.discard(listener)
        return unsubscribe

    def _capture_auth_attempt(self, ticket, handle):
        # Called under auth's creation lock. Never acquire the host-wide lock here.
        with self._attempt_state_lock:
            if self._connect_ticket is not ticket or self._cancel_connect_requested: return False
            self._auth_attempt = handle
            return True

    def connect(self):
        ticket = object()
        with self._lock:
            with self._attempt_state_lock:
                if self._connecting: raise ValueError('drive-connect-in-progress')
                self._connecting = True; self._connect_ticket = ticket
                self._cancel_connect_requested = False; self._auth_attempt = None
            self._expecting_auth = False
            self._invalidate()
        try:
            result, handle = cloud_drive_auth.connect_with_attempt(lambda captured: self._capture_auth_attempt(ticket, captured))
            with self._lock:
                with self._attempt_state_lock:
                    current = self._connect_ticket is ticket
                    cancelled = not current or self._cancel_connect_requested or self._auth_attempt is not handle
                if current: self._expecting_auth = not cancelled
            if cancelled: cloud_drive_auth.cancel_attempt(handle)
            return result
        finally:
            with self._attempt_state_lock:
                if self._connect_ticket is ticket: self._connecting = False

    def cancel_connect(self):
        # Lock order: read/retire under attempt-state lock, RELEASE it before
        # acquiring either the host or auth lock (auth capture uses auth->state).
        with self._attempt_state_lock:
            self._cancel_connect_requested = True
            self._connect_ticket = None; self._connecting = False
            handle, self._auth_attempt = self._auth_attempt, None
            group = self._connect_io_group
            self._expecting_auth = False
        if group is not None: group.cancel()
        return cloud_drive_auth.cancel_attempt(handle) if handle is not None else False

    def _assert_transport_state(self, generation):
        self._check_io()
        with self._lock:
            transport = self._transport
            if self._blocked or transport is None or generation != self._generation:
                raise ValueError('drive-provider-auth-changed')
            with cloud_drive_auth.transfer_guard(transport.generation): pass

    @contextmanager
    def _transport_guard(self, generation):
        # Network has optimistic generation fences, NEVER the commit lock span.
        self._assert_transport_state(generation)
        yield
        self._assert_transport_state(generation)

    def _activate_and_verify(self, setup_locked, confirm_locked):
        with self._lock:
            generation, transport, group = setup_locked()
        try:
            with self.io_scope(group): value = transport.about()
            digest = google_drive_principal_digest(value.get('user', {}).get('permissionId'))
            transport.assert_current()
            with self._lock:
                with self._attempt_state_lock:
                    confirm_locked()
                    if generation != self._generation or transport is not self._transport: raise ValueError('drive-provider-auth-changed')
                    self._principal = {'digest': digest, 'generation': generation}; self._expecting_auth = False
                    return dict(self._principal)
        except Exception:
            # An old finishing request cannot invalidate a newer connect lifetime.
            with self._lock:
                if generation == self._generation and transport is self._transport: self._invalidate()
            raise
        finally:
            with self._attempt_state_lock:
                if self._connect_io_group is group: self._connect_io_group = None
            group.close()

    def _begin_verified_transport(self):
        self._blocked = False; generation = self._generation
        transport = GoogleDriveProviderTransport(lambda: self._assert_transport(generation),
            lambda: self._transport_guard(generation), self._invalidate, self._request_group)
        self._transport = transport
        group = self.new_request_group()
        with self._attempt_state_lock: self._connect_io_group = group
        return generation, transport, group

    def finish_connect(self):
        handle = None
        def setup():
            nonlocal handle
            status = cloud_drive_auth.status()
            if not self._expecting_auth or status.get('connecting') or not status.get('connected') or status.get('auth_error'):
                raise ValueError('drive-connect-incomplete')
            with self._attempt_state_lock: handle = self._auth_attempt
            if not cloud_drive_auth.authorization_completed(handle): raise ValueError('drive-connect-not-completed')
            return self._begin_verified_transport()
        def confirm():
            if handle is not self._auth_attempt or self._cancel_connect_requested: raise ValueError('drive-connect-cancelled')
        return self._activate_and_verify(setup, confirm)

    def reconnect_saved(self):
        def setup():
            with self._attempt_state_lock:
                if self._connecting: raise ValueError('drive-connect-in-progress')
            status = cloud_drive_auth.status()
            if status.get('connecting') or not status.get('connected'):
                raise ValueError('drive-saved-credentials-missing')
            self._invalidate()
            with self._attempt_state_lock:
                if self._connecting: raise ValueError('drive-connect-in-progress')
                self._cancel_connect_requested = False
                self._expecting_auth = False
                self._auth_attempt = None
            return self._begin_verified_transport()
        def confirm():
            if self._cancel_connect_requested: raise ValueError('drive-connect-cancelled')
        return self._activate_and_verify(setup, confirm)

    def _assert_transport(self, generation):
        with self._transport_guard(generation):
            pass

    @contextmanager
    def guard(self, expected):
        # Short authoritative commit guard: retain this exact lock order and
        # credential generation THROUGH SQLite COMMIT, never through network.
        self._check_io()
        with self._lock:
            if (not isinstance(expected, dict) or set(expected) != {'digest', 'generation'} or type(expected.get('generation')) is not int
                    or not isinstance(expected.get('digest'), str) or not re.fullmatch(r'[0-9a-f]{64}', expected['digest'])):
                raise ValueError('drive-provider-auth-changed')
            expected = dict(expected); transport = self._transport
            if self._principal is None or expected != self._principal or transport is None: raise ValueError('drive-provider-auth-changed')
            with cloud_drive_auth.transfer_guard(transport.generation):
                yield
                self._check_io()
                if expected != self._principal or transport is not self._transport: raise ValueError('drive-provider-auth-changed')

    @contextmanager
    def operation_guard(self, expected):
        self.assert_current(expected)
        previous = getattr(self._io_local, 'principal', None)
        if previous is not None and previous != expected: raise ValueError('drive-provider-auth-changed')
        self._io_local.principal = dict(expected)
        try:
            yield
            self.assert_current(expected)
        finally: self._io_local.principal = previous

    def assert_current(self, expected):
        with self.guard(expected):
            pass

    def current(self):
        with self._lock:
            if self._principal is None: raise ValueError('drive-provider-not-connected')
            expected = dict(self._principal)
        with self.operation_guard(expected):
            value = self._receiver().about()
            try: digest = google_drive_principal_digest(value.get('user', {}).get('permissionId'))
            except (ValueError, TypeError, AttributeError):
                self.assert_current(expected); self._invalidate(); raise ValueError('drive-principal-invalid') from None
            if digest != expected['digest']:
                self.assert_current(expected); self._invalidate(); raise ValueError('drive-principal-changed')
            return expected

    def _metadata(self, file_id, downloadable=True):
        value = self._receiver().metadata(_id(file_id), FIELDS)
        return _validated_metadata(value, file_id, downloadable)

    def _descriptor(self, file_id, expected=None):
        if expected is None:
            expected = self.current()
        with self.operation_guard(expected):
            before = self._metadata(file_id)
            name, size, props, parents = before.get('name'), before.get('size'), before.get('properties', {}), before.get('parents')
            if (before.get('mimeType') != 'application/json' or props.get('papeer') != 'canonical-provider-v1'
                    or props.get('providerKind') != 'descriptor' or not isinstance(name, str) or not name or name != name.strip() or len(name) > EDIT_LIMITS['title']
                    or not isinstance(size, str) or not re.fullmatch(r'[0-9]+', size) or not 1 <= int(size) <= EDIT_LIMITS['providerDescriptorBytes']
                    or not isinstance(parents, list) or len(parents) != 1):
                raise ValueError('drive-descriptor-metadata')
            folder_id = _id(parents[0])
            folder = self._metadata(folder_id, False)
            if folder.get('mimeType') != 'application/vnd.google-apps.folder':
                raise ValueError('drive-descriptor-folder')
            raw = self._receiver().bytes(file_id, EDIT_LIMITS['providerDescriptorBytes'])
            after, folder_after = self._metadata(file_id), self._metadata(folder_id, False)
            digest = hashlib.sha256(raw).hexdigest()
            if before != after or folder != folder_after or len(raw) != int(size):
                raise ValueError('drive-descriptor-version-changed')
            if 'sha256Checksum' in before and before['sha256Checksum'] != digest:
                raise ValueError('drive-descriptor-checksum')
            try:
                value = json.loads(raw.decode('utf8', errors='strict'))
                scope = value['scope']
            except (ValueError, UnicodeError, TypeError, KeyError):
                raise ValueError('drive-descriptor-json') from None
            validated = read_provider_descriptor_bytes(raw, digest, scope)
            summary = {'id': file_id, 'version': before['version'], 'sha256': digest, 'scope': validated['descriptor']['scope'],
                       'owner': True, 'writable': True, 'folderId': folder_id, 'title': name}
            return {'metadata': before, 'descriptor': summary, 'bytes': bytes(raw)}

    def descriptor(self, expected, selection):
        with self.operation_guard(expected):
            result = self._descriptor(_id(selection), expected)
            with self._lock:
                self._selected[selection] = result
            return copy.deepcopy(result['descriptor'])

    def descriptor_bytes(self, expected, file_id):
        with self.operation_guard(expected):
            with self._lock:
                previous = self._selected.get(file_id)
            if previous is None:
                raise ValueError('drive-descriptor-not-selected')
            fresh = self._descriptor(file_id, expected)
            if fresh['descriptor'] != previous['descriptor']:
                raise ValueError('drive-descriptor-version-changed')
            return bytes(fresh['bytes'])

    def capture_descriptor(self, expected, selection):
        with self.operation_guard(expected):
            result = self._descriptor(_id(selection), expected)
            with self._lock:
                self._selected[selection] = result
            return copy.deepcopy(result['descriptor']), bytes(result['bytes'])

    def list(self):
        expected = self.current()
        with self.operation_guard(expected):
            result = self._receiver().list_files("trashed = false and 'me' in owners and properties has { key='papeer' and value='canonical-provider-v1' }", 'id,name')
            if any(not isinstance(item.get('name'), str) or len(item['name']) > 2000 for item in result):
                raise ValueError('drive-list-entry')
            return [{'id': _id(item['id']), 'title': item['name']} for item in result]

    def allocate_file_ids(self, count):
        expected = self.current()
        with self.operation_guard(expected):
            return self._receiver().allocate_file_ids(count)

    def _folder(self, folder_id):
        value = self._metadata(folder_id, False)
        if value.get('mimeType') != 'application/vnd.google-apps.folder':
            raise ValueError('drive-folder-required')
        return value

    def create_folder(self, provider_id, logical_id, title, parent_id=None):
        expected = self.current()
        with self.operation_guard(expected):
            _id(provider_id)
            if not _UUID.fullmatch(logical_id) or not isinstance(title, str) or not title.strip() or title != title.strip() or len(title) > EDIT_LIMITS['title']:
                raise ValueError('drive-folder-title')
            if parent_id is not None:
                self._folder(_id(parent_id))
            properties = {'papeer': 'canonical-provider-folder-v1', 'objectId': logical_id}
            metadata = {'id': provider_id, 'name': title, 'mimeType': 'application/vnd.google-apps.folder', 'properties': properties}
            if parent_id is not None:
                metadata['parents'] = [parent_id]
            try:
                result = self._receiver().create_metadata(metadata)
                if result.get('id') != provider_id:
                    raise ValueError('drive-folder-id')
            except DriveProviderHttpError as error:
                if error.status != 409:
                    raise
            actual = self._folder(provider_id)
            if actual.get('name') != title or actual.get('properties') != properties or (parent_id is not None and parent_id not in actual.get('parents', [])):
                raise ValueError('drive-folder-metadata')
            return {'id': provider_id, 'version': actual['version']}

    def _write(self, provider_id, logical_id, folder_id, name, namespace, properties, raw):
        expected = self.current()
        with self.operation_guard(expected):
            _id(provider_id)
            if not _UUID.fullmatch(logical_id) or not re.fullmatch(r'[0-9a-f]{64}', namespace):
                raise ValueError('drive-immutable-identity')
            self._folder(folder_id)
            props = {**properties, 'scope': namespace, 'objectId': logical_id}
            metadata = {'id': provider_id, 'name': name, 'mimeType': 'application/json', 'parents': [folder_id], 'properties': props}
            try:
                result = self._receiver().create_json(metadata, raw)
                if result.get('id') != provider_id:
                    raise ValueError('drive-upload-id')
            except DriveProviderHttpError as error:
                if error.status != 409:
                    raise
            digest = hashlib.sha256(raw).hexdigest()
            def matches_immutable(item):
                size = item.get('size')
                checksum = item.get('sha256Checksum')
                return (
                    item.get('mimeType') == 'application/json'
                    and item.get('name') == name
                    and item.get('properties') == props
                    and folder_id in item.get('parents', [])
                    and (size is None or size == str(len(raw)))
                    and (checksum is None or checksum == digest)
                )
            before = self._metadata(provider_id)
            if not matches_immutable(before):
                raise ValueError('drive-immutable-metadata')
            downloaded = self._receiver().bytes(provider_id, max(1, len(raw)))
            after = self._metadata(provider_id)
            # Google Drive may increment `version` and populate `sha256Checksum` asynchronously right after upload.
            if not matches_immutable(after) or after.get('parents') != before.get('parents') or downloaded != raw:
                raise ValueError('drive-immutable-changed')
            return {'id': provider_id, 'version': after['version'], 'sha256': digest}

    def write_descriptor(self, provider_id, logical_id, folder_id, title, raw, namespace):
        if not isinstance(title, str) or not title or title != title.strip() or len(title) > EDIT_LIMITS['title'] or not 1 <= len(raw) <= EDIT_LIMITS['providerDescriptorBytes']:
            raise ValueError('drive-descriptor-title-or-size')
        try:
            value = json.loads(raw.decode('utf8', errors='strict'))
            read_provider_descriptor_bytes(raw, hashlib.sha256(raw).hexdigest(), value['scope'])
        except (ValueError, UnicodeError, TypeError, KeyError):
            raise ValueError('drive-descriptor-json') from None
        return self._write(provider_id, logical_id, folder_id, title, namespace, {'papeer': 'canonical-provider-v1', 'providerKind': 'descriptor'}, bytes(raw))

    def write_immutable_json(self, provider_id, namespace, folder_id, logical_id, kind, value):
        if kind not in ('dataset-manifest', 'repository-checkpoint'):
            raise ValueError('drive-immutable-kind')
        raw = canonical_json(value).encode('utf8')
        if len(raw) > 16 * 1024 * 1024:
            raise ValueError('drive-immutable-size')
        return self._write(provider_id, logical_id, folder_id, logical_id + '.json', namespace, {'papeer': 'edits-v1', 'editKind': kind}, raw)

    def disconnect_and_wait(self):
        self._invalidate()
        cloud_drive_auth.disconnect()  # Existing transfer guard drains bounded HTTP/body before credentials change.

    def release_and_wait(self):
        # Retire the active host session while keeping DPAPI credentials for the next launch.
        self._invalidate()

    def close(self):
        self.cancel_connect()
        self._invalidate()
        self._unsubscribe()


    def dataset_storage(self, owner):
        from papeer.core.providers.drive.data_plane import _ProviderDriveStorage
        return _ProviderDriveStorage(self, owner, False)

    def edit_storage(self, owner):
        from papeer.core.providers.drive.data_plane import _ProviderDriveStorage
        return _ProviderDriveStorage(self, owner, True)


def create_google_drive_provider_host():
    return GoogleDriveProviderHost()
