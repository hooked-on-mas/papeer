"""SQLite provider staging and atomic activation under a host-owned authority.

The authority and verifier must be created by Native host code. A parsed plan,
descriptor or saved binding is never an authorization capability.
"""
from copy import deepcopy
import hashlib
import json
import re

from papeer.core.bootstrap.canonical_bootstrap import assert_canonical_profile
from papeer.core.edit_contracts import validate_canonicaldevicepeer, validate_canonicalproviderbinding, validate_canonicalproviderintent
from papeer.core.edit_model import canonical_json, reject
from papeer.core.edit_repository import SqliteEditRepository
from papeer.core.edits.dataset_control import assert_dataset_control_plan, assert_empty_initial_publication, dataset_access
from papeer.core.edits.datasets import assert_dataset_checkpoint
from papeer.core.edits.provider_binding_decision import assert_live_provider_binding, assert_provider_plan
from papeer.core.edits.provider_descriptor_bytes import read_provider_descriptor_bytes


def upgrade_provider_metadata(db):
    """Explicit owner-authorized upgrade only; never called by read/admit/constructor."""
    db.execute('CREATE TABLE IF NOT EXISTS canonical_provider_bindings (owner TEXT NOT NULL, identity TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,identity))')
    db.execute('CREATE TABLE IF NOT EXISTS canonical_provider_intents (owner TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,request_id))')
    db.execute('CREATE TABLE IF NOT EXISTS canonical_provider_artifacts (owner TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,request_id))')
    db.execute('CREATE TABLE IF NOT EXISTS canonical_provider_resource_bytes (owner TEXT NOT NULL, request_id TEXT NOT NULL, resource_id TEXT NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(owner,request_id,resource_id))')
    db.execute('CREATE TABLE IF NOT EXISTS canonical_provider_acknowledgements (owner TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(owner,request_id))')
    assert_provider_schema(db)


def assert_provider_schema(db):
    expected = {
        'canonical_provider_bindings': (('owner', 'identity', 'payload'), ('owner', 'identity')),
        'canonical_provider_intents': (('owner', 'request_id', 'payload'), ('owner', 'request_id')),
        'canonical_provider_artifacts': (('owner', 'request_id', 'payload'), ('owner', 'request_id')),
        'canonical_provider_resource_bytes': (('owner', 'request_id', 'resource_id', 'payload'), ('owner', 'request_id', 'resource_id')),
        'canonical_provider_acknowledgements': (('owner', 'request_id'), ('owner', 'request_id')),
    }
    for table, (columns, key) in expected.items():
        info = db.execute('PRAGMA table_info("' + table + '")').fetchall()
        primary = tuple(row[1] for row in sorted((row for row in info if row[5]), key=lambda row: row[5]))
        if tuple(row[1] for row in info) != columns or primary != key: reject('provider-schema-invalid')


def _identity(scope):
    return canonical_json([scope['accountId'], scope['libraryId']])


def _namespace(scope):
    return canonical_json([scope['accountId'], scope['libraryId'], scope['epoch']])


def _digest(value):
    return hashlib.sha256(canonical_json(value).encode('utf8')).hexdigest()


def _commitment(plan):
    intent = {key: value for key, value in plan['intent'].items() if key not in {'phase', 'requestSha256'}}
    keys = ('ownerNamespace', 'requestId', 'title', 'folderId', 'principalDigest', 'descriptor', 'publication', 'resources', 'activationIds', 'createObjects')
    return {key: plan[key] for key in keys} | {'intent': intent}


