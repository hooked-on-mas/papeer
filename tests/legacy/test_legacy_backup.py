"""Migration backup preserves raw input, journals and WAL without opening the source Library."""
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from papeer.core.migrations.legacy_backup import NativeLegacyBackup, assert_backup_manifest, inventory_hash
from sidecar import deps
from sidecar.app import app


def contents(root):
    return {path.relative_to(root).as_posix(): path.read_bytes() for path in root.rglob("*") if path.is_file()}


@pytest.fixture
def source(tmp_path):
    root = tmp_path / "library"
    root.mkdir()
    (root / "papers" / "古い").mkdir(parents=True)
    (root / "empty").mkdir()
    for key, data in {"library.sqlite3": b"raw database fixture", ".notebook-change.json": b'{"pending":true}',
                      ".interrupted.abc.tmp": b"unfinished draft", "papers/古い/note.md": "未送信😀".encode(),
                      "papers/古い/original.pdf": b"pdf", "zero": b"", "same": b"pdf"}.items():
        (root / key).write_bytes(data)
    return root


def test_all_files_empty_directories_journals_and_duplicate_bodies_survive_restart_and_verified_read(source):
    original = contents(source)
    backup = NativeLegacyBackup(source)
    identity = str(uuid4())
    assert backup.load(identity) is None
    assert not backup.root.exists(), "read-only recovery lookup must not create a directory"
    plan = backup.inventory(identity)
    assert ["empty"] in plan["manifest"]["containers"]
    assert {"/".join(e["key"]) for e in plan["manifest"]["entries"]} == set(original)
    result = backup.capture(plan)
    assert result == plan["manifest"]
    restarted = NativeLegacyBackup(source)
    assert restarted.plan(identity) == plan
    assert restarted.load(identity) == result
    restored = {"/".join(entry["key"]): restarted.object(identity, entry) for entry in result["entries"]}
    assert restored == original == contents(source)
    assert len(list((backup.root / "objects").iterdir())) == len({hashlib.sha256(value).hexdigest() for value in original.values()})
    assert restarted.capture(plan) == result


