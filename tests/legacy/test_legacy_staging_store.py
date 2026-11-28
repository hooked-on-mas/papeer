"""Work B7-c: the staging store of the Native legacy conversion (synthetic, isolated data only; DESIGN-r161-b7-staging.md 3.2-3.3, 4, 5).

ST-1 schema and location, ST-2 run row and manifest, ST-3 operation allowlist, ST-4 scope, ST-5 absent, ST-6 uninitialized,
ST-7 resumable phases and the only complete state, ST-8 every diagnostic-required cause, ST-9 orphaned, ST-10 closed vocabularies,
ST-11 `staging_status` writes nothing, ST-12 links and junctions. Nothing here opens a Library, a canonical store or a backup:
the staging folder is made beside a plain temporary folder named like a Library, and the "writer" states are made by direct SQL
on that disposable file (B7-f owns the real writer).
"""
import ast
from contextlib import closing, contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

import pytest

from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_repository import SqliteEditRepository
from papeer.core.edit_storage import edit_storage_root
from papeer.core.edits.datasets import checkpoint_hash
from papeer.core.migrations import legacy_staging_store as store

FOLDER = Path(__file__).resolve().parents[1] / 'fixtures'
FIXTURE = json.loads((FOLDER / 'shared-edits.json').read_text('utf-8'))
LIB = FIXTURE['libraryId']
RUN = '3f1c9a52-0b7e-4d6a-9c1f-5a2e8b7d4c10'
OTHER_RUN = '9b2d4e60-1a3c-4f58-8e7d-6c0a5b1f2e34'
ACCOUNT = 'native-local'
SCOPE = store.staging_scope(ACCOUNT, LIB, RUN)
PLAN_UNITS = [{'seq': n, 'unitKind': 'document', 'targetId': f'00000000-0000-0000-0000-00000000010{n}', 'payloadSha256': str(n) * 64}
              for n in (1, 2)]
PLAN = {'units': PLAN_UNITS, 'residualReasons': ['uncollected-source'], 'notConverted': []}


@pytest.fixture(autouse=True)
def relaxed_phases(request, monkeypatch):
    """These tests fabricate states of the writer by hand (a checkpoint at `initialized`, a resource at `planned`). The real phase gate of
    the authority (work B7-f, REVIEW-r161-b7c low 2) is exercised by the tests that ask for the `real_phases` fixture."""
    if 'real_phases' not in request.fixturenames:
        monkeypatch.setattr(store, 'WRITE_PHASES', {})


@pytest.fixture
def real_phases():
    yield


def manifest(run_id=RUN, **changes):
    """A sealed manifest of the B6 shape (the parts the staging store looks at)."""
    body = {'version': 1, 'scope': store.MANIFEST_SCOPE, 'runId': run_id, 'peerId': '5d1e0c3a-7b2f-4a96-8d4e-1f0b9c8a7e65',
            'libraryId': LIB, 'journalRecordSha256': 'a' * 64, 'selectionSha256': 'c' * 64, 'inputSetSha256': 'b' * 64,
            'sources': [], 'inventory': {'reportSha256': 'd' * 64, 'summary': {}}, 'sqlite': None, 'notebooks': [],
            'wholeLibrary': {'status': 'refused', 'reasons': ['uncollected-source']}}
    body.update(changes)
    return {**body, 'manifestSha256': edit_content_hash(body)}


def library(tmp_path):
    root = tmp_path / 'library'
    root.mkdir()
    return root


def initialized(tmp_path, run_id=RUN, **changes):
    root = library(tmp_path) if not (tmp_path / 'library').exists() else tmp_path / 'library'
    store.initialize_run(root, run_id, account_id=ACCOUNT, manifest=manifest(run_id, **changes))
    return root


def database(root, run_id=RUN):
    return store.staging_folder(root, run_id) / store.DB_NAME


@contextmanager
def raw(root, run_id=RUN):
    """The staging DB as a test tampers with it (a plain connection: foreign keys off, no CHECK bypass)."""
    with closing(sqlite3.connect(database(root, run_id), timeout=30)) as db:
        yield db
        db.commit()


def state_of(root, run_id=RUN, **options):
    return store.staging_status(root, run_id, **options)


def repository(root, run_id=RUN, scope=None, current=lambda: None):
    scope = scope or store.staging_scope(ACCOUNT, LIB, run_id)
    return SqliteEditRepository(store.StagingAuthority(root, run_id, scope, current), scope)


def tree(folder):
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(Path(folder).iterdir()) if path.is_file()}


def fixture_resource(repo):
    value = FIXTURE['resource']['metadata']
    return repo.store_resource(value['id'], value['sha256'], value['mediaType'], (FOLDER / FIXTURE['resource']['file']).read_bytes(), value)


# ST-1 ------------------------------------------------------------------------------------------
def test_location_is_a_folder_beside_the_library_and_apart_from_canonical_and_backups(tmp_path):
    root = library(tmp_path)
    base = store.staging_base(root)
    assert base == root.resolve().parent / '.library-shared-app-staging'
    assert store.staging_folder(root, RUN) == base / RUN
    assert base != edit_storage_root(root) and base.name != '.library-shared-app-backups' and not base.is_relative_to(root.resolve())
    assert not base.exists(), 'computing a location creates nothing'
    initialized(tmp_path)
    assert (base / RUN / store.DB_NAME).is_file()
    assert sorted(path.name for path in tmp_path.iterdir()) == ['.library-shared-app-staging', 'library']
    assert not edit_storage_root(root).exists() and list(root.iterdir()) == []


def test_schema_is_exactly_the_edit_tables_and_the_staging_tables(tmp_path):
    root = initialized(tmp_path)
    assert len(store.EDIT_TABLES) == 11
    with raw(root) as db:
        db.execute('PRAGMA foreign_keys=ON')       # before any statement: it is ignored inside a transaction
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND substr(name, 1, 7) <> 'sqlite_'")}
        assert tables == set(store.EDIT_TABLES) | set(store.STAGING_TABLES)
        assert not any(name.startswith(('canonical_', 'cloud_', 'provider_')) for name in tables)
        assert store._schema_of(db) == store.expected_schema()
        # `publishable` cannot be stored: the CHECK constraint is part of the schema.
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE migration_staging_run SET phase='publishable'")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute('UPDATE migration_staging_run SET version=2')
        assert 'publishable' not in store.PHASES and store.PHASES[-1] == 'staged'
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO migration_staging_plan VALUES('not-a-run','{}')")
        for table in ('edit_dataset_controls', 'edit_batches', 'edit_intents', 'edit_publications', 'edit_datasets', 'edit_roots'):
            assert db.execute(f'SELECT COUNT(*) FROM {table}').fetchone() == (0,)


def test_connection_is_wal_full_sync_and_foreign_keys_and_rolls_back_on_error(tmp_path):
    root = initialized(tmp_path)
    with store.staging_connection(root, RUN) as db:
        assert db.execute('PRAGMA journal_mode').fetchone() == ('wal',)
        assert db.execute('PRAGMA synchronous').fetchone() == (2,)
        assert db.execute('PRAGMA foreign_keys').fetchone() == (1,)
        assert db.in_transaction
    with pytest.raises(RuntimeError):
        with store.staging_connection(root, RUN) as db:
            db.execute("UPDATE migration_staging_run SET converter_version='changed'")
            raise RuntimeError('boom')
    assert store.read_run_record(root, RUN)['converterVersion'] == store.CONVERTER_VERSION
    # Nothing is created unless creation is asked for.
    with pytest.raises(ValueError) as error:
        with store.staging_connection(root, OTHER_RUN):
            pytest.fail('a missing staging must not open')
    assert error.value.args == ('staging-state-unavailable',) and not store.staging_folder(root, OTHER_RUN).exists()