def _check_create_prepared(plan, owner):
    plan = deepcopy(plan)
    intent = plan['intent']
    validate_canonicalproviderintent(intent)
    if (intent['action'] != 'create' or intent['phase'] != 'prepared' or plan['binding'] is not None
            or plan['ownerNamespace'] != owner.namespace or plan['principalDigest'] != owner.principal_digest
            or plan['requestId'] != intent['requestId'] or plan['descriptor']['version'] is not None
            or _digest(_commitment(plan)) != intent['requestSha256']):
        reject('provider-prepared-plan-invalid')
    objects = plan['createObjects']
    drive = re.compile(r'^[A-Za-z0-9_-]+$')
    uuid = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    ids = [*plan['activationIds'].values(), intent['requestId'], intent['bindingId'], intent['manifestId'],
           intent['checkpointObjectId'], intent['descriptorObjectId'], intent['peerId'], objects['folderObjectId']]
    remote = [objects[k] for k in ('folderId', 'checkpointFileId', 'manifestFileId', 'descriptorFileId')]
    if (any(not uuid.fullmatch(x) for x in ids) or len(set(ids)) != len(ids)
            or any(not drive.fullmatch(x) for x in remote) or len(set(remote)) != 4
            or objects['folderId'] != plan['folderId'] or objects['descriptorFileId'] != plan['descriptor']['id']
            or not plan['title'].strip() or plan['title'] != plan['title'].strip()
            or len(plan['title']) > 200):
        reject('provider-prepared-plan-invalid')
    descriptor = read_provider_descriptor_bytes(bytes.fromhex(plan['descriptorBytesHex']), plan['descriptor']['sha256'], intent['scope'])['descriptor']
    publication = plan['publication']
    assert_empty_initial_publication(publication)
    assert_dataset_checkpoint(publication['manifest'], publication['checkpoint'], intent['scope'])
    if (descriptor['manifestId'] != publication['manifest']['id']
            or descriptor['checkpointSha256'] != publication['manifest']['checkpointSha256']
            or intent['manifestId'] != descriptor['manifestId'] or intent['checkpointSha256'] != descriptor['checkpointSha256']
            or intent['descriptorSha256'] != plan['descriptor']['sha256']
            or intent['checkpointObjectId'] != publication['checkpointObjectId'] or plan['resources']):
        reject('provider-prepared-plan-invalid')
    return plan


def prepare_create(owner, captured_plan):
    """Durably retain CREATE IDs and reserve its scope before any remote POST."""
    owner.assert_current()
    plan = _check_create_prepared(captured_plan, owner)
    raw = canonical_json(plan)
    if len(raw.encode('utf8')) > 16 * 1024 * 1024: reject('provider-plan-too-large')
    with owner.transaction('provider-prepare') as db:
        assert_provider_schema(db)
        request = plan['requestId']
        old = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request)).fetchone()
        if old:
            retained = json.loads(old[0])
            if (_commitment(retained) != _commitment(plan) or retained['descriptorBytesHex'] != plan['descriptorBytesHex']):
                reject('provider-request-reused')
            saved = db.execute('SELECT payload FROM canonical_provider_intents WHERE owner=? AND request_id=?', (owner.namespace, request)).fetchone()
            if (not saved or json.loads(saved[0]) not in (retained['intent'], {**retained['intent'], 'phase': 'activated'})):
                reject('provider-plan-changed')
        else:
            identity = _identity(plan['intent']['scope'])
            if (db.execute('SELECT 1 FROM canonical_provider_bindings WHERE owner=? AND identity=?', (owner.namespace, identity)).fetchone()
                    or db.execute('SELECT 1 FROM canonical_profiles WHERE identity=?', (identity,)).fetchone()
                    or db.execute('SELECT 1 FROM edit_dataset_controls WHERE identity=?', (identity,)).fetchone()): reject('provider-scope-already-present')
            for (payload,) in db.execute("SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id NOT LIKE 'transfer:%'", (owner.namespace,)):
                other = json.loads(payload)
                if _identity(other['intent']['scope']) == identity: reject('provider-scope-already-present')
            db.execute('INSERT INTO canonical_provider_artifacts VALUES(?,?,?)', (owner.namespace, request, raw))
            db.execute('INSERT INTO canonical_provider_intents VALUES(?,?,?)', (owner.namespace, request, canonical_json(plan['intent'])))
        owner.assert_current()
    return {'status': 'pending', 'requestId': plan['requestId']}


