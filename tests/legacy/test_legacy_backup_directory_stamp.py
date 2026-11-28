"""Work B6-f: a folder's stamp does not contain st_size (DESIGN-r161-b6f-stamp.md, tests F-1 .. F-11).

On NTFS a folder that is not cached reports st_size 0 from the by-name stat CPython 3.12 uses, and the real
allocation (4096, ...) after the folder has been listed. A scan reads a folder before it lists it and again
afterwards, so an unchanged, uncached folder failed every scan with `backup-source-changed` (REVIEW-r161-b6c.md,
aspect 6). The stamp of a folder is now [dev, ino, mtime_ns, ctime_ns], and the names of the children are listed
again at the end of every scan, in every mode. Only synthetic folders under tmp_path are read. The cold folder is
a model (`folder_scans(cold=True)`), so these tests do not depend on the cache of the machine; the real NTFS is
checked by a separate script (probe_cold_b6f.py), not here.
"""
import json
import os
from pathlib import Path
import random
from types import SimpleNamespace
from uuid import uuid4

import pytest

from _synthetic_legacy_library import Reported, folder_scans
from papeer.core import paths
from papeer.core.migrations import legacy_backup
from papeer.core.migrations.legacy_backup import NativeLegacyBackup
from papeer.core.migrations.legacy_device import NativeLegacyDeviceBackup

CHANGED = 'backup-source-changed'
FIELDS = ('st_dev', 'st_ino', 'st_mtime_ns', 'st_ctime_ns')


@pytest.fixture
def source(tmp_path):
    root = tmp_path / 'library'
    files = {'library.sqlite3': b'raw database fixture', 'top.txt': b'top', 'papers/古い/a.md': b'first',
             'papers/古い/b.pdf': b'second', 'papers/古い/c.json': b'{}', 'papers/新/x.txt': b'x',
             'deep/one/side.txt': b'side', 'deep/one/two/leaf.txt': b'leaf'}
    for name, data in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(data)
    (root / 'empty').mkdir()
    return root


def bumped(value, field):
    return Reported(value, **{field: int(getattr(value, field)) + 1})


def test_f1_cold_folders_are_stable_across_inventory_assert_and_capture(source):
    backup = NativeLegacyBackup(source)
    identity = str(uuid4())
    with folder_scans(cold=True) as cold:
        plan = backup.inventory(identity)
        backup.assert_current(plan)
        assert cold.scans == 2 and cold.cold_stats >= 8, 'the model must really report folders as not cached'
    backup.assert_current(plan)                       # warm: the same observation
    assert backup.inventory(identity) == plan
    with folder_scans(cold=True):
        assert backup.capture(plan) == plan['manifest']
    assert NativeLegacyBackup(source).load(identity) == plan['manifest']


def test_f1_control_the_cold_model_fails_the_old_definition(source, monkeypatch):
    """The model reaches the failure: with the old stamp (size included) a cold scan refuses an unchanged tree."""
    monkeypatch.setattr(legacy_backup, '_directory_stamp', legacy_backup._stamp)
    backup = NativeLegacyBackup(source)
    with folder_scans(cold=True):
        with pytest.raises(ValueError) as error:
            backup.inventory(str(uuid4()))
    assert error.value.args == (CHANGED,)


def test_f2_the_size_of_a_folder_is_never_read(source):
    backup = NativeLegacyBackup(source)
    identity = str(uuid4())
    plan = backup.inventory(identity)
    with folder_scans(size=lambda _path: random.randrange(1, 10 ** 9)):
        backup.assert_current(plan)
        assert backup.inventory(identity) == plan
        assert backup.capture(plan) == plan['manifest']


@pytest.mark.parametrize('field', (*FIELDS, 'st_size'))
def test_f3_a_nested_folder_that_changed_between_two_scans_is_refused_except_for_its_size(source, field):
    backup = NativeLegacyBackup(source)
    plan = backup.inventory(str(uuid4()))
    target = backup.source / 'deep' / 'one'

    def rewrite(_scan, path, directory, value):
        return bumped(value, field) if directory and path == target else value

    with folder_scans(rewrite=rewrite) as scans:
        if field == 'st_size':
            backup.assert_current(plan)
        else:
            with pytest.raises(ValueError) as error:
                backup.assert_current(plan)
            assert error.value.args == (CHANGED,)
        assert scans.scans == 1


@pytest.mark.parametrize('field', (*FIELDS, 'st_size'))
def test_f4_a_nested_folder_that_changed_inside_one_scan_is_refused_except_for_its_size(source, field):
    backup = NativeLegacyBackup(source)
    target = backup.source / 'deep' / 'one'

    def rewrite(scan, path, directory, value):
        # Only the last stat of the folder, taken after its children were listed.
        return bumped(value, field) if directory and path == target and str(path) in scan.listed else value

    with folder_scans(rewrite=rewrite):
        if field == 'st_size':
            backup.inventory(str(uuid4()))
        else:
            with pytest.raises(ValueError) as error:
                backup.inventory(str(uuid4()))
            assert error.value.args == (CHANGED,)