def test_real_live_sqlite_wal_and_shm_are_copied_as_raw_bytes_and_recover_on_an_isolated_copy(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    with closing(sqlite3.connect(source / "library.sqlite3")) as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA wal_autocheckpoint=0")
        db.execute("CREATE TABLE pending(id INTEGER PRIMARY KEY, text TEXT)")
        db.execute("INSERT INTO pending VALUES(9223372036854775807, '未送信')")
        db.commit()
        before = contents(source)
        assert "library.sqlite3-wal" in before and "library.sqlite3-shm" in before
        backup = NativeLegacyBackup(source)
        plan = backup.inventory(str(uuid4()))
        manifest = backup.capture(plan)
        with backup.analysis_copy(manifest["id"]) as restored:
            assert contents(restored) == before
            assert contents(source) == before
            with closing(sqlite3.connect(restored / "library.sqlite3")) as recovered:
                assert recovered.execute("SELECT * FROM pending").fetchall() == [(9223372036854775807, "未送信")]
                assert recovered.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                recovered.execute("INSERT INTO pending VALUES(1, 'analysis only')")
                recovered.commit()
            assert backup.load(manifest["id"]) == manifest, "SQL recovery/writes must not mutate immutable object bodies"
        assert not restored.exists()
        assert contents(source) == before, "recovery belongs to the copy; opening it cannot change the live WAL/SHM"


def test_private_analysis_copy_keeps_empty_directories_and_is_cleaned_after_failure(source):
    backup = NativeLegacyBackup(source)
    manifest = backup.capture(backup.inventory(str(uuid4())))
    original = contents(source)
    working = None
    with pytest.raises(RuntimeError, match="parser failed"):
        with backup.analysis_copy(manifest["id"]) as working:
            assert contents(working) == original and (working / "empty").is_dir()
            (working / "library.sqlite3").write_bytes(b"parser changed its private input")
            raise RuntimeError("parser failed")
    assert working is not None and not working.exists()
    assert backup.load(manifest["id"]) == manifest and contents(source) == original
    with pytest.raises(ValueError, match="backup-completion-missing"):
        with backup.analysis_copy(str(uuid4())):
            pytest.fail("missing completion cannot yield input")


@pytest.mark.parametrize('kind', ['metadata', 'entries', 'bytes'])
def test_bounded_analysis_rejects_excess_before_reading_objects_or_making_copy(source, monkeypatch, kind):
    from papeer.core.migrations.legacy_backup import BackupReadLimits
    backup = NativeLegacyBackup(source)
    manifest = backup.capture(backup.inventory(str(uuid4())))
    limits = BackupReadLimits(metadata_bytes=1 if kind == 'metadata' else 1024 * 1024,
                              entries=1 if kind == 'entries' else 100,
                              total_bytes=1 if kind == 'bytes' else 1024 * 1024)

    def refuse_object(_entry):
        raise AssertionError('the limit must be checked before reading backup objects')

    monkeypatch.setattr(backup.store, 'object_path', refuse_object)
    with pytest.raises(ValueError, match='backup-read-limit'):
        with backup.analysis_copy(manifest['id'], limits=limits):
            pytest.fail('oversized input must not produce an analysis copy')
    assert not list(backup.root.glob('.analysis-*'))


def test_oversized_backup_object_is_refused_before_hashing_its_body(tmp_path, monkeypatch):
    from papeer.core.migrations import legacy_backup
    root = tmp_path / 'library'; root.mkdir()
    (root / 'small').write_bytes(b'small')
    backup = NativeLegacyBackup(root)
    manifest = backup.capture(backup.inventory(str(uuid4())))
    entry = manifest['entries'][0]
    obj = backup.root / 'objects' / entry['sha256']
    obj.write_bytes(b'x' * (1024 * 1024))
    real_digest = legacy_backup.hashlib.file_digest

    def refuse_large_body(stream, algorithm):
        if Path(stream.name) == obj:
            raise AssertionError('oversized object must be rejected before its body is hashed')
        return real_digest(stream, algorithm)

    monkeypatch.setattr(legacy_backup.hashlib, 'file_digest', refuse_large_body)
    with pytest.raises(ValueError, match='backup-object-hash'):
        backup.load(manifest['id'])


def test_analysis_copy_does_not_copy_appended_bytes_after_object_verification(tmp_path, monkeypatch):
    from papeer.core.migrations import legacy_backup
    root = tmp_path / 'library'; root.mkdir()
    (root / 'small').write_bytes(b'small')
    backup = NativeLegacyBackup(root)
    manifest = backup.capture(backup.inventory(str(uuid4())))
    original_object = backup._object
    real_remove = legacy_backup.shutil.rmtree
    copied_sizes = []

    def append_after_verification(entry):
        obj = original_object(entry)
        with obj.open('ab') as stream:
            stream.write(b'x' * (1024 * 1024))
        return obj

    def observe_cleanup(directory):
        target = Path(directory) / 'small'
        if target.exists(): copied_sizes.append(target.stat().st_size)
        return real_remove(directory)

    monkeypatch.setattr(backup, '_object', append_after_verification)
    monkeypatch.setattr(legacy_backup.shutil, 'rmtree', observe_cleanup)
    with pytest.raises(ValueError, match='backup-object-hash|backup-source-changed'):
        with backup.analysis_copy(manifest['id']):
            pytest.fail('changed object must not yield an analysis copy')
    assert copied_sizes and copied_sizes[0] <= len(b'small')
    assert not list(backup.root.glob('.analysis-*')) and (root / 'small').read_bytes() == b'small'


def test_analysis_copy_refuses_object_growth_while_it_is_being_read(tmp_path, monkeypatch):
    from papeer.core.migrations import legacy_backup
    root = tmp_path / 'library'; root.mkdir()
    (root / 'small').write_bytes(b'small')
    backup = NativeLegacyBackup(root)
    manifest = backup.capture(backup.inventory(str(uuid4())))
    obj = backup.root / 'objects' / manifest['entries'][0]['sha256']
    original_object, real_open = backup._object, Path.open
    real_remove = legacy_backup.shutil.rmtree
    armed = False
    copied_sizes = []

    def arm_copy(entry):
        nonlocal armed
        path = original_object(entry)
        armed = True
        return path

    class GrowingStream:
        def __init__(self, stream):
            self.stream = stream
            self.grown = False

        def __enter__(self): return self
        def __exit__(self, *args): return self.stream.__exit__(*args)
        def fileno(self): return self.stream.fileno()
        def read(self, count):
            data = self.stream.read(count)
            if not self.grown:
                self.grown = True
                with real_open(obj, 'ab') as stream:
                    stream.write(b'x' * (1024 * 1024))
            return data

    def open_for_copy(path, mode='r', *args, **kwargs):
        nonlocal armed
        stream = real_open(path, mode, *args, **kwargs)
        if path == obj and mode == 'rb' and armed:
            armed = False
            return GrowingStream(stream)
        return stream

    def observe_cleanup(directory):
        target = Path(directory) / 'small'
        if target.exists(): copied_sizes.append(target.stat().st_size)
        return real_remove(directory)

    monkeypatch.setattr(backup, '_object', arm_copy)
    monkeypatch.setattr(Path, 'open', open_for_copy)
    monkeypatch.setattr(legacy_backup.shutil, 'rmtree', observe_cleanup)
    with pytest.raises(ValueError, match='backup-object-hash|backup-source-changed'):
        with backup.analysis_copy(manifest['id']):
            pytest.fail('growing object must not yield an analysis copy')
    assert copied_sizes and copied_sizes[0] <= len(b'small')
    assert not list(backup.root.glob('.analysis-*')) and (root / 'small').read_bytes() == b'small'


class _CancelAfter:
    """An Event-like flag that reads as set from its n-th check on (counts every is_set call)."""
    def __init__(self, checks):
        self.checks, self.calls = checks, 0

    def is_set(self):
        self.calls += 1
        return self.calls > self.checks


def test_hash_file_cancel_stops_between_blocks_and_none_keeps_old_behavior(tmp_path):
    from papeer.core.migrations.legacy_backup import _hash_file
    path = tmp_path / 'large'
    data = b'a' * (3 * 1024 * 1024 + 5)
    path.write_bytes(data)
    expected = hashlib.sha256(data).hexdigest()
    # No cancel: identical results for both the sized and the unsized path.
    assert _hash_file(path)[0] == expected and _hash_file(path, expected_size=len(data))[0] == expected
    # Never-set cancel does not change the digest either.
    flag = _CancelAfter(10_000)
    assert _hash_file(path, cancel=flag)[0] == expected and _hash_file(path, expected_size=len(data), cancel=flag)[0] == expected
    # Set before the read, and set after the first blocks: both stop with the same reason.
    for kwargs in ({}, {'expected_size': len(data)}):
        for checks in (0, 2):
            with pytest.raises(ValueError, match='^backup-read-cancelled$'):
                _hash_file(path, cancel=_CancelAfter(checks), **kwargs)


def test_analysis_copy_cancel_removes_the_working_directory_and_keeps_objects(tmp_path):
    root = tmp_path / 'library'; root.mkdir()
    (root / 'one').write_bytes(b'1' * (2 * 1024 * 1024 + 1))
    (root / 'two').write_bytes(b'2' * (2 * 1024 * 1024 + 3))
    backup = NativeLegacyBackup(root)
    manifest = backup.capture(backup.inventory(str(uuid4())))
    objects = {path.name: path.read_bytes() for path in (backup.root / 'objects').iterdir()}
    # Cancel during the manifest verification, then during the copy of a later entry.
    for checks in (1, 8, 14):
        flag = _CancelAfter(checks)
        with pytest.raises(ValueError, match='^backup-read-cancelled$'):
            with backup.analysis_copy(manifest['id'], cancel=flag):
                pytest.fail('a cancelled copy must not yield')
        assert not list(backup.root.glob('.analysis-*')), f'working directory left after {checks} checks'
    assert {path.name: path.read_bytes() for path in (backup.root / 'objects').iterdir()} == objects
    # The default (no cancel) still yields a complete copy and removes it afterwards.
    with backup.analysis_copy(manifest['id']) as copy:
        assert (copy / 'one').read_bytes() == b'1' * (2 * 1024 * 1024 + 1)
    assert not list(backup.root.glob('.analysis-*'))


def test_private_analysis_refuses_forged_native_keys_without_creating_or_writing_working_files(source, monkeypatch):
    backup = NativeLegacyBackup(source)
    manifest = backup.capture(backup.inventory(str(uuid4())))
    original = contents(source)
    for component in ("..", ".", "a/b", "a\\b", "C:outside", "bad\0name"):
        forged = deepcopy(manifest)
        forged["entries"][0]["key"] = [component]
        # The outer contract's valid hashes do not make an archive key safe as a native path.
        monkeypatch.setattr(backup, "load", lambda _identity: forged)
        with pytest.raises(ValueError, match="backup-native-key"):
            with backup.analysis_copy(manifest["id"]):
                pytest.fail("forged filesystem key yielded input")
        assert not list(backup.root.glob(".analysis-*")) and contents(source) == original


def test_failed_copy_keeps_the_fixed_plan_objects_and_source_and_retries_after_restart(source, monkeypatch):
    backup = NativeLegacyBackup(source)
    plan = backup.inventory(str(uuid4()))
    before = contents(source)
    copy = backup._copy
    count = 0

    def quota(entry):
        nonlocal count
        count += 1
        if count == 2:
            raise OSError("no space left")
        copy(entry)

    monkeypatch.setattr(backup, "_copy", quota)
    with pytest.raises(OSError, match="no space left"):
        backup.capture(plan)
    assert backup.plan(plan["manifest"]["id"]) == plan
    assert backup.load(plan["manifest"]["id"]) is None
    assert list((backup.root / "objects").iterdir())
    assert contents(source) == before
    restarted = NativeLegacyBackup(source)
    assert restarted.capture(restarted.plan(plan["manifest"]["id"])) == plan["manifest"]


def test_post_copy_source_drift_never_publishes_completion_and_cannot_reuse_the_fixed_run_id(source, monkeypatch):
    backup = NativeLegacyBackup(source)
    plan = backup.inventory(str(uuid4()))
    copy = backup._copy
    once = False

    def drift(entry):
        nonlocal once
        copy(entry)
        if not once:
            once = True
            (source / "late-operation.json").write_text('{"pending":"late"}', "utf-8")

    monkeypatch.setattr(backup, "_copy", drift)
    with pytest.raises(ValueError, match="backup-source-changed"):
        backup.capture(plan)
    assert backup.load(plan["manifest"]["id"]) is None
    restarted = NativeLegacyBackup(source)
    changed = restarted.inventory(plan["manifest"]["id"])
    with pytest.raises(ValueError, match="backup-id-reused"):
        restarted.capture(changed)
    assert restarted.plan(plan["manifest"]["id"]) == plan
    assert (source / "late-operation.json").read_text("utf-8") == '{"pending":"late"}'


def test_manifest_response_loss_leaves_a_complete_immutable_backup(source, monkeypatch):
    backup = NativeLegacyBackup(source)
    plan = backup.inventory(str(uuid4()))
    monkeypatch.setattr(backup, "load", lambda _identity: (_ for _ in ()).throw(ConnectionError("response lost")))
    with pytest.raises(ConnectionError, match="response lost"):
        backup.capture(plan)
    restarted = NativeLegacyBackup(source)
    assert restarted.load(plan["manifest"]["id"]) == plan["manifest"]
    assert restarted.capture(plan) == plan["manifest"]
    # The saved input remains readable even when the source DB is no longer readable.
    (source / "library.sqlite3").write_bytes(b"corrupt source")
    assert restarted.load(plan["manifest"]["id"]) == plan["manifest"]
    with pytest.raises(ValueError, match="backup-source-changed"):
        restarted.assert_current(plan)


def test_independent_concurrent_captures_publish_one_immutable_plan_and_completion(source):
    plan = NativeLegacyBackup(source).inventory(str(uuid4()))
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(NativeLegacyBackup(source).capture, plan) for _ in range(2)]
        results = [future.result(timeout=15) for future in futures]
    assert results == [plan["manifest"], plan["manifest"]]
    assert NativeLegacyBackup(source).plan(plan["manifest"]["id"]) == plan


