"""Account/generation boundaries use fake HTTP and disposable credentials only."""
import io
import json
import threading
import time
from urllib.error import HTTPError

import pytest

from papeer.core import cloud_drive as cloud, cloud_drive_auth as auth
from papeer.core.edit_drive import DriveEditStorage


def _credentials(tmp_path, token):
    """Saved credentials the way capture_provider_access_token reads them (fresh, so no refresh request)."""
    (tmp_path / "credentials").write_bytes(json.dumps({
        "access_token": token, "refresh_token": "fixture-refresh", "client_id": "fixture-client",
        "expires_at": time.time() + 3600}).encode())


@pytest.fixture
def remote(monkeypatch, tmp_path):
    # Drive takes its token from capture_provider_access_token(generation), which reads the saved credentials
    # under the generation guard (a disconnect deletes them). Only the Windows DPAPI wrapper is replaced.
    monkeypatch.setattr(auth, "_path", lambda: tmp_path / "credentials")
    monkeypatch.setattr(auth, "_protect", lambda data, *, decrypt=False: data)
    monkeypatch.setattr(auth, "_credential_cache", None)
    monkeypatch.setattr(auth, "_attempt", None)
    monkeypatch.setattr(auth, "_generation", "fixture-generation")
    _credentials(tmp_path, "fixture-A")
    calls = []

    def request(request, timeout):
        calls.append(request)
        return io.BytesIO(json.dumps({"user": {"permissionId": "A"}}).encode())

    monkeypatch.setattr(cloud, "urlopen", request)
    return calls


def test_account_mismatch_and_forged_or_stale_lease_never_send_payload(remote):
    scope = {"accountId": "B", "libraryId": "library", "epoch": "epoch"}
    with pytest.raises(ValueError, match="account-mismatch"):
        DriveEditStorage(scope, "shared-folder")
    assert len(remote) == 1 and remote[0].data is None
    bound = cloud.Drive().bind_account("A")
    with pytest.raises(ValueError, match="auth-lease"):
        cloud.Drive(account_id="B", lease_id=bound.lease_id)
    auth.disconnect()
    with pytest.raises(ValueError, match="auth-changed"):
        cloud.Drive(account_id="A", lease_id=bound.lease_id)
    with pytest.raises(ValueError, match="auth-changed"):
        bound.json(cloud.API, method="POST", value={"private": "A"})
    assert len(remote) == 2


def test_change_between_resumable_chunks_does_not_use_new_token(remote, monkeypatch, tmp_path):
    drive = cloud.Drive().bind_account("A")
    path = tmp_path / "payload"
    path.write_bytes(b"x" * (8 * 1024 * 1024 + 1))

    class Response(io.BytesIO):
        headers = {"Location": "https://www.googleapis.com/upload/drive/v3/files?upload_id=fixture"}

    monkeypatch.setattr(drive, "request", lambda *a, **kw: Response())
    sent = []

    def chunk(request, timeout):
        sent.append(request.get_header("Authorization"))
        auth.disconnect()
        _credentials(tmp_path, "fixture-B")  # Another account connects between chunks.
        raise HTTPError(request.full_url, 308, "continue", {"Range": f"bytes=0-{len(request.data)-1}"}, None)

    monkeypatch.setattr(cloud, "urlopen", chunk)
    with pytest.raises(ValueError, match="auth-changed"):
        drive.upload(path, {}, threading.Event())
    assert sent == ["Bearer fixture-A"]


def test_response_after_auth_invalidation_is_not_accepted(remote, monkeypatch):
    drive = cloud.Drive().bind_account("A")

    def response(request, timeout):
        auth.disconnect()
        return io.BytesIO(b'{"private":"old"}')

    monkeypatch.setattr(cloud, "urlopen", response)
    with pytest.raises(ValueError, match="auth-changed"):
        drive.json(cloud.API)


def test_disconnect_drains_request_body_before_changing_credentials(remote, monkeypatch):
    drive = cloud.Drive().bind_account("A")
    started, release, changed = threading.Event(), threading.Event(), threading.Event()

    class Response(io.BytesIO):
        def read(self, *args):
            started.set()
            assert release.wait(3)
            assert not changed.is_set()
            return super().read(*args)

    monkeypatch.setattr(cloud, "urlopen", lambda *a, **kw: Response(b'{}'))
    failures = []
    def read():
        try:
            drive.json(cloud.API)
        except ValueError as exc:
            failures.append(str(exc))
    reader = threading.Thread(target=read)
    switch = threading.Thread(target=lambda: (auth.disconnect(), changed.set()))
    reader.start()
    assert started.wait(3)
    switch.start()
    assert not changed.wait(.05)
    release.set()
    reader.join(3)
    switch.join(3)
    assert changed.is_set() and not reader.is_alive() and not switch.is_alive()
    assert failures == ["drive-auth-changed"]
