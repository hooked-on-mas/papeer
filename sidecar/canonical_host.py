"""D1a candidate: native in-process authority and transaction gate.

Not connected to routes or SqliteEditRepository. This is not a production
authorization boundary until every canonical route and transaction uses it.
"""
from contextlib import closing, contextmanager
from copy import deepcopy
import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import weakref
from typing import cast

from papeer.core.bootstrap.canonical_bootstrap import assert_canonical_profile
from papeer.core.bootstrap.canonical_local_grant_sqlite import _grant, _refuse_link, _tables, _occupied, provision_local_grant
from papeer.core.edit_contracts import validate_canonicaldevicepeer
from papeer.core.edits.dataset_control import assert_dataset_control, dataset_access
from papeer.core.edits.datasets import assert_dataset_manifest
from papeer.core.edit_model import canonical_json
from papeer.core.migrations.legacy_startup import NativeLegacyStartup, legacy_startup_allowed
from sidecar import deps

_READ = frozenset({'read','receipt','pending','pending-records','pending-publications','intent','pending-intents','checkpoint','datasets','dataset-control','read-resource','resource-metadata'})
_WRITE = frozenset({'commit','publish','replace-intent','store-resource'})
_BOOTSTRAP_READ = frozenset({'bootstrap-list','bootstrap-query','bootstrap-snapshot'})
_BOOTSTRAP_WRITE = frozenset({'bootstrap-peer','bootstrap-prepare','bootstrap-execute','bootstrap-acknowledge'})

class AuthorityError(Exception):
    pass

class _RepositoryAuthority:
    """Server-created adapter; every method still enters NativeAuthority.transaction."""
    def __init__(self, registry, authorization, lease_id, admission_id):
        self._registry, self._authorization, self._lease_id, self._admission_id = registry, authorization, lease_id, admission_id

    def transaction(self, operation, scope):
        return self._registry.transaction(self._authorization, self._lease_id, operation, admission_id=self._admission_id, scope=scope)

    def assert_current(self):
        with self._registry._lock:
            self._registry._lease(self._authorization, self._lease_id)
            admission = self._registry._admissions.get(self._admission_id)
            if not admission or admission['lease_id'] != self._lease_id: raise AuthorityError('unauthorized')
            provider_owner = admission.get('provider_owner')
        if provider_owner is not None: provider_owner.assert_current()
        offline_owner = admission.get('offline_owner')
        if offline_owner is not None: offline_owner.assert_current()

class _InitializationAuthority:
    """Bound server-side to the authenticated durable grant namespace."""
    def __init__(self, registry, authorization, lease_id, account_id):
        self._registry, self._authorization, self._lease_id = registry, authorization, lease_id
        self._account_id = account_id

    @property
    def account_id(self):
        return self._account_id

    def assert_current(self):
        with self._registry._lock:
            lease = self._registry._lease(self._authorization, self._lease_id)
            if lease['grant']['namespaceId'] != self.account_id: raise AuthorityError('lease-expired')

    @contextmanager
    def transaction(self, operation):
        if operation not in _BOOTSTRAP_READ | _BOOTSTRAP_WRITE: raise AuthorityError('operation-denied')
        with self._registry.transaction(self._authorization, self._lease_id, operation) as db:
            self.assert_current()
            yield db
            self.assert_current()

def canonical_storage_path():
    """Single server-selected path; no legacy Library is opened."""
    return deps.get_canonical_storage_path()

def _require_clear():
    if not legacy_startup_allowed(deps.get_data_dir()): raise AuthorityError('migration-held')

def _bearer(authorization):
    # verify_token permits dev-no-auth and query credentials; neither grants owner
    # authority. Require the configured real bearer on every ingress operation.
    expected = deps.get_auth_token()
    supplied = deps.provided_token(authorization, None) if isinstance(authorization, str) and authorization.startswith('Bearer ') else None
    if not expected or not supplied or not hmac.compare_digest(expected.encode('utf8'), supplied.encode('utf8')):
        raise AuthorityError('unauthorized')
    return hashlib.sha256(expected.encode('utf8')).digest()