def mark_create_published(owner, captured_plan):
    """CAS the retained CREATE to a freshly verified observed descriptor version."""
    owner.assert_current()
    published, _, _, _, _ = _check_plan(captured_plan, owner.live_evidence())
    if published['intent']['action'] != 'create' or published['ownerNamespace'] != owner.namespace: reject('provider-owner-invalid')
    state = query_prepared(owner, published['requestId'])
    if state['status'] == 'accepted':
        with owner.transaction('provider-read') as db:
            row = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, published['requestId'])).fetchone()
            if not row or json.loads(row[0]) != published: reject('provider-request-reused')
        return state
    with owner.transaction('provider-prepare') as db:
        assert_provider_schema(db)
        request = published['requestId']
        row = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request)).fetchone()
        saved = db.execute('SELECT payload FROM canonical_provider_intents WHERE owner=? AND request_id=?', (owner.namespace, request)).fetchone()
        if not row or not saved: reject('provider-plan-missing')
        if json.loads(row[0]) == published and json.loads(saved[0]) == published['intent']:
            binding = db.execute('SELECT payload FROM canonical_provider_bindings WHERE owner=? AND identity=?', (owner.namespace, _identity(published['intent']['scope']))).fetchone()
            if not binding or json.loads(binding[0]) != published['binding']: reject('provider-plan-changed')
            return {'status': 'pending', 'requestId': request}
        prior = _check_create_prepared(json.loads(row[0]), owner)
        if (json.loads(saved[0]) != prior['intent'] or _commitment(prior) != _commitment(published)
                or prior['descriptorBytesHex'] != published['descriptorBytesHex']): reject('provider-plan-changed')
        identity = _identity(published['intent']['scope'])
        if db.execute('SELECT 1 FROM canonical_provider_bindings WHERE owner=? AND identity=?', (owner.namespace, identity)).fetchone(): reject('provider-scope-already-present')
        db.execute('INSERT INTO canonical_provider_bindings VALUES(?,?,?)', (owner.namespace, identity, canonical_json(published['binding'])))
        db.execute('UPDATE canonical_provider_artifacts SET payload=? WHERE owner=? AND request_id=?', (canonical_json(published), owner.namespace, request))
        db.execute('UPDATE canonical_provider_intents SET payload=? WHERE owner=? AND request_id=?', (canonical_json(published['intent']), owner.namespace, request))
        owner.assert_current()
    return owner.confirm_committed(lambda: query_prepared(owner, published['requestId']))


