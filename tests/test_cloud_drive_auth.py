"""Desktop PKCE/loopback flow, token refresh and the credential-free public API."""
import base64
import hashlib
import json
import socket
import sys
import threading
import time
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode
from urllib.request import ProxyHandler, build_opener

from fastapi.testclient import TestClient
import pytest

from papeer.core import cloud_drive_auth as auth
from papeer.core.cloud_drive_config import DesktopOAuth

CLIENT = "123-desktop.apps.googleusercontent.com"


@pytest.fixture(autouse=True)
def configuration(monkeypatch, tmp_path):
    monkeypatch.setattr(auth, "desktop_oauth", lambda: DesktopOAuth(CLIENT))
    monkeypatch.setattr(auth, "setup_status", lambda: {"configured": True, "setup_error": None})
    monkeypatch.setattr(auth, "_pending", False)
    monkeypatch.setattr(auth, "_error", None)
    monkeypatch.setattr(auth, "_path", lambda: tmp_path / "credentials.dpapi")


@pytest.mark.skipif(sys.platform != "win32", reason="Windows desktop OAuth")
@pytest.mark.parametrize("fail", [False, True])
def test_new_connection_uses_pkce_without_client_secret_and_rejects_forged_state(monkeypatch, fail):
    seen, saved, opened = [], [], []
    finished = threading.Event()
    def token(values):
        seen.append(values)
        if fail:
            raise ValueError("a-secret-value-from-an-error-response")
        return {"access_token": "user-access", "refresh_token": "user-refresh", "expires_at": 9999999999}
    monkeypatch.setattr(auth, "_token", token)
    monkeypatch.setattr(auth, "_save", saved.append)
    def browser(url):
        params = parse_qs(url.split("?", 1)[1]); opened.append(params)
        client = build_opener(ProxyHandler({}))
        try:
            client.open(params["redirect_uri"][0] + "?" + urlencode({"state": "forged", "code": "bad"}), timeout=3)
        except HTTPError as exc:
            assert exc.code == 400
        assert seen == []
        with client.open(params["redirect_uri"][0] + "?" + urlencode({"state": params["state"][0], "code": "valid-test-code"}), timeout=3):
            pass
        return True
    monkeypatch.setattr(auth.webbrowser, "open", browser)
    auth.connect()
    deadline = time.monotonic() + 3
    while auth.status()["connecting"] and time.monotonic() < deadline:
        finished.wait(.01)
    assert not auth.status()["connecting"]
    assert len(seen) == 1 and "client_secret" not in seen[0]
    verifier = seen[0]["code_verifier"]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    assert opened[0]["code_challenge"] == [challenge]
    assert opened[0]["code_challenge_method"] == ["S256"]
    assert seen[0]["client_id"] == CLIENT
    assert seen[0]["redirect_uri"].startswith("http://127.0.0.1:")
    if fail:
        assert saved == [] and auth.status()["auth_error"]
        assert "a-secret-value" not in json.dumps(auth.status())
    else:
        assert saved[0]["client_id"] == CLIENT and "client_secret" not in saved[0]


def _wait_until_idle(timeout=3):
    deadline = time.monotonic() + timeout
    while auth.status()["connecting"] and time.monotonic() < deadline:
        threading.Event().wait(.01)
    assert not auth.status()["connecting"]


def _cancel_if_pending(params):
    if auth.status()["connecting"]:
        client = build_opener(ProxyHandler({}))
        with client.open(params["redirect_uri"][0] + "?" + urlencode({
            "state": params["state"][0], "error": "access_denied"}), timeout=3):
            pass
        _wait_until_idle()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows desktop OAuth")
def test_incomplete_callback_cannot_hold_connection_past_auth_deadline(monkeypatch):
    monkeypatch.setattr(auth, "_AUTH_TIMEOUT", .4)
    monkeypatch.setattr(auth, "_CALLBACK_TIMEOUT", 5)
    opened, seen, saved = [], [], []
    monkeypatch.setattr(auth.webbrowser, "open", lambda url: opened.append(parse_qs(url.split("?", 1)[1])))
    monkeypatch.setattr(auth, "_save", saved.append)
    def token(values):
        seen.append(values)
        return {"access_token": "user-access", "refresh_token": "user-refresh", "expires_at": 9999999999}
    monkeypatch.setattr(auth, "_token", token)
    auth.connect()
    params = opened[0]
    port = int(params["redirect_uri"][0].split(":")[2].rstrip("/"))
    connection = socket.create_connection(("127.0.0.1", port), timeout=2)
    try:
        query = urlencode({"state": params["state"][0], "code": "expired-test-code"})
        connection.sendall(f"GET /?{query} HTTP/1.1\r\nHost: localhost\r\n".encode())
        _wait_until_idle()
        assert auth.status()["auth_error"]
        assert seen == [] and saved == []
        auth.disconnect()  # Expiration releases the pending gate, including for reconnect.
        auth.connect()
        assert len(opened) == 2
    finally:
        connection.close()
        _cancel_if_pending(opened[-1])