# ST-2 ------------------------------------------------------------------------------------------
def test_the_run_row_keeps_the_whole_sealed_manifest_and_the_scope_is_derived(tmp_path):
    value = manifest()
    root = library(tmp_path)
    record = store.initialize_run(root, RUN, account_id=ACCOUNT, manifest=value)
    assert record['phase'] == 'initialized' and record['scope'] == {'accountId': ACCOUNT, 'libraryId': LIB, 'epoch': 'legacy-' + RUN}
    assert record['scope']['epoch'] == 'legacy-' + RUN and len(record['scope']['epoch']) <= 200
    assert (record['planSha256'], record['checkpointSha256'], record['reportSha256']) == (None, None, None)
    assert store.read_run_record(root, RUN) == record
    with raw(root) as db:
        row = db.execute('SELECT version, scope, manifest, manifest_sha256, journal_record_sha256, input_set_sha256, converter_version, phase '
                         'FROM migration_staging_run').fetchall()
    assert len(row) == 1 and row[0][0] == 1 and json.loads(row[0][1]) == record['scope']
    assert json.loads(row[0][2]) == value and row[0][3] == value['manifestSha256']
    assert row[0][2] == store.canonical_json(value) and row[0][4:] == ('a' * 64, 'b' * 64, 'b7-v1', 'initialized')
    body = {key: item for key, item in json.loads(row[0][2]).items() if key != 'manifestSha256'}
    assert edit_content_hash(body) == row[0][3], 'the stored seal is recomputed from the stored manifest, not copied'
    # The scope does not depend on the root, the time or a random value: a second, separate staging has the same scope.
    other = tmp_path / 'elsewhere'
    other.mkdir()
    (other / 'library').mkdir()
    assert store.initialize_run(other / 'library', RUN, account_id=ACCOUNT, manifest=value)['scope'] == record['scope']


@pytest.mark.parametrize('changes', [
    {'scope': 'native-legacy-preview'}, {'version': 2}, {'runId': OTHER_RUN}, {'libraryId': 'not-an-id'},
    {'journalRecordSha256': 'A' * 64}, {'inputSetSha256': 'b' * 63}, {'wholeLibrary': {'status': 'accepted', 'reasons': []}},
    {'wholeLibrary': None}])
def test_an_unsealed_or_unexpected_manifest_creates_nothing(tmp_path, changes):
    root = library(tmp_path)
    body = manifest()
    body = {key: item for key, item in body.items() if key != 'manifestSha256'}
    body.update(changes)
    resealed = {**body, 'manifestSha256': edit_content_hash(body)}
    with pytest.raises(ValueError) as error:
        store.initialize_run(root, RUN, account_id=ACCOUNT, manifest=resealed)
    assert error.value.args == ('staging-input-changed',)
    assert not store.staging_base(root).exists(), 'a refused manifest creates no folder'


def test_a_manifest_whose_body_changed_after_sealing_is_refused(tmp_path):
    root = library(tmp_path)
    value = manifest()
    for tampered in ({**value, 'notebooks': [{'x': 1}]}, {**value, 'manifestSha256': 'e' * 64},
                     {key: item for key, item in value.items() if key != 'manifestSha256'}, 'not a manifest', None):
        with pytest.raises(ValueError) as error:
            store.initialize_run(root, RUN, account_id=ACCOUNT, manifest=tampered)
        assert error.value.args == ('staging-input-changed',)
    assert not store.staging_base(root).exists()
    with pytest.raises(ValueError) as error:
        store.initialize_run(root, 'not-a-run-id C:\\private', account_id=ACCOUNT, manifest=value)
    assert error.value.args == ('staging-input-changed',)
    with pytest.raises(ValueError) as error:
        store.initialize_run(root, RUN, account_id='', manifest=value)
    assert error.value.args == ('staging-state-unavailable',)
    assert not store.staging_base(root).exists()


def test_resume_needs_the_same_manifest_converter_and_plan_and_trusts_no_stored_value(tmp_path):
    root = initialized(tmp_path)
    record = store.read_run_record(root, RUN)
    store.assert_resumable(record, manifest())                                  # the rebuilt manifest equals the stored one
    for changed in (manifest(peerId='6e2f1d4b-8c3a-4b07-9e5f-2a1c0d9b8f76'), manifest(notebooks=[{'a': 1}]),
                    manifest(journalRecordSha256='9' * 64), manifest(inputSetSha256='8' * 64)):
        with pytest.raises(ValueError) as error:
            store.assert_resumable(record, changed)
        assert error.value.args == ('staging-input-changed',)
    with pytest.raises(ValueError) as error:
        store.assert_resumable(record, manifest(), converter_version='b7-v2')
    assert error.value.args == ('staging-converter-changed',)
    store.assert_resumable(record, manifest(), plan_sha256='f' * 64)           # no plan yet: nothing to compare
    with raw(root) as db:
        db.execute('UPDATE migration_staging_run SET plan_sha256=?', ('1' * 64,))
    record = store.read_run_record(root, RUN)
    store.assert_resumable(record, manifest(), plan_sha256='1' * 64)
    with pytest.raises(ValueError) as error:
        store.assert_resumable(record, manifest(), plan_sha256='2' * 64)
    assert error.value.args == ('staging-plan-changed',)
    # A stored manifest that no longer matches its own seal is a diagnostic, never a resume.
    with raw(root) as db:
        db.execute('UPDATE migration_staging_run SET manifest=?', (store.canonical_json({**manifest(), 'notebooks': [1]}),))
    with pytest.raises(ValueError) as error:
        store.read_run_record(root, RUN)
    assert error.value.args == ('staging-diagnostic-required',)


def test_initialization_is_one_transaction_and_a_database_with_any_table_is_never_initialized_again(tmp_path, monkeypatch):
    root = library(tmp_path)
    real = store.initialize_staging_schema

    def then_fail(db):
        real(db)
        raise RuntimeError('crash after the schema')

    monkeypatch.setattr(store, 'initialize_staging_schema', then_fail)
    with pytest.raises(RuntimeError):
        store.initialize_run(root, RUN, account_id=ACCOUNT, manifest=manifest())
    monkeypatch.setattr(store, 'initialize_staging_schema', real)
    assert state_of(root)['state'] == 'uninitialized', 'P1: the folder exists and the database has no table (the DDL was rolled back too)'
    store.initialize_run(root, RUN, account_id=ACCOUNT, manifest=manifest())      # P1 is initialized again
    assert state_of(root)['state'] == 'resumable'
    before = database(root).read_bytes()
    with pytest.raises(ValueError) as error:
        store.initialize_run(root, RUN, account_id=ACCOUNT, manifest=manifest())
    assert error.value.args == ('staging-diagnostic-required',)
    assert database(root).read_bytes() == before


# ST-3 ------------------------------------------------------------------------------------------
def test_the_allowlist_is_every_repository_operation_that_stores_resources_or_reads(tmp_path):
    source = (Path(__file__).resolve().parents[2] / 'papeer' / 'core' / 'edit_repository.py').read_text('utf-8')
    found = set(re.findall(r"_transaction\('([a-z-]+)'\)", source))
    assert found == store.REPOSITORY_OPERATIONS and len(found) == 22, 'a new repository operation must be classified here'
    assert store.ALLOWED_OPERATIONS == {'store-resource', 'install-checkpoint', 'checkpoint', 'read', 'read-resource',
                                        'resource-metadata', 'datasets', 'dataset-control'}
    assert store.ALLOWED_OPERATIONS < store.REPOSITORY_OPERATIONS


def test_every_operation_is_denied_except_the_allowlist_and_a_denial_touches_nothing(tmp_path):
    root = initialized(tmp_path)
    repo = repository(root)
    before = tree(store.staging_folder(root, RUN))
    for operation in sorted(store.REPOSITORY_OPERATIONS):
        if operation in store.ALLOWED_OPERATIONS:
            with repo._transaction(operation) as db:
                assert db.execute('SELECT COUNT(*) FROM migration_staging_run').fetchone() == (1,)
        else:
            with pytest.raises(ValueError) as error:
                with repo._transaction(operation):
                    pytest.fail('a denied operation must not open a transaction')
            assert error.value.args == ('staging-operation-denied',), operation
    for operation in (None, 5, ['read'], b'read', 'READ', 'read ', ''):
        with pytest.raises(ValueError) as error:
            with repo.authority.transaction(operation, SCOPE):
                pytest.fail('not an operation')
        assert error.value.args == ('staging-operation-denied',)
    assert tree(store.staging_folder(root, RUN)).get(store.DB_NAME) == before[store.DB_NAME], 'the allowed no-op transactions wrote nothing'