def _check_plan(plan, evidence, allow_prepared=False):
    """Validate immutable host-captured plan before opening a write transaction."""
    plan = deepcopy(plan)
    binding, intent, publication = plan['binding'], plan['intent'], plan['publication']
    validate_canonicalproviderbinding(binding); validate_canonicalproviderintent(intent)
    uuid = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    drive_id = re.compile(r'^[A-Za-z0-9_-]+$')
    ids = [*plan['activationIds'].values(), intent['requestId'], intent['bindingId'], intent['manifestId'],
           intent['checkpointObjectId'], intent['descriptorObjectId'], intent['peerId']]
    if (not uuid.fullmatch(plan['ownerNamespace']) or not plan['title'].strip() or plan['title'] != plan['title'].strip()
            or len(plan['title']) > 200 or not drive_id.fullmatch(plan['folderId'])
            or not drive_id.fullmatch(plan['descriptor']['id']) or not re.fullmatch(r'[0-9a-f]{64}', plan['principalDigest'])
            or any(not uuid.fullmatch(value) for value in ids) or len(set(ids)) != len(ids)):
        reject('provider-owner-plan-invalid')
    if intent['action'] == 'create':
        objects = plan['createObjects']
        if (not objects or not uuid.fullmatch(objects['folderObjectId']) or objects['folderObjectId'] in ids
                or any(not drive_id.fullmatch(objects[key]) for key in ('folderId', 'checkpointFileId', 'manifestFileId', 'descriptorFileId'))
                or len({objects[key] for key in ('folderId', 'checkpointFileId', 'manifestFileId', 'descriptorFileId')}) != 4
                or objects['folderId'] != plan['folderId'] or objects['descriptorFileId'] != plan['descriptor']['id']
                or plan['descriptor']['version'] is not None): reject('provider-create-objects-invalid')
        assert_empty_initial_publication(publication)
    elif plan['createObjects'] is not None or not plan['descriptor']['version']:
        reject('provider-join-descriptor-invalid')
    descriptor = read_provider_descriptor_bytes(bytes.fromhex(plan['descriptorBytesHex']), binding['descriptorSha256'], binding['scope'])['descriptor']
    assert_provider_plan(binding, descriptor, intent)
    if binding['state'] != 'preparing' or intent['phase'] not in ({'prepared', 'published'} if allow_prepared else {'published'}) or intent['action'] not in {'join', 'create'}:
        reject('provider-plan-phase')
    if (binding['principalDigest'] != plan['principalDigest'] or binding['descriptorId'] != plan['descriptor']['id']
            or binding['descriptorSha256'] != plan['descriptor']['sha256'] or not binding['descriptorVersion']
            or (plan['descriptor']['version'] is not None and binding['descriptorVersion'] != plan['descriptor']['version'])
            or plan['requestId'] != intent['requestId']): reject('provider-binding-plan-mismatch')
    if [item['metadata'] for item in plan['resources']] != publication['manifest']['resources']:
        reject('provider-staging-incomplete')
    if any(item['stagingKey'] != canonical_json([plan['ownerNamespace'], plan['requestId'], 'resource', item['metadata']['id']]) for item in plan['resources']):
        reject('provider-staging-invalid')
    assert_live_provider_binding({**binding, 'state': 'active'}, descriptor, evidence)
    assert_dataset_checkpoint(publication['manifest'], publication['checkpoint'], binding['scope'])
    if (publication['manifest']['id'] != descriptor['manifestId'] or publication['manifest']['checkpointSha256'] != descriptor['checkpointSha256']
            or publication['checkpointObjectId'] != intent['checkpointObjectId']):
        reject('provider-publication-mismatch')
    scope = binding['scope']; identity = {'accountId': scope['accountId'], 'libraryId': scope['libraryId']}
    ids = plan['activationIds']
    control = {'version': 1, 'id': ids['activeControlId'], 'identity': identity, 'epochs': [scope['epoch']], 'active': publication['manifest'],
               'transition': {'id': intent['requestId'], 'mode': 'import', 'source': None, 'phase': 'activated', 'publication': publication}}
    peer = {'version': 1, 'accountId': scope['accountId'], 'peerId': intent['peerId']}
    profile = {'version': 1, 'revision': ids['profileRevision'], 'identity': identity, 'title': plan['title'],
               'remote': {'kind': 'drive', 'folderId': plan['folderId']}, 'initialization': None,
               'origin': {'kind': 'activated-installation', 'source': 'import', 'controlId': control['id'],
                          'manifestId': publication['manifest']['id'], 'installedScope': scope}}
    assert_canonical_profile(profile); validate_canonicaldevicepeer(peer)
    assert_dataset_control_plan(control, identity)
    if (profile['identity'] != identity or profile['origin']['kind'] != 'activated-installation'
            or profile['origin']['installedScope'] != scope or profile['origin']['manifestId'] != publication['manifest']['id']
            or profile['origin']['controlId'] != control['id'] or profile['remote'] != {'kind': 'drive', 'folderId': plan['folderId']}
            or control['active'] != publication['manifest'] or control['transition']['phase'] != 'activated'
            or control['transition']['publication'] != publication or peer['accountId'] != scope['accountId'] or peer['peerId'] != intent['peerId']):
        reject('provider-activation-invalid')
    if _digest(_commitment(plan)) != intent['requestSha256']:
        reject('provider-plan-changed')
    return plan, descriptor, profile, control, peer