@contextmanager
def _existing(path, write):
    _refuse_link(path)
    # mode=rw refuses creation; mode=ro cannot perform DDL or write.
    with closing(sqlite3.connect(path.resolve().as_uri() + ('?mode=rw' if write else '?mode=ro'), uri=True, timeout=30)) as db:
        try:
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield db
            if write: db.commit()
            else: db.rollback()
        except BaseException:
            db.rollback(); raise

def _current_grant(db):
    try:
        value = _grant(db)
    except (ValueError, TypeError, KeyError) as error:
        # Structural/JSON errors are authority failures, never a definitive
        # application-level write rejection. SQLite I/O errors remain distinct.
        raise AuthorityError('recovery-required') from error
    if value is None: raise AuthorityError('recovery-required')
    return value

_COLUMNS = {
    'edit_roots':('scope','target','payload'), 'edit_batches':('scope','id','target','payload','receipt','history'),
    'edit_projections':('scope','target','version','payload'), 'edit_projection_pages':('scope','id','payload'),
    'edit_publications':('scope','id','payload'), 'edit_resources':('scope','id','payload'),
    'edit_resource_bytes':('scope','sha256','payload'), 'edit_checkpoints':('scope','sha256'),
    'edit_intents':('scope','target','payload'), 'edit_datasets':('scope','id','payload'),
    'edit_dataset_controls':('identity','payload','active_epoch','staging_epoch','frozen','epochs'),
    'canonical_peers':('account','payload'), 'canonical_profiles':('identity','account','library','request_id','payload'),
    'canonical_initial_intents':('account','request_id','library','retired','payload'), 'canonical_initial_artifacts':('identity','payload'),
}
_PRIMARY = {
    'edit_roots':('scope','target'), 'edit_batches':('scope','id'), 'edit_projections':('scope','target','version'),
    'edit_projection_pages':('scope','id'), 'edit_publications':('scope','id'), 'edit_resources':('scope','id'),
    'edit_resource_bytes':('scope','sha256'), 'edit_checkpoints':('scope','sha256'), 'edit_intents':('scope','target'),
    'edit_datasets':('scope','id'), 'edit_dataset_controls':('identity',), 'canonical_peers':('account',),
    'canonical_profiles':('identity',), 'canonical_initial_intents':('account','request_id'), 'canonical_initial_artifacts':('identity',),
}

def _schema_state(db):
    tables = _tables(db)
    for name, columns in _COLUMNS.items():
        if name in tables:
            info = db.execute('PRAGMA table_info("' + name + '")').fetchall()
            primary = tuple(row[1] for row in sorted((row for row in info if row[5]), key=lambda row: row[5]))
            if tuple(row[1] for row in info) != columns or primary != _PRIMARY[name]: raise AuthorityError('recovery-required')
    if set(_COLUMNS) - tables:
        if _occupied(db,tables): raise AuthorityError('recovery-required')
        return 'setup-required'
    def indexes(table):
        result = []
        for row in db.execute('PRAGMA index_list("' + table + '")').fetchall():
            index_name = row[1].replace('"','""')
            result.append((row[1], bool(row[2]), bool(row[4]), tuple(item[2] for item in db.execute('PRAGMA index_info("' + index_name + '")'))))
        return result
    if not any(unique and not partial and cols == ('account','request_id') for _,unique,partial,cols in indexes('canonical_profiles')):
        raise AuthorityError('recovery-required')
    if not any(name == 'canonical_intent_library' and unique and partial and cols == ('account','library') for name,unique,partial,cols in indexes('canonical_initial_intents')):
        raise AuthorityError('recovery-required')
    row = db.execute("SELECT sql FROM sqlite_master WHERE type='index' AND name='canonical_intent_library'").fetchone()
    if not row or ''.join(row[0].lower().split()).replace('indexifnotexists','index') != 'createuniqueindexcanonical_intent_libraryoncanonical_initial_intents(account,library)whereretired=0':
        raise AuthorityError('recovery-required')
    return 'ready'