def test_the_real_repository_methods_store_a_resource_and_read_but_never_edit_publish_or_install(tmp_path):
    root = initialized(tmp_path)
    repo = repository(root)
    metadata = fixture_resource(repo)
    assert repo.resource_metadata(metadata['id']) == metadata and repo.read_resource(metadata['id'])['metadata'] == metadata
    assert repo.checkpoint() == {'version': 1, 'libraryId': LIB, 'roots': [], 'edits': []}
    assert repo.installed_datasets() == [] and repo.dataset_control() is None
    record = FIXTURE['editRecords'][0]
    assert repo.commit(record['batch'], record['history']) == {'status': 'aborted', 'reason': 'staging-operation-denied'}
    for call in (lambda: repo.initialize(FIXTURE['document']), lambda: repo.replace_intent(FIXTURE['document']['id'], None, None),
                 lambda: repo.acknowledge(record['batch']['id']), lambda: repo.receive_records([record]), repo.pending, repo.pending_records,
                 repo.pending_publications, repo.pending_intents, lambda: repo.receipt(record['batch']['id']),
                 lambda: repo.read_intent(FIXTURE['document']['id'])):
        with pytest.raises(ValueError) as error:
            call()
        assert error.value.args == ('staging-operation-denied',)
    with raw(root) as db:
        for table in store.FORBIDDEN_ROW_TABLES + ('edit_roots',):
            assert db.execute(f'SELECT COUNT(*) FROM {table}').fetchone() == (0,), table
    state = state_of(root)
    assert state['state'] == 'resumable' and state['counts']['resources'] == 1 and state['counts']['roots'] == 0


def test_a_bundled_step_is_part_of_the_same_transaction(tmp_path):
    """The writer writes the ID and provenance rows with the resource, atomically (a resource without its provenance cannot exist)."""
    root = initialized(tmp_path)
    auth = store.StagingAuthority(root, RUN, SCOPE, lambda: None)
    repo = SqliteEditRepository(auth, SCOPE)
    seen = []

    def write_the_rows(operation, db):
        seen.append(operation)
        if operation == 'store-resource':
            db.execute('INSERT INTO migration_staging_ids VALUES(?,?,?,?)', (RUN, 'resource', 'pdf:1', FIXTURE['resource']['metadata']['id']))
            db.execute('INSERT INTO migration_staging_provenance VALUES(?,?,?,?,?,?,?,?)',
                       (RUN, 'resource', FIXTURE['resource']['metadata']['id'], 'file', 'pdf:1', '1' * 64, store.CONVERTER_VERSION, 'b' * 64))

    with auth.bundled(write_the_rows):
        fixture_resource(repo)
        assert repo.checkpoint()['roots'] == []
    assert seen == ['store-resource']                                  # a read (`checkpoint`) never runs a step (REVIEW-r161-b7c low 3)
    counts = state_of(root)['counts']
    assert (counts['resources'], counts['ids'], counts['provenance']) == (1, 1, 1) and state_of(root)['state'] == 'resumable'
    fixture_resource(repo)                                             # no step any more: nothing more is written
    assert seen == ['store-resource'] and state_of(root)['counts']['ids'] == 1
    # A step that fails takes the resource with it; a refused operation never reaches a step.
    other = initialized(tmp_path, OTHER_RUN)
    auth2 = store.StagingAuthority(other, OTHER_RUN, store.staging_scope(ACCOUNT, LIB, OTHER_RUN), lambda: None)
    repo2 = SqliteEditRepository(auth2, store.staging_scope(ACCOUNT, LIB, OTHER_RUN))

    def fails(operation, _db):
        raise RuntimeError('crash between the resource and its provenance')

    with auth2.bundled(fails):
        with pytest.raises(RuntimeError):
            fixture_resource(repo2)
        with pytest.raises(ValueError) as error:
            repo2.pending()
        assert error.value.args == ('staging-operation-denied',)
    assert state_of(other, OTHER_RUN)['counts']['resources'] == 0 and repository(other, OTHER_RUN).resource_metadata(FIXTURE['resource']['metadata']['id']) is None
    with pytest.raises(ValueError):
        with auth.bundled('not callable'):
            pass


# ST-4 ------------------------------------------------------------------------------------------
def test_only_the_staging_scope_is_accepted(tmp_path):
    root = initialized(tmp_path)
    auth = store.StagingAuthority(root, RUN, SCOPE, lambda: None)
    malformed = ({**SCOPE, 'epoch': 'dataset'}, {**SCOPE, 'epoch': 'legacy-' + OTHER_RUN}, {**SCOPE, 'extra': 'x'}, {'accountId': ACCOUNT}, None, 'legacy')
    for other in (*malformed, {**SCOPE, 'accountId': 'controlled-copy-local'}, {**SCOPE, 'libraryId': OTHER_RUN}):
        with pytest.raises(ValueError) as error:
            with auth.transaction('read', other):
                pytest.fail('another scope must not open')
        assert error.value.args == ('staging-operation-denied',)
    for other in malformed:
        with pytest.raises(ValueError) as error:
            store.StagingAuthority(root, RUN, other, lambda: None)
        assert error.value.args == ('staging-operation-denied',), other
    with pytest.raises(ValueError):
        store.StagingAuthority(root, RUN, SCOPE, 'not callable')
    with pytest.raises(ValueError):
        store.StagingAuthority(root, 'bad', SCOPE, lambda: None)
    # A repository built for a different epoch is refused by the authority, whatever the caller calls it.
    wrong = {**SCOPE, 'epoch': 'dataset'}
    with pytest.raises(ValueError) as error:
        SqliteEditRepository(auth, wrong).checkpoint()
    assert error.value.args == ('staging-operation-denied',)
    # An authority made for another account does not match this database's run row.
    foreign = store.StagingAuthority(root, RUN, store.staging_scope('controlled-copy-local', LIB, RUN), lambda: None)
    with pytest.raises(ValueError) as error:
        with foreign.transaction('read', store.staging_scope('controlled-copy-local', LIB, RUN)):
            pytest.fail('not this DB')
    assert error.value.args == ('staging-state-unavailable',)


def test_a_lapsed_admission_stops_the_authority_and_rolls_back_the_transaction(tmp_path):
    root = initialized(tmp_path)
    calls = []

    def lapses_on_the_second_call():
        calls.append(1)
        if len(calls) >= 2:
            raise ValueError('staging-cancelled')

    repo = repository(root, current=lapses_on_the_second_call)
    value = FIXTURE['resource']['metadata']
    with pytest.raises(ValueError) as error:
        fixture_resource(repo)
    assert error.value.args == ('staging-cancelled',) and len(calls) == 2, 'checked before the transaction and again before it commits'
    assert repository(root).resource_metadata(value['id']) is None, 'the resource of the lapsed transaction was rolled back'
    dead = repository(root, current=lambda: (_ for _ in ()).throw(ValueError('staging-state-unavailable')))
    with pytest.raises(ValueError) as error:
        dead.checkpoint()
    assert error.value.args == ('staging-state-unavailable',)


# ST-5 / ST-6 -----------------------------------------------------------------------------------
def test_absent_creates_nothing_and_an_invalid_id_is_one_closed_refusal(tmp_path):
    root = library(tmp_path)
    for run_id in (RUN, OTHER_RUN):
        result = state_of(root, run_id)
        assert (result['state'], result['phase'], result['complete'], result['counts'], result['reasons']) == ('absent', None, False, None, [])
        assert result['version'] == 1 and result['scope'] == store.STATUS_SCOPE and result['runId'] == run_id
    assert not store.staging_base(root).exists() and list(tmp_path.iterdir()) == [root]
    initialized(tmp_path)
    assert state_of(root, OTHER_RUN)['state'] == 'absent', 'another run is not affected by this run folder'
    for bad in ('x', '../' + RUN, 'C:\\private\\' + RUN, None, 5, RUN.upper()):
        with pytest.raises(ValueError) as error:
            state_of(root, bad)
        assert error.value.args == ('staging-state-unavailable',)
        with pytest.raises(ValueError):
            store.staging_folder(root, bad)


