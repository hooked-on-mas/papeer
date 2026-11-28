"""Attempt-specific cancellation against the actual auth worker; no real OAuth/DPAPI.

Browser launch, Google token HTTP and DPAPI conversion are isolated fake boundaries;
actual local callback, auth generation, atomic credential save and worker execute.
"""
import threading
from urllib.parse import parse_qs, urlencode
from urllib.request import ProxyHandler, build_opener
import pytest

from papeer.core import cloud_drive_auth as auth
from papeer.core.cloud_drive_config import DesktopOAuth
from papeer.core.providers.drive.verifier import create_google_drive_provider_host


@pytest.fixture
def authorization(monkeypatch, tmp_path):
    monkeypatch.setattr(auth, 'desktop_oauth', lambda: DesktopOAuth('synthetic.apps.googleusercontent.com'))
    monkeypatch.setattr(auth, 'setup_status', lambda: {'configured': True, 'setup_error': None})
    monkeypatch.setattr(auth, '_attempt', None)
    monkeypatch.setattr(auth, '_error', None)
    monkeypatch.setattr(auth, '_error_code', None)
    path = tmp_path / 'isolated-synthetic-credentials.dpapi'
    monkeypatch.setattr(auth, '_path', lambda: path)
    monkeypatch.setattr(auth, '_protect', lambda data, **_kwargs: data)  # No actual Windows credential operation.
    opened, workers = [], []
    monkeypatch.setattr(auth.webbrowser, 'open', lambda url: opened.append(parse_qs(url.split('?', 1)[1])) or True)
    def token(values):
        return {'access_token': 'synthetic-' + values['code'], 'refresh_token': 'synthetic-refresh', 'expires_at': 9999999999}
    monkeypatch.setattr(auth, '_token', token)
    def start():
        result, handle = auth.connect_with_attempt()
        assert 'handle' not in result and 'url' not in result and 'state' not in result
        current = auth._attempt
        assert current is not None and current.handle is handle and current.worker is not None
        workers.append(current.worker)
        return handle, current, opened[-1]
    def callback(params, code):
        with build_opener(ProxyHandler({})).open(params['redirect_uri'][0] + '?' + urlencode({'state': params['state'][0], 'code': code}), timeout=3): pass
    try: yield path, opened, workers, start, callback
    finally:
        auth.cancel()
        for worker in workers: worker.join(timeout=4)


def test_cancel_a_then_b_late_a_reply_and_stale_cancel_cannot_save_or_stop_b(authorization, monkeypatch):
    path, _opened, workers, start, callback = authorization
    entered, release = threading.Event(), threading.Event()
    original = auth._token
    def token(values):
        if values['code'] == 'A':
            entered.set(); assert release.wait(4)
        return original(values)
    monkeypatch.setattr(auth, '_token', token)
    a, current_a, params_a = start(); generation_a = auth.generation()
    # Refusing a concurrent login must not invalidate the first valid attempt.
    with pytest.raises(ValueError): auth.connect_with_attempt()
    assert auth.generation() == generation_a and auth._attempt is current_a
    callback(params_a, 'A'); assert entered.wait(3)
    try:
        assert auth.cancel_attempt(a) is True
        b, current_b, params_b = start(); generation_b = auth.generation()
        assert auth.cancel_attempt(a) is False
        assert auth.generation() == generation_b and auth._attempt is current_b and not current_b.cancelled.is_set()
        release.set(); current_a.worker.join(timeout=3); assert not current_a.worker.is_alive()
        assert not path.exists() and not auth.authorization_completed(a) and not auth.authorization_completed(b)
        callback(params_b, 'B'); current_b.worker.join(timeout=3); assert not current_b.worker.is_alive()
        assert auth.authorization_completed(b) and not auth.authorization_completed(a)
        assert auth._load()['access_token'] == 'synthetic-B'
        before = path.read_bytes(); assert auth.cancel_attempt(a) is False
        assert path.read_bytes() == before and auth.generation() == generation_b
    finally: release.set()
    assert all(not worker.is_alive() for worker in workers)


def test_normal_attempt_cancel_terminates_waiting_worker_and_reconnects(authorization):
    path, _opened, _workers, start, callback = authorization
    a, current_a, _params_a = start()
    assert auth.cancel_attempt(a) is True
    current_a.worker.join(timeout=3); assert not current_a.worker.is_alive()
    assert not auth.status()['connecting'] and not path.exists() and not auth.authorization_completed(a)
    b, current_b, params_b = start(); callback(params_b, 'B')
    current_b.worker.join(timeout=3); assert not current_b.worker.is_alive() and auth.authorization_completed(b)
    assert auth.cancel_attempt(a) is False and auth._load()['access_token'] == 'synthetic-B'


def test_fixed_host_old_cancel_and_finish_do_not_capture_new_legacy_login(authorization):
    _path, opened, workers, start, callback = authorization
    host = create_google_drive_provider_host()
    try:
        host.connect(); current_a = auth._attempt; workers.append(current_a.worker)
        assert host.cancel_connect() is True
        current_a.worker.join(timeout=3); assert not current_a.worker.is_alive()
        b, current_b, params_b = start()
        assert host.cancel_connect() is False and auth._attempt is current_b and not current_b.cancelled.is_set()
        callback(params_b, 'B'); current_b.worker.join(timeout=3)
        with pytest.raises(ValueError, match='incomplete'): host.finish_connect()
        assert auth.authorization_completed(b) and len(opened) == 2
    finally: host.close()


