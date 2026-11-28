"""Actual isolated Core mutators and OS file locking; no real profile or browser."""
import json
from pathlib import Path
import subprocess
import sys
import threading

import pytest

from papeer.core import cloud_drive, cloud_drive_auth, config, device_authority as device
from papeer.core import drive_sync, file_lock, local_history, ocr, paths, storage_location
from papeer.core.instance import LibraryLock


@pytest.fixture
def library(tmp_path):
    root = tmp_path / 'library-A'
    root.mkdir()
    return root


def test_nested_writer_uses_one_handle_and_exception_releases_actual_os_lock(monkeypatch):
    opened = []
    original = file_lock.open_lock_file

    def observe(path):
        opened.append(path)
        return original(path)

    monkeypatch.setattr(file_lock, 'open_lock_file', observe)
    with pytest.raises(LookupError), device.writer():
        with device.writer():
            device.assert_writer()
            raise LookupError('bounded-test-failure')
    assert len(opened) == 1
    handle = original(paths.device_directory() / device.LOCK_NAME)
    try:
        assert file_lock.try_lock(handle)
    finally:
        file_lock.unlock(handle)


@pytest.mark.parametrize('mutation', ['settings', 'ocr', 'history', 'location', 'credentials', 'drive', 'folder-sync'])
def test_retained_device_authority_refuses_actual_cross_library_global_mutators(library, monkeypatch, mutation):
    other = library.with_name('library-B')
    other.mkdir()
    (other / 'library.sqlite3').write_bytes(b'only schedule existence is needed')
    monkeypatch.setattr(cloud_drive_auth, '_protect', lambda body, **_kwargs: body)
    action = {
        'settings': lambda: config.Settings().save(other),
        'ocr': lambda: ocr.save_ocr_settings('ask', 'auto', 'auto'),
        'history': lambda: local_history.save_history_settings(2, 2),
        'location': lambda: storage_location._save({'path': str(other)}),
        'credentials': lambda: cloud_drive_auth._save({'access_token': 'synthetic-never-log'}),
        'drive': lambda: cloud_drive.save_state(other, {'folder_id': 'synthetic'}),
        'folder-sync': lambda: drive_sync.save_state(other, {'folder': 'synthetic'}),
    }[mutation]
    lease = device.reserve_maintenance()
    try:
        before = {file.relative_to(paths.device_directory()): file.read_bytes()
                  for file in paths.device_directory().rglob('*') if file.is_file() and file.name != device.LOCK_NAME}
        with pytest.raises(device.DeviceWriterBusy) as error:
            action()
        assert error.value.code == 'device-maintenance-active'
        assert before == {file.relative_to(paths.device_directory()): file.read_bytes()
                          for file in paths.device_directory().rglob('*') if file.is_file() and file.name != device.LOCK_NAME}
        assert not (other / 'settings.json').exists()
    finally:
        lease.release()


def test_settings_load_defers_guarded_migration_while_busy_and_remains_readonly(library):
    raw = {'provider_options': {'codex': {'cli_path': 'synthetic-never-executed'}}}
    path = library / 'settings.json'
    path.write_text(json.dumps(raw), encoding='utf8')
    before = path.read_bytes()
    lease = device.reserve_maintenance()
    try:
        loaded = config.Settings.load(library)
        assert loaded.options('codex') == {'cli_path': 'synthetic-never-executed'}
        assert path.read_bytes() == before
        assert not config.device_settings_path().exists()
    finally:
        lease.release()
    config.Settings.load(library)
    assert json.loads(config.device_settings_path().read_text('utf8'))['migrated'] is True
    assert 'cli_path' not in json.loads(path.read_text('utf8'))['provider_options'].get('codex', {})
    after = {file: file.read_bytes() for file in (path, config.device_settings_path())}
    lease = device.reserve_maintenance()
    try:
        assert isinstance(config.Settings.load(library), config.Settings)
        assert all(file.read_bytes() == body for file, body in after.items())
    finally:
        lease.release()


def test_new_library_claim_is_fenced_before_lock_or_protocol_publication(library):
    lease = device.reserve_maintenance()
    lock = LibraryLock()
    try:
        with pytest.raises(device.DeviceWriterBusy):
            lock.try_acquire(library)
        assert not lock.held
        assert not (paths.device_directory() / 'instances').exists()
    finally:
        lease.release()
    try:
        assert lock.try_acquire(library)
        assert lock.writer_protocol_current(library)
        other = LibraryLock()
        assert not other.try_acquire(library)
        assert not other.writer_protocol_current(library)
    finally:
        lock.release()
    assert not lock.writer_protocol_current(library)