def _proof(db, namespace, library, *, allow_provider=False):
    identity = {'accountId':namespace,'libraryId':library}
    key = canonical_json([namespace,library])
    profile_row = db.execute('SELECT account,library,payload FROM canonical_profiles WHERE identity=?', (key,)).fetchone()
    peer_row = db.execute('SELECT payload FROM canonical_peers WHERE account=?', (namespace,)).fetchone()
    control_row = db.execute('SELECT payload,active_epoch,staging_epoch,frozen,epochs FROM edit_dataset_controls WHERE identity=?', (key,)).fetchone()
    if not profile_row or not peer_row or not control_row: raise AuthorityError('recovery-required')
    try:
        profile = json.loads(profile_row[2]); peer = json.loads(peer_row[0]); control = json.loads(control_row[0])
        assert_canonical_profile(profile); validate_canonicaldevicepeer(peer); assert_dataset_control(control,identity)
        if (profile['remote'] is not None) != allow_provider: raise AuthorityError('provider-admission-required')
        if profile_row[:2] != (namespace,library) or profile['identity'] != identity or peer['accountId'] != namespace:
            raise AuthorityError('recovery-required')
        active = control['active']; access = dataset_access(control)
        if not active or access['frozen']: raise AuthorityError('dataset-unavailable')
        if (control_row[1] != access['activeEpoch'] or control_row[2] != access['stagingEpoch']
                or control_row[3] != int(access['frozen']) or json.loads(control_row[4]) != access['epochs']):
            raise AuthorityError('recovery-required')
        scope = active['scope']; assert_dataset_manifest(active,scope)
        manifest_row = db.execute('SELECT payload FROM edit_datasets WHERE scope=? AND id=?',
            (canonical_json([namespace,library,scope['epoch']]),active['id'])).fetchone()
        if not manifest_row or json.loads(manifest_row[0]) != active: raise AuthorityError('recovery-required')
        return {'scope':scope,'profile':profile,'peer':peer,'control':control,'manifest':active}
    except (KeyError, TypeError, ValueError):
        raise AuthorityError('recovery-required') from None


def _provider_proof(db, owner, scope):
    """Stored binding is evidence only; owner carries the live host verifier."""
    from papeer.core.edits.provider_binding_decision import assert_live_provider_binding
    from papeer.core.edits.provider.activation import assert_provider_schema
    assert_provider_schema(db)
    identity = canonical_json([scope['accountId'], scope['libraryId']])
    row = db.execute('SELECT payload FROM canonical_provider_bindings WHERE owner=? AND identity=?', (owner.namespace, identity)).fetchone()
    if not row: raise AuthorityError('provider-binding-missing')
    binding = json.loads(row[0]); descriptor = owner.descriptor()
    assert_live_provider_binding(binding, descriptor, owner.live_evidence())
    if binding['scope'] != scope: raise AuthorityError('provider-scope-mismatch')
    proof = _proof(db, scope['accountId'], scope['libraryId'], allow_provider=True)
    if proof['scope'] != scope or proof['profile']['remote'] != {'kind': 'drive', 'folderId': owner.live_evidence()['folderId']}:
        raise AuthorityError('provider-scope-mismatch')
    return {**proof, 'providerBinding': binding}