def test_cancel_during_host_connect_setup_cancels_only_captured_attempt(authorization, monkeypatch):
    _path, _opened, workers, _start, _callback = authorization
    entered, release = threading.Event(), threading.Event()
    def browser(_url):
        entered.set(); assert release.wait(4); return True
    monkeypatch.setattr(auth.webbrowser, 'open', browser)
    host = create_google_drive_provider_host(); result = []
    thread = threading.Thread(target=lambda: result.append(host.connect()), name='synthetic-host-connect')
    thread.start(); assert entered.wait(3); current = auth._attempt; workers.append(current.worker)
    try:
        assert host.cancel_connect() is True  # Handle was delivered before entering the blocked browser call.
        release.set(); thread.join(timeout=3); current.worker.join(timeout=3)
        assert not thread.is_alive() and not current.worker.is_alive() and current.cancelled.is_set()
        assert result and not auth.status()['connecting'] and not auth.authorization_completed(current.handle)
        with pytest.raises(ValueError, match='incomplete'): host.finish_connect()
    finally: release.set(); host.close()


def test_cancel_while_browser_launch_blocked_fences_late_token_save(authorization, monkeypatch):
    path, _opened, workers, _start, callback = authorization
    launch_entered, release_launch = threading.Event(), threading.Event()
    token_entered, release_token = threading.Event(), threading.Event()
    original = auth._token
    def token(values):
        token_entered.set(); assert release_token.wait(4); return original(values)
    def browser(url):
        params = parse_qs(url.split('?', 1)[1]); callback(params, 'A')
        launch_entered.set(); assert release_launch.wait(4); return True
    monkeypatch.setattr(auth, '_token', token); monkeypatch.setattr(auth.webbrowser, 'open', browser)
    host = create_google_drive_provider_host(); result = []
    thread = threading.Thread(target=lambda: result.append(host.connect()), name='synthetic-blocked-launch')
    thread.start(); assert launch_entered.wait(3) and token_entered.wait(3)
    current = auth._attempt; workers.append(current.worker)
    try:
        assert host.cancel_connect() is True
        release_token.set(); current.worker.join(timeout=3)
        assert not current.worker.is_alive() and not path.exists() and not auth.authorization_completed(current.handle)
        release_launch.set(); thread.join(timeout=3); assert not thread.is_alive() and result
        with pytest.raises(ValueError, match='incomplete'): host.finish_connect()
    finally: release_token.set(); release_launch.set(); host.close()


def test_precancel_before_auth_creation_does_not_start_worker_or_open_browser(authorization, monkeypatch):
    path, opened, _workers, _start, _callback = authorization
    entered, release = threading.Event(), threading.Event()
    def config():
        entered.set(); assert release.wait(4); return DesktopOAuth('synthetic.apps.googleusercontent.com')
    monkeypatch.setattr(auth, 'desktop_oauth', config)
    host = create_google_drive_provider_host(); result = []
    thread = threading.Thread(target=lambda: result.append(host.connect()), name='synthetic-precreation-cancel')
    thread.start(); assert entered.wait(3)
    try:
        assert host.cancel_connect() is False  # Request retained before any real attempt exists.
        release.set(); thread.join(timeout=3)
        assert not thread.is_alive() and result and auth._attempt is None and opened == [] and not path.exists()
        with pytest.raises(ValueError, match='incomplete'): host.finish_connect()
    finally: release.set(); host.close()


def test_same_host_b_connect_completes_before_cancelled_a_launch_returns(authorization, monkeypatch):
    import io
    import json
    from papeer.core.providers.drive import transport
    from papeer.core.providers.drive.principal import google_drive_principal_digest
    path, _opened, workers, _start, callback = authorization
    entered, release_launch, token_entered, release_token = (threading.Event() for _ in range(4))
    original = auth._token
    def token(values):
        if values['code'] == 'A': token_entered.set(); assert release_token.wait(4)
        return original(values)
    launches = []
    def browser(url):
        params = parse_qs(url.split('?', 1)[1]); launches.append(params); workers.append(auth._attempt.worker)
        callback(params, 'A' if len(launches) == 1 else 'B')
        if len(launches) == 1: entered.set(); assert release_launch.wait(4)
        return True
    monkeypatch.setattr(auth, '_token', token); monkeypatch.setattr(auth.webbrowser, 'open', browser)
    def about(request, timeout):
        assert '/about?' in request.full_url and request.get_header('Authorization') == 'Bearer synthetic-B'
        return io.BytesIO(json.dumps({'user': {'permissionId': 'fixture-permission-B'}}).encode())
    monkeypatch.setattr(transport, '_open', about)
    host = create_google_drive_provider_host(); a_result = []
    a = threading.Thread(target=lambda: a_result.append(host.connect()), name='synthetic-old-launch')
    a.start(); assert entered.wait(3) and token_entered.wait(3)
    try:
        assert host.cancel_connect() is True
        # New B is allowed while A's browser invocation still has not returned.
        host.connect(); workers[1].join(timeout=3); assert not workers[1].is_alive()
        principal = host.finish_connect(); assert principal['digest'] == google_drive_principal_digest('fixture-permission-B')
        before = path.read_bytes(); generation_b = auth.generation()
        release_token.set(); workers[0].join(timeout=3); release_launch.set(); a.join(timeout=3)
        assert not a.is_alive() and not workers[0].is_alive() and a_result
        assert path.read_bytes() == before and auth.generation() == generation_b
        assert host.current() == principal
    finally: release_token.set(); release_launch.set(); host.close()