def test_uninitialized_is_a_folder_without_a_database_or_a_database_without_a_table(tmp_path):
    root = library(tmp_path)
    folder = store.staging_folder(root, RUN)
    folder.mkdir(parents=True)
    assert state_of(root)['state'] == 'uninitialized' and state_of(root)['phase'] is None
    database(root).write_bytes(b'')
    assert state_of(root)['state'] == 'uninitialized', 'a zero-byte database has no table'
    database(root).unlink()
    with closing(sqlite3.connect(database(root))) as db:
        db.execute('PRAGMA user_version=7')
    assert state_of(root)['state'] == 'uninitialized', 'a database that holds only a header has no table (P1)'
    with closing(sqlite3.connect(database(root))) as db:
        db.execute('CREATE TABLE anything(x)')
    result = state_of(root)
    assert result['state'] == 'diagnostic-required' and 'schema-mismatch' in result['reasons'], 'one table that is not ours is not P1'


# ST-7 ------------------------------------------------------------------------------------------
def advance(root, run_id=RUN, **fields):
    with raw(root, run_id) as db:
        db.execute('UPDATE migration_staging_run SET ' + ', '.join(f'{key}=?' for key in fields), tuple(fields.values()))


def put_unit(root, entry):
    with raw(root) as db:
        db.execute('INSERT INTO migration_staging_units VALUES(?,?,?,?,?,?)',
                   (RUN, entry['seq'], entry['unitKind'], entry['targetId'], '{}', entry['payloadSha256']))


def test_each_phase_is_resumable_and_only_staged_is_complete(tmp_path):
    root = initialized(tmp_path)
    repo = repository(root)

    def expect(phase, **counts):
        result = state_of(root)
        assert result['state'] == ('staged' if phase == 'staged' else 'resumable'), result
        assert result['phase'] == phase and result['complete'] == (phase == 'staged') and result['reasons'] == []
        assert {key: result['counts'][key] for key in counts} == counts, result['counts']
        return result

    expect('initialized', resources=0, plan=0, units=0, roots=0, checkpoints=0)             # P2
    fixture_resource(repo)
    expect('initialized', resources=1)                                                      # P3: resources are stored one at a time
    advance(root, phase='resources')
    expect('resources', resources=1, plan=0)
    with raw(root) as db:
        db.execute('INSERT INTO migration_staging_plan VALUES(?,?)', (RUN, store.canonical_json(PLAN)))
    advance(root, phase='planned', plan_sha256=edit_content_hash(PLAN))
    expect('planned', plan=1, units=0)                                                      # P5
    put_unit(root, PLAN_UNITS[0])
    expect('planned', units=1)                                                              # P6
    put_unit(root, PLAN_UNITS[1])
    advance(root, phase='units')
    expect('units', units=2, checkpoints=0, roots=0)
    checkpoint = {**FIXTURE['checkpoint'], 'edits': []}
    repo.install_checkpoint(checkpoint)
    result = expect('units', checkpoints=1)                                                 # P7: installed, T_asm not yet written
    assert result['counts']['roots'] == len(checkpoint['roots'])
    advance(root, phase='assembled', checkpoint_sha256=checkpoint_hash(checkpoint))
    expect('assembled', checkpoints=1)                                                      # P8
    verification = {'version': 1, 'ok': True}
    with raw(root) as db:
        db.execute('INSERT INTO migration_staging_verification VALUES(?,?,?)', (RUN, store.canonical_json(verification), edit_content_hash(verification)))
    advance(root, phase='verified')
    expect('verified', verification=1)                                                      # P9
    advance(root, phase='staged', report_sha256='7' * 64)
    result = expect('staged', verification=1)
    assert result['state'] == 'staged' and result['complete'] is True and 'publishable' not in json.dumps(result)


# ST-8 ------------------------------------------------------------------------------------------
def assembled(root):
    """A consistent `assembled` staging (made by direct SQL and the real repository) that the diagnostic cases then damage."""
    repo = repository(root)
    fixture_resource(repo)
    with raw(root) as db:
        db.execute('INSERT INTO migration_staging_plan VALUES(?,?)', (RUN, store.canonical_json(PLAN)))
    for entry in PLAN_UNITS:
        put_unit(root, entry)
    checkpoint = {**FIXTURE['checkpoint'], 'edits': []}
    repo.install_checkpoint(checkpoint)
    advance(root, phase='assembled', plan_sha256=edit_content_hash(PLAN), checkpoint_sha256=checkpoint_hash(checkpoint))
    assert state_of(root)['state'] == 'resumable'
    return checkpoint


NAMESPACE = json.dumps([ACCOUNT, LIB, 'legacy-' + RUN], ensure_ascii=False, separators=(',', ':'))


def _sql(statement, *args):
    def run(root, _checkpoint):
        with raw(root) as db:
            db.execute(statement, args)
    return run


def _unit(entry):
    return lambda root, _checkpoint: put_unit(root, entry)


def _drop_a_staging_table(root, _checkpoint):
    with raw(root) as db:
        db.execute('DROP TABLE migration_staging_verification')


def _unconstrained_ids(root, _checkpoint):
    with raw(root) as db:
        db.execute('DROP TABLE migration_staging_ids')
        db.execute('CREATE TABLE migration_staging_ids (run_id TEXT, kind TEXT, source_key TEXT, target_id TEXT)')


def _garbage(root, _checkpoint):
    database(root).write_bytes(b'this is not a database ' * 400)


def _damaged_pages(root, _checkpoint):
    path = database(root)
    data = bytearray(path.read_bytes())
    assert len(data) > 12288
    data[4096:12288] = b'\xff' * 8192
    path.write_bytes(bytes(data))


def _damaged_overflow_chain(root, _checkpoint):
    """Break the pointer of an overflow page of a stored resource: the status never reads a resource's bytes, so nothing but
    `quick_check` can see it (reads of every table still work)."""
    body = b''.join(b'MARK-%04d' % number + b'.' * 3000 for number in range(20))
    repository(root).store_resource('1f2e3d4c-5b6a-4879-8a9b-0c1d2e3f4a5b', hashlib.sha256(body).hexdigest(), 'application/octet-stream', body)
    with raw(root) as db:
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    data = bytearray(database(root).read_bytes())
    size = int.from_bytes(data[16:18], 'big') or 65536
    position = bytes(data).find(b'MARK-0010')
    assert position > size, 'the marker must be inside an overflow page, not in the first page of the row'
    page = position // size * size
    data[page:page + 4] = b'\x7f\xff\xff\xff'
    database(root).write_bytes(bytes(data))


def _extra_file(root, _checkpoint):
    (store.staging_folder(root, RUN) / 'notes.txt').write_text('x', 'utf-8')


def _wal_alone(root, _checkpoint):
    database(root).unlink()
    (store.staging_folder(root, RUN) / (store.DB_NAME + '-wal')).write_bytes(b'')


def _second_checkpoint(root, _checkpoint):
    with raw(root) as db:
        db.execute('INSERT INTO edit_checkpoints VALUES(?,?)', (NAMESPACE, 'f' * 64))


def _verification(report, digest):
    def run(root, _checkpoint):
        with raw(root) as db:
            db.execute('INSERT INTO migration_staging_verification VALUES(?,?,?)', (RUN, report, digest))
    return run


def _plan_text(text):
    return lambda root, _checkpoint: _sql('UPDATE migration_staging_plan SET plan=?', text)(root, _checkpoint)


def _forbidden(table, row):
    def run(root, _checkpoint):
        with raw(root) as db:
            db.execute(f'INSERT INTO {table} VALUES({",".join("?" * len(row))})', row)
    return run


def _remove(statement):
    return lambda root, _checkpoint: _sql(statement)(root, _checkpoint)