def test_retained_handle_has_no_dead_capture_thread_rlock_ownership():
    values = []
    creator = threading.Thread(target=lambda: values.append(device.reserve_maintenance()))
    creator.start(); creator.join(2)
    assert not creator.is_alive() and len(values) == 1
    lease = values[0]
    try:
        lease.assert_current()
        with pytest.raises(device.DeviceWriterBusy):
            with device.writer(timeout=0):
                pytest.fail('write admitted during retained capture')
    finally:
        lease.release()
    with device.writer(timeout=0):
        device.assert_writer()


def test_refresh_http_runs_outside_device_authority_then_commit_uses_exact_generation(library, monkeypatch):
    monkeypatch.setattr(cloud_drive_auth, '_protect', lambda body, **_kwargs: body)
    monkeypatch.setattr(cloud_drive_auth, '_attempt', None)
    cloud_drive_auth._changing.clear()
    cloud_drive_auth._save({'access_token': 'synthetic-old', 'refresh_token': 'synthetic-refresh',
                           'client_id': 'synthetic-client', 'expires_at': 0})
    reached = []

    def renew(_values):
        with pytest.raises(device.DeviceWriterUnavailable):
            device.assert_writer()
        # A genuine other-thread global settings write must complete while the
        # synthetic remote response is being obtained; no global lease over HTTP.
        worker = threading.Thread(target=lambda: (config.Settings().save(library), reached.append(True)))
        worker.start(); worker.join(2)
        assert not worker.is_alive() and reached == [True]
        return {'access_token': 'synthetic-new', 'expires_at': 10**12}

    monkeypatch.setattr(cloud_drive_auth, '_token', renew)
    assert cloud_drive_auth.capture_provider_access_token(cloud_drive_auth.generation()) == 'synthetic-new'
    assert json.loads(cloud_drive_auth._path().read_bytes())['access_token'] == 'synthetic-new'


def test_unavailable_os_lock_never_falls_back_to_unlocked_write(library, monkeypatch):
    def unavailable(_handle):
        raise OSError('synthetic-filesystem-lock-unavailable')

    monkeypatch.setattr(file_lock, 'try_lock', unavailable)
    with pytest.raises(OSError, match='synthetic-filesystem-lock-unavailable'):
        config.Settings().save(library)
    assert not config.device_settings_path().exists()
    assert not (library / 'settings.json').exists()


@pytest.mark.skipif(sys.platform != 'win32', reason='default-profile admission currently has only a Windows fixed-drive policy')
def test_supported_local_selection_is_real_owned_and_does_not_use_controlled_registry(monkeypatch):
    from sidecar import deps
    from sidecar.lifecycle import instance
    from sidecar.migrations import census

    monkeypatch.delenv('PAPEER_DATA_DIR', raising=False)
    monkeypatch.delenv('PAPERDESK_DATA_DIR', raising=False)
    root = paths.default_data_directory(); root.mkdir(parents=True, exist_ok=True)
    for name in ('_lock', '_owned_root', '_maintenance'):
        monkeypatch.setattr(instance, name, None)
    monkeypatch.setattr(deps, 'get_data_dir', lambda: root)
    monkeypatch.setattr(census, '_controlled_roots', {})
    held = instance.claim_library(root, 'dev', wait=0)
    try:
        assert held.held and held.writer_protocol_current(root)
        selected = census.select_current()
        assert selected.managed and selected.held_lock is held and not census._controlled_roots
        assert selected.root == root and selected.history_refs
    finally:
        instance.release()


_CHILD_SETUP = r'''
import importlib.util, pathlib, sys
root, candidate = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
for name in ('papeer.core.device_authority', 'papeer.core.config'):
    source = candidate / (name.replace('.', '/') + '.py')
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
device, config = sys.modules['papeer.core.device_authority'], sys.modules['papeer.core.config']
'''

_CHILD = _CHILD_SETUP + r'''
print('ready', flush=True)
try:
    with device.writer(timeout=.15):
        config.Settings().save(root)
except device.DeviceWriterBusy:
    print('blocked', flush=True)
else:
    raise AssertionError('writer bypassed retained OS lock')
assert sys.stdin.readline().strip() == 'retry-after-release'
with device.writer(timeout=2):
    config.Settings().save(root)
print('saved-after-release', flush=True)
'''


