"""Work B7-c: admission, status and invisibility of the Native legacy staging (synthetic, isolated data only).

A-1 mutual busy, A-2 shutdown, A-3 other writers, A-4 no caller claim (and unexpected causes), A-5 interrupted preparation states,
A-6 the hold and every old byte stay as they were. V-1 no canonical store, V-2 the canonical path is not the staging, V-3 the old
Library and the canonical host stay refused, V-4 the staging authority, V-5 no route and no caller, V-6 a later capture never
sees a staging, V-7 nothing of another device or peer is in a staging.

Admission and status are the whole of B7-c (the writer is B7-f), so the staging databases here are made by the core functions
of `legacy_staging_store` directly, with the real manifest of a real synthetic run. Nothing touches a real profile: conftest
isolates the folders and every child process asserts them first.
"""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import threading
from uuid import uuid4

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
import pytest

from _synthetic_legacy_library import SENTINELS
from test_native_maintenance_entry import AUTH, PREFIX, runtime  # noqa: F401 - existing controlled-copy fixture
from test_native_notebook_preview import assert_blocked, assert_leases_held, post, to_cold
from test_native_conversion_input import (REWRITE, assert_isolated, backup_base, build, capture_live, hashed, held_build, holder, prepared,
                                          refused, run_child, snapshot, spy_on_backup_reads)
from test_native_cleanup_unknown_diagnostic import make_state
from test_native_preparation_recovery import seeded
from tools import export_openapi
from papeer.core import edit_storage, paths
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_storage import edit_storage_root
from papeer.core.instance import instance_key
from papeer.core.migrations import legacy_staging_store as store
from papeer.core.migrations.legacy_device import NativeLegacyHeldDeviceBackup
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal
from papeer.core.migrations.legacy_startup import LegacyMigrationRequired, NativeLegacyStartup, legacy_startup_allowed
from papeer.core.storage import Library
from sidecar import canonical_host, deps
from sidecar.app import app
from sidecar.lifecycle import instance
from sidecar.migrations import census, conversion_input, preparation, preview_gate, staging
from sidecar.routes import system

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def fresh_gate(monkeypatch):
    gate = preview_gate.PreviewGate()
    monkeypatch.setattr(preview_gate, 'gate', gate)
    yield gate
    assert gate.wait_idle(10), 'a staging admission outlived its test'


def raised(call, *args, **kwargs):
    """The arguments of the ValueError that `call` raises. A call that wrongly succeeds is let go of (an admission is released)
    before the test fails, so that a failing test never leaves the lifespan waiting for a gate that nobody will release."""
    try:
        value = call(*args, **kwargs)
    except ValueError as error:
        assert error.__cause__ is None
        return error.args
    if isinstance(value, staging.Admission):
        staging.release(value)
    pytest.fail('the call was not refused')


def gate_free():
    token = preview_gate.gate._token
    if token is not None:
        preview_gate.gate.finish(token)             # a failing test must not leave the lifespan waiting for it
    assert token is None, 'the gate was not given back'


def refused_staging(run_id, reason):
    assert raised(staging.admit, run_id) == (reason,)
    gate_free()


def parent_names(root):
    return {path.name for path in root.parent.iterdir()}


def make_staging(admission, manifest):
    """The first transaction of a run (the core function B7-f will call) with the real manifest of this run."""
    account = NativeLegacyInputs(admission.root).read(admission.run_id)['catalog']['identity']['accountId']
    store.initialize_run(admission.root, admission.run_id, account_id=account, manifest=manifest)
    return store.staging_scope(account, manifest['libraryId'], admission.run_id)


def put_a_resource(repo, body=b'a synthetic resource'):
    return repo.store_resource(str(uuid4()), hashlib.sha256(body).hexdigest(), 'application/octet-stream', body)