CAUSES = {
    'quick-check-garbage': (_garbage, {'database-unreadable', 'quick-check-failed'}),
    'quick-check-pages': (_damaged_pages, {'database-unreadable', 'quick-check-failed'}),
    'quick-check-overflow-chain': (_damaged_overflow_chain, {'quick-check-failed'}),
    'schema-extra-table': (_sql('CREATE TABLE extra(x)'), {'schema-mismatch'}),
    'schema-extra-index': (_sql('CREATE INDEX extra_index ON edit_resources(id)'), {'schema-mismatch'}),
    'schema-extra-trigger': (_sql('CREATE TRIGGER extra_trigger BEFORE INSERT ON edit_roots BEGIN SELECT 1; END'), {'schema-mismatch'}),
    'schema-dropped-table': (_drop_a_staging_table, {'schema-mismatch'}),
    'schema-without-constraints': (_unconstrained_ids, {'schema-mismatch'}),
    'run-row-missing': (_remove('DELETE FROM migration_staging_run'), {'run-row-missing'}),
    'run-row-twice': (_sql("INSERT INTO migration_staging_run SELECT ?, version, scope, manifest, manifest_sha256, journal_record_sha256, "
                           "input_set_sha256, converter_version, phase, plan_sha256, checkpoint_sha256, report_sha256 FROM migration_staging_run", OTHER_RUN),
                          {'run-row-invalid'}),
    'run-row-id': (_sql('UPDATE migration_staging_run SET run_id=?', OTHER_RUN), {'run-row-invalid'}),
    'run-row-hash-type': (_sql('UPDATE migration_staging_run SET plan_sha256=5'), {'run-row-invalid'}),
    'run-row-hash-shape': (_sql("UPDATE migration_staging_run SET report_sha256='XYZ'"), {'run-row-invalid'}),
    'run-row-empty-converter': (_sql("UPDATE migration_staging_run SET converter_version=''"), {'run-row-invalid'}),
    'run-row-scope': (_sql("UPDATE migration_staging_run SET scope=?", json.dumps({'accountId': ACCOUNT, 'libraryId': LIB, 'epoch': 'dataset'})), {'run-row-invalid'}),
    'run-row-blob': (_sql("UPDATE migration_staging_run SET input_set_sha256=x'00'"), {'run-row-invalid'}),
    'manifest-text': (_sql("UPDATE migration_staging_run SET manifest='[1]'"), {'manifest-invalid'}),
    'manifest-seal': (_sql('UPDATE migration_staging_run SET manifest_sha256=?', 'e' * 64), {'manifest-invalid'}),
    'manifest-journal': (_sql('UPDATE migration_staging_run SET journal_record_sha256=?', 'e' * 64), {'manifest-invalid'}),
    'phase-before-plan': (_sql("UPDATE migration_staging_run SET phase='planned', plan_sha256=NULL"), {'phase-mismatch'}),
    'plan-before-phase': (_sql("UPDATE migration_staging_run SET phase='resources'"), {'phase-mismatch'}),
    'report-before-staged': (_sql("UPDATE migration_staging_run SET report_sha256=?", '7' * 64), {'phase-mismatch'}),
    'roots-without-checkpoint': (_remove('DELETE FROM edit_checkpoints'), {'phase-mismatch'}),
    'checkpoint-without-roots': (_remove('DELETE FROM edit_roots'), {'checkpoint-mismatch'}),
    'plan-not-json': (_plan_text('not json'), {'plan-invalid'}),
    'plan-hash': (_plan_text(store.canonical_json({**PLAN, 'residualReasons': []})), {'plan-invalid'}),
    'plan-shape': (_plan_text(store.canonical_json({'units': [{'seq': 1}]})), {'plan-invalid'}),
    'unit-not-in-plan': (_unit({'seq': 9, 'unitKind': 'document', 'targetId': '00000000-0000-0000-0000-000000000199', 'payloadSha256': '9' * 64}),
                         {'unit-plan-mismatch'}),
    'unit-payload-differs': (_sql("UPDATE migration_staging_units SET payload_sha256=? WHERE seq=1", '0' * 64), {'unit-plan-mismatch'}),
    'units-fewer-than-plan': (_remove('DELETE FROM migration_staging_units WHERE seq=2'), {'unit-plan-mismatch'}),
    'multiple-checkpoints': (_second_checkpoint, {'multiple-checkpoints'}),
    'checkpoint-hash': (_sql('UPDATE migration_staging_run SET checkpoint_sha256=?', '6' * 64), {'checkpoint-mismatch'}),
    'verification-too-early': (_verification('{}', edit_content_hash({})), {'verification-invalid'}),
    'foreign-scope-resource': (_forbidden('edit_resources', ('["x","y","z"]', 'id', '{}')), {'foreign-scope'}),
    'foreign-scope-bytes': (_forbidden('edit_resource_bytes', (NAMESPACE + ' ', 'a' * 64, b'x')), {'foreign-scope'}),
    'foreign-run-ids': (_forbidden('migration_staging_ids', (OTHER_RUN, 'k', 's', 't')), {'foreign-scope'}),
    'forbidden-batch': (_forbidden('edit_batches', (NAMESPACE, 'b', 't', '{}', '{}', None)), {'forbidden-rows'}),
    'forbidden-intent': (_forbidden('edit_intents', (NAMESPACE, 't', '{}')), {'forbidden-rows'}),
    'forbidden-publication': (_forbidden('edit_publications', (NAMESPACE, 'p', '{}')), {'forbidden-rows'}),
    'forbidden-dataset': (_forbidden('edit_datasets', (NAMESPACE, 'd', '{}')), {'forbidden-rows'}),
    'forbidden-control': (_forbidden('edit_dataset_controls', ('["a","b"]', '{}', None, None, 0, '[]')), {'forbidden-rows'}),
    'unexpected-file': (_extra_file, {'unexpected-entries'}),
    'wal-without-database': (_wal_alone, {'unexpected-entries'}),
    'foreign-key': (_sql("INSERT INTO migration_staging_ids VALUES(?,?,?,?)", OTHER_RUN, 'k', 's', 't'), {'foreign-key-violation', 'foreign-scope'}),
}


@pytest.mark.parametrize('cause', sorted(CAUSES))
def test_everything_that_cannot_be_classified_is_diagnostic_required_never_resumable(tmp_path, cause):
    root = initialized(tmp_path)
    checkpoint = assembled(root)
    damage, expected = CAUSES[cause]
    damage(root, checkpoint)
    result = state_of(root)
    assert result['state'] == 'diagnostic-required', result
    assert result['complete'] is False and expected & set(result['reasons']), result      # one of the acceptable causes
    assert set(result['reasons']) <= set(store.DIAGNOSTIC_REASONS)
    assert not any(token in json.dumps(result) for token in (str(tmp_path), 'Traceback', 'sqlite3.'))
    # A staging with any damage is neither resumed nor initialized again: the one writer entry that exists refuses it.
    if database(root).exists():
        before = database(root).read_bytes()
        with pytest.raises(ValueError) as error:
            store.initialize_run(root, RUN, account_id=ACCOUNT, manifest=manifest())
        assert error.value.args == ('staging-diagnostic-required',) and database(root).read_bytes() == before


def lightly(root, *, phase, plan=True, plan_hash=True, units=0, checkpoint=False):
    """A run with no roots (made by direct SQL) in which exactly one thing disagrees with its phase."""
    if plan:
        with raw(root) as db:
            db.execute('INSERT INTO migration_staging_plan VALUES(?,?)', (RUN, store.canonical_json(PLAN)))
    for entry in PLAN_UNITS[:units]:
        put_unit(root, entry)
    advance(root, phase=phase, **({'plan_sha256': edit_content_hash(PLAN)} if plan_hash else {}))
    if checkpoint:
        repo = repository(root)
        fixture_resource(repo)
        repo.install_checkpoint({**FIXTURE['checkpoint'], 'edits': []})


ISOLATED = {
    'plan-row-before-the-planned-phase': (dict(phase='resources', plan_hash=False), {'phase-mismatch'}),
    'planned-without-a-plan-row': (dict(phase='planned', plan=False), {'phase-mismatch'}),
    'planned-without-a-plan-hash': (dict(phase='planned', plan_hash=False), {'phase-mismatch'}),
    'units-before-the-planned-phase': (dict(phase='resources', plan=False, plan_hash=False, units=1), {'phase-mismatch'}),
    'a-checkpoint-and-roots-before-the-units-phase': (dict(phase='planned', units=2, checkpoint=True), {'phase-mismatch'}),
    'a-checkpoint-hash-before-assembly': (dict(phase='units', units=2), {'checkpoint-mismatch'}),
    'units-phase-with-fewer-units': (dict(phase='units', units=1), {'unit-plan-mismatch'}),
    'planned-with-all-its-units-is-resumable': (dict(phase='planned', units=2), None),
}


