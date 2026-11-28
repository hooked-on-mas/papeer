"""Private fixed-Google data plane; no import/adoption/outbox/replication writer.

DriveEditStorage namespace/framing and canonical model validators are reused.
A real ProviderOperationOwner supplies scope/admission; serialized input cannot.
"""
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import re
import threading

from papeer.core.edit_drive import DriveEditStorage, scope_namespace
from papeer.core.edit_model import canonical_json
from papeer.core.edit_contracts import validate_repositorycheckpoint
from papeer.core.edits.records import assert_edit_record
from papeer.core.edits.datasets import assert_dataset_manifest, assert_dataset_checkpoint, checkpoint_hash
from papeer.core.edits.resources import assert_resource_metadata
from papeer.core.providers.drive.transport import DriveProviderHttpError, _id
from papeer.core.providers.drive.verifier import FIELDS, _validated_metadata

MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_RESOURCE_BYTES = 128 * 1024 * 1024
MAX_PULL_BYTES = 128 * 1024 * 1024
MAX_ENVELOPE_CACHE_BYTES = 16 * 1024 * 1024
MAX_ENVELOPE_CACHE_ENTRIES = 1000
_UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def _json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value: raise ValueError('drive-duplicate-json-key')
            value[key] = item
        return value
    try:
        return json.loads(raw.decode('utf8', errors='strict'), object_pairs_hook=pairs,
                          parse_constant=lambda _value: (_ for _ in ()).throw(ValueError('drive-json-number')))
    except (ValueError, UnicodeError):
        raise ValueError('drive-envelope-json') from None


def _envelope(value, scope):
    if not isinstance(value, dict): raise ValueError('invalid-edit-envelope')
    kind = value.get('kind')
    keys = {'edit-record': {'kind', 'record'}, 'import-receipt': {'kind', 'batchId', 'peerId'},
            'dataset-manifest': {'kind', 'manifest'}, 'repository-checkpoint': {'kind', 'checkpoint'},
            'resource': {'kind', 'metadata', 'blobId'}}
    if kind not in keys or set(value) != keys[kind]: raise ValueError('invalid-edit-envelope')
    if kind == 'edit-record':
        assert_edit_record(value['record'])
        if value['record']['batch']['libraryId'] != scope['libraryId']: raise ValueError('batch-scope')
    elif kind == 'import-receipt':
        if any(not isinstance(value[key], str) or not _UUID.fullmatch(value[key]) for key in ['batchId', 'peerId']):
            raise ValueError('invalid-import-receipt')
    elif kind == 'dataset-manifest': assert_dataset_manifest(value['manifest'], scope)
    elif kind == 'repository-checkpoint':
        validate_repositorycheckpoint(value['checkpoint'])
        if value['checkpoint']['libraryId'] != scope['libraryId']: raise ValueError('batch-scope')
    else:
        assert_resource_metadata(value['metadata']); _id(value['blobId'])
    return value


