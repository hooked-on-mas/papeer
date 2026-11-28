"""Work B6-a: a cancel whose end cannot be confirmed stays a diagnostic state (synthetic, isolated data only).

`cleanup-unknown` (a cleanup began but is not recorded as complete, or `cancel-complete` exists
without a completed cleanup) and `cancel-interrupted` (intent only) are classified from the
durable record alone. Nothing may advance them by itself or by a read: no start, no resume, no
re-created hold, no legacy Library open, no preview. These tests pin that existing behavior; they
do not change the product. They run under tests/ (conftest isolation); the child process asserts
its isolated folders first.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from test_native_maintenance_entry import AUTH, PREFIX, runtime  # noqa: F401 - existing controlled-copy fixture
from test_native_preparation_recovery import seeded
from papeer.core import paths
from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal
from papeer.core.migrations.legacy_startup import LegacyMigrationRequired, NativeLegacyStartup, legacy_startup_allowed
from papeer.core.storage import Library
from sidecar import deps
from sidecar.app import app
from sidecar.lifecycle import instance
from sidecar.migrations import census, preparation, preview_gate

UNKNOWN = {'state': 'recovery-required', 'phase': 'cleanup-unknown', 'failure': 'maintenance-cleanup-unknown',
           'scope': 'native-preparation-only'}
INTERRUPTED = {'state': 'recovery-required', 'phase': 'cancel-interrupted', 'failure': 'maintenance-interrupted',
               'scope': 'native-preparation-only'}
# kind -> (is the hold still present, is cancel-complete recorded)
UNKNOWN_KINDS = {
    'cleanup-begin-hold-present': (True, False),
    'cleanup-begin-hold-removed': (False, False),
    'cancel-complete-cleanup-pending': (False, True),
    'cancel-complete-no-cleanup-record': (False, True),
}


@pytest.fixture(autouse=True)
def fresh_gate(monkeypatch):
    """The lifespan closes the (sticky) gate on exit; never leave the shared one closed."""
    gate = preview_gate.PreviewGate()
    monkeypatch.setattr(preview_gate, 'gate', gate)
    yield gate
    assert gate.wait_idle(10)


def make_state(root, kind):
    """Journal and hold as a crash would leave them; return (record, hold present)."""
    record = seeded(root, 'hold-only')
    journal, startup = NativePreparationJournal(root), NativeLegacyStartup(root)
    journal.mark(record, 'cancel-intent')
    if kind == 'cancel-interrupted':
        return record, True
    if kind != 'cancel-complete-no-cleanup-record':
        journal.mark_cleanup(record, str(uuid4()), 'begin')
    present, completed = UNKNOWN_KINDS[kind]
    if not present:
        startup.path.unlink()
    if completed:
        journal.mark(record, 'cancel-complete')
    return record, present


def snapshot(root):
    """Names and sha256 of every entry of the Library folder and of its backup/bootstrap folder."""
    result = {}
    for base in (root, NativeLegacyStartup(root).root):
        for path in sorted(base.rglob('*')):
            key = (base.name, path.relative_to(base).as_posix())
            result[key] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    return result


def assert_idle_and_fenced(root, lock, present, before, run_id):
    assert preparation._current is None and deps._maintenance_owner is None and instance.maintenance_owner() is None
    assert lock.held
    startup = NativeLegacyStartup(root)
    if present:
        assert startup.read() == {'version': 1, 'runId': run_id}
    else:
        assert not startup.path.exists() and startup.read() is None
    assert not legacy_startup_allowed(root)
    assert snapshot(root) == before
    assert not list(startup.root.glob('.analysis-*'))


def test_cleanup_begin_without_complete_keeps_the_hold_and_refuses_everything(runtime):  # noqa: F811
    root, _device, lock = runtime
    (root / 'legacy-data').write_bytes(b'preserve')
    record, present = make_state(root, 'cleanup-begin-hold-present')
    run_id = record['runId']
    before = snapshot(root)
    assert NativePreparationJournal(root).cleanup_state(run_id) == 'pending'
    first, second = preparation.status(), preparation.status()
    assert first == second == {**UNKNOWN, 'runId': run_id}
    with pytest.raises(census.CoverageUnresolved, match='^maintenance-recovery-required$'):
        preparation.start()
    for action in ('capture', 'cancel'):
        with pytest.raises(ValueError, match='^maintenance-recovery-unavailable$'):
            preparation.recover(run_id, action)
    assert preparation.status() == first
    assert_idle_and_fenced(root, lock, present, before, run_id)
    assert (root / 'legacy-data').read_bytes() == b'preserve'
    with pytest.raises(LegacyMigrationRequired):
        Library(root)
    assert_idle_and_fenced(root, lock, present, before, run_id)
    assert not (root / 'library.sqlite3').exists() and not (root / 'papers').exists()


@pytest.mark.parametrize('kind', ['cleanup-begin-hold-removed', 'cancel-complete-cleanup-pending', 'cancel-complete-no-cleanup-record'])
def test_a_removed_hold_is_not_recreated_and_cancel_is_not_finished(runtime, kind):  # noqa: F811
    root, _device, lock = runtime
    record, present = make_state(root, kind)
    assert present is False
    run_id = record['runId']
    journal = NativePreparationJournal(root)
    assert journal.event(run_id, 'cancel-complete') == UNKNOWN_KINDS[kind][1]
    assert journal.cleanup_state(run_id) == ('none' if kind == 'cancel-complete-no-cleanup-record' else 'pending')
    before = snapshot(root)
    first, second = preparation.status(), preparation.status()
    assert first == second == {**UNKNOWN, 'runId': run_id}
    with pytest.raises(census.CoverageUnresolved, match='^maintenance-recovery-required$'):
        preparation.start()
    for action in ('capture', 'cancel'):
        with pytest.raises(ValueError, match='^maintenance-recovery-unavailable$'):
            preparation.recover(run_id, action)
    # The hold is gone and stays gone; the journal and events are byte-identical.
    assert_idle_and_fenced(root, lock, present, before, run_id)
    with pytest.raises(LegacyMigrationRequired):
        Library(root)
    assert_idle_and_fenced(root, lock, present, before, run_id)
    assert preparation.status() == first


@pytest.mark.parametrize('kind', ['cleanup-begin-hold-present', 'cancel-complete-cleanup-pending'])
def test_http_status_reports_cleanup_unknown_and_every_mutation_is_refused(runtime, kind):  # noqa: F811
    root, _device, lock = runtime
    record, present = make_state(root, kind)
    run_id = record['runId']
    before = snapshot(root)
    with TestClient(app) as client:
        for _ in range(2):
            reply = client.post(PREFIX + 'status', json={}, headers=AUTH)
            assert reply.status_code == 200 and reply.json() == {**UNKNOWN, 'runId': run_id}
        started = client.post(PREFIX + 'start', json={}, headers=AUTH)
        assert started.status_code == 409 and started.headers['Cache-Control'] == 'no-store'
        assert started.json() == {'state': 'blocked', 'reason': 'maintenance-recovery-required'}
        for route in ('resume', 'abandon'):
            reply = client.post(PREFIX + route, json={'runId': run_id}, headers=AUTH)
            assert reply.status_code == 409 and reply.headers['Cache-Control'] == 'no-store'
            assert reply.json() == {'state': 'blocked', 'reason': 'maintenance-recovery-unavailable'}
        again = client.post(PREFIX + 'status', json={}, headers=AUTH)
        assert again.json() == {**UNKNOWN, 'runId': run_id}
        assert_idle_and_fenced(root, lock, present, before, run_id)
    assert_idle_and_fenced(root, lock, present, before, run_id)


@pytest.mark.parametrize('kind', ['cleanup-begin-hold-present', 'cancel-complete-cleanup-pending'])
def test_notebook_preview_is_unavailable_in_cleanup_unknown(runtime, kind):  # noqa: F811
    root, _device, lock = runtime
    record, present = make_state(root, kind)
    run_id = record['runId']
    before = snapshot(root)
    expected = {'state': 'blocked', 'reason': 'preview-unavailable', 'scope': 'native-notebook-preview-only'}
    with TestClient(app) as client:
        for route, body in (('notebooks', {'runId': run_id}), ('notebook-preview', {'runId': run_id, 'selector': '0' * 32})):
            reply = client.post(PREFIX + route, json=body, headers=AUTH)
            assert reply.status_code == 409 and reply.headers['Cache-Control'] == 'no-store'
            assert reply.json() == expected
            assert str(root) not in reply.text
        assert preview_gate.gate.wait_idle(5) and not preview_gate.gate.inflight()
        assert client.post(PREFIX + 'status', json={}, headers=AUTH).json() == {**UNKNOWN, 'runId': run_id}
    assert_idle_and_fenced(root, lock, present, before, run_id)


def test_cancel_interrupted_does_not_advance_alone_and_only_an_explicit_cancel_is_accepted(runtime):  # noqa: F811
    root, _device, lock = runtime
    original = root / 'legacy-data'
    original.write_bytes(b'preserve')
    record, present = make_state(root, 'cancel-interrupted')
    run_id = record['runId']
    journal = NativePreparationJournal(root)
    before = snapshot(root)
    assert journal.event(run_id, 'cancel-intent') and not journal.event(run_id, 'cancel-complete')
    first, second = preparation.status(), preparation.status()
    assert first == second == {**INTERRUPTED, 'runId': run_id}
    with pytest.raises(ValueError, match='^maintenance-recovery-unavailable$'):
        preparation.recover(run_id, 'capture')
    with pytest.raises(census.CoverageUnresolved, match='^maintenance-recovery-required$'):
        preparation.start()
    assert preparation.status() == first
    assert_idle_and_fenced(root, lock, present, before, run_id)
    # Existing behavior, pinned: the explicit cancel is the only way forward and finishes the cancel.
    accepted = preparation.recover(run_id, 'cancel')
    assert accepted['state'] == 'running' and accepted['runId'] == run_id
    assert preparation._current.wait(20)['state'] == 'cancelled'
    assert NativeLegacyStartup(root).read() is None and journal.event(run_id, 'cancel-complete')
    assert original.read_bytes() == b'preserve'
    assert preparation.status()['phase'] == 'restart-required'


CHILD = r'''
import json
from papeer.core import paths
from sidecar.migrations import preparation
print(json.dumps({'device': str(paths.device_directory()), 'data': str(paths.selected_data_directory()),
                  'first': preparation.status(), 'second': preparation.status()}, sort_keys=True))
'''


@pytest.mark.parametrize('kind', ['cleanup-begin-hold-present', 'cancel-complete-cleanup-pending', 'cancel-interrupted'])
def test_another_process_sees_the_same_phase_without_changing_it(runtime, tmp_path_factory, kind):  # noqa: F811
    root, device, lock = runtime
    record, present = make_state(root, kind)
    run_id = record['runId']
    before = snapshot(root)
    expected = {**(INTERRUPTED if kind == 'cancel-interrupted' else UNKNOWN), 'runId': run_id}
    assert preparation.status() == expected
    # Isolation is asserted before the child starts; the child only inherits this environment.
    base = tmp_path_factory.getbasetemp().resolve()
    for folder in (paths.device_directory(), paths.selected_data_directory(), root, device):
        assert Path(folder).resolve().is_relative_to(base)
    env = os.environ.copy()
    assert Path(env['PAPEER_DATA_DIR']).resolve() == root.resolve()
    assert Path(env['LOCALAPPDATA']).resolve().is_relative_to(base)
    result = subprocess.run([sys.executable, '-B', '-c', CHILD], env=env, capture_output=True, text=True,
                            encoding='utf8', timeout=300)   # a cold import took 10-20 s, and over 90 s when memory was short
    assert result.returncode == 0, result.stderr
    seen = json.loads(result.stdout)
    assert Path(seen['device']).resolve() == device.resolve() and Path(seen['data']).resolve() == root.resolve()
    assert seen['first'] == seen['second'] == expected
    assert_idle_and_fenced(root, lock, present, before, run_id)