@pytest.mark.parametrize('name', sorted(ISOLATED))
def test_a_phase_and_its_rows_must_agree_in_both_directions(tmp_path, name):
    """Each case is a single disagreement on an otherwise consistent run, so no other check can be the one that notices it."""
    root = initialized(tmp_path)
    options, expected = ISOLATED[name]
    lightly(root, **options)
    if name == 'a-checkpoint-hash-before-assembly':
        advance(root, checkpoint_sha256='6' * 64)
    result = state_of(root)
    if expected is None:                                         # the control: units 0..total with phase planned is a legal P6
        assert result['state'] == 'resumable' and result['phase'] == 'planned'
        return
    assert result['state'] == 'diagnostic-required' and expected <= set(result['reasons']), result
    assert not (set(result['reasons']) - expected - {'plan-invalid'}), result


def test_the_phase_counts_of_a_staged_run_are_checked_too(tmp_path):
    root = initialized(tmp_path)
    assembled(root)
    verification = {'version': 1}
    with raw(root) as db:
        db.execute('INSERT INTO migration_staging_verification VALUES(?,?,?)', (RUN, store.canonical_json(verification), 'f' * 64))
    advance(root, phase='verified')
    assert 'verification-invalid' in state_of(root)['reasons'], 'a verification report must match its own hash'
    with raw(root) as db:
        db.execute('UPDATE migration_staging_verification SET report_sha256=?', (edit_content_hash(verification),))
    assert state_of(root)['state'] == 'resumable'
    advance(root, phase='staged')
    assert 'phase-mismatch' in state_of(root)['reasons'], 'staged needs the report hash'
    advance(root, report_sha256='7' * 64)
    assert state_of(root)['state'] == 'staged'


# ST-9 ------------------------------------------------------------------------------------------
def test_a_staging_of_another_run_is_orphaned_and_is_only_read(tmp_path):
    root = initialized(tmp_path, OTHER_RUN)
    folder = store.staging_folder(root, OTHER_RUN)
    before = tree(folder)
    result = state_of(root, OTHER_RUN, hold_run_id=RUN)
    assert result['state'] == 'orphaned' and result['underlying'] == 'resumable' and result['phase'] == 'initialized' and not result['complete']
    assert state_of(root, OTHER_RUN, hold_run_id=None)['state'] == 'orphaned', 'no hold at all: still not the current run'
    assert state_of(root, OTHER_RUN, hold_run_id=OTHER_RUN)['state'] == 'resumable'
    assert state_of(root, OTHER_RUN)['state'] == 'resumable'
    assert state_of(root, RUN, hold_run_id=OTHER_RUN)['state'] == 'absent', 'nothing is made up for a missing folder'
    advance(root, OTHER_RUN, phase='staged', report_sha256='7' * 64)       # claims to be staged, but has no plan or units: not classifiable
    damaged = state_of(root, OTHER_RUN, hold_run_id=RUN)
    assert damaged['state'] == 'orphaned' and damaged['complete'] is False and damaged['underlying'] == 'diagnostic-required'
    assert folder.is_dir() and database(root, OTHER_RUN).is_file(), 'an orphan is never deleted'
    assert before[store.DB_NAME]


def test_staging_runs_lists_the_run_folders_and_counts_anything_else(tmp_path):
    root = library(tmp_path)
    assert store.staging_runs(root) == {'runIds': [], 'unexpected': 0}
    initialized(tmp_path)
    initialized(tmp_path, OTHER_RUN)
    base = store.staging_base(root)
    (base / 'stray-folder').mkdir()
    (base / 'stray.txt').write_text('x', 'utf-8')
    assert store.staging_runs(root) == {'runIds': sorted([RUN, OTHER_RUN]), 'unexpected': 2}


# ST-10 -----------------------------------------------------------------------------------------
def test_the_vocabularies_are_closed():
    assert store.REASONS == tuple('staging-' + name for name in (
        'busy', 'shutdown-pending', 'cancelled', 'capacity-exceeded', 'disk-insufficient', 'state-unavailable', 'source-changed',
        'library-lock-unavailable', 'other-writer-present', 'instance-writer-unverified', 'input-changed', 'converter-changed',
        'plan-changed', 'unit-conflict', 'id-changed', 'id-collision', 'resource-mismatch', 'verification-failed',
        'provenance-incomplete', 'diagnostic-required', 'orphaned', 'operation-denied', 'not-publishable', 'unavailable',
        'rows-not-listable', 'plan-rejected'))                      # the last two were added by work B7-f
    assert len(set(store.REASONS)) == len(store.REASONS) and len(set(store.DIAGNOSTIC_REASONS)) == len(store.DIAGNOSTIC_REASONS)
    assert store.PHASES == ('initialized', 'resources', 'planned', 'units', 'assembled', 'verified', 'staged')
    assert store.CONVERTER_VERSION == 'b7-v1' and store.SCOPE == 'native-legacy-staging-v1'
    # The module defines no ValueError subclass (tests/test_sidecar_errors.py) and never writes a file with write_text/write_bytes.
    source = Path(store.__file__).read_text('utf-8')
    classes = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.ClassDef)]
    assert classes and not any(isinstance(base, ast.Name) and base.id.endswith('Error') for node in classes for base in node.bases)
    assert '.write_text(' not in source and '.write_bytes(' not in source


# ST-11 -----------------------------------------------------------------------------------------
def test_status_writes_nothing_except_what_a_read_only_wal_open_may_create_inside_the_staging_folder(tmp_path, record_property):
    root = initialized(tmp_path)
    fixture_resource(repository(root))
    folder = store.staging_folder(root, RUN)
    database_before = database(root).read_bytes()
    stat_before = database(root).stat().st_mtime_ns
    names_before = sorted(path.name for path in folder.iterdir())
    outside_before = sorted(path.name for path in tmp_path.rglob('*') if not path.is_relative_to(folder))
    for _ in range(3):
        assert state_of(root)['state'] == 'resumable'
        assert state_of(root, hold_run_id=OTHER_RUN)['state'] == 'orphaned'
        assert store.read_run_record(root, RUN)['phase'] == 'initialized'
    assert database(root).read_bytes() == database_before and database(root).stat().st_mtime_ns == stat_before
    # SQLite may create or rewrite the -shm (and an empty -wal) beside a WAL database it opens: recorded, never anything else.
    names_after = sorted(path.name for path in folder.iterdir())
    record_property('folder_before_status', json.dumps(names_before))        # what SQLite really leaves behind is kept in the junit record
    record_property('folder_after_status', json.dumps([[path.name, path.stat().st_size] for path in sorted(folder.iterdir())]))
    assert set(names_after) <= {store.DB_NAME, store.DB_NAME + '-wal', store.DB_NAME + '-shm'}, names_after
    assert set(names_before) <= set(names_after)
    assert sorted(path.name for path in tmp_path.rglob('*') if not path.is_relative_to(folder)) == outside_before
    for path in folder.iterdir():
        if path.name.endswith('-wal'):
            assert path.stat().st_size == 0, 'a WAL file that a status left behind holds nothing'
    # Absent and uninitialized runs are not created by a status either.
    other = tmp_path / 'second'
    other.mkdir()
    (other / 'library').mkdir()
    assert state_of(other / 'library')['state'] == 'absent' and not store.staging_base(other / 'library').exists()


# ST-12 -----------------------------------------------------------------------------------------
def junction(link, target):
    """A directory junction (no privilege needed on Windows) or, elsewhere, a symlink."""
    if sys.platform == 'win32':
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    else:
        os.symlink(target, link, target_is_directory=True)


def unlink_link(path):
    try:
        os.rmdir(path)
    except OSError:
        os.unlink(path)


def test_a_linked_staging_root_or_run_folder_is_refused_and_nothing_is_created_through_it(tmp_path):
    root = library(tmp_path)
    elsewhere = tmp_path / 'elsewhere'
    elsewhere.mkdir()
    base = store.staging_base(root)
    junction(base, elsewhere)
    assert store._kind(base) == 'link'
    result = state_of(root)
    assert result['state'] == 'diagnostic-required' and result['reasons'] == ['link-refused']
    with pytest.raises(ValueError) as error:
        store.initialize_run(root, RUN, account_id=ACCOUNT, manifest=manifest())
    assert error.value.args == ('staging-diagnostic-required',)
    with pytest.raises(ValueError):
        store.staging_runs(root)
    assert list(elsewhere.iterdir()) == [], 'nothing was written through the link'
    unlink_link(base)
    # The run folder itself is a link.
    base.mkdir()
    junction(base / RUN, elsewhere)
    assert state_of(root)['reasons'] == ['link-refused']
    with pytest.raises(ValueError) as error:
        with store.staging_connection(root, RUN, create=True):
            pytest.fail('a linked run folder must not open')
    assert error.value.args == ('staging-diagnostic-required',) and list(elsewhere.iterdir()) == []
    unlink_link(base / RUN)