class NativeAuthority:
    """Created once per sidecar process. IDs are opaque and never persisted."""
    def __init__(self):
        self._lock = threading.RLock()
        self._generation = 0
        self._leases = {}
        self._admissions = {}
        self._handles = {}
        self._provider_principal = None
        self._offline_services = weakref.WeakSet()
        from sidecar.provider.offline.jobs import PermissionJobs
        self._offline_jobs = PermissionJobs()

    def _lease(self, authorization, lease_id):
        token_hash = _bearer(authorization)
        lease = self._leases.get(lease_id) if isinstance(lease_id, str) else None
        if (not lease or lease['generation'] != self._generation or lease['path'] != canonical_storage_path()
                or not hmac.compare_digest(lease['token_hash'], token_hash)):
            raise AuthorityError('unauthorized')
        return lease

    def issue(self, authorization):
        """Only actual bearer + existing durable grant can issue a lease."""
        with self._lock:
            token_hash = _bearer(authorization); _require_clear(); path = canonical_storage_path()
            with _existing(path, False) as db:
                grant = _current_grant(db)
                if _schema_state(db) != 'ready': raise AuthorityError('setup-required')
            lease_id = secrets.token_urlsafe(32)
            self._leases[lease_id] = {'path':path,'generation':self._generation,'grant':deepcopy(grant),'token_hash':token_hash}
            return lease_id

    def _lease_retirement(self, authorization, lease_id):
        """Capture server-only, identity-bound retirement; this cannot issue authority."""
        with self._lock:
            exact = self._lease(authorization, lease_id)
        return self._retirement_for_exact(lease_id, exact)

    def _retirement_for_exact(self, lease_id, exact):
        def retire():
            with self._lock:
                current = self._leases.get(lease_id)
                if current is None: return
                if current is not exact: raise AuthorityError('lease-retirement-mismatch')
                self._admissions = {key: value for key, value in self._admissions.items() if value['lease_id'] != lease_id}
                del self._leases[lease_id]
        return retire

    def _issue_with_retirement(self, authorization):
        # Capture the exact minted object while still holding the same lock.
        with self._lock:
            lease_id = self.issue(authorization)
            return lease_id, self._retirement_for_exact(lease_id, self._leases[lease_id])

    def provision(self, authorization):
        """Explicit authenticated setup. Grant-only interruption is recoverable."""
        from papeer.core.edit_repository import initialize_edit_schema
        from papeer.core.bootstrap.canonical_initialization_sqlite import initialize_canonical_metadata
        with self._lock:
            token_hash = _bearer(authorization); _require_clear(); path = canonical_storage_path()
            _refuse_link(path); path.parent.mkdir(mode=0o700, parents=True, exist_ok=True); _refuse_link(path)
            grant = provision_local_grant(path)
            with _existing(path, True) as db:
                if _current_grant(db) != grant: raise AuthorityError('lease-expired')
                state = _schema_state(db)
                if state == 'setup-required':
                    initialize_edit_schema(db); initialize_canonical_metadata(db)
                if _schema_state(db) != 'ready' or _current_grant(db) != grant: raise AuthorityError('recovery-required')
                if not hmac.compare_digest(token_hash, _bearer(authorization)): raise AuthorityError('unauthorized')
                _require_clear()
            return self.issue(authorization)

    def revoke_all(self):
        with self._lock:
            for service in list(self._offline_services): service._retire_locked()
            self._generation += 1; self._leases.clear(); self._admissions.clear(); self._handles.clear()

    def save_legacy_hold(self, value):
        """Legacy management route authenticates before invoking this operation.

        Serialize hold publication with canonical commit. Even an exception may
        follow durable publication, so every attempt invalidates old capability.
        """
        with self._lock:
            try:
                return NativeLegacyStartup(deps.get_data_dir()).hold(value)
            finally:
                self.revoke_all()

    def bind_repository(self, authorization, lease_id, admission_id):
        with self._lock:
            self._lease(authorization, lease_id)
            admission = self._admissions.get(admission_id) if isinstance(admission_id, str) else None
            if not admission or admission['lease_id'] != lease_id: raise AuthorityError('unauthorized')
            return _RepositoryAuthority(self, authorization, lease_id, admission_id)

    def bind_initialization(self, authorization, lease_id):
        with self._lock:
            lease = self._lease(authorization, lease_id)
            return _InitializationAuthority(self, authorization, lease_id, lease['grant']['namespaceId'])

    def admit(self, authorization, lease_id, library_id):
        """The requested library is merely a selector; evidence comes from DB."""
        with self._lock:
            lease = self._lease(authorization,lease_id); _require_clear()
            with _existing(lease['path'],False) as db:
                if _current_grant(db) != lease['grant']: raise AuthorityError('lease-expired')
                proof = _proof(db,lease['grant']['namespaceId'],library_id)
            self._lease(authorization,lease_id)
            admission_id = secrets.token_urlsafe(32)
            self._admissions[admission_id] = {'lease_id':lease_id,'proof':deepcopy(proof)}
            return admission_id, deepcopy(proof['scope'])

    def admit_provider(self, authorization, lease_id, owner, scope):
        """Only host-created provider owners are accepted; no route-provided verifier."""
        from sidecar.provider.owner import ProviderOperationOwner
        if not isinstance(owner, ProviderOperationOwner) or owner._registry is not self or owner._lease_id != lease_id:
            raise AuthorityError('unauthorized')
        owner.verify_fresh()
        with owner.transaction('provider-read') as db:
            self._lease(authorization, lease_id)
            proof = _provider_proof(db, owner, deepcopy(scope))
            admission_id = secrets.token_urlsafe(32)
            self._admissions[admission_id] = {'lease_id': lease_id, 'proof': deepcopy(proof), 'provider_owner': owner}
        with self._lock:
            self._lease(authorization, lease_id)
            self._provider_principal = owner.principal_digest
            for service in list(self._offline_services): service._provider_admitted_locked(owner.principal_digest)
        return admission_id, deepcopy(proof['scope'])

    def _provider_captured_locked(self, owner):
        """Called while a real owner's verifier guard and this registry lock are held."""
        from sidecar.provider.owner import ProviderOperationOwner
        if not isinstance(owner, ProviderOperationOwner) or owner._registry is not self:
            raise AuthorityError('unauthorized')
        self._lease(owner._authorization, owner._lease_id)
        self._provider_principal = owner.principal_digest
        for service in list(self._offline_services): service._provider_admitted_locked(owner.principal_digest)

    def admit_offline(self, authorization, lease_id, owner, scope):
        """Accept only a decrypted, server-created offline owner, never a wire proof."""
        from sidecar.provider.offline.owner import OfflineOperationOwner
        if (not isinstance(owner, OfflineOperationOwner) or owner._registry is not self
                or owner._lease_id != lease_id or owner._authorization != authorization):
            raise AuthorityError('unauthorized')
        with owner.transaction('read') as db:
            self._lease(authorization, lease_id)
            proof = owner._check(db)
            if proof['scope'] != scope: raise AuthorityError('operation-denied')
            admission_id = secrets.token_urlsafe(32)
            self._admissions[admission_id] = {'lease_id': lease_id, 'proof': deepcopy(proof), 'offline_owner': owner}
        return admission_id, deepcopy(proof['scope'])

    def offline_handle(self, authorization, lease_id, owner, scope):
        admission_id, admitted = self.admit_offline(authorization, lease_id, owner, scope)
        self.release(authorization, lease_id, admission_id)
        with self._lock:
            lease = self._lease(authorization, lease_id)
            owner._memory()
            handle = secrets.token_urlsafe(32)
            self._handles[handle] = {'namespace': lease['grant']['namespaceId'], 'offline_owner': owner, 'scope': deepcopy(admitted)}
            return handle

    def provider_handle(self, authorization, lease_id, owner, scope):
        """Issue a selector only after fresh host-owned provider proof."""
        admission_id, admitted = self.admit_provider(authorization, lease_id, owner, scope)
        self.release(authorization, lease_id, admission_id)
        with self._lock:
            lease = self._lease(authorization, lease_id)
            handle = secrets.token_urlsafe(32)
            self._handles[handle] = {'namespace': lease['grant']['namespaceId'], 'provider_owner': owner, 'scope': deepcopy(admitted)}
            return handle

    def discover(self, authorization, lease_id):
        from papeer.core.bootstrap.canonical_initialization_sqlite import SqliteCanonicalInitialization
        with self._lock:
            bound = self.bind_initialization(authorization, lease_id)
            listed = SqliteCanonicalInitialization().list(bound)
            lease = self._lease(authorization, lease_id); libraries = []
            with self.transaction(authorization,lease_id,'bootstrap-list') as db:
                for profile in listed['profiles']:
                    # A provider-backed profile, even with the same account UUID,
                    # is reachable only through a fresh provider-bound admission.
                    if profile.get('remote') is not None:
                        continue
                    identity = profile['identity']; key = canonical_json([lease['grant']['namespaceId'],identity['libraryId']])
                    current = db.execute('SELECT payload FROM canonical_profiles WHERE identity=?',(key,)).fetchone()
                    if not current or json.loads(current[0]) != profile: raise AuthorityError('snapshot-changed')
                    try: _proof(db,lease['grant']['namespaceId'],identity['libraryId']); status,reason = 'available',None
                    except AuthorityError as error: status,reason = ('frozen' if str(error) == 'dataset-unavailable' else 'recovery-required'),str(error)
                    handle = secrets.token_urlsafe(32)
                    self._handles[handle] = {'namespace':lease['grant']['namespaceId'],'library':identity['libraryId']}
                    libraries.append({'handleId':handle,'title':profile['title'],'status':status,**({'reason':reason} if reason else {})})
            creations = []
            for intent in listed['intents']:
                request = intent['request']; outcome = intent['result'] or {'status':'pending'}
                creations.append({'requestId':intent['requestId'],'title':request['profile']['title'],'outcome':outcome})
            return {'libraries':libraries,'creations':creations,'canCreateLibrary':True}

    def inspect_handle(self, authorization, lease_id, handle_id):
        with self._lock:
            lease = self._lease(authorization,lease_id); handle = self._handles.get(handle_id) if isinstance(handle_id,str) else None
            if not handle or handle['namespace'] != lease['grant']['namespaceId']: raise AuthorityError('unauthorized')
            provider_owner = handle.get('provider_owner')
            offline_owner = handle.get('offline_owner')
        if offline_owner is not None:
            admission_id, scope = self.admit_offline(authorization, lease_id, offline_owner, handle['scope'])
        elif provider_owner is not None:
            admission_id, scope = self.admit_provider(authorization, lease_id, provider_owner, handle['scope'])
        else:
            admission_id, scope = self.admit(authorization, lease_id, handle['library'])
        return self.revalidate(authorization,lease_id,admission_id) | {'admissionId':admission_id,'scope':scope}

    def revalidate(self, authorization, lease_id, admission_id):
        with self._lock:
            lease = self._lease(authorization,lease_id)
            admission = self._admissions.get(admission_id) if isinstance(admission_id,str) else None
            if not admission or admission['lease_id'] != lease_id: raise AuthorityError('unauthorized')
            proof = deepcopy(admission['proof']); grant = deepcopy(lease['grant'])
        with self.transaction(authorization,lease_id,'read',admission_id=admission_id,scope=proof['scope']): pass
        with self._lock:
            self._lease(authorization,lease_id)
            if self._admissions.get(admission_id) is not admission: raise AuthorityError('unauthorized')
            fingerprint = hashlib.sha256(canonical_json([grant,proof]).encode('utf8')).hexdigest()
            return {'scope':deepcopy(proof['scope']),'peerId':proof['peer']['peerId'],'fingerprint':fingerprint,
                    'authorizationMode': 'provider-offline' if admission.get('offline_owner') is not None else 'provider-online' if admission.get('provider_owner') is not None else 'local'}

    def release(self, authorization, lease_id, admission_id=None):
        with self._lock:
            self._lease(authorization,lease_id)
            if admission_id is not None:
                admission = self._admissions.get(admission_id)
                if not admission or admission['lease_id'] != lease_id: raise AuthorityError('unauthorized')
                del self._admissions[admission_id]
            else:
                self._admissions = {k:v for k,v in self._admissions.items() if v['lease_id'] != lease_id}
                del self._leases[lease_id]

    @contextmanager
    def transaction(self, authorization, lease_id, operation, *, admission_id=None, scope=None):
        """Hold generation fence through same-connection checks and commit.

        Operation names must be selected by trusted server code, never request
        bodies. An unrecognized operation, cross-scope access or missing proof
        is rejected. No migration/transition privilege is issued here.
        """
        if operation not in _READ | _WRITE | _BOOTSTRAP_READ | _BOOTSTRAP_WRITE:
            raise AuthorityError('operation-denied')
        scope = deepcopy(scope)
        is_bootstrap = operation in _BOOTSTRAP_READ | _BOOTSTRAP_WRITE
        write = operation in _WRITE | _BOOTSTRAP_WRITE
        # Provider admission retains the host owner, and its verifier guard is
        # acquired before the registry lock through the whole SQLite commit.
        with self._lock:
            captured = self._admissions.get(admission_id) if isinstance(admission_id, str) else None
            provider_owner = captured.get('provider_owner') if captured else None
            offline_owner = captured.get('offline_owner') if captured else None
        if offline_owner is not None:
            captured = cast(dict, captured)
            if is_bootstrap or captured['lease_id'] != lease_id or scope != captured['proof']['scope']:
                raise AuthorityError('operation-denied')
            with offline_owner.transaction(operation) as db:
                def check_offline():
                    self._lease(authorization, lease_id)
                    if self._admissions.get(admission_id) is not captured or offline_owner._check(db) != captured['proof']:
                        raise AuthorityError('admission-changed')
                check_offline(); yield db; check_offline()
            return
        if provider_owner is not None:
            captured = cast(dict, captured)
            if is_bootstrap or captured['lease_id'] != lease_id or scope != captured['proof']['scope']:
                raise AuthorityError('operation-denied')
            with provider_owner.transaction('provider-write' if write else 'provider-read') as db:
                def check_provider():
                    self._lease(authorization, lease_id)
                    if self._admissions.get(admission_id) is not captured or _provider_proof(db, provider_owner, scope) != captured['proof']:
                        raise AuthorityError('admission-changed')
                check_provider(); yield db; check_provider()
            return
        with self._lock:
            lease = self._lease(authorization,lease_id)
            admission = None
            library_id = None
            if is_bootstrap:
                if admission_id is not None or scope is not None: raise AuthorityError('operation-denied')
            else:
                admission = self._admissions.get(admission_id) if isinstance(admission_id,str) else None
                if not admission or admission['lease_id'] != lease_id or scope != admission['proof']['scope']:
                    raise AuthorityError('operation-denied')
                library_id = admission['proof']['scope']['libraryId']  # == scope['libraryId'], checked above
            def check(db):
                self._lease(authorization,lease_id)
                _require_clear()
                if _current_grant(db) != lease['grant']: raise AuthorityError('lease-expired')
                if _schema_state(db) != 'ready': raise AuthorityError('recovery-required')
                if admission and _proof(db,lease['grant']['namespaceId'],library_id) != admission['proof']:
                    raise AuthorityError('admission-changed')
            with _existing(lease['path'],write) as db:
                check(db)
                yield db
                check(db)
            self._lease(authorization,lease_id)

# One authority per sidecar process. Restart discards all lease/admission IDs.
authority = NativeAuthority()