def test_actual_second_process_cannot_save_while_retained_capture_then_retries_after_release(library):
    # No OS inventory/termination, only this bounded child, whose environment is
    # the real project's isolated_app_data fixture inherited by subprocesses.
    candidate = Path(device.__file__).parents[2]
    lease = device.reserve_maintenance()
    process = subprocess.Popen([sys.executable, '-B', '-c', _CHILD, str(library), str(candidate)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True)
    try:
        assert process.stdout is not None and process.stdin is not None
        assert process.stdout.readline().strip() == 'ready'
        assert process.stdout.readline().strip() == 'blocked'
        assert not config.device_settings_path().exists()
        assert not (library / 'settings.json').exists()
        lease.release()
        process.stdin.write('retry-after-release\n'); process.stdin.flush()
        output, error = process.communicate(timeout=5)
        assert process.returncode == 0, error
        assert output.strip() == 'saved-after-release'
        assert json.loads(config.device_settings_path().read_text('utf8'))['migrated'] is True
        assert (library / 'settings.json').exists()
    finally:
        lease.release()
        if process.poll() is None:
            # Closing stdin retires only the exact child; no force kill or
            # process-name lookup, and failure remains visible in the test.
            if process.stdin is not None:
                process.stdin.close(); process.stdin = None
            process.communicate(timeout=5)


def test_capture_times_out_behind_real_existing_writer_then_acquires_after_owned_release(library):
    holder = _CHILD_SETUP + r'''
with device.writer(timeout=2):
    config.Settings().save(root)
    print('writer-held', flush=True)
    assert sys.stdin.readline().strip() == 'finish-write'
print('writer-released', flush=True)
'''
    candidate = Path(device.__file__).parents[2]
    process = subprocess.Popen([sys.executable, '-B', '-c', holder, str(library), str(candidate)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert process.stdout is not None and process.stdin is not None
        assert process.stdout.readline().strip() == 'writer-held'
        before = config.device_settings_path().read_bytes()
        with pytest.raises(device.DeviceWriterBusy):
            device.reserve_maintenance(timeout=.15)
        assert config.device_settings_path().read_bytes() == before
        process.stdin.write('finish-write\n'); process.stdin.flush()
        output, error = process.communicate(timeout=5)
        assert process.returncode == 0, error
        assert output.strip() == 'writer-released'
        lease = device.reserve_maintenance(timeout=.15)
        try:
            lease.assert_current()
            with pytest.raises(device.DeviceWriterBusy):
                config.Settings().save(library)
            assert config.device_settings_path().read_bytes() == before
        finally:
            lease.release()
    finally:
        if process.poll() is None:
            if process.stdin is not None:
                process.stdin.close(); process.stdin = None
            process.communicate(timeout=5)


@pytest.mark.parametrize('raw', ['{"migrated":true,"provider_options":{}}', '{broken JSON'])
def test_pure_device_reads_never_request_a_writer_lease(library, monkeypatch, raw):
    path = config.device_settings_path()
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(raw, 'utf8')
    def forbidden(*_args, **_kwargs):
        raise AssertionError('pure device read requested a writer lease')
    monkeypatch.setattr(config, 'writer', forbidden)
    assert isinstance(config.Settings.load(library), config.Settings)
    assert path.read_text('utf8') == raw
    assert not (paths.device_directory() / device.LOCK_NAME).exists()


def test_guarded_migration_body_error_is_not_reclassified_as_unavailable_lease(library, monkeypatch):
    source = library / 'settings.json'
    raw = '{"provider_options":{"codex":{"cli_path":"synthetic-late-write"}}}'
    source.write_text(raw, 'utf8')
    original = config.atomic_write_json
    writes = []
    def write(path, value):
        device.assert_writer()
        writes.append(path)
        if path == source:
            raise OSError('synthetic-library-cleanup-failure-after-device-write')
        return original(path, value)
    monkeypatch.setattr(config, 'atomic_write_json', write)
    with pytest.raises(OSError, match='synthetic-library-cleanup-failure-after-device-write'):
        config.Settings.load(library)
    # Existing migration is not one transaction: device publication succeeded,
    # cleanup failed. Preserve both facts rather than pretend this was a pure
    # read/failed lease entry or silently report completion.
    assert writes == [config.device_settings_path(), source]
    assert json.loads(config.device_settings_path().read_text('utf8'))['migrated'] is True
    assert source.read_text('utf8') == raw
    with device.writer(timeout=0):
        device.assert_writer()