def test_corrupt_immutable_body_is_detected_and_never_overwritten(source):
    backup = NativeLegacyBackup(source)
    plan = backup.inventory(str(uuid4()))
    manifest = backup.capture(plan)
    entry = manifest["entries"][0]
    path = backup.root / "objects" / entry["sha256"]
    path.write_bytes(b"broken")
    with pytest.raises(ValueError, match="backup-object-hash"):
        backup.load(manifest["id"])
    with pytest.raises(ValueError, match="backup-object-hash"):
        backup.capture(plan)
    assert path.read_bytes() == b"broken"


def test_injected_paths_invalid_ids_and_overlapping_destination_are_rejected_before_copy(source):
    backup = NativeLegacyBackup(source)
    plan = backup.inventory(str(uuid4()))
    injected = deepcopy(plan)
    injected["manifest"]["entries"][0]["key"] = ["..", "outside"]
    injected["manifest"]["containers"] = [[".."], *injected["manifest"]["containers"]]
    injected["manifest"]["entries"].sort(key=lambda entry: entry["key"])
    injected["manifest"]["inventorySha256"] = inventory_hash(injected["manifest"])
    with pytest.raises(ValueError, match="backup-source-changed"):
        backup.capture(injected)
    assert not backup.root.exists()
    with pytest.raises(ValueError):
        backup.inventory("../../escape")
    for destination in [source, source / "backup", source.parent]:
        with pytest.raises(ValueError, match="overlaps-source"):
            NativeLegacyBackup(source, destination)


