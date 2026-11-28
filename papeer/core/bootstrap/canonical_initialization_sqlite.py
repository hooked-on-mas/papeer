"""Canonical bootstrap SQLite adapter with a host-bound transaction authority.

Each lease transaction checks the durable grant in the same snapshot and fences
generation through commit. The host binds this authority after bearer admission.
No token is persisted; schema creation is a separate explicit provision step.
"""
from contextlib import contextmanager
from copy import deepcopy
import json
from uuid import UUID
from papeer.core.bootstrap.canonical_bootstrap import admit_initial_library, assert_canonical_profile
from papeer.core.bootstrap.canonical_initialization_intent import make_initialization_intent, assert_initialization_intent
from papeer.core.edit_contracts import validate_canonicaldevicepeer, validate_canonicallibraryinitializationintent
from papeer.core.edit_model import canonical_json, reject
from papeer.core.edit_repository import SqliteEditRepository
from papeer.core.edits.datasets import assert_dataset_checkpoint
from papeer.core.edits.dataset_control import assert_dataset_control, assert_empty_initial_publication


class RetrySnapshot(Exception):
    """Read facts changed during outside-transaction validation; caller retries same request."""


def _id(value):
    if str(UUID(value)) != value:
        reject('invalid-id')


def _identity(identity):
    return canonical_json([identity['accountId'], identity['libraryId']])


def _receipt(profile):
    e = profile['initialization']
    return {'requestId':e['requestId'], 'identity':profile['identity'], 'initialScope':e['initialScope'], 'manifestId':e['manifestId'], 'peerId':e['peerId']}


def initialize_canonical_metadata(db):
    """Explicit provisioning only; caller owns an authorized write transaction."""
    db.execute('CREATE TABLE IF NOT EXISTS canonical_peers (account TEXT PRIMARY KEY, payload TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS canonical_profiles (identity TEXT PRIMARY KEY, account TEXT NOT NULL, library TEXT NOT NULL, request_id TEXT, payload TEXT NOT NULL, UNIQUE(account,request_id))')
    db.execute('CREATE TABLE IF NOT EXISTS canonical_initial_intents (account TEXT NOT NULL, request_id TEXT NOT NULL, library TEXT NOT NULL, retired INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(account,request_id))')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS canonical_intent_library ON canonical_initial_intents(account,library) WHERE retired=0')
    db.execute('CREATE TABLE IF NOT EXISTS canonical_initial_artifacts (identity TEXT PRIMARY KEY, payload TEXT NOT NULL)')