@pytest.mark.parametrize('field', ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))
def test_f5_a_file_that_changed_between_two_scans_is_refused_in_every_field(source, field):
    """The stamp of a file is unchanged by B6-f, size included."""
    backup = NativeLegacyBackup(source)
    plan = backup.inventory(str(uuid4()))
    target = backup.source / 'papers' / '古い' / 'a.md'

    def rewrite(_scan, path, directory, value):
        return bumped(value, field) if not directory and path == target else value

    with folder_scans(rewrite=rewrite):
        with pytest.raises(ValueError) as error:
            backup.assert_current(plan)
    assert error.value.args == (CHANGED,)


def hash_then_change(monkeypatch, folder, how):
    """After the first file of `folder` has been hashed, change the folder (once)."""
    real, done = legacy_backup._hash_file, []

    def changing(path, *args, **kwargs):
        result = real(path, *args, **kwargs)
        if path == folder / 'a.md' and not done:
            done.append(how)
            if how == 'add':
                (folder / 'late.txt').write_bytes(b'late')
            elif how == 'delete':
                (folder / 'a.md').unlink()
            else:
                (folder / 'a.md').rename(folder / 'renamed.md')
        return result

    monkeypatch.setattr(legacy_backup, '_hash_file', changing)
    return done


@pytest.mark.parametrize('how', ('add', 'delete', 'rename'))
def test_f6_the_names_are_listed_again_even_when_no_time_stamp_moves(source, monkeypatch, how):
    """freeze makes the folder keep its first stat (an mtime that never moves): only the second listing can see it."""
    backup = NativeLegacyBackup(source)
    done = hash_then_change(monkeypatch, backup.source / 'papers' / '古い', how)
    with folder_scans(freeze=True):
        with pytest.raises(ValueError) as error:
            backup.inventory(str(uuid4()))
    assert error.value.args == (CHANGED,) and done == [how], 'the change must have happened inside the scan'


def test_f7_a_file_added_during_a_scan_on_the_real_filesystem_is_refused_and_the_next_scan_succeeds(source, monkeypatch):
    backup = NativeLegacyBackup(source)
    folder = backup.source / 'papers' / '古い'
    done = hash_then_change(monkeypatch, folder, 'add')
    with pytest.raises(ValueError) as error:
        backup.inventory(str(uuid4()))
    assert error.value.args == (CHANGED,) and done == ['add']
    plan = backup.inventory(str(uuid4()))
    assert ['papers', '古い', 'late.txt'] in [entry['key'] for entry in plan['manifest']['entries']]
    backup.assert_current(plan)


@pytest.fixture
def device(tmp_path):
    library, root = tmp_path / 'device-library', tmp_path / 'device'
    library.mkdir()
    key, custom = paths.library_key(library), 'c' * 64
    files = {'device-settings.json': b'{}', 'storage-location.json': json.dumps({'path': str(library.resolve())}).encode(),
             key + '.json': b'{"last_revision":"base"}', key + '.opened.json': b'{}', 'history/' + key + '/state.json': b'current',
             'logs/current.log': b'excluded log', 'google-drive-credentials.dpapi': b'excluded'}
    for name, data in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(data)
    (root / 'history' / custom).mkdir()
    return library, root


def test_f8_a_selected_footprint_has_the_same_observation_under_the_old_and_the_new_definition(device, monkeypatch):
    library, root = device
    port = NativeLegacyDeviceBackup(library, root)
    identity = str(uuid4())
    new = port.inventory(identity)
    assert new['manifest']['entries'], 'the selection must have found device records'
    with monkeypatch.context() as patch:
        patch.setattr(legacy_backup, '_directory_stamp', legacy_backup._stamp)
        old = port.inventory(identity)
    assert new == old
    with folder_scans(cold=True):
        assert port.inventory(identity) == new


def test_f9_a_plan_made_with_the_old_definition_is_refused_and_a_fresh_plan_is_accepted(source, monkeypatch):
    backup = NativeLegacyBackup(source)
    identity = str(uuid4())
    with monkeypatch.context() as patch:
        patch.setattr(legacy_backup, '_directory_stamp', legacy_backup._stamp)
        old = backup.inventory(identity)
    new = backup.inventory(identity)
    assert old['manifest'] == new['manifest'] and old['observationSha256'] != new['observationSha256']
    for action in (backup.assert_current, backup.capture):
        with pytest.raises(ValueError) as error:
            action(old)
        assert error.value.args == (CHANGED,)
    assert not backup.root.exists(), 'a refused old plan must not create a backup'
    backup.assert_current(new)
    assert backup.capture(new) == new['manifest']


def test_f10_a_missing_source_has_the_same_observation_under_the_old_and_the_new_definition(tmp_path, monkeypatch):
    backup = NativeLegacyBackup(tmp_path / 'absent', allow_missing=True)
    identity = str(uuid4())
    new = backup.inventory(identity)
    assert new['manifest']['entries'] == [] and new['manifest']['containers'] == []
    with monkeypatch.context() as patch:
        patch.setattr(legacy_backup, '_directory_stamp', legacy_backup._stamp)
        assert backup.inventory(identity) == new


def test_f11_the_definition_of_the_stamps():
    value = SimpleNamespace(st_dev=1, st_ino=2, st_size=999, st_mtime_ns=3, st_ctime_ns=4)
    assert legacy_backup._directory_stamp(value) == ['1', '2', '3', '4']
    assert legacy_backup._stamp(value) == ['1', '2', '999', '3', '4'], 'the stamp of a file keeps st_size'
    real = os.stat(Path(__file__))
    assert len(legacy_backup._directory_stamp(real)) == 4 and len(legacy_backup._stamp(real)) == 5