def query_prepared(owner, request_id):
    """Read the durable operation without creating authority from the saved row."""
    owner.assert_current()
    with owner.transaction('provider-read') as db:
        assert_provider_schema(db)
        artifact = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
        intent = db.execute('SELECT payload FROM canonical_provider_intents WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
        if not artifact and not intent: return {'status': 'not-found', 'requestId': request_id}
        if not artifact or not intent: reject('provider-plan-incomplete')
        raw, saved_intent = artifact[0], json.loads(intent[0])
    decoded = json.loads(raw)
    if decoded['binding'] is None:
        plan = _check_create_prepared(decoded, owner)
        if plan['requestId'] != request_id or saved_intent != plan['intent']: reject('provider-plan-changed')
        owner.assert_current()
        return {'status': 'pending', 'requestId': request_id}
    plan, descriptor, profile, control, peer = _check_plan(decoded, owner.live_evidence(), allow_prepared=True)
    if plan['requestId'] != request_id or plan['ownerNamespace'] != owner.namespace: reject('provider-request-mismatch')
    expected = plan['intent']
    if saved_intent == expected:
        with owner.transaction('provider-read') as db:
            binding = db.execute('SELECT payload FROM canonical_provider_bindings WHERE owner=? AND identity=?', (owner.namespace, _identity(plan['binding']['scope']))).fetchone()
            current = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
            if not current or current[0] != raw or not binding or json.loads(binding[0]) != plan['binding']: reject('provider-plan-changed')
            for ref in plan['resources']:
                metadata = ref['metadata']
                row = db.execute('SELECT payload FROM canonical_provider_resource_bytes WHERE owner=? AND request_id=? AND resource_id=?', (owner.namespace, request_id, metadata['id'])).fetchone()
                if not row or not isinstance(row[0], bytes) or len(row[0]) != metadata['byteLength'] or hashlib.sha256(row[0]).hexdigest() != metadata['sha256']:
                    reject('provider-staged-resource-invalid')
        return {'status': 'pending', 'requestId': request_id}
    if saved_intent != {**expected, 'phase': 'activated'}: reject('provider-intent-invalid')
    identity, scope = _identity(plan['binding']['scope']), plan['binding']['scope']
    namespace = _namespace(scope)
    with owner.transaction('provider-read') as db:
        assert_provider_schema(db)
        current = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
        saved = db.execute('SELECT payload FROM canonical_provider_intents WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
        binding = db.execute('SELECT payload FROM canonical_provider_bindings WHERE owner=? AND identity=?', (owner.namespace, identity)).fetchone()
        saved_profile = db.execute('SELECT payload FROM canonical_profiles WHERE identity=?', (identity,)).fetchone()
        saved_control = db.execute('SELECT payload,active_epoch,staging_epoch,frozen,epochs FROM edit_dataset_controls WHERE identity=?', (identity,)).fetchone()
        saved_peer = db.execute('SELECT payload FROM canonical_peers WHERE account=?', (scope['accountId'],)).fetchone()
        saved_manifest = db.execute('SELECT payload FROM edit_datasets WHERE scope=? AND id=?', (namespace, plan['publication']['manifest']['id'])).fetchone()
        if (not current or current[0] != raw or not saved or json.loads(saved[0]) != saved_intent
                or not binding or json.loads(binding[0]) != {**plan['binding'], 'state': 'active'}
                or not saved_profile or json.loads(saved_profile[0]) != profile or not saved_control or json.loads(saved_control[0]) != control
                or not saved_peer or json.loads(saved_peer[0]) != peer or not saved_manifest or json.loads(saved_manifest[0]) != plan['publication']['manifest']
                or not db.execute('SELECT 1 FROM edit_checkpoints WHERE scope=? AND sha256=?', (namespace, plan['publication']['manifest']['checkpointSha256'])).fetchone()):
            reject('provider-activation-incomplete')
        access = dataset_access(control)
        if saved_control[1:] != (access['activeEpoch'], access['stagingEpoch'], int(access['frozen']), canonical_json(access['epochs'])):
            reject('provider-activation-incomplete')
        repo = SqliteEditRepository.__new__(SqliteEditRepository)
        repo.scope, repo.namespace, repo.identity = scope, namespace, identity
        repo._verify_dataset_resources(db, plan['publication']['manifest'])
        assert_live_provider_binding({**plan['binding'], 'state': 'active'}, descriptor, owner.live_evidence())
    owner.assert_current()
    return {'status': 'accepted', 'requestId': request_id}


def recoveries(owner, select_owner):
    """Return only this namespace and currently authenticated principal's retained operations."""
    owner.assert_current()
    with owner.transaction('provider-read') as db:
        assert_provider_schema(db)
        rows = db.execute("SELECT request_id,payload FROM canonical_provider_artifacts WHERE owner=? AND request_id NOT LIKE 'transfer:%' ORDER BY request_id", (owner.namespace,)).fetchall()
        acknowledged = {row[0] for row in db.execute('SELECT request_id FROM canonical_provider_acknowledgements WHERE owner=?', (owner.namespace,))}
    result = []
    for request_id, raw in rows:
        plan = json.loads(raw)
        if plan['principalDigest'] != owner.principal_digest or request_id in acknowledged:
            continue
        # Published operations require a newly verified descriptor-specific host
        # owner; a namespace-only operation may inspect only pre-POST CREATE.
        selected = owner if plan['binding'] is None else select_owner(plan['descriptor']['id'])
        if selected.namespace != owner.namespace or selected.principal_digest != owner.principal_digest: reject('provider-owner-invalid')
        state = query_prepared(selected, request_id)
        result.append({'requestId': request_id, 'action': plan['intent']['action'], 'title': plan['title'], 'status': state['status']})
    return result


def acknowledge(owner, request_id):
    """Hide an accepted recovery entry without deleting its replay/admission anchor."""
    if query_prepared(owner, request_id)['status'] != 'accepted': reject('provider-ack-not-accepted')
    with owner.transaction('provider-ack') as db:
        assert_provider_schema(db)
        db.execute('INSERT OR IGNORE INTO canonical_provider_acknowledgements VALUES(?,?)', (owner.namespace, request_id))
        owner.assert_current()


def prepare_join(owner, captured_plan, resource_bytes):
    if captured_plan['intent']['action'] != 'join' or captured_plan['intent']['phase'] != 'prepared': reject('provider-plan-phase')
    return _reserve_selected(owner, captured_plan, resource_bytes)


def _reserve_selected(owner, captured_plan, resource_bytes):
    """Reserve an already verified immutable publication; retries keep exact IDs.

    `captured_plan` and resource bytes are supplied by trusted host verifier/transport,
    never directly by a route. Provider publication can be unknown before this step.
    """
    owner.assert_current()
    plan, _, _, _, _ = _check_plan(captured_plan, owner.live_evidence(), allow_prepared=True)
    if plan['ownerNamespace'] != owner.namespace: reject('provider-owner-invalid')
    request_id, identity = plan['requestId'], _identity(plan['binding']['scope'])
    if len(canonical_json(plan).encode('utf8')) > 16 * 1024 * 1024: reject('provider-plan-too-large')
    refs = plan['resources']
    if set(resource_bytes) != {ref['metadata']['id'] for ref in refs}: reject('provider-staging-incomplete')
    staged = {}; total = 0
    for ref in refs:
        metadata = ref['metadata']; data = bytes(resource_bytes[metadata['id']]); total += len(data)
        if total > 128 * 1024 * 1024 or len(data) != metadata['byteLength'] or hashlib.sha256(data).hexdigest() != metadata['sha256']:
            reject('provider-staged-resource-invalid')
        staged[metadata['id']] = data
    raw = canonical_json(plan)
    owner.assert_current()
    with owner.transaction('provider-prepare') as db:
        assert_provider_schema(db)
        existing = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
        if existing:
            if existing[0] != raw: reject('provider-request-reused')
            for key, data in staged.items():
                prior = db.execute('SELECT payload FROM canonical_provider_resource_bytes WHERE owner=? AND request_id=? AND resource_id=?', (owner.namespace, request_id, key)).fetchone()
                if not prior or prior[0] != data: reject('provider-request-reused')
        else:
            if (db.execute('SELECT 1 FROM canonical_provider_intents WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
                    or db.execute('SELECT 1 FROM canonical_provider_bindings WHERE owner=? AND identity=?', (owner.namespace, identity)).fetchone()
                    or db.execute('SELECT 1 FROM canonical_profiles WHERE identity=?', (identity,)).fetchone()
                    or db.execute('SELECT 1 FROM edit_dataset_controls WHERE identity=?', (identity,)).fetchone()): reject('provider-scope-already-present')
            for (payload,) in db.execute("SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id NOT LIKE 'transfer:%'", (owner.namespace,)):
                if _identity(json.loads(payload)['intent']['scope']) == identity: reject('provider-scope-already-present')
            db.execute('INSERT INTO canonical_provider_bindings VALUES(?,?,?)', (owner.namespace, identity, canonical_json(plan['binding'])))
            db.execute('INSERT INTO canonical_provider_intents VALUES(?,?,?)', (owner.namespace, request_id, canonical_json(plan['intent'])))
            db.execute('INSERT INTO canonical_provider_artifacts VALUES(?,?,?)', (owner.namespace, request_id, raw))
            for key, data in staged.items():
                db.execute('INSERT INTO canonical_provider_resource_bytes VALUES(?,?,?,?)', (owner.namespace, request_id, key, data))
        owner.assert_current()
    return owner.confirm_committed(lambda: query_prepared(owner, request_id))


def mark_join_published(owner, captured_plan):
    owner.assert_current()
    published, _, _, _, _ = _check_plan(captured_plan, owner.live_evidence())
    if published['intent']['action'] != 'join' or published['ownerNamespace'] != owner.namespace: reject('provider-owner-invalid')
    request = published['requestId']; identity = _identity(published['intent']['scope'])
    state = query_prepared(owner, request)
    if state['status'] == 'accepted':
        with owner.transaction('provider-read') as db:
            row = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request)).fetchone()
            if not row or json.loads(row[0]) != published: reject('provider-request-reused')
        return state
    with owner.transaction('provider-prepare') as db:
        assert_provider_schema(db)
        row = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request)).fetchone()
        saved = db.execute('SELECT payload FROM canonical_provider_intents WHERE owner=? AND request_id=?', (owner.namespace, request)).fetchone()
        binding = db.execute('SELECT payload FROM canonical_provider_bindings WHERE owner=? AND identity=?', (owner.namespace, identity)).fetchone()
        if not row or not saved or not binding: reject('provider-plan-missing')
        prior = json.loads(row[0]); old_intent = json.loads(saved[0])
        if prior == published and old_intent == published['intent'] and json.loads(binding[0]) == published['binding']:
            return {'status': 'pending', 'requestId': request}
        _check_plan(prior, owner.live_evidence(), allow_prepared=True)
        if (prior['intent']['phase'] != 'prepared' or old_intent != prior['intent']
                or _commitment(prior) != _commitment(published) or prior['binding'] != published['binding']
                or prior['descriptorBytesHex'] != published['descriptorBytesHex'] or json.loads(binding[0]) != prior['binding']):
            reject('provider-plan-changed')
        db.execute('UPDATE canonical_provider_artifacts SET payload=? WHERE owner=? AND request_id=?', (canonical_json(published), owner.namespace, request))
        db.execute('UPDATE canonical_provider_intents SET payload=? WHERE owner=? AND request_id=?', (canonical_json(published['intent']), owner.namespace, request))
        owner.assert_current()
    return owner.confirm_committed(lambda: query_prepared(owner, request))