class _ProviderDriveStorage(DriveEditStorage):
    """Constructed only by the fixed host. Inherits the existing namespace query.

    Normal writable pulls replay until durable acknowledgement; dataset pulls remain complete.
    Fresh admission and metadata checks remain authoritative.
    """
    def __init__(self, host, owner, writable):
        from sidecar.provider.owner import ProviderOperationOwner
        if type(owner) is not ProviderOperationOwner: raise ValueError('provider-owner-required')
        self._host, self._owner, self._writable = host, owner, writable
        self._io_lock = threading.Lock(); self._io_group = None; self._active_groups = set(); self._io_cancelled = False
        self._seen, self._uploads, self._references = {}, {}, {}
        self._envelope_cache = {}
        self._applied = {}
        self._delivery = None
        self._delivery_generation = 0
        with self.pass_scope(), owner.provider_guard(host):
            if not writable: owner.verify_fresh()
            descriptor, evidence = owner.descriptor(), owner.live_evidence()
            if not descriptor or not evidence: raise ValueError('provider-descriptor-required')
            self._scope = deepcopy(descriptor['scope']); self.namespace = scope_namespace(self._scope)
            self.folder_id = _id(evidence['folderId'])
            if writable and owner.assert_admitted() != self._scope: raise ValueError('provider-admission-required')

    def cancel(self):
        with self._io_lock:
            self._io_cancelled = True
            self._envelope_cache = {}
            self._applied = {}; self._delivery = None; self._delivery_generation += 1
            groups = set(self._active_groups)
            if self._io_group is not None: groups.add(self._io_group)
        for group in groups: group.cancel()

    def renew(self):
        with self._io_lock:
            if self._active_groups: raise ValueError('provider-io-in-flight')
            previous = self._io_group
            self._delivery = None; self._delivery_generation += 1
            self._io_group = self._host.new_request_group(); self._io_cancelled = False
        if previous is not None: previous.close()

    def finish(self):
        with self._io_lock:
            if self._active_groups: raise ValueError('provider-io-in-flight')
            group, self._io_group = self._io_group, None
        if group is not None: group.close()

    @contextmanager
    def pass_scope(self):
        previous = self._host._request_group()
        if previous is not None:
            previous.check(); yield; previous.check(); return
        with self._io_lock:
            if self._io_cancelled:
                from papeer.core.providers.drive.request_group import ProviderRequestCancelled
                raise ProviderRequestCancelled('provider-io-cancelled')
            automatic = self._io_group is None
            group = self._host.new_request_group() if automatic else self._io_group
            if group is None: raise ValueError('provider-io-group-missing')
            self._active_groups.add(group)
        try:
            with self._host.io_scope(group): yield
        finally:
            with self._io_lock: self._active_groups.discard(group)
            if automatic: group.close()

    @contextmanager
    def _guard(self, write=False):
        if write and not self._writable: raise ValueError('provider-read-only')
        with self.pass_scope(), self._owner.provider_guard(self._host):
            if not self._writable: self._owner.verify_fresh()
            if self._owner.descriptor()['scope'] != self._scope or self._owner.live_evidence()['folderId'] != self.folder_id:
                raise ValueError('provider-binding-changed')
            if self._writable and self._owner.assert_admitted() != self._scope: raise ValueError('provider-admission-required')
            yield
            if not self._writable: self._owner.verify_fresh()
            if self._writable and self._owner.assert_admitted() != self._scope: raise ValueError('provider-admission-required')

    def _header(self, file_id, marker, downloadable=True):
        value = self._host._metadata(_id(file_id), downloadable)
        if (value.get('properties', {}).get('papeer') != marker or value['properties'].get('scope') != self.namespace
                or value.get('parents') != [self.folder_id]): raise ValueError('resource-scope-or-version')
        return value

    def files(self):
        with self._guard():
            files = self._host._transport.list_files(self._query('edits-v1') + " and trashed = false and '" + self.folder_id + "' in parents",
                'id,version,properties')
            return [{'id': _id(file['id']), 'version': file.get('version'), 'kind': file.get('properties', {}).get('editKind')} for file in files]

    def read_json(self, file_id):
        value, _header = self._read_json_with_header(file_id)
        return value

    def _read_json_with_header(self, file_id):
        with self._guard():
            return self._read_json_in_pull_guard(file_id)

    def _read_json_in_pull_guard(self, file_id):
        # Private finite-pull body: caller owns the full pre/post admission guard.
        before = self._header(file_id, 'edits-v1')
        if before.get('mimeType') != 'application/json' or not str(before.get('size', '')).isdigit() or not 1 <= int(before['size']) <= MAX_JSON_BYTES:
            raise ValueError('drive-envelope-size')
        raw = self._host._transport.bytes(file_id, MAX_JSON_BYTES)
        after = self._header(file_id, 'edits-v1')
        if before != after or len(raw) != int(before['size']): raise ValueError('immutable-drive-file-changed')
        value = _envelope(_json(raw), self._scope)
        if before['properties'].get('editKind', value['kind']) != value['kind']: raise ValueError('invalid-edit-envelope')
        digest = hashlib.sha256(canonical_json(value).encode('utf8')).hexdigest()
        if file_id in self._seen and self._seen[file_id] != digest: raise ValueError('immutable-drive-file-changed')
        self._seen[file_id] = digest
        return deepcopy(value), after

    def _cache_header(self, value, file_id):
        """Pure eligibility check; incomplete/denied list data uses the GET path."""
        try:
            header = _validated_metadata(value, file_id)
            required = {'id', 'name', 'mimeType', 'version', 'size', 'ownedByMe', 'trashed', 'capabilities', 'properties', 'parents'}
            props = header.get('properties')
            if (not required <= header.keys() or not isinstance(header['name'], str)
                    or not isinstance(props, dict) or props.get('papeer') != 'edits-v1'
                    or props.get('scope') != self.namespace or header['parents'] != [self.folder_id]
                    or header['mimeType'] != 'application/json' or not isinstance(header['size'], str)
                    or not re.fullmatch(r'[0-9]+', header['size']) or not 1 <= int(header['size']) <= MAX_JSON_BYTES):
                return None
            return canonical_json(header).encode('utf8')
        except (ValueError, TypeError, KeyError):
            return None

    def read_resource(self, metadata, blob_id):
        assert_resource_metadata(metadata)
        if metadata['byteLength'] > MAX_RESOURCE_BYTES: raise ValueError('drive-resource-budget')
        with self._guard():
            before = self._header(blob_id, 'edits-resource-v1')
            if (before['properties'].get('sha256') != metadata['sha256'] or str(before.get('size')) != str(metadata['byteLength'])
                    or before.get('mimeType') != 'application/octet-stream'): raise ValueError('resource-scope-or-version')
            raw = self._host._transport.resource_bytes(blob_id, metadata['byteLength'])
            after = self._header(blob_id, 'edits-resource-v1')
            if before != after or len(raw) != metadata['byteLength'] or hashlib.sha256(raw).hexdigest() != metadata['sha256']:
                raise ValueError('resource-hash')
            return raw

    def _put(self, logical_id, data, name, media_type, properties, provider_file_id=None):
        if not isinstance(logical_id, str) or not re.fullmatch(r'[0-9a-f-]{36,73}', logical_id): raise ValueError('invalid-edit-object-id')
        digest = hashlib.sha256(data).hexdigest()
        cache_key = properties['papeer'] + ':' + logical_id
        old = self._uploads.get(cache_key)
        if old and old['digest'] != digest: raise ValueError('immutable-object-id-reused')
        if provider_file_id is not None:
            actual_id = _id(provider_file_id)
            if old and old['id'] != actual_id: raise ValueError('immutable-object-id-reused')
        else: actual_id = old['id'] if old else self._host._transport.allocate_file_ids(1)[0]
        self._uploads[cache_key] = {'id': actual_id, 'digest': digest}
        props = {**properties, 'scope': self.namespace, 'objectId': logical_id}
        expected = {'id': actual_id, 'name': name, 'parents': [self.folder_id], 'mimeType': media_type, 'properties': props}
        try:
            created = self._host._transport.create_binary(expected, data, media_type)
            if created.get('id') != actual_id: raise ValueError('drive-upload-id')
        except DriveProviderHttpError as error:
            if error.status != 409: raise
        header = self._header(actual_id, props['papeer'])
        if any(header.get(key) != expected[key] for key in ['name', 'parents', 'mimeType', 'properties']): raise ValueError('drive-immutable-metadata')
        actual = self._host._transport.resource_bytes(actual_id, len(data))
        if header != self._header(actual_id, props['papeer']) or actual != data: raise ValueError('drive-immutable-changed')
        return actual_id

    def upload_json(self, edit_id, value, provider_file_id=None):
        stable = deepcopy(value); _envelope(stable, self._scope)
        expected_id = (stable['record']['batch']['id'] if stable['kind'] == 'edit-record' else stable['manifest']['id'] if stable['kind'] == 'dataset-manifest'
                       else stable['metadata']['id'] if stable['kind'] == 'resource' else stable['batchId'] + '-' + stable['peerId'] if stable['kind'] == 'import-receipt' else edit_id)
        if edit_id != expected_id: raise ValueError('invalid-edit-object-id')
        raw = canonical_json(stable).encode('utf8')
        if len(raw) > MAX_JSON_BYTES: raise ValueError('drive-envelope-size')
        with self._guard(True):
            self._put(edit_id, raw, 'edit-' + edit_id + '.json', 'application/json', {'papeer': 'edits-v1', 'editKind': stable['kind']}, provider_file_id)

    def save_resource(self, metadata, data, retained_blob_id=None, retained_descriptor_id=None):
        metadata, data = deepcopy(metadata), bytes(data); assert_resource_metadata(metadata)
        if len(data) > MAX_RESOURCE_BYTES or len(data) != metadata['byteLength'] or hashlib.sha256(data).hexdigest() != metadata['sha256']:
            raise ValueError('resource-hash')
        with self._guard(True):
            # Blob and metadata use distinct immutable IDs, as in the shared Web wire format.
            logical_blob = metadata['id']
            blob_id = self._put(logical_blob, data, 'resource-' + metadata['sha256'], 'application/octet-stream',
                                {'papeer': 'edits-resource-v1', 'sha256': metadata['sha256']}, retained_blob_id)
            self.upload_json(metadata['id'], {'kind': 'resource', 'metadata': metadata, 'blobId': blob_id}, retained_descriptor_id)

    def pull(self, dataset=False):
        result = {'edits': [], 'imports': [], 'resources': [], 'checkpoints': [], 'manifests': []}
        resources, all_resources, total, cache_bytes, candidate, physical = {}, {}, 0, 0, {}, {}
        with self._io_lock:
            self._delivery_generation += 1; generation = self._delivery_generation
            self._delivery = None
        try:
            with self._guard():
                # File.version changes on every server change (Drive v3 File).
                # A fresh complete header is required; no authorization is cached.
                files = self._host._transport.list_files(self._query('edits-v1') + " and trashed = false and '" + self.folder_id + "' in parents", FIELDS)
                counts = {}
                for row in files:
                    file_id = row.get('id') if isinstance(row, dict) else None
                    if isinstance(file_id, str): counts[file_id] = counts.get(file_id, 0) + 1
                with self._io_lock:
                    previous = dict(self._envelope_cache); applied = dict(self._applied)
                for file in files:
                    file_id = _id(file['id'])
                    listed = self._cache_header(file, file_id) if counts[file_id] == 1 else None
                    cached = previous.get(file_id)
                    if listed is not None and cached is not None and cached[0] == listed:
                        header, raw = cached
                        value = _json(raw)
                    else:
                        value, after = self._read_json_in_pull_guard(file_id)
                        raw = canonical_json(value).encode('utf8')
                        header = self._cache_header(after, file_id)
                        # A list/GET race may be valid for this pull, but not cacheable.
                        if header != listed: header = None
                    total += len(raw)
                    if total > MAX_PULL_BYTES: raise ValueError('drive-pull-budget')
                    if header is not None and file_id not in candidate:
                        size = len(header) + len(raw)
                        if len(candidate) < MAX_ENVELOPE_CACHE_ENTRIES and cache_bytes + size <= MAX_ENVELOPE_CACHE_BYTES:
                            candidate[file_id] = (header, raw); cache_bytes += size
                    kind = value['kind']
                    entry = candidate.get(file_id)
                    skip = bool(self._writable and not dataset and entry is not None and applied.get(file_id) == entry)
                    if kind == 'edit-record':
                        physical[file_id] = ('edit', value['record']['batch']['id'])
                        if not skip: result['edits'].append(value['record'])
                    elif kind == 'import-receipt':
                        physical[file_id] = ('import', (value['batchId'], value['peerId']))
                        if not skip: result['imports'].append({key: value[key] for key in ['batchId', 'peerId']})
                    elif kind == 'resource':
                        metadata = value['metadata']; old = all_resources.get(metadata['id'])
                        if old is not None and old != metadata: raise ValueError('resource-id-reused')
                        all_resources[metadata['id']] = metadata
                        physical[file_id] = ('resource', metadata['id'])
                        if not skip: resources[metadata['id']] = metadata
                        entry = self._references.setdefault(metadata['id'], {'metadata': metadata, 'blobIds': []})
                        if entry['metadata'] != metadata: raise ValueError('resource-id-reused')
                        if value['blobId'] not in entry['blobIds']: entry['blobIds'].append(value['blobId'])
                    elif dataset: result['manifests' if kind == 'dataset-manifest' else 'checkpoints'].append(value['manifest' if kind == 'dataset-manifest' else 'checkpoint'])
                result['resources'] = list(resources.values())
            # Publish only after the outer admission/credential post-check succeeds.
            with self._io_lock:
                if self._io_cancelled:
                    from papeer.core.providers.drive.request_group import ProviderRequestCancelled
                    raise ProviderRequestCancelled('provider-io-cancelled')
                if generation != self._delivery_generation: raise ValueError('provider-delivery-stale')
                self._envelope_cache = candidate
                self._applied = {key: value for key, value in self._applied.items() if candidate.get(key) == value}
                returned = deepcopy(result)
                if self._writable and not dataset:
                    self._delivery = (returned, generation, {key: (candidate[key], logical) for key, logical in physical.items() if key in candidate})
            return returned
        except BaseException:
            with self._io_lock:
                self._envelope_cache = {}; self._applied = {}; self._delivery = None
            raise

    def acknowledge_pull(self, incoming, edits, imports, resources):
        # Identity and generation tie a successful Core result to one validated pull.
        with self._guard():
            with self._io_lock:
                delivery = self._delivery
                if self._io_cancelled or not delivery or delivery[0] is not incoming or delivery[1] != self._delivery_generation:
                    raise ValueError('provider-delivery-stale')
            self._owner.assert_current()
        with self._io_lock:
            if self._io_cancelled or self._delivery is not delivery or delivery[1] != self._delivery_generation:
                raise ValueError('provider-delivery-stale')
            allowed = {'edit': set(edits), 'import': set(imports), 'resource': set(resources)}
            for key, (entry, (kind, logical)) in delivery[2].items():
                if logical in allowed[kind] and self._envelope_cache.get(key) == entry: self._applied[key] = entry
            self._delivery = None

    def download_resource(self, metadata):
        entry = self._references.get(metadata['id'])
        if not entry or entry['metadata'] != metadata: raise ValueError('resource-descriptor-changed')
        failure = ValueError('resource-unavailable')
        for blob_id in entry['blobIds']:
            try: return {'metadata': deepcopy(metadata), 'bytes': self.read_resource(metadata, blob_id)}
            except ValueError as error: failure = error
        raise failure

    def read_published_dataset(self):
        with self._guard():
            descriptor = self._owner.descriptor(); values = self.pull(True)
            manifests = [value for value in values['manifests'] if value['id'] == descriptor['manifestId']]
            if not manifests or any(value != manifests[0] for value in manifests): raise ValueError('dataset-manifest-unavailable')
            manifest = manifests[0]
            if manifest['checkpointSha256'] != descriptor['checkpointSha256']: raise ValueError('dataset-checkpoint-hash')
            checkpoints = [value for value in values['checkpoints'] if checkpoint_hash(value) == descriptor['checkpointSha256']]
            if not checkpoints: raise ValueError('dataset-checkpoint-unavailable')
            checkpoint = checkpoints[0]; assert_dataset_checkpoint(manifest, checkpoint, self._scope)
            if sum(item['byteLength'] for item in manifest['resources']) > MAX_PULL_BYTES: raise ValueError('drive-pull-budget')
            resources = []
            for metadata in manifest['resources']:
                resources.append(self.download_resource(metadata))
            return {'manifest': deepcopy(manifest), 'checkpoint': deepcopy(checkpoint), 'resources': resources}

    def upload(self, record, provider_file_id=None):
        return self.upload_json(record['batch']['id'], {'kind': 'edit-record', 'record': record}, provider_file_id)

    def upload_dataset_manifest(self, manifest, provider_file_id=None):
        return self.upload_json(manifest['id'], {'kind': 'dataset-manifest', 'manifest': manifest}, provider_file_id)

    def upload_checkpoint(self, checkpoint, object_id, provider_file_id=None):
        return self.upload_json(object_id, {'kind': 'repository-checkpoint', 'checkpoint': checkpoint}, provider_file_id)

    def imported(self, batch_id, peer_id):
        return self.upload_json(batch_id + '-' + peer_id, {'kind': 'import-receipt', 'batchId': batch_id, 'peerId': peer_id})