class SqliteCanonicalInitialization:

    @contextmanager
    def _write(self, lease, operation):
        with lease.transaction(operation) as db:
            yield db

    def get_or_create_peer(self, lease, candidate_peer_id):
        _id(candidate_peer_id)
        with self._write(lease, 'bootstrap-peer') as db:
            row = db.execute('SELECT payload FROM canonical_peers WHERE account=?', (lease.account_id,)).fetchone()
            if row:
                peer = json.loads(row[0]); validate_canonicaldevicepeer(peer)
                if peer['accountId'] != lease.account_id: reject('recovery-required')
            else:
                peer = {'version':1, 'accountId':lease.account_id, 'peerId':candidate_peer_id}
                validate_canonicaldevicepeer(peer)
                db.execute('INSERT INTO canonical_peers VALUES(?,?)', (lease.account_id, canonical_json(peer)))
        lease.assert_current()
        return peer

    def _lookup(self, db, account, request_id):
        row = db.execute('SELECT payload FROM canonical_initial_intents WHERE account=? AND request_id=?', (account,request_id)).fetchone()
        intent = json.loads(row[0]) if row else None
        if intent:
            validate_canonicallibraryinitializationintent(intent)
            if intent['accountId'] != account or intent['requestId'] != request_id: reject('recovery-required')
        row = db.execute('SELECT payload FROM canonical_profiles WHERE account=? AND request_id=?', (account,request_id)).fetchone()
        profile = json.loads(row[0]) if row else None
        if profile:
            assert_canonical_profile(profile)
            if profile['identity']['accountId'] != account or profile['origin']['kind'] != 'local-initialize' or not profile['initialization'] or profile['initialization']['requestId'] != request_id: reject('recovery-required')
        if intent and intent.get('result') and intent['result']['status'] == 'accepted' and not profile: reject('recovery-required')
        if profile: self._accepted_snapshot(db, profile)
        if intent and profile:
            evidence = profile['initialization']
            if (intent['requestSha256'] != evidence['requestSha256'] or intent.get('retired') or not intent['result']
                    or intent['result'] != {'status':'accepted','receipt':_receipt(profile)}
                    or intent['request']['profile']['identity'] != profile['identity']): reject('recovery-required')
        return intent, profile

    @staticmethod
    def _accepted_snapshot(db, profile):
        identity = profile['identity']; evidence = profile['initialization']; key = _identity(identity)
        row = db.execute('SELECT payload FROM canonical_initial_artifacts WHERE identity=?', (key,)).fetchone()
        if not row: reject('recovery-required')
        try:
            artifacts = json.loads(row[0]); root = artifacts['root']; checkpoint = artifacts['checkpoint']; manifest = artifacts['manifest']
            if (manifest['id'] != evidence['manifestId'] or manifest['scope'] != evidence['initialScope']
                    or manifest['scope']['accountId'] != identity['accountId'] or manifest['scope']['libraryId'] != identity['libraryId']
                    or checkpoint['libraryId'] != identity['libraryId'] or checkpoint['roots'] != [root]):
                reject('recovery-required')
            scope = canonical_json([identity['accountId'],identity['libraryId'],manifest['scope']['epoch']])
            saved_root = db.execute('SELECT payload FROM edit_roots WHERE scope=? AND target=?',(scope,identity['libraryId'])).fetchone()
            saved_manifest = db.execute('SELECT payload FROM edit_datasets WHERE scope=? AND id=?',(scope,manifest['id'])).fetchone()
            marker = db.execute('SELECT 1 FROM edit_checkpoints WHERE scope=? AND sha256=?',(scope,manifest['checkpointSha256'])).fetchone()
            if not saved_root or not saved_manifest or not marker or json.loads(saved_root[0]) != root or json.loads(saved_manifest[0]) != manifest:
                reject('recovery-required')
            control_row = db.execute('SELECT payload FROM edit_dataset_controls WHERE identity=?', (key,)).fetchone()
            if not control_row: reject('recovery-required')
            control = json.loads(control_row[0]); assert_dataset_control(control, identity)
            return {'artifacts':artifacts,'control':control}

        except (KeyError, TypeError, ValueError):
            reject('recovery-required')

    def _validated_lookup(self, db, account, request_id):
        # Called under a consistent read transaction, never inside a write transaction.
        intent, profile = self._lookup(db, account, request_id)
        if intent:
            try: assert_initialization_intent(intent)
            except (ValueError, KeyError, TypeError): reject('recovery-required')
        proof = self._accepted_snapshot(db, profile) if profile else None
        if proof:
            publication = proof['artifacts']
            try:
                assert_dataset_checkpoint(publication['manifest'], publication['checkpoint'], publication['manifest']['scope'])
                assert_empty_initial_publication(publication)
            except (ValueError, KeyError, TypeError):
                reject('recovery-required')
        return intent, profile, proof

    def list(self, lease):
        lease.assert_current()
        with lease.transaction('bootstrap-list') as db:
            rows = db.execute('SELECT account,request_id,library,payload FROM canonical_initial_intents WHERE account=? AND retired=0 ORDER BY request_id', (lease.account_id,)).fetchall()
            values = []
            for account, request_id, library, payload in rows:
                value = json.loads(payload); assert_initialization_intent(value)
                if (account != lease.account_id or value['accountId'] != account or value['requestId'] != request_id
                        or value.get('retired') or value['request']['profile']['identity'] != {'accountId':account,'libraryId':library}):
                    reject('recovery-required')
                if value['result'] and value['result']['status'] == 'accepted':
                    self._validated_lookup(db,account,request_id)
                values.append(value)
            profiles = []
            for account, library, identity, payload in db.execute('SELECT account,library,identity,payload FROM canonical_profiles WHERE account=? ORDER BY library', (lease.account_id,)):
                profile = json.loads(payload); assert_canonical_profile(profile)
                if account != lease.account_id or profile['identity'] != {'accountId':account,'libraryId':library} or identity != _identity(profile['identity']):
                    reject('recovery-required')
                profiles.append(profile)
        lease.assert_current(); return {'profiles':profiles, 'intents':values}

    def query(self, lease, request_id):
        _id(request_id); lease.assert_current()
        with lease.transaction('bootstrap-query') as db:
            intent, profile, _ = self._validated_lookup(db, lease.account_id, request_id)
            result = self._outcome(intent, profile)
        lease.assert_current(); return result

    @staticmethod
    def _outcome(intent, profile):
        if profile: return {'status':'accepted','receipt':_receipt(profile)}
        if not intent: return {'status':'not-found'}
        return deepcopy(intent['result']) if intent['result'] else {'status':'pending'}

    def prepare(self, lease, request):
        intent = make_initialization_intent(request, lease.account_id)
        library = intent['request']['profile']['identity']['libraryId']; request_id = intent['requestId']
        lease.assert_current()
        with lease.transaction('bootstrap-snapshot') as db:
            captured = self._validated_lookup(db,lease.account_id,request_id)
        if captured[0]: assert_initialization_intent(captured[0])
        with self._write(lease, 'bootstrap-prepare') as db:
            existing, profile = self._lookup(db, lease.account_id, request_id)
            proof = self._accepted_snapshot(db,profile) if profile else None
            if (existing,profile,proof) != captured: raise RetrySnapshot()
            if existing or profile:
                if existing:
                    digest = existing['requestSha256']
                    identity = existing.get('identity', existing.get('request', {}).get('profile', {}).get('identity'))
                else:
                    if profile is None: reject('recovery-required')
                    digest = profile['initialization']['requestSha256']
                    identity = profile['identity']
                if digest != intent['requestSha256'] or identity != intent['request']['profile']['identity']: reject('dataset-request-reused')
                result = self._outcome(existing, profile)
            else:
                row = db.execute('SELECT request_id FROM canonical_initial_intents WHERE account=? AND library=? AND retired=0', (lease.account_id,library)).fetchone()
                if row: reject('dataset-library-request-pending')
                db.execute('INSERT INTO canonical_initial_intents VALUES(?,?,?,?,?)', (lease.account_id,request_id,library,0,canonical_json(intent)))
                result = {'status':'pending'}
        lease.assert_current(); return result

    def _snapshot(self, db, account, request_id, request):
        identity = request['profile']['identity']; key = _identity(identity); library = identity['libraryId']
        def get(sql, args):
            row = db.execute(sql,args).fetchone(); return json.loads(row[0]) if row else None
        peer = get('SELECT payload FROM canonical_peers WHERE account=?',(account,))
        intent, profile_by_request = self._lookup(db,account,request_id)
        profile = get('SELECT payload FROM canonical_profiles WHERE identity=?',(key,))
        control = get('SELECT payload FROM edit_dataset_controls WHERE identity=?',(key,))
        artifacts = get('SELECT payload FROM canonical_initial_artifacts WHERE identity=?',(key,))
        tables = ('edit_roots','edit_batches','edit_projections','edit_projection_pages','edit_publications','edit_resources','edit_resource_bytes','edit_checkpoints','edit_intents','edit_datasets')
        footprint = []
        for table in tables:
            for row in db.execute("SELECT * FROM " + table + " WHERE json_extract(scope,'$[0]')=? AND json_extract(scope,'$[1]')=?", (account,library)):
                scope = json.loads(row[0])
                if scope[:2] == [account,library]: footprint.append([table,*[(v.hex() if isinstance(v,bytes) else v) for v in row]])
        footprint.sort(key=canonical_json)
        physical = True
        if artifacts:
            manifest, root = artifacts['manifest'], artifacts['root']
            scope = canonical_json([account,library,manifest['scope']['epoch']])
            actual_root = get('SELECT payload FROM edit_roots WHERE scope=? AND target=?',(scope,library))
            actual_manifest = get('SELECT payload FROM edit_datasets WHERE scope=? AND id=?',(scope,manifest['id']))
            marker = db.execute('SELECT 1 FROM edit_checkpoints WHERE scope=? AND sha256=?',(scope,manifest['checkpointSha256'])).fetchone()
            physical = actual_root == root and actual_manifest == manifest and marker is not None
        return {'physicalInitialArtifacts':physical,'peer':peer,'intent':intent,'profileByRequest':profile_by_request,'profile':profile,'control':control,'artifacts':artifacts,'footprint':footprint}

    def execute(self, lease, request_id):
        _id(request_id); lease.assert_current()
        with lease.transaction('bootstrap-snapshot') as db:
            intent, profile, _ = self._validated_lookup(db,lease.account_id,request_id)
            outcome = self._outcome(intent,profile)
            if outcome['status'] != 'pending': lease.assert_current(); return outcome
            if intent is None: reject('recovery-required')
            snapshot = self._snapshot(db,lease.account_id,request_id,intent['request'])
        lease.assert_current()
        assert_initialization_intent(intent)  # crypto outside the write transaction
        request = deepcopy(intent['request']); artifacts = snapshot['artifacts']
        if artifacts and not snapshot['physicalInitialArtifacts']: reject('recovery-required')
        state = {'peer':snapshot['peer'],'profile':snapshot['profile'],'control':snapshot['control'],
                 'root':artifacts['root'] if artifacts else None,'checkpoint':artifacts['checkpoint'] if artifacts else None,
                 'manifest':artifacts['manifest'] if artifacts else None,'otherLibraryState':bool(snapshot['footprint']),
                 'requestIdUsedByOtherIdentity':bool(snapshot['profileByRequest'] and snapshot['profileByRequest']['identity'] != request['profile']['identity'])}
        try:
            decision = admit_initial_library(request,lease.account_id,state) # outside write transaction
        except ValueError as error:
            # Only a confirmed request-ID collision is definitive; all other errors preserve pending.
            if str(error) != 'dataset-request-reused': raise
            with self._write(lease, 'bootstrap-execute') as db:
                if self._snapshot(db,lease.account_id,request_id,request) != snapshot: raise RetrySnapshot() from error
                intent['result']={'status':'rejected','reason':'dataset-request-reused'}
                db.execute('UPDATE canonical_initial_intents SET payload=? WHERE account=? AND request_id=?',(canonical_json(intent),lease.account_id,request_id))
            lease.assert_current(); return deepcopy(intent['result'])
        with self._write(lease, 'bootstrap-execute') as db:
            if self._snapshot(db,lease.account_id,request_id,request) != snapshot: raise RetrySnapshot()
            if decision['kind'] == 'create':
                publication = request['control']['transition']['publication']; manifest=publication['manifest']; checkpoint=publication['checkpoint']
                scope=manifest['scope']; repo=SqliteEditRepository.__new__(SqliteEditRepository)
                repo.scope=scope; repo.namespace=canonical_json([scope['accountId'],scope['libraryId'],scope['epoch']]); repo.identity=_identity(scope)
                repo._install_checkpoint_in(db,checkpoint,manifest['checkpointSha256'])
                db.execute('INSERT INTO edit_datasets VALUES(?,?,?)',(repo.namespace,manifest['id'],canonical_json(manifest)))
                control=request['control']; db.execute('INSERT INTO edit_dataset_controls VALUES(?,?,?,?,?,?)',(repo.identity,canonical_json(control),scope['epoch'],None,0,canonical_json(control['epochs'])))
                profile=decision['profile']; db.execute('INSERT INTO canonical_profiles VALUES(?,?,?,?,?)',(repo.identity,lease.account_id,scope['libraryId'],request_id,canonical_json(profile)))
                initial={'root':checkpoint['roots'][0],'checkpoint':checkpoint,'manifest':manifest}
                db.execute('INSERT INTO canonical_initial_artifacts VALUES(?,?)',(repo.identity,canonical_json(initial)))
            intent['result']={'status':'accepted','receipt':decision['receipt']}
            db.execute('UPDATE canonical_initial_intents SET payload=? WHERE account=? AND request_id=?',(canonical_json(intent),lease.account_id,request_id))
        lease.assert_current(); return deepcopy(intent['result'])

    def acknowledge(self, lease, request_id):
        _id(request_id); lease.assert_current()
        with lease.transaction('bootstrap-snapshot') as db:
            captured = self._validated_lookup(db,lease.account_id,request_id)
        if captured[0]: assert_initialization_intent(captured[0])
        with self._write(lease, 'bootstrap-acknowledge') as db:
            intent, profile = self._lookup(db,lease.account_id,request_id)
            proof = self._accepted_snapshot(db,profile) if profile else None
            if (intent,profile,proof) != captured: raise RetrySnapshot()
            if not intent or intent.get('retired'): return
            if not intent['result']: reject('initialization-pending')
            if intent['result']['status'] == 'accepted':
                if not profile: reject('recovery-required')
                db.execute('DELETE FROM canonical_initial_intents WHERE account=? AND request_id=?',(lease.account_id,request_id))
            else:
                retired={'version':1,'accountId':lease.account_id,'requestId':request_id,'requestSha256':intent['requestSha256'],'identity':intent['request']['profile']['identity'],'result':intent['result'],'retired':True}
                db.execute('UPDATE canonical_initial_intents SET retired=1,payload=? WHERE account=? AND request_id=?',(canonical_json(retired),lease.account_id,request_id))
        lease.assert_current()
