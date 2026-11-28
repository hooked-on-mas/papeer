"""A durable input set covers exactly the declared sources, without claiming unknown peers stopped."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from papeer.core.migrations.legacy_inputs import NativeLegacyInputs, assert_migration_input_set
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
from sidecar import deps
from sidecar.app import app


def corpus():
    return json.loads((Path(__file__).parent.parent / "fixtures/shared-edits.json").read_text("utf-8"))["legacyMigrationInputs"]


def test_input_coverage_matches_typescript_corpus():
    for case in corpus():
        if case["valid"]:
            assert_migration_input_set(case["value"])
        else:
            with pytest.raises(ValueError):
                assert_migration_input_set(case["value"])


def test_input_set_needs_hold_and_is_immutable_across_restart(tmp_path):
    root = tmp_path / "old-library"
    record = corpus()[0]["value"]
    store = NativeLegacyInputs(root)
    run_id = record["catalog"]["runId"]
    assert store.read(run_id) is None and not root.exists() and not store.root.exists()
    with pytest.raises(ValueError, match="hold-required"):
        store.prepare(record)
    NativeLegacyStartup(root).hold({"version": 1, "runId": run_id})
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: NativeLegacyInputs(root).prepare(record), range(2)))
    assert NativeLegacyInputs(root).read(run_id) == record
    changed = deepcopy(record)
    changed["catalog"]["identity"]["accountId"] = "another-account"
    with pytest.raises(ValueError, match="backup-id-reused"):
        store.prepare(changed)
    assert store.read(run_id) == record and not root.exists()
    path = store.root / (run_id + ".json")
    path.write_text(json.dumps(changed | {"freezeComplete": True}), "utf-8")
    with pytest.raises(ValueError):
        store.read(run_id)


def test_input_set_bounded_read_refuses_metadata_and_total_bytes(tmp_path):
    from papeer.core.migrations.legacy_backup import BackupReadLimits
    root = tmp_path / 'old-library'
    record = corpus()[0]['value']
    run_id = record['catalog']['runId']
    NativeLegacyStartup(root).hold({'version': 1, 'runId': run_id})
    store = NativeLegacyInputs(root)
    store.prepare(record)
    assert store.read(run_id, limits=BackupReadLimits(metadata_bytes=1024 * 1024, entries=100, total_bytes=64)) == record
    for limits in (BackupReadLimits(metadata_bytes=1, entries=100, total_bytes=100),
                   BackupReadLimits(metadata_bytes=1024 * 1024, entries=100, total_bytes=63)):
        with pytest.raises(ValueError, match='backup-read-limit'):
            store.read(run_id, limits=limits)
    assert store.read(run_id) == record


def test_input_set_api_is_authenticated_and_validates_before_writing(tmp_path, monkeypatch):
    root = tmp_path / "old-library"
    monkeypatch.setattr(deps, "get_data_dir", lambda: root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "0")
    monkeypatch.setenv("PAPEER_TOKEN", "input-fixture")
    client = TestClient(app)
    base = "/api/edits/legacy-inputs/"
    record = corpus()[0]["value"]
    run_id = record["catalog"]["runId"]
    assert client.post(base + "read", json={"runId": run_id}).status_code == 401
    client.headers["Authorization"] = "Bearer input-fixture"
    assert client.post(base + "read", json={"runId": run_id}).json() is None
    assert client.post(base + "prepare", json={"inputSet": record}).status_code == 422
    NativeLegacyStartup(root).hold({"version": 1, "runId": run_id})
    for case in corpus():
        if not case["valid"]:
            assert client.post(base + "prepare", json={"inputSet": case["value"]}).status_code == 422, case["name"]
    assert client.post(base + "prepare", json={"inputSet": record}).json() == {"status": "prepared"}
    assert client.post(base + "read", json={"runId": run_id}).json() == record
    assert client.post(base + "read", json={"runId": "../hold"}).status_code == 422
    assert not root.exists(), "metadata operations must not initialize old Library"


def test_declared_synthetic_input_backup_cold_process_and_private_analysis_copy(tmp_path):
    """One declared stopped synthetic source only; no global writer-drain claim."""
    import hashlib
    import subprocess
    import sys
    from uuid import uuid4
    from papeer.core.migrations.legacy_backup import NativeLegacyBackup

    source = tmp_path / 'declared-synthetic-library'
    source.mkdir()
    payload = b'synthetic pending legacy content\x00'
    (source / 'pending.bin').write_bytes(payload)
    run_id, backup_id = str(uuid4()), str(uuid4())
    backup = NativeLegacyBackup(source)
    plan = backup.inventory(backup_id)
    record = deepcopy(corpus()[0]['value'])
    record['catalog']['runId'] = run_id
    peer = record['catalog']['peers'][0]
    peer['sources'] = [deepcopy(plan['manifest']['source'])]
    record['inputs'] = [{'peerId': peer['id'], 'plan': plan}]
    NativeLegacyStartup(source).hold({'version': 1, 'runId': run_id})
    inputs = NativeLegacyInputs(source)
    inputs.prepare(record)
    assert inputs.read(run_id) == record
    manifest = backup.capture(plan)
    backup.assert_current(plan)
    assert manifest == plan['manifest']
    expected = hashlib.sha256(payload).hexdigest()
    # New interpreter cold-loads the immutable run and backup, verifies bodies,
    # and obtains an analysis copy. The caller supplies only its own tmp_path.
    script = r"""
import hashlib, json, sys
from pathlib import Path
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_backup import NativeLegacyBackup
source = Path(sys.argv[1]); run_id, backup_id = sys.argv[2:4]
record = NativeLegacyInputs(source).read(run_id)
backup = NativeLegacyBackup(source); manifest = backup.load(backup_id)
assert record['inputs'][0]['plan']['manifest'] == manifest
for entry in manifest['entries']:
    body = backup.object(backup_id, entry)
    assert len(body) == entry['byteLength'] and hashlib.sha256(body).hexdigest() == entry['sha256']
with backup.analysis_copy(backup_id) as working:
    result = hashlib.sha256((working / 'pending.bin').read_bytes()).hexdigest()
    (working / 'pending.bin').write_bytes(b'analysis-only mutation')
assert not working.exists()
assert backup.load(backup_id) == manifest
print(json.dumps({'runId': run_id, 'backupId': backup_id, 'sha256': result}))
"""
    child = subprocess.run([sys.executable, '-c', script, str(source), run_id, backup_id],
                           cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=30, check=True)
    assert json.loads(child.stdout) == {'runId': run_id, 'backupId': backup_id, 'sha256': expected}
    assert (source / 'pending.bin').read_bytes() == payload
    assert inputs.read(run_id) == record and backup.load(backup_id) == manifest
