"""Old source without a hold must not disappear behind a fresh canonical chooser."""
from pathlib import Path
import importlib
import json
import sqlite3

from fastapi.testclient import TestClient
import pytest

from papeer.core.migrations.legacy_startup import NativeLegacyStartup, read_native_legacy_presence
from papeer.core import paths, storage_location
from sidecar import deps
from sidecar.app import app
from sidecar.app import remove_unused_translation_runs
from sidecar.canonical_host import authority
from papeer.translation import translation_preview


@pytest.fixture
def context(tmp_path, monkeypatch):
    root = tmp_path / 'legacy'
    monkeypatch.setenv('PAPEER_DATA_DIR', str(root))
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'admission-test-token')
    monkeypatch.setattr(deps, 'get_library', lambda: pytest.fail('legacy Library opened'))
    authority.revoke_all()
    with TestClient(app) as client:
        client.headers['Authorization'] = 'Bearer admission-test-token'
        yield root, client
    authority.revoke_all()


def test_absent_and_empty_directories_are_clear_without_creating_anything(context):
    root, client = context
    assert client.post('/api/edits/legacy-startup/presence', json={}).json() == 'clear'
    assert not root.exists() and not deps.get_canonical_storage_path().exists()
    (root / 'papers' / 'empty').mkdir(parents=True)
    assert read_native_legacy_presence(root) == 'clear'
    result = client.post('/api/edits/bootstrap/local-context/provision', json={})
    assert result.status_code == 200 and result.json()['status'] == 'ready'
    assert list((root / 'papers' / 'empty').iterdir()) == []
    assert sorted(path.relative_to(root).as_posix() for path in root.rglob('*')) == ['papers', 'papers/empty']
    assert deps.get_canonical_storage_path().parent.parent == root.parent


@pytest.mark.parametrize('relative', ['library.sqlite3', 'library.sqlite3-wal', '.notebook-change.json',
                                      'papers/old/notes.md', 'papers/old/ink.json', 'unknown.bin'])
def test_any_old_body_blocks_fresh_setup_without_reading_or_recovering_it(context, monkeypatch, relative):
    root, client = context
    source = root / relative
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b'raw old bytes, deliberately not valid SQLite or JSON')
    before = source.read_bytes(), source.stat().st_mtime_ns
    assert NativeLegacyStartup(root).read() is None
    with monkeypatch.context() as readonly:
        readonly.setattr(sqlite3, 'connect', lambda *a, **k: pytest.fail('SQLite opened during admission'))
        readonly.setattr(Path, 'read_bytes', lambda self: pytest.fail('source body read during admission'))
        assert read_native_legacy_presence(root) == 'legacy-present'
        assert client.post('/api/edits/legacy-startup/presence', json={}).json() == 'legacy-present'
        # The actual hold protocol remains record|null, not a synthetic migration hold.
        assert client.post('/api/edits/legacy-startup/read', json={}).json() is None
        for route in ('read', 'provision'):
            result = client.post('/api/edits/bootstrap/local-context/' + route, json={})
            assert result.status_code == 403 and result.json()['detail'] == 'canonical-authority-denied'
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before
    assert not deps.get_canonical_storage_path().parent.exists()
    assert not NativeLegacyStartup(root).root.exists()


def test_missing_auth_and_unverifiable_presence_fail_closed(context, monkeypatch):
    root, client = context
    with TestClient(app) as anonymous:
        assert anonymous.post('/api/edits/legacy-startup/presence', json={}).status_code == 401
    root.mkdir()
    real_scandir = __import__('os').scandir

    def denied(path):
        if Path(path) == root:
            raise PermissionError('unreadable legacy root')
        return real_scandir(path)

    monkeypatch.setattr('papeer.core.migrations.legacy_startup.os.scandir', denied)
    assert client.post('/api/edits/legacy-startup/presence', json={}).status_code == 503
    assert client.post('/api/edits/bootstrap/local-context/provision', json={}).status_code == 403
    assert not deps.get_canonical_storage_path().exists()


def test_linked_root_is_not_followed_or_treated_as_empty(context, tmp_path):
    root, client = context
    target = tmp_path / 'other'
    target.mkdir()
    try:
        root.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError):
        # Windows commonly permits junctions without the symlink privilege.
        if __import__('os').name != 'nt':
            pytest.skip('directory symlink unavailable on this host')
        import _winapi
        _winapi.CreateJunction(str(target), str(root))
    with pytest.raises(ValueError, match='link-refused'):
        read_native_legacy_presence(root)
    assert client.post('/api/edits/legacy-startup/presence', json={}).status_code == 422
    assert list(target.iterdir()) == []


