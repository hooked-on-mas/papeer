from copy import deepcopy
from pathlib import Path
import threading

import pytest

from papeer.core import drive_sync as sync
from papeer.core.storage import Library


class MemoryDrive:
    def __init__(self):
        self.items = []
        self.data = {}
        self.fail = False

    def revisions(self):
        return deepcopy(self.items)

    def upload(self, path, metadata, cancel, progress):
        if self.fail:
            raise OSError("offline")
        identity = str(len(self.items) + 1)
        self.items.append({**metadata, "id": identity, "created": "2026-09-27T00:00:00Z"})
        self.data[identity] = path.read_bytes()
        return identity

    def download(self, identity, path, cancel, progress):
        path.write_bytes(self.data[identity])


@pytest.fixture
def pair(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "device-state"))
    a, b = Library(tmp_path / "a"), Library(tmp_path / "b")
    for lib in (a, b):
        sync.save_state(lib.root, {"connected": True})
    identity, _ = a.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    return a, b, identity, MemoryDrive()


def run(lib, remote, **kwargs):
    return sync.sync(lib, remote, threading.Event(), lambda _: None, **kwargs)


def connect_pair(a, b, remote):
    run(a, remote)
    assert run(b, remote)["status"] == "conflict"
    run(b, remote, choice="1", expected_heads=["1"])
    run(a, remote)


def test_all_data_roundtrip_and_noop(pair):
    a, b, identity, remote = pair
    a.save_ink(identity, "original", 1, [{"id": "stroke", "points": [[1, 2]]}])
    a.update(identity, note="読書メモ", tags=["研究"])
    a.add_exchange(identity, "question", "answer")
    a.save_note_template("custom", "template")
    folder = a.folder(identity)
    for name, content in {"article.md": "サマリー", "translation.md": "訳文", "article-usage.json": "{}"}.items():
        (folder / name).write_text(content, "utf-8")
    (a.root / "prompts").mkdir()
    (a.root / "prompts" / "custom.txt").write_text("prompt")
    (a.root / "ui-state.json").write_text('{"last_paper":"' + identity + '"}')
    connect_pair(a, b, remote)
    assert sync.fingerprint(a) == sync.fingerprint(b)
    assert b.ink(identity, "original", 1)[0]["id"] == "stroke"
    assert b.paper(identity)["note"] == "読書メモ"
    assert (b.folder(identity) / "article.md").read_text("utf-8") == "サマリー"
    assert (b.root / "ui-state.json").read_bytes() == (a.root / "ui-state.json").read_bytes()
    assert sync.state_path(a.root).is_relative_to(a.root) is False
    count = len(remote.items)
    run(a, remote)
    run(b, remote)
    assert len(remote.items) == count


def test_edit_and_delete_propagate_without_losing_previous_copy(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="new note")
    run(a, remote)
    result = run(b, remote)
    assert result["reloaded"]
    assert b.paper(identity)["note"] == "new note"
    assert Library(Path(result["previous_path"])).paper(identity)["note"] == ""
    a.delete_paper(identity)
    run(a, remote)
    run(b, remote)
    assert not b.papers()


def test_conflicting_edits_require_choice_and_preserve_both(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    b.update(identity, note="B")
    run(a, remote)
    heads = [item["id"] for item in sync.revision_heads(remote.items)]
    assert run(b, remote)["status"] == "conflict"
    assert b.paper(identity)["note"] == "B"
    with pytest.raises(ValueError, match="別のPC"):
        run(b, remote, choice="local", expected_heads=["stale"])
    result = run(b, remote, choice=heads[0], expected_heads=heads)
    assert b.paper(identity)["note"] == "A"
    assert Library(Path(result["previous_path"])).paper(identity)["note"] == "B"
    assert len(sync.revision_heads(remote.items)) == 1


def test_failed_upload_and_corrupt_download_leave_local_unchanged(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    before = sync.read_state(a.root)
    remote.fail = True
    with pytest.raises(OSError):
        run(a, remote)
    assert sync.read_state(a.root) == before
    remote.fail = False
    run(a, remote)
    head = sync.revision_heads(remote.items)[0]
    remote.data[head["id"]] = b"corrupt"
    with pytest.raises(ValueError, match="検証"):
        run(b, remote)
    assert b.paper(identity)["note"] == ""


def test_failed_resolution_upload_does_not_replace_local(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    b.update(identity, note="B")
    run(a, remote)
    head = sync.revision_heads(remote.items)[0]["id"]
    remote.fail = True
    with pytest.raises(OSError):
        run(b, remote, choice=head, expected_heads=[head])
    assert b.paper(identity)["note"] == "B"


def test_concurrent_publications_remain_branches(pair):
    a, b, identity, remote = pair
    connect_pair(a, b, remote)
    a.update(identity, note="A")
    b.update(identity, note="B")
    observed = remote.revisions()
    run(a, remote)
    original = remote.revisions
    remote.revisions = lambda: observed
    run(b, remote)
    remote.revisions = original
    assert len(sync.revision_heads(remote.items)) == 2
    assert run(a, remote)["status"] == "conflict"
    assert run(b, remote)["status"] == "conflict"


def test_snapshot_waits_for_existing_requests(monkeypatch):
    from sidecar import deps
    monkeypatch.setattr(deps, "snapshot_running", lambda: False)
    assert deps.begin_library_request()
    entered = threading.Event()
    def worker():
        deps.wait_for_library_requests()
        entered.set()
    thread = threading.Thread(target=worker)
    thread.start()
    assert not entered.wait(0.05)
    deps.end_library_request()
    thread.join(2)
    assert entered.is_set()


def test_drive_api_sync_status_and_error_redaction(pair, monkeypatch):
    import time
    from fastapi.testclient import TestClient
    from sidecar.app import app
    from sidecar import deps
    from sidecar.jobs import JobManager

    a, _, _, remote = pair
    monkeypatch.setattr(deps, "get_data_dir", lambda: a.root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    sync.save_state(a.root, {"connected": True, "folder": str(a.root.parent / "shared")})
    monkeypatch.setattr(sync, "FolderDrive", lambda _: remote)
    with TestClient(app) as client:
        response = client.post("/api/drive/sync", json={})
        assert response.status_code == 200
        identity = response.json()["job_id"]
        deadline = time.monotonic() + 5
        while deps.job_manager.get_job(identity).running and time.monotonic() < deadline:
            time.sleep(0.01)
        job = deps.job_manager.get_job(identity)
        assert job.status == "succeeded", job.error
        state = client.get("/api/drive").json()
        assert state["last_sync"]
        assert "base" not in state and "hash" not in state

        def failure(_):
            raise RuntimeError("secret-token-in-oauth-url")
        monkeypatch.setattr(sync, "FolderDrive", failure)
        identity = client.post("/api/drive/sync", json={}).json()["job_id"]
        deadline = time.monotonic() + 5
        while deps.job_manager.get_job(identity).running and time.monotonic() < deadline:
            time.sleep(0.01)
        job = deps.job_manager.get_job(identity)
        assert job.status == "failed"
        assert "secret-token" not in job.error
        assert "secret-token" not in client.get("/api/drive").text

