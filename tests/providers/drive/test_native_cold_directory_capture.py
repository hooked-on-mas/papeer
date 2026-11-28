"""Work B6-f: the Native capture and its resume do not fail on folders the file system has not cached.

A live Library's `papers/<id>` folders are usually not cached when a capture starts. Their by-name stat reports
st_size 0 until they are listed, then the real allocation, and the old stamp refused that as
`backup-source-changed` (REVIEW-r161-b6c.md, aspect 6). These tests run the real preparation (inventory, two
checks inside capture, the check after it and the read-back, per source) while a model makes EVERY scan start
from not-cached folders (`folder_scans(cold=True)`, the worst case), and a resume of an interrupted run whose
plan was made with the old definition. Synthetic data and the existing controlled-copy fixture only.
"""
from fastapi.testclient import TestClient

from _synthetic_legacy_library import build_synthetic_library, folder_scans
from test_native_maintenance_entry import runtime, start  # noqa: F401 - existing controlled-copy fixture
from test_native_notebook_preview import assert_leases_held, to_cold
from test_native_preparation_recovery import seeded
from papeer.core.migrations import legacy_backup
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_startup import NativeLegacyStartup, legacy_startup_allowed
from sidecar.app import app
from sidecar.migrations import preparation

WAIT = 600     # memory-starved machines are slow; a wait is never a reason to call the capture failed


def hold_bytes(root):
    path = NativeLegacyStartup(root).path
    return path.read_bytes() if path.exists() else None


def test_f12_a_fresh_capture_succeeds_when_every_scan_starts_from_cold_folders(runtime):  # noqa: F811
    root, device, _lock = runtime
    build_synthetic_library(root, device=device)
    with folder_scans(cold=True) as cold, TestClient(app) as client:
        run_id = start(client)['runId']
        state = preparation._current.wait(WAIT)
        assert state['state'] == 'captured', state          # the old stamp: failed / backup-source-changed
        preparation._current._thread.join(10)
        # 3 sources x (inventory, 2 checks in capture, check after it, read-back) = 15 scans, all cold at their start.
        assert cold.scans >= 15 and cold.cold_stats >= 15, (cold.scans, cold.cold_stats)
        assert_leases_held(preparation._current)
        assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': run_id} and not legacy_startup_allowed(root)
        assert NativeLegacyInputs(root).read(run_id) is not None


def test_f13_an_interrupted_run_with_an_old_definition_plan_is_refused_keeps_its_hold_and_can_be_retaken(runtime, monkeypatch):  # noqa: F811
    """No version field exists in a plan: an old plan simply no longer matches, and the run is cancelled and retaken."""
    root, device, _lock = runtime
    build_synthetic_library(root, device=device)
    with monkeypatch.context() as patch:
        patch.setattr(legacy_backup, '_directory_stamp', legacy_backup._stamp)     # the previous definition
        record = seeded(root, 'partial')
    run_id, registered, hold = record['runId'], NativeLegacyInputs(root).read(record['runId']), hold_bytes(root)
    assert registered is not None and hold is not None
    assert preparation.recover(run_id, 'capture')['state'] == 'running'
    state = preparation._current.wait(WAIT)
    assert state['state'] == 'failed' and state['failure'] == 'backup-source-changed', state
    preparation._current._thread.join(10)
    # The failed run keeps its fence: hold bytes, registered input set and the startup gate are unchanged.
    assert hold_bytes(root) == hold and not legacy_startup_allowed(root)
    assert NativeLegacyInputs(root).read(run_id) == registered
    # Cancel (as the Diagnostic does), then take the capture again with the current definition.
    assert preparation.recover(run_id, 'cancel')['state'] == 'cancelled'
    assert preparation.status()['phase'] == 'restart-required'
    assert NativeLegacyStartup(root).read() is None
    to_cold(monkeypatch)
    assert legacy_startup_allowed(root)
    with TestClient(app) as client:
        again = start(client)['runId']
        assert again != run_id
        assert preparation._current.wait(WAIT)['state'] == 'captured'
        preparation._current._thread.join(10)
    assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': again}


def test_f14_a_resumed_run_with_a_current_definition_plan_succeeds_on_cold_folders(runtime):  # noqa: F811
    root, device, _lock = runtime
    build_synthetic_library(root, device=device)
    record = seeded(root, 'partial')
    before = NativeLegacyInputs(root).read(record['runId'])
    with folder_scans(cold=True) as cold:
        assert preparation.recover(record['runId'], 'capture')['state'] == 'running'
        state = preparation._current.wait(WAIT)
        assert state['state'] == 'captured', state
        preparation._current._thread.join(10)
        assert cold.scans >= 10 and cold.cold_stats >= 10, (cold.scans, cold.cold_stats)
    assert NativeLegacyInputs(root).read(record['runId']) == before
    assert NativeLegacyStartup(root).read() == {'version': 1, 'runId': record['runId']}