@pytest.mark.skipif(sys.platform != "win32", reason="Windows desktop OAuth")
def test_slow_partial_headers_expire_and_next_valid_callback_still_works(monkeypatch):
    monkeypatch.setattr(auth, "_AUTH_TIMEOUT", 5)
    monkeypatch.setattr(auth, "_CALLBACK_TIMEOUT", .2)
    opened, seen, saved = [], [], []
    monkeypatch.setattr(auth.webbrowser, "open", lambda url: opened.append(parse_qs(url.split("?", 1)[1])))
    def token(values):
        seen.append(values)
        return {"access_token": "user-access", "refresh_token": "user-refresh", "expires_at": 9999999999}
    monkeypatch.setattr(auth, "_token", token)
    monkeypatch.setattr(auth, "_save", saved.append)
    auth.connect()
    params = opened[0]
    port = int(params["redirect_uri"][0].split(":")[2].rstrip("/"))
    connection = socket.create_connection(("127.0.0.1", port), timeout=2)
    stop = threading.Event()
    connection.sendall(b"GET / HTTP/1.1\r\nX-Padding: ")
    def trickle():
        while not stop.wait(.02):
            try:
                connection.sendall(b"x")
            except OSError:
                return
    sender = threading.Thread(target=trickle, daemon=True)
    sender.start()
    try:
        # Each byte arrives faster than the socket timeout; the absolute request limit must close it.
        connection.settimeout(2)
        try:
            assert connection.recv(1) == b""
        except ConnectionResetError:
            pass  # Windows may signal a reset rather than EOF after shutdown.
        assert auth.status()["connecting"] and seen == []
        client = build_opener(ProxyHandler({}))
        with client.open(params["redirect_uri"][0] + "?" + urlencode({
            "state": params["state"][0], "code": "valid-after-incomplete-request"}), timeout=2):
            pass
        _wait_until_idle()
        assert seen[0]["code"] == "valid-after-incomplete-request"
        assert len(saved) == 1 and auth.status()["auth_error"] is None
    finally:
        stop.set()
        connection.close()
        sender.join(timeout=2)
        _cancel_if_pending(params)


@pytest.mark.parametrize("secret", [None, "legacy-desktop-secret"])
def test_refresh_preserves_existing_connection_identity_and_optional_legacy_secret(monkeypatch, secret):
    record = {"client_id": "old-client", "refresh_token": "refresh", "access_token": "old", "expires_at": 0}
    if secret:
        record["client_secret"] = secret
    seen, saved = [], []
    monkeypatch.setattr(auth, "_load", lambda: record.copy())
    monkeypatch.setattr(auth, "_save", saved.append)
    def token(values):
        seen.append(values)
        return {"access_token": "renewed", "expires_at": 9999999999}
    monkeypatch.setattr(auth, "_token", token)
    assert auth.access_token() == "renewed"
    assert seen[0]["client_id"] == "old-client"
    assert seen[0].get("client_secret") == secret
    assert saved[0]["refresh_token"] == "refresh"


def test_connection_api_has_no_credential_body_and_ignores_client_selection(monkeypatch, tmp_path):
    from sidecar.app import app
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "library"))
    monkeypatch.setenv("PAPEER_TOKEN", "expected")
    monkeypatch.delenv("PAPEER_DEV_NO_AUTH", raising=False)
    calls = []
    def connect():
        calls.append(True)
        return {"connecting": True}
    monkeypatch.setattr(auth, "connect", connect)
    with TestClient(app) as client:
        assert client.post("/api/cloud-drive/connect").status_code == 401
        assert client.post("/api/cloud-drive/connect", headers={"Authorization": "Bearer expected"}).status_code == 200
        assert client.post("/api/cloud-drive/connect", headers={"Authorization": "Bearer expected"},
                           json={"client_id": "attacker", "client_secret": "ignored"}).status_code == 200
    assert len(calls) == 2
    assert "requestBody" not in app.openapi()["paths"]["/api/cloud-drive/connect"]["post"]