def test_a_linked_database_file_is_refused(tmp_path):
    root = initialized(tmp_path)
    target = tmp_path / 'target.sqlite3'
    database(root).replace(target)
    try:
        os.symlink(target, database(root))
    except (OSError, NotImplementedError):
        pytest.skip('symbolic links need a privilege on this machine')
    assert state_of(root)['reasons'] == ['link-refused']
    with pytest.raises(ValueError) as error:
        with store.staging_connection(root, RUN):
            pytest.fail('a linked database must not open')
    assert error.value.args == ('staging-diagnostic-required',)


# ST-13 .. ST-17: work B7-f (the hand-over of REVIEW-r161-b7c low 1-4, and the writer's own rows) -------------
def test_st13_an_object_whose_name_only_looks_like_sqlite_internal_is_a_schema_mismatch(tmp_path):
    """Low 1: `NOT LIKE 'sqlite_%'` let `sqlitex_hidden` (`_` matches any character) and a trigger `sqlite1trig` out of the comparison."""
    root = initialized(tmp_path)
    assert state_of(root)['state'] == 'resumable'
    with raw(root) as db:
        db.execute('CREATE TABLE sqlitex_hidden (a)')
    result = state_of(root)
    assert result['state'] == 'diagnostic-required' and result['reasons'] == ['schema-mismatch']
    with raw(root) as db:
        db.execute('DROP TABLE sqlitex_hidden')
        db.execute('CREATE TRIGGER sqlite1trig AFTER INSERT ON edit_roots BEGIN SELECT 1; END')
    assert state_of(root)['reasons'] == ['schema-mismatch']
    with raw(root) as db:
        db.execute('DROP TRIGGER sqlite1trig')
    assert state_of(root)['state'] == 'resumable'                       # and nothing else was left behind


def test_st14_a_resource_and_the_checkpoint_are_written_only_in_their_own_phase(tmp_path, real_phases):
    """Low 2: the authority reads the phase. `staged` and `planned` runs never take a resource, a run without all its units no checkpoint."""
    root = initialized(tmp_path)
    repo = repository(root)
    checkpoint = {**FIXTURE['checkpoint'], 'edits': []}

    def denied(call):
        with pytest.raises(ValueError) as error:
            call()
        assert error.value.args == ('staging-operation-denied',)

    denied(lambda: repo.install_checkpoint(checkpoint))                 # `initialized`: the units are not all there
    fixture_resource(repo)                                              # but a resource is welcome
    assert state_of(root)['counts']['resources'] == 1 and state_of(root)['counts']['roots'] == 0
    for phase in ('resources', 'planned'):
        advance(root, phase=phase, **({'plan_sha256': edit_content_hash(PLAN)} if phase == 'planned' else {}))
        with raw(root) as db:
            if phase == 'planned':
                db.execute('INSERT INTO migration_staging_plan VALUES(?,?)', (RUN, store.canonical_json(PLAN)))
        denied(lambda: fixture_resource(repo))                          # a resource after the resources phase
        denied(lambda: repo.install_checkpoint(checkpoint))
    for entry in PLAN_UNITS:
        put_unit(root, entry)
    advance(root, phase='units')
    denied(lambda: fixture_resource(repo))
    repo.install_checkpoint(checkpoint)                                 # `units`: the one moment
    assert state_of(root)['counts']['checkpoints'] == 1
    assert repo.checkpoint()['roots'] and repo.read_resource(FIXTURE['resource']['metadata']['id']) is not None       # reads work in every phase
    advance(root, phase='assembled', checkpoint_sha256=checkpoint_hash(checkpoint))
    denied(lambda: repo.install_checkpoint(checkpoint))
    assert state_of(root)['state'] == 'resumable' and state_of(root)['phase'] == 'assembled'


def test_st15_a_write_that_leaves_an_edit_or_a_forbidden_row_behind_never_commits(tmp_path, real_phases):
    """Low 3 and 4: a step (or a checkpoint with edits) cannot reach a forbidden table; the transaction is rolled back, nothing stays."""
    root = initialized(tmp_path)
    auth = store.StagingAuthority(root, RUN, SCOPE, lambda: None)
    repo = SqliteEditRepository(auth, SCOPE)

    def writes_a_batch(operation, db):
        if operation == 'store-resource':
            db.execute("INSERT INTO edit_batches VALUES(?,?,?,?,?,NULL)", (store._namespace(SCOPE), 'b', 't', '{}', '{}'))

    with auth.bundled(writes_a_batch):
        with pytest.raises(ValueError) as error:
            fixture_resource(repo)
    assert error.value.args == ('staging-operation-denied',)
    assert state_of(root)['counts']['resources'] == 0 and state_of(root)['state'] == 'resumable'
    for table in store.FORBIDDEN_ROW_TABLES:
        with raw(root) as db:
            assert db.execute(f'SELECT COUNT(*) FROM {table}').fetchone() == (0,)
    # A checkpoint that carries edits goes through the repository, which writes the batch; the authority refuses to commit it.
    fixture_resource(repo)
    for entry in PLAN_UNITS:
        put_unit(root, entry)
    advance(root, phase='units', plan_sha256=edit_content_hash(PLAN))
    with raw(root) as db:
        db.execute('INSERT INTO migration_staging_plan VALUES(?,?)', (RUN, store.canonical_json(PLAN)))
    assert FIXTURE['checkpoint']['edits'], 'the fixture checkpoint carries edits'
    with pytest.raises(ValueError) as error:
        repo.install_checkpoint(FIXTURE['checkpoint'])
    assert error.value.args == ('staging-operation-denied',)
    assert state_of(root)['counts']['checkpoints'] == 0 and state_of(root)['counts']['roots'] == 0
    for table in store.FORBIDDEN_ROW_TABLES:
        with raw(root) as db:
            assert db.execute(f'SELECT COUNT(*) FROM {table}').fetchone() == (0,)