# A-1 -------------------------------------------------------------------------------------------
def test_staging_the_preview_and_the_conversion_input_are_mutually_busy(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        admission = staging.admit(run_id)
        try:
            assert admission.status['state'] == 'absent' and admission.run_id == run_id and preview_gate.gate.inflight()
            assert admission.root == census._root(paths.selected_data_directory())
            refused(run_id, 'conversion-input-busy')
            reply = post(client, run_id)
            assert reply.status_code == 409 and reply.json()['reason'] == 'preview-busy'
            assert raised(staging.admit, run_id) == ('staging-busy',)
            for action in ('resume', 'abandon'):
                reply = client.post(PREFIX + action, json={'runId': run_id}, headers=AUTH)
                assert reply.status_code == 409 and reply.json()['reason'] == 'maintenance-recovery-unavailable'
            assert preparation._current.status()['state'] == 'captured'
        finally:
            staging.release(admission)
        staging.release(admission)                                         # idempotent
        assert preview_gate.gate.wait_idle(5) and not preview_gate.gate.inflight()
        token = preparation.admit_preview(run_id)                            # a preview in flight blocks staging
        try:
            assert raised(staging.admit, run_id) == ('staging-busy',)
        finally:
            preview_gate.gate.finish(token)
        entered, release = held_build(monkeypatch, honor_cancel=False)       # so does a conversion input
        token, future = conversion_input.start(run_id)
        try:
            assert entered.wait(10)
            assert raised(staging.admit, run_id) == ('staging-busy',)
        finally:
            release.set()
        assert future.result(10) and preview_gate.gate.wait_idle(10)
        with staging.admitted(run_id) as again:                              # and the gate is free again
            assert again.token.kind == 'live'
        gate_free()
        assert not store.staging_base(root).exists()


def test_a_refusal_after_the_gate_was_taken_gives_the_gate_back(runtime):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        folder = store.staging_folder(root, run_id)
        folder.mkdir(parents=True)
        (folder / 'notes.txt').write_bytes(b'x')                            # something staging does not own: diagnostic-required
        refused_staging(run_id, 'staging-diagnostic-required')
        assert staging.status(run_id)['state'] == 'diagnostic-required'
        (folder / 'notes.txt').unlink()
        with staging.admitted(run_id) as admission:
            assert admission.status['state'] == 'uninitialized'
        assert post(client, run_id).status_code == 200, 'the preview works again'


def test_a_cold_run_is_admitted_after_the_recovery_classifier_verified_it(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        to_cold(monkeypatch)
        settled = snapshot(root, device)
        with staging.admitted(run_id) as admission:
            assert admission.token.kind == 'cold' and admission.status['state'] == 'absent'
        refused_staging(str(uuid4()), 'staging-state-unavailable')
        assert snapshot(root, device) == settled and not store.staging_base(root).exists()


def test_a_seeded_cold_run_that_the_recovery_classifier_verified_is_admitted(runtime):  # noqa: F811
    root, device, _lock = runtime
    run_id = seeded(root, 'artifacts-verified')['runId']
    before = snapshot(root, device)
    with staging.admitted(run_id) as admission:
        assert admission.token.kind == 'cold' and admission.status['state'] == 'absent'
    assert snapshot(root, device) == before and not store.staging_base(root).exists()


# A-2 -------------------------------------------------------------------------------------------
def test_shutdown_is_sticky_keeps_the_leases_and_ends_the_authority(runtime, monkeypatch):  # noqa: F811
    root, _device, lock = runtime
    prepared(runtime)
    monkeypatch.setattr(system, 'SHUTDOWN_JOB_TIMEOUT', .05)
    monkeypatch.setattr(system, 'SHUTDOWN_REQUEST_TIMEOUT', .05)
    exited = threading.Event()
    monkeypatch.setattr(system, 'exit_process', exited.set)
    with TestClient(app) as client:
        run_id = capture_live(client)
        owner = preparation._current
        manifest = build(run_id)['manifest']
        admission = staging.admit(run_id)
        scope = make_staging(admission, manifest)
        repo = staging.repository(admission, scope)
        assert put_a_resource(repo)['byteLength'] == len(b'a synthetic resource')
        try:
            reply = client.post('/shutdown', headers=AUTH)
            assert reply.status_code == 200 and reply.json()['status'] == 'pending' and reply.json()['stopped'] is False
            assert admission.token.cancel.is_set() and preview_gate.gate.closed
            assert not exited.wait(.7), 'the process must stay while the admission holds the gate'
            assert_leases_held(owner)
            assert lock.held and instance.maintenance_owner() is owner
            assert raised(repo.checkpoint) == ('staging-cancelled',), 'the authority stops as soon as the token is cancelled'
            assert raised(staging.admit, run_id) == ('staging-shutdown-pending',)
        finally:
            staging.release(admission)
        assert preview_gate.gate.wait_idle(10)
        reply = client.post('/shutdown', headers=AUTH)
        assert reply.json()['status'] == 'shutting down' and reply.json()['stopped'] is True
        assert exited.wait(5)
        assert owner._closed and owner._device_lease is None and owner._history_lease is None, 'released only afterwards'
        assert raised(staging.admit, run_id) == ('staging-shutdown-pending',)         # sticky
    assert store.staging_status(root, run_id)['state'] == 'resumable', 'what was written stays, as an interruption'


# A-3 -------------------------------------------------------------------------------------------
def test_another_process_holding_the_library_lock_refuses_before_any_backup_is_read(runtime, monkeypatch, tmp_path_factory):  # noqa: F811
    root, device, lock = runtime
    prepared(runtime)
    env = assert_isolated(tmp_path_factory, device, root, paths.selected_data_directory())
    copies = spy_on_backup_reads(monkeypatch)
    with TestClient(app) as client:
        run_id = capture_live(client)
        to_cold(monkeypatch)
        copies.clear()
        instance.release()
        assert instance.current_library_lock(root) is None and not lock.held
        with holder(env, root, device):
            refused_staging(run_id, 'staging-library-lock-unavailable')
            assert copies == []
        assert not store.staging_base(root).exists()


def test_another_librarys_writer_refuses_live_and_cold_and_a_leftover_lock_file_still_refuses(runtime, monkeypatch, tmp_path, tmp_path_factory):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    env = assert_isolated(tmp_path_factory, device, root)
    other = tmp_path / 'another-library'
    other.mkdir()
    copies = spy_on_backup_reads(monkeypatch)
    with TestClient(app) as client:
        with holder(env, other, device):
            run_id = capture_live(client)
            copies.clear()
            assert (device / 'instances' / (instance_key(other) + '.lock')).exists()
            refused_staging(run_id, 'staging-other-writer-present')
            to_cold(monkeypatch)
            refused_staging(run_id, 'staging-other-writer-present')
            assert copies == []
        assert [item.name for item in (device / 'instances').iterdir() if item.name.startswith(instance_key(other))]
        refused_staging(run_id, 'staging-other-writer-present')
        assert copies == [] and not store.staging_base(root).exists()


@pytest.mark.parametrize('state', ['live', 'cold'])
def test_a_rewritten_writer_record_is_not_this_processs_authority(runtime, monkeypatch, tmp_path_factory, state):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    env = assert_isolated(tmp_path_factory, device, root)
    record = device / 'instances' / (instance_key(root) + '.writer-v1.json')
    with TestClient(app) as client:
        run_id = capture_live(client)
        if state == 'cold':
            to_cold(monkeypatch)
        with staging.admitted(run_id):
            pass                                                              # the genuine record is accepted
        original = record.read_bytes()
        try:
            assert run_child(env, REWRITE, str(record)).strip() == 'rewritten'
            assert record.read_bytes() != original
            refused_staging(run_id, 'staging-instance-writer-unverified')
        finally:
            record.write_bytes(original)
        with staging.admitted(run_id):
            pass


# A-4 -------------------------------------------------------------------------------------------
@pytest.mark.parametrize('claim', [{'quiescent': True}, {'path': 'C:/anything'}, {'writers_stopped': True}, {'digest': 'f' * 64}, {'force': True}])
def test_no_caller_claim_authorises_anything(runtime, claim):  # noqa: F811
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        with pytest.raises(TypeError):
            staging.admit(run_id, **claim)
        with pytest.raises(TypeError):
            staging.admit(run_id, 'C:/another')
        with pytest.raises(TypeError):
            staging.admit()
        with pytest.raises(TypeError):
            staging.status(run_id, **claim)
        gate_free()
        for bad in (None, 5, [run_id], b'x', 'not-a-run-id C:\\private', '../' + run_id, run_id.upper(), ''):
            assert raised(staging.admit, bad) == ('staging-state-unavailable',), bad
            assert raised(staging.status, bad) == ('staging-state-unavailable',), bad
        unknown = str(uuid4())                    # a valid ID of no run: no admission, and nothing to see
        assert raised(staging.admit, unknown) == ('staging-state-unavailable',)
        assert staging.status(unknown)['state'] == 'absent'
        gate_free()


def test_an_unexpected_exception_is_one_closed_reason_and_gives_the_gate_back(runtime, monkeypatch):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        for error in (KeyError('secret-key C:\\private'), TypeError('secret'), RuntimeError('secret'), OSError('secret')):
            def boom(*_args, _error=error, **_kwargs):
                raise _error
            with monkeypatch.context() as patch:
                patch.setattr(store, 'staging_status', boom)
                assert raised(staging.admit, run_id) == ('staging-unavailable',)
                gate_free()
                assert raised(staging.status, run_id) == ('staging-unavailable',)
        with monkeypatch.context() as patch:                                # a failure before the gate is taken
            patch.setattr(conversion_input, '_assert_external_writers', lambda _selection: (_ for _ in ()).throw(KeyError('secret')))
            assert raised(staging.admit, run_id) == ('staging-unavailable',)
            gate_free()
        with staging.admitted(run_id):
            assert preview_gate.gate.inflight()
        gate_free()
        assert not store.staging_base(root).exists()


def test_reasons_are_a_closed_set_and_the_conversion_input_names_map_to_staging_names():
    for text, expected in (('preview-busy', 'staging-busy'), ('preview-shutdown-pending', 'staging-shutdown-pending'),
                           ('preview-cancelled', 'staging-cancelled'), ('backup-read-cancelled', 'staging-cancelled'),
                           ('backup-read-limit', 'staging-capacity-exceeded'), ('backup-disk-insufficient', 'staging-disk-insufficient'),
                           ('preview-state-unavailable', 'staging-state-unavailable'), ('preview-source-changed', 'staging-source-changed'),
                           ('backup-source-changed', 'staging-source-changed'),
                           ('conversion-input-library-lock-unavailable', 'staging-library-lock-unavailable'),
                           ('conversion-input-other-writer-present', 'staging-other-writer-present'),
                           ('conversion-input-instance-writer-unverified', 'staging-instance-writer-unverified'),
                           ('conversion-input-instance-census-unbounded', 'staging-unavailable'),
                           ('conversion-input-whole-library-refused', 'staging-unavailable'), ('anything else', 'staging-unavailable'),
                           ('staging-diagnostic-required', 'staging-diagnostic-required'),
                           ('staging-operation-denied', 'staging-operation-denied')):
        assert staging.reason_of(ValueError(text)) == expected, text
        assert expected in store.REASONS
    assert staging.reason_of(census.CoverageUnresolved('maintenance-lock-unavailable')) == 'staging-library-lock-unavailable'
    assert staging.reason_of(census.CoverageUnresolved('anything')) == 'staging-unavailable'
    assert staging.reason_of(KeyError('x')) == 'staging-unavailable' and staging.reason_of(ValueError('a', 'b')) == 'staging-unavailable'
    assert store.MANIFEST_SCOPE == conversion_input.SCOPE and staging.SCOPE == store.SCOPE


# A-5 -------------------------------------------------------------------------------------------
def interrupted(root, kind):
    """The durable state a crash leaves (the kill-test cases K2, K11, K8, K10, K9, and an uncollected or partial capture)."""
    if kind == 'K2':             # a hold with no journal record: the durable state cannot be verified
        run_id = str(uuid4())
        NativeLegacyStartup(root).hold({'version': 1, 'runId': run_id})
        return run_id
    if kind == 'K11':            # an unreadable journal
        record = seeded(root, 'hold-only')
        NativePreparationJournal(root).active.write_bytes(b'{')
        return record['runId']
    if kind in ('hold-only', 'partial'):
        return seeded(root, kind)['runId']
    return make_state(root, {'K8': 'cleanup-begin-hold-present', 'K10': 'cancel-complete-cleanup-pending', 'K9': 'cancel-interrupted'}[kind])[0]['runId']


@pytest.mark.parametrize('kind', ['K2', 'K11', 'K8', 'K10', 'K9', 'hold-only', 'partial'])
def test_an_interrupted_preparation_is_never_admitted_and_nothing_is_made(runtime, kind):  # noqa: F811
    root, device, _lock = runtime
    run_id = interrupted(root, kind)
    with TestClient(app) as client:
        before = snapshot(root, device)
        for _ in range(2):
            assert raised(staging.admit, run_id) == ('staging-state-unavailable',)
            gate_free()
        assert raised(staging.admit, str(uuid4())) == ('staging-state-unavailable',)
        gate_free()
        # The existing refusals around it are unchanged (B6-a's gap): the preview answers 409 and the old Library will not open.
        assert_blocked(post(client, run_id), 'preview-unavailable')
        assert_blocked(post(client, run_id, '0' * 32), 'preview-unavailable')
        with pytest.raises(LegacyMigrationRequired):
            Library(root)
        assert preview_gate.gate.wait_idle(5)
        assert snapshot(root, device) == before
    assert not store.staging_base(root).exists() and not legacy_startup_allowed(root)


def test_a_cancelled_run_that_is_waiting_for_a_restart_is_not_admitted(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        assert client.post(PREFIX + 'abandon', json={'runId': run_id}, headers=AUTH).status_code in (200, 202)
        assert preparation._current.wait(30)['state'] == 'cancelled'
        refused_staging(run_id, 'staging-state-unavailable')
    assert not store.staging_base(root).exists()


# A-6 -------------------------------------------------------------------------------------------
def test_the_hold_and_every_old_byte_stay_as_they_were(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        manifest = build(run_id)['manifest']
        startup = NativeLegacyStartup(root)
        for cold in (False, True):
            if cold:
                to_cold(monkeypatch)           # a normal shutdown appends its cleanup event first; the baseline is taken after it
            settled = snapshot(root, device)
            hold, journal = startup.path.read_bytes(), NativePreparationJournal(root).active.read_bytes()
            status = preparation.status()
            with staging.admitted(run_id) as admission:
                assert admission.token.kind == ('cold' if cold else 'live')
                if not cold:
                    make_staging(admission, manifest)
            with staging.admitted(run_id) as admission:
                assert admission.status['state'] == 'resumable'
            assert staging.status(run_id)['state'] == 'resumable'
            assert startup.read() == {'version': 1, 'runId': run_id} and startup.path.read_bytes() == hold
            assert NativePreparationJournal(root).active.read_bytes() == journal
            assert snapshot(root, device) == settled, 'admission, release and status change no old byte, not even the hold'
            assert not legacy_startup_allowed(root) and preparation.status() == status


# V-1 / V-2 -------------------------------------------------------------------------------------
def test_no_canonical_store_is_made_or_opened_and_its_path_is_not_the_staging(runtime, monkeypatch):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    asked = []
    real_connection, real_edit = edit_storage.canonical_edit_connection, deps.get_edit_connection
    monkeypatch.setattr(edit_storage, 'canonical_edit_connection', lambda *a, **k: (asked.append('canonical_edit_connection'), real_connection(*a, **k))[1])
    monkeypatch.setattr(deps, 'get_edit_connection', lambda: (asked.append('get_edit_connection'), real_edit())[1])
    with TestClient(app) as client:
        run_id = capture_live(client)
        manifest = build(run_id)['manifest']
        settled, names = snapshot(root, device), parent_names(root)
        asked.clear()
        with staging.admitted(run_id) as admission:
            scope = make_staging(admission, manifest)
            repo = staging.repository(admission, scope)
            put_a_resource(repo)
            database = store.staging_folder(root, run_id) / store.DB_NAME
            canonical = deps.get_canonical_storage_path()
            assert canonical == edit_storage_root(root) / 'content.sqlite3' and canonical != database      # V-2
            assert not canonical.exists() and not edit_storage_root(root).exists()                           # V-1
            assert database.is_file() and database.parent.parent.name == '.' + root.name + '-shared-app-staging'
            assert not database.is_relative_to(edit_storage_root(root)) and not database.is_relative_to(backup_base(root))
            assert not database.is_relative_to(root) and deps.get_data_dir().resolve() == root.resolve()
        assert snapshot(root, device) == settled, 'Library, canonical, device, backups and bootstrap are unchanged'
        assert parent_names(root) - names == {'.' + root.name + '-shared-app-staging'}
        assert names - parent_names(root) == set()
        assert not edit_storage_root(root).exists() and asked == [], 'the canonical connection (it makes its folder) was never asked for'


# V-3 -------------------------------------------------------------------------------------------
def test_the_old_library_and_the_canonical_host_stay_refused_exactly_as_before(runtime):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)

    def observe(client):
        replies = [client.get(path, headers=AUTH) for path in ('/api/storage', '/api/cloud-drive')]
        outcomes = [(reply.status_code, reply.json()) for reply in replies]
        with pytest.raises(LegacyMigrationRequired):
            Library(root)
        with pytest.raises(canonical_host.AuthorityError, match='^migration-held$'):
            canonical_host._require_clear()
        return outcomes, legacy_startup_allowed(root), NativeLegacyStartup(root).read()

    with TestClient(app) as client:
        run_id = capture_live(client)
        manifest = build(run_id)['manifest']
        before = observe(client)
        assert [code for code, _body in before[0]] == [409, 409] and before[1] is False
        with staging.admitted(run_id) as admission:
            make_staging(admission, manifest)
            assert observe(client) == before, 'while a staging is admitted'
        assert observe(client) == before, 'after it was released'
        assert staging.status(run_id)['state'] == 'resumable'


# V-4 -------------------------------------------------------------------------------------------
def test_the_staging_authority_refuses_edits_publication_installation_and_control(runtime):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    fixture = json.loads((REPO / 'tests' / 'fixtures' / 'shared-edits.json').read_text('utf-8'))
    with TestClient(app) as client:
        run_id = capture_live(client)
        manifest = build(run_id)['manifest']
        with staging.admitted(run_id) as admission:
            scope = make_staging(admission, manifest)
            repo = staging.repository(admission, scope)
            for operation in sorted(store.REPOSITORY_OPERATIONS - store.ALLOWED_OPERATIONS):
                assert raised(lambda op=operation: repo._transaction(op).__enter__()) == ('staging-operation-denied',), operation
            assert raised(repo.initialize, fixture['document']) == ('staging-operation-denied',)
            assert raised(repo.replace_intent, fixture['document']['id'], None, None) == ('staging-operation-denied',)
            assert raised(repo.acknowledge, fixture['editRecords'][0]['batch']['id']) == ('staging-operation-denied',)
            assert repo.dataset_control() is None and repo.installed_datasets() == [], 'a staging has no control record and no dataset'
            # A repository made for any other scope is refused too.
            other = {**scope, 'epoch': 'dataset'}
            assert raised(staging.repository, admission, other) == ('staging-operation-denied',)
            admission.token.cancel.set()
            assert raised(repo.checkpoint) == ('staging-cancelled',)
        assert raised(repo.checkpoint) == ('staging-state-unavailable',), 'after release the authority is dead'
        with closing(sqlite3.connect(store.staging_folder(root, run_id) / store.DB_NAME)) as db:
            for table in store.FORBIDDEN_ROW_TABLES + ('edit_roots',):
                assert db.execute(f'SELECT COUNT(*) FROM {table}').fetchone() == (0,), table
        assert staging.status(run_id)['state'] == 'resumable'


def test_a_live_run_whose_hold_is_not_its_own_is_not_admitted(runtime):  # noqa: F811
    """The live owner knows its run, but the hold FILE is what keeps the old Library closed: admission compares it."""
    root, _device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        startup = NativeLegacyStartup(root)
        hold = startup.path.read_bytes()
        startup.path.write_bytes(json.dumps({'version': 1, 'runId': str(uuid4())}).encode('utf-8'))
        try:
            refused_staging(run_id, 'staging-state-unavailable')
        finally:
            startup.path.write_bytes(hold)
        with staging.admitted(run_id):
            pass


def test_the_authority_stops_when_the_hold_is_no_longer_this_runs(runtime):  # noqa: F811
    root, _device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        manifest = build(run_id)['manifest']
        with staging.admitted(run_id) as admission:
            repo = staging.repository(admission, make_staging(admission, manifest))
            assert repo.checkpoint()['roots'] == []
            startup = NativeLegacyStartup(root)
            hold = startup.path.read_bytes()
            startup.path.write_bytes(json.dumps({'version': 1, 'runId': str(uuid4())}).encode('utf-8'))
            try:
                assert raised(repo.checkpoint) == ('staging-state-unavailable',), 'another run is holding the Library'
            finally:
                startup.path.write_bytes(hold)
            assert repo.checkpoint()['roots'] == [] and startup.read() == {'version': 1, 'runId': run_id}


# V-5 -------------------------------------------------------------------------------------------
def test_no_route_exists_the_openapi_is_unchanged_and_nothing_outside_tests_calls_the_staging(runtime):  # noqa: F811
    def routes(items, prefix=''):
        for route in items:
            router = getattr(route, 'original_router', None)
            if router is not None:
                yield from routes(router.routes, prefix + route.include_context.prefix)
            elif isinstance(route, APIRoute):
                yield prefix + route.path
    paths_found = sorted(set(routes(app.routes)))
    assert not [path for path in paths_found if 'staging' in path.lower()]
    assert {path for path in paths_found if path.startswith('/api/edits/legacy-maintenance/')} == {
        f'/api/edits/legacy-maintenance/{name}' for name in ('start', 'status', 'resume', 'abandon', 'notebooks', 'notebook-preview')}
    committed = export_openapi.OPENAPI_JSON.read_bytes().decode('utf-8')
    assert committed == export_openapi.openapi_text() and 'staging' not in committed.lower()
    # Nothing in the product imports the staging modules (callers are tests only).
    offenders = []
    for folder in ('papeer', 'sidecar'):
        for path in sorted((REPO / folder).rglob('*.py')):
            if path.name in ('legacy_staging_store.py', 'staging.py'):
                continue
            text = path.read_text('utf-8')
            if re.search(r'legacy_staging_store|migrations\.staging\b|\bimport\b[^\n]*\bstaging\b', text):
                offenders.append(path.relative_to(REPO).as_posix())
    assert offenders == []


# V-6 -------------------------------------------------------------------------------------------
def test_a_later_capture_never_sees_a_staging(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    other_run = str(uuid4())
    body = {'version': 1, 'scope': store.MANIFEST_SCOPE, 'runId': other_run, 'peerId': str(uuid4()), 'libraryId': str(uuid4()),
            'journalRecordSha256': 'a' * 64, 'inputSetSha256': 'b' * 64, 'wholeLibrary': {'status': 'refused', 'reasons': ['uncollected-source']}}
    store.initialize_run(root, other_run, account_id='controlled-copy-local', manifest={**body, 'manifestSha256': edit_content_hash(body)})
    folder = store.staging_folder(root, other_run)
    before = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in folder.iterdir()}
    with TestClient(app) as client:
        run_id = capture_live(client)
        manifest = build(run_id)['manifest']
        record = NativeLegacyInputs(root).read(run_id)
        text = json.dumps([manifest, record], sort_keys=True)
        assert 'staging' not in text and other_run not in text
        assert not any('staging' in key or other_run in key for key in hashed(backup_base(root)))
        assert {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in folder.iterdir()} == before, 'a capture only reads'
        assert staging.status(other_run)['state'] == 'orphaned', 'the staging of another run is only read, never used or deleted'
        assert staging.status(other_run)['underlying'] == 'resumable' and folder.is_dir()
        assert staging.status(run_id)['state'] == 'absent'


# V-7 -------------------------------------------------------------------------------------------
def test_nothing_of_another_device_or_peer_is_in_a_staging(runtime):  # noqa: F811
    root, device, _lock = runtime
    prepared(runtime)
    with TestClient(app) as client:
        run_id = capture_live(client)
        manifest = build(run_id)['manifest']
        with staging.admitted(run_id) as admission:
            scope = make_staging(admission, manifest)
            put_a_resource(staging.repository(admission, scope))
        library_key = NativeLegacyHeldDeviceBackup(root, device_root=device).library_key
        database = store.staging_folder(root, run_id) / store.DB_NAME
        with closing(sqlite3.connect(database)) as db:
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND substr(name, 1, 7) <> 'sqlite_'")}
            assert tables == set(store.EDIT_TABLES) | set(store.STAGING_TABLES)
            assert not any(name.startswith(('canonical_', 'cloud_', 'provider_')) for name in tables)
            for table in ('edit_batches', 'edit_intents', 'edit_dataset_controls', 'edit_publications', 'edit_datasets', 'edit_roots'):
                assert db.execute(f'SELECT COUNT(*) FROM {table}').fetchone() == (0,), table
            text = ''
            for table in sorted(tables - {'migration_staging_run'}):
                text += table + repr(db.execute(f'SELECT * FROM {table}').fetchall())
            run_row = db.execute('SELECT scope, manifest, journal_record_sha256 FROM migration_staging_run').fetchone()
        record = NativePreparationJournal(root).read()
        for private in (manifest['peerId'], record['peerId'], library_key, instance_key(root), str(device), str(root), *SENTINELS, 'cloud-drive'):
            assert private not in text, private
        # The run row holds the sealed manifest as it is (it names the preparation's peer and nothing else of a device): the
        # peer is not in the scope, and the scope does not carry a device or Drive value either.
        assert manifest['peerId'] not in run_row[0] and library_key not in run_row[0] and str(device) not in run_row[1]
        assert json.loads(run_row[1]) == manifest and run_row[2] == manifest['journalRecordSha256']