def test_old_input_appearing_after_grant_does_not_get_hidden_by_existing_lease(context):
    root, client = context
    response = client.post('/api/edits/bootstrap/local-context/provision', json={})
    lease = response.json()['leaseId']
    canonical = deps.get_canonical_storage_path()
    before = canonical.read_bytes()
    (root / 'papers').mkdir(parents=True)
    (root / 'papers' / 'note.md').write_text('retained old note', encoding='utf8')
    result = client.post('/api/edits/bootstrap/discover', json={}, headers={'X-Papeer-Host-Lease': lease})
    assert result.status_code == 403 and result.json()['detail'] == 'canonical-authority-denied'
    assert client.post('/api/edits/legacy-startup/presence', json={}).json() == 'legacy-present'
    assert canonical.read_bytes() == before


def test_startup_cleanup_skips_unheld_legacy_bodies_before_any_recovery(tmp_path, monkeypatch):
    root = tmp_path / 'legacy'
    source = root / 'papers' / 'old' / 'translation-pages' / 'orphan.pdf'
    source.parent.mkdir(parents=True)
    source.write_bytes(b'old pending source must remain untouched')
    before = source.read_bytes(), source.stat().st_mtime_ns
    monkeypatch.setenv('PAPEER_DATA_DIR', str(root))
    monkeypatch.setattr(translation_preview, 'remove_unused_translation_runs',
                        lambda _: pytest.fail('legacy startup cleanup ran before admission'))
    assert NativeLegacyStartup(root).read() is None
    remove_unused_translation_runs()
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before
    assert not deps.get_canonical_storage_path().exists()


@pytest.mark.parametrize('old_body', [False, True])
def test_main_defers_pending_location_until_legacy_admission(tmp_path, monkeypatch, old_body):
    """Exercise the real pre-server main branch without starting a server/process."""
    application = importlib.import_module('sidecar.app')
    root = tmp_path / 'legacy'
    root.mkdir()
    if old_body:
        (root / 'library.sqlite3').write_bytes(b'old raw SQLite input')
    target = tmp_path / 'pending-destination'
    target.mkdir()
    target_body = target / 'notes.md'
    target_body.write_bytes(b'old pending destination input')
    device = tmp_path / 'device'
    device.mkdir()
    setting = device / 'storage-location.json'
    setting.write_text(json.dumps({'path': str(root), 'pending': {
        'source': str(root), 'destination': str(target)}}), encoding='utf8')
    before = [(path, path.read_bytes(), path.stat().st_mtime_ns)
              for path in (setting, target_body)]
    monkeypatch.setattr(paths, 'device_directory', lambda: device)
    calls = []
    monkeypatch.setenv('PAPEER_DATA_DIR', str(root))
    monkeypatch.setattr(application, 'startup_error', lambda: None)
    monkeypatch.setattr(deps, 'auth_disabled', lambda: False)
    monkeypatch.setattr(application, 'log_to_file', lambda: None)
    monkeypatch.setattr(application.system, 'start_watching_stdin', lambda: None)
    monkeypatch.setattr(application.system, 'stop_on_terminate', lambda: None)
    monkeypatch.setattr(application.instance, 'launcher', lambda: 'app')
    monkeypatch.setattr(application.instance, 'claim_library', lambda *args: object())
    monkeypatch.setattr(storage_location, 'apply_pending',
                        lambda *args: calls.append(args) or root)

    class BeforeServer(Exception):
        pass

    def stop_before_server(_):
        raise BeforeServer()

    monkeypatch.setattr(application, 'bind_socket', stop_before_server)
    with pytest.raises(BeforeServer):
        application.main()
    assert calls == []
    assert paths.storage_location_settings()['pending']['destination'] == str(target)
    for path, body, modified in before:
        assert (path.read_bytes(), path.stat().st_mtime_ns) == (body, modified)
    if old_body:
        assert (root / 'library.sqlite3').read_bytes() == b'old raw SQLite input'