def test_st16_the_writers_rows_move_the_phase_forward_one_step_and_overwrite_nothing(tmp_path):
    root = initialized(tmp_path)
    scope = SCOPE
    payloads = {entry['targetId']: {'kind': 'unit', 'n': entry['seq']} for entry in PLAN_UNITS}
    units = [{**entry, 'payload': payloads[entry['targetId']], 'payloadSha256': edit_content_hash(payloads[entry['targetId']])} for entry in PLAN_UNITS]
    plan = {'units': [{key: unit[key] for key in ('seq', 'unitKind', 'targetId', 'payloadSha256')} for unit in units], 'residualReasons': []}

    def refused(call, reason='staging-operation-denied'):
        with pytest.raises(ValueError) as error:
            call()
        assert error.value.args == (reason,)

    with store.staging_connection(root, RUN) as db:
        refused(lambda: store.advance_phase(db, RUN, 'initialized', 'planned'))               # a phase is never skipped
        refused(lambda: store.advance_phase(db, RUN, 'resources', 'planned'))                  # nor taken from the wrong one
        refused(lambda: store.advance_phase(db, RUN, 'resources', 'initialized'))              # nor set back
        refused(lambda: store.advance_phase(db, RUN, 'initialized', 'resources', report_sha256='xyz'))
        refused(lambda: store.advance_phase(db, RUN, 'initialized', 'resources', version=2))
        refused(lambda: store.put_plan(db, RUN, plan, [], [], manifest_sha256='b' * 64))      # not before `resources`
        refused(lambda: store.put_verification(db, RUN, {'ok': True}))
        refused(lambda: store.seal_run(db, RUN))
        store.advance_phase(db, RUN, 'initialized', 'resources')
        ids = [{'kind': 'pdf-document', 'source': ['a'], 'targetId': 'id-1'}]
        row = {'targetKind': 'document', 'targetId': 'id-1', 'sourceKind': 'file', 'sourceKey': ['papers', 'a'], 'sourceSha256': '1' * 64}
        store.put_ids(db, RUN, ids)
        store.put_provenance(db, RUN, [row], manifest_sha256='b' * 64)
        store.put_ids(db, RUN, ids)                                                            # the same entry again: kept
        store.put_provenance(db, RUN, [row], manifest_sha256='b' * 64)
        refused(lambda: store.put_ids(db, RUN, [{**ids[0], 'targetId': 'id-2'}]), 'staging-id-changed')      # the same source, another target
        refused(lambda: store.put_ids(db, RUN, [{**ids[0], 'source': ['b']}]), 'staging-id-collision')     # another source, the same target
        refused(lambda: store.put_ids(db, RUN, [{'kind': 'x'}]), 'staging-id-collision')
        refused(lambda: store.put_provenance(db, RUN, [{**row, 'sourceSha256': '2' * 64}], manifest_sha256='b' * 64), 'staging-id-changed')
        refused(lambda: store.put_provenance(db, RUN, [{**row, 'extra': 1}], manifest_sha256='b' * 64), 'staging-provenance-incomplete')
        assert store.put_plan(db, RUN, plan, ids, [row], manifest_sha256='b' * 64) == edit_content_hash(plan)      # the plan's rows: the same, kept
        # From `planned` on the ID and provenance rows are fixed (work B7-g, REVIEW-r161-b7f low 2): the same row is refused too.
        refused(lambda: store.put_ids(db, RUN, ids))
        refused(lambda: store.put_provenance(db, RUN, [row], manifest_sha256='b' * 64))
        refused(lambda: store.put_unit(db, RUN, {**units[0], 'payload': {'kind': 'other'}}), 'staging-unit-conflict')   # not the planned hash
        refused(lambda: store.put_unit(db, RUN, {**units[0], 'seq': 5}), 'staging-unit-conflict')                      # not a planned unit
        store.put_unit(db, RUN, units[0])
        store.put_unit(db, RUN, units[0])                                                      # identical: kept
        assert db.execute('SELECT phase FROM migration_staging_run').fetchone() == ('planned',)
        store.put_unit(db, RUN, units[1])
        assert db.execute('SELECT phase FROM migration_staging_run').fetchone() == ('units',)                           # the last unit moves it
        refused(lambda: store.put_unit(db, RUN, units[1]))                                    # after the units phase: no more
        refused(lambda: store.mark_assembled(db, RUN, scope, 'c' * 64))                       # no such checkpoint was installed
    assert state_of(root)['phase'] == 'units' and state_of(root)['counts']['units'] == 2 and state_of(root)['counts']['ids'] == 1
    with raw(root) as db:
        assert db.execute('SELECT converter_version, manifest_sha256 FROM migration_staging_provenance').fetchall() == [(store.CONVERTER_VERSION, 'b' * 64)]


def test_st17_the_stored_report_is_the_verification_row_and_only_a_staged_run_has_one(tmp_path):
    root = initialized(tmp_path)
    rows = store.read_writer_rows(root, RUN)
    assert rows['plan'] is None and rows['units'] == [] and rows['verification'] is None and rows['record']['phase'] == 'initialized'
    with pytest.raises(ValueError) as error:
        store.read_staged_report(root, RUN)
    assert error.value.args == ('staging-state-unavailable',)
    report = {'version': 1, 'residualReasons': ['uncollected-source']}
    with raw(root) as db:
        db.execute('INSERT INTO migration_staging_verification VALUES(?,?,?)', (RUN, store.canonical_json(report), edit_content_hash(report)))
    advance(root, phase='staged', report_sha256=edit_content_hash(report))
    assert store.read_staged_report(root, RUN) == {**report, 'reportSha256': edit_content_hash(report)}
    advance(root, report_sha256='9' * 64)
    with pytest.raises(ValueError) as error:
        store.read_staged_report(root, RUN)
    assert error.value.args[0] in ('staging-state-unavailable', 'staging-diagnostic-required')
    advance(root, report_sha256=edit_content_hash(report))
    with raw(root) as db:                                               # the verification row's report changed, its hash stayed
        db.execute('UPDATE migration_staging_verification SET report = ?', (store.canonical_json({**report, 'residualReasons': []}),))
    with pytest.raises(ValueError) as error:
        store.read_staged_report(root, RUN)
    assert error.value.args[0] in ('staging-state-unavailable', 'staging-diagnostic-required')


def test_st18_a_sealed_staging_is_never_written_and_the_id_rows_are_fixed_from_planned_on(tmp_path):
    """Work B7-g (REVIEW-r161-b7f low 2): `write()` refuses a `staged` run, `put_ids`/`put_provenance` refuse every phase from `planned` on."""
    root = initialized(tmp_path)
    auth = store.StagingAuthority(root, RUN, SCOPE, lambda: None)
    ids = [{'kind': 'pdf-document', 'source': ['a'], 'targetId': 'id-1'}]
    row = {'targetKind': 'document', 'targetId': 'id-1', 'sourceKind': 'file', 'sourceKey': ['papers', 'a'], 'sourceSha256': '1' * 64}

    def denied(call):
        with pytest.raises(ValueError) as error:
            call()
        assert error.value.args == ('staging-operation-denied',)

    def writing(phase):
        def call():
            with auth.write() as db:
                db.execute("UPDATE migration_staging_run SET report_sha256 = report_sha256")      # any write at all
        return call

    def id_rows(phase):
        def call():
            with auth.write() as db:
                store.put_ids(db, RUN, ids)
                store.put_provenance(db, RUN, [row], manifest_sha256='b' * 64)
        return call

    for phase in store.PHASES:
        advance(root, phase=phase)
        if phase == 'staged':
            denied(writing(phase))                                                # nothing is written to a sealed run, not even a no-op
            denied(id_rows(phase))
        else:
            writing(phase)()
        if phase in store.ID_ROW_PHASES:
            id_rows(phase)()
        elif phase != 'staged':
            denied(id_rows(phase))
    assert state_of(root)['counts']['ids'] == 1 and state_of(root)['counts']['provenance'] == 1


def test_st19_the_resume_helpers_read_the_units_and_the_installed_checkpoints_without_writing(tmp_path):
    root = initialized(tmp_path)
    folder = store.staging_folder(root, RUN)
    assert store.read_units(root, RUN) == [] and store.read_checkpoint_hashes(root, RUN) == []
    advance(root, phase='planned', plan_sha256=edit_content_hash(PLAN))
    with raw(root) as db:
        db.execute('INSERT INTO migration_staging_plan VALUES(?,?)', (RUN, store.canonical_json(PLAN)))
    for entry in PLAN_UNITS:
        put_unit(root, entry)                                           # the stored text is `{}` while the column names another hash
    def files():
        return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in folder.iterdir() if not path.name.endswith('-shm') and not (path.name.endswith('-wal') and path.stat().st_size == 0)}

    before = files()
    units = store.read_units(root, RUN)
    assert store.read_checkpoint_hashes(root, RUN) == [] and files() == before         # reading changed no byte (the -shm may be rewritten)
    assert [(row['seq'], row['unitKind'], row['targetId'], row['payloadSha256']) for row in units] == [
        (entry['seq'], entry['unitKind'], entry['targetId'], entry['payloadSha256']) for entry in PLAN_UNITS]
    assert all(row['payloadComputedSha256'] == edit_content_hash({}) != row['payloadSha256'] for row in units)    # a changed payload shows
    repo = repository(root)
    fixture_resource(repo)
    assert store.read_checkpoint_hashes(root, RUN) == []
    with raw(root) as db:
        db.execute('INSERT INTO edit_checkpoints VALUES(?,?)', (store._namespace(SCOPE), 'b' * 64))
        db.execute('INSERT INTO edit_checkpoints VALUES(?,?)', (store._namespace(SCOPE), 'a' * 64))
    assert store.read_checkpoint_hashes(root, RUN) == ['a' * 64, 'b' * 64]
    before = files()
    store.read_units(root, RUN)
    store.read_checkpoint_hashes(root, RUN)
    assert files() == before
    with pytest.raises(ValueError) as error:
        store.read_units(root, '9b2d4e60-1a3c-4f58-8e7d-6c0a5b1f2e34')   # no such run: closed, no path
    assert error.value.args[0] in ('staging-state-unavailable', 'staging-diagnostic-required')