def test_linked_input_or_object_directory_is_refused_instead_of_followed(source, tmp_path):
    other = tmp_path / "other"
    other.write_bytes(b"outside")
    linked = source / "linked"
    try:
        linked.symlink_to(other)
    except OSError as exc:
        if os.name != "nt":
            pytest.skip(f"OS symlink privilege unavailable: {exc}")
        target = tmp_path / "junction-target"
        target.mkdir()
        (target / "untouched").write_bytes(b"outside directory")
        assert linked.resolve().is_relative_to(tmp_path.resolve()) and target.resolve().is_relative_to(tmp_path.resolve())
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(linked), str(target)], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        assert result.returncode == 0, result.stderr
    try:
        with pytest.raises(ValueError, match="backup-link-refused"):
            NativeLegacyBackup(source).inventory(str(uuid4()))
    finally:
        if os.name == "nt" and linked.is_junction():
            assert linked.parent.resolve().is_relative_to(tmp_path.resolve())
            linked.rmdir()  # Remove only this test's junction, never recurse through its target.
    assert other.read_bytes() == b"outside"


def test_frozen_manifest_golden_hash_and_unicode_order_match_the_typescript_contract():
    fixture = json.loads((Path(__file__).parent.parent / "fixtures/shared-edits.json").read_text("utf-8"))["legacyBackup"]
    assert_backup_manifest(fixture["plan"]["manifest"])
    bodies = {value["sha256"]: value["dataBase64"] for value in fixture["bodies"]}
    import base64
    for entry in fixture["plan"]["manifest"]["entries"]:
        value = base64.b64decode(bodies[entry["sha256"]])
        assert len(value) == entry["byteLength"] and hashlib.sha256(value).hexdigest() == entry["sha256"]