@pytest.mark.parametrize('selection', ['config', 'env'])
@pytest.mark.parametrize('existing_grant', [False, True])
def test_pending_device_record_blocks_even_an_empty_selected_root(tmp_path, monkeypatch, selection, existing_grant):
    root, target, device = (tmp_path / name for name in ('empty-source', 'old-destination', 'device'))
    root.mkdir(); target.mkdir(); device.mkdir()
    source = target / 'notes.md'
    source.write_bytes(b'old destination body remains raw')
    setting = device / 'storage-location.json'
    setting.write_text(json.dumps({'path': str(root)}), encoding='utf8')
    monkeypatch.setattr(paths, 'device_directory', lambda: device)
    if selection == 'env':
        monkeypatch.setenv('PAPEER_DATA_DIR', str(root))
    else:
        monkeypatch.delenv('PAPEER_DATA_DIR', raising=False)
        monkeypatch.delenv('PAPERDESK_DATA_DIR', raising=False)
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'pending-test-token')
    monkeypatch.setattr(deps, 'get_library', lambda: pytest.fail('legacy Library opened'))
    authority.revoke_all()
    try:
        with TestClient(app) as client:
            client.headers['Authorization'] = 'Bearer pending-test-token'
            assert deps.get_data_dir() == root
            assert client.post('/api/edits/legacy-startup/presence', json={}).json() == 'clear'
            lease = None
            canonical = deps.get_canonical_storage_path()
            if existing_grant:
                lease = client.post('/api/edits/bootstrap/local-context/provision', json={}).json()['leaseId']
            canonical_before = canonical.read_bytes() if canonical.exists() else None
            setting.write_text(json.dumps({'path': str(root), 'pending': {
                'source': str(root), 'destination': str(target)}}), encoding='utf8')
            before = [(path, path.read_bytes(), path.stat().st_mtime_ns) for path in (source, setting)]
            assert NativeLegacyStartup(root).read() is None
            assert client.post('/api/edits/legacy-startup/presence', json={}).json() == 'legacy-present'
            for route in ('read', 'provision'):
                assert client.post('/api/edits/bootstrap/local-context/' + route, json={}).status_code == 403
            if lease:
                headers = {'X-Papeer-Host-Lease': lease}
                # peer enters the actual initialization SQL transaction, not just discovery.
                for route in ('discover', 'peer'):
                    assert client.post('/api/edits/bootstrap/' + route, json={}, headers=headers).status_code == 403
            remove_unused_translation_runs()
            assert (canonical.read_bytes() if canonical.exists() else None) == canonical_before
            assert list(root.iterdir()) == []
            assert sorted(path.name for path in target.iterdir()) == ['notes.md']
            for path, body, modified in before:
                assert (path.read_bytes(), path.stat().st_mtime_ns) == (body, modified)
    finally:
        authority.revoke_all()


@pytest.mark.parametrize('selection', ['config', 'env'])
@pytest.mark.parametrize('ancestor', [False, True])
def test_real_selection_keeps_root_and_ancestor_links_visible_to_admission(tmp_path, monkeypatch, selection, ancestor):
    target, link, device = (tmp_path / name for name in ('target', 'link', 'device'))
    target.mkdir(); device.mkdir()
    if ancestor:
        (target / 'leaf').mkdir()
    try:
        link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError):
        if __import__('os').name != 'nt':
            pytest.skip('directory symlink unavailable on this host')
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    selected = link / 'leaf' if ancestor else link
    resolved = target / 'leaf' if ancestor else target
    monkeypatch.setattr(paths, 'device_directory', lambda: device)
    setting = device / 'storage-location.json'
    if selection == 'env':
        monkeypatch.setenv('PAPEER_DATA_DIR', str(selected))
        # Ordinary callers retain their existing resolved-override contract.
        assert deps.get_data_dir() == resolved
    else:
        monkeypatch.delenv('PAPEER_DATA_DIR', raising=False)
        monkeypatch.delenv('PAPERDESK_DATA_DIR', raising=False)
        setting.write_text(json.dumps({'path': str(selected)}), encoding='utf8')
        assert deps.get_data_dir() == selected
    assert paths.selected_data_directory() == selected
    before = setting.read_bytes() if setting.exists() else None
    monkeypatch.setattr(deps, 'get_auth_token', lambda: 'link-test-token')
    monkeypatch.setattr(deps, 'get_library', lambda: pytest.fail('legacy Library opened'))
    authority.revoke_all()
    try:
        with TestClient(app) as client:
            client.headers['Authorization'] = 'Bearer link-test-token'
            assert client.post('/api/edits/legacy-startup/presence', json={}).status_code == 422
            assert client.post('/api/edits/bootstrap/local-context/provision', json={}).status_code == 403
            assert not deps.get_canonical_storage_path().exists()
            assert list(resolved.iterdir()) == []
            assert (setting.read_bytes() if setting.exists() else None) == before
    finally:
        authority.revoke_all()


def test_mismatched_injected_root_cannot_establish_clear(context, monkeypatch, tmp_path):
    root, client = context
    monkeypatch.setattr(deps, 'get_data_dir', lambda: tmp_path / 'different-root')
    assert client.post('/api/edits/legacy-startup/presence', json={}).status_code == 422
    assert client.post('/api/edits/bootstrap/local-context/provision', json={}).status_code == 403
    assert not root.exists() and not deps.get_canonical_storage_path().exists()