def activate_prepared(owner, request_id):
    """Install an exact staged plan atomically; owner fences local and provider generations.

    owner.transaction() must recheck bearer, local grant, active provider principal,
    scope and generation immediately before commit on the same SQLite connection.
    """
    existing = query_prepared(owner, request_id)
    if existing['status'] == 'accepted': return existing
    if existing['status'] != 'pending': reject('provider-plan-missing')
    owner.assert_current()
    with owner.transaction('provider-read') as db:
        assert_provider_schema(db)
        row = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
        if not row: reject('provider-plan-missing')
        raw = row[0]
    plan, descriptor, profile, control, peer = _check_plan(json.loads(raw), owner.live_evidence())
    if plan['intent']['requestId'] != request_id or plan['ownerNamespace'] != owner.namespace: reject('provider-request-mismatch')
    owner.assert_current()
    scope, publication = plan['binding']['scope'], plan['publication']
    namespace, identity = _namespace(scope), _identity(scope)
    with owner.transaction('provider-activate') as db:
        assert_provider_schema(db)
        current = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
        if not current or current[0] != raw: reject('provider-plan-changed')
        stored_intent = db.execute('SELECT payload FROM canonical_provider_intents WHERE owner=? AND request_id=?', (owner.namespace, request_id)).fetchone()
        stored_binding = db.execute('SELECT payload FROM canonical_provider_bindings WHERE owner=? AND identity=?', (owner.namespace, identity)).fetchone()
        if not stored_intent or json.loads(stored_intent[0]) != plan['intent'] or not stored_binding or json.loads(stored_binding[0]) != plan['binding']:
            reject('provider-plan-changed')
        assert_live_provider_binding({**plan['binding'], 'state': 'active'}, descriptor, owner.live_evidence())
        if db.execute('SELECT 1 FROM canonical_profiles WHERE identity=?', (identity,)).fetchone() or db.execute('SELECT 1 FROM edit_dataset_controls WHERE identity=?', (identity,)).fetchone():
            reject('provider-scope-already-present')
        for table in ('edit_roots', 'edit_batches', 'edit_projections', 'edit_projection_pages', 'edit_publications',
                      'edit_resources', 'edit_resource_bytes', 'edit_checkpoints', 'edit_intents', 'edit_datasets'):
            if db.execute("SELECT 1 FROM " + table + " WHERE json_extract(scope,'$[0]')=? AND json_extract(scope,'$[1]')=? LIMIT 1",
                          (scope['accountId'], scope['libraryId'])).fetchone(): reject('provider-scope-already-present')
        repo = SqliteEditRepository.__new__(SqliteEditRepository)
        repo.scope, repo.namespace, repo.identity = scope, namespace, identity
        for metadata in publication['manifest']['resources']:
            data = db.execute('SELECT payload FROM canonical_provider_resource_bytes WHERE owner=? AND request_id=? AND resource_id=?', (owner.namespace, request_id, metadata['id'])).fetchone()
            if not data or not isinstance(data[0], bytes) or len(data[0]) != metadata['byteLength'] or hashlib.sha256(data[0]).hexdigest() != metadata['sha256']:
                reject('provider-staged-resource-invalid')
            previous = db.execute('SELECT payload FROM edit_resource_bytes WHERE scope=? AND sha256=?', (namespace, metadata['sha256'])).fetchone()
            if previous is not None and previous[0] != data[0]: reject('provider-resource-collision')
            db.execute('INSERT OR IGNORE INTO edit_resource_bytes VALUES(?,?,?)', (namespace, metadata['sha256'], data[0]))
            db.execute('INSERT INTO edit_resources VALUES(?,?,?)', (namespace, metadata['id'], canonical_json(metadata)))
        repo._verify_dataset_resources(db, publication['manifest'])
        repo._install_checkpoint_in(db, publication['checkpoint'], publication['manifest']['checkpointSha256'])
        db.execute('INSERT INTO edit_datasets VALUES(?,?,?)', (namespace, publication['manifest']['id'], canonical_json(publication['manifest'])))
        access = dataset_access(control)
        db.execute('INSERT INTO edit_dataset_controls VALUES(?,?,?,?,?,?)', (identity, canonical_json(control), access['activeEpoch'], access['stagingEpoch'], int(access['frozen']), canonical_json(access['epochs'])))
        existing_peer = db.execute('SELECT payload FROM canonical_peers WHERE account=?', (scope['accountId'],)).fetchone()
        if existing_peer and json.loads(existing_peer[0]) != peer: reject('provider-peer-mismatch')
        if not existing_peer: db.execute('INSERT INTO canonical_peers VALUES(?,?)', (scope['accountId'], canonical_json(peer)))
        db.execute('INSERT INTO canonical_profiles VALUES(?,?,?,?,?)', (identity, scope['accountId'], scope['libraryId'], request_id, canonical_json(profile)))
        binding = {**plan['binding'], 'state': 'active'}; intent = {**plan['intent'], 'phase': 'activated'}
        db.execute('UPDATE canonical_provider_bindings SET payload=? WHERE owner=? AND identity=?', (canonical_json(binding), owner.namespace, identity))
        db.execute('UPDATE canonical_provider_intents SET payload=? WHERE owner=? AND request_id=?', (canonical_json(intent), owner.namespace, request_id))
        owner.assert_current()
    return owner.confirm_committed(lambda: query_prepared(owner, request_id))