def test_common_manifest_rules_reject_duplicate_parent_collision_and_wrong_digest(source):
    manifest = NativeLegacyBackup(source).inventory(str(uuid4()))["manifest"]
    for mode in ("duplicate", "parent", "collision", "digest"):
        invalid = deepcopy(manifest)
        if mode == "duplicate":
            invalid["entries"].insert(0, deepcopy(invalid["entries"][0]))
        elif mode == "parent":
            invalid["containers"] = []
        elif mode == "collision":
            invalid["containers"].append(invalid["entries"][0]["key"])
            invalid["containers"].sort()
        else:
            invalid["inventorySha256"] = "0" * 64
        if mode != "digest":
            invalid["inventorySha256"] = inventory_hash(invalid)
        with pytest.raises(ValueError):
            assert_backup_manifest(invalid)


def test_authenticated_api_never_initializes_source_library_and_rejects_drift(source, monkeypatch):
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "get_data_dir", lambda: source)
    monkeypatch.setattr(deps, "get_library", lambda: (_ for _ in ()).throw(AssertionError("must not open source Library")))
    client = TestClient(app)
    base = "/api/edits/legacy-backup/"
    identity = str(uuid4())
    response = client.post(base + "inventory", json={"id": identity})
    assert response.status_code == 200, response.text
    plan = response.json()
    assert client.post(base + "capture", json={"plan": plan}).json() == plan["manifest"]
    assert client.post(base + "plan", json={"id": identity}).json() == plan
    assert client.post(base + "load", json={"id": identity}).json() == plan["manifest"]
    assert client.post(base + "assert-current", json={"plan": plan}).status_code == 200
    (source / "late").write_text("late", "utf-8")
    assert client.post(base + "assert-current", json={"plan": plan}).status_code == 422
    assert client.post(base + "capture", json={"plan": plan}).status_code == 422
    # Readback of a completed immutable input does not depend on the current source generation.
    assert client.post(base + "load", json={"id": identity}).json() == plan["manifest"]
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "0")
    monkeypatch.setenv("PAPEER_TOKEN", "fixture-secret")
    assert client.post(base + "inventory", json={"id": str(uuid4())}).status_code == 401
