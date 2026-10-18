"""Private Drive publication: complete snapshots, incremental transfer, interruption and credentials."""
from __future__ import annotations

import hashlib
import io
import json
import sqlite3
import sys
import threading
from urllib.error import HTTPError

from fastapi.testclient import TestClient
import pymupdf
import pytest

from papeer.core import cloud_drive as cloud, cloud_drive_auth as auth, notebook
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from papeer.providers import Cancelled


class MemoryDrive:
    def __init__(self):
        self.files = {}
        self.calls = []
        self.fail = None

    def json(self, url, *, method="GET", value=None):
        if method == "POST":
            return {"id": "folder"}
        identity = url.split("/")[-1].split("?")[0]
        if identity not in self.files:
            raise ValueError("missing")
        if "alt=media" in url:
            return json.loads(self.files[identity][1])
        return {"id": identity}

    def list(self, query):
        return [{"id": identity, "name": metadata["name"], "size": len(data),
                 "sha256Checksum": hashlib.sha256(data).hexdigest()}
                for identity, (metadata, data) in self.files.items()
                if (metadata.get("properties", {}).get("papeer") == "ink-v1") == ("ink-v1" in query)]

    def upload(self, path, metadata, cancel, file_id=None):
        name = metadata["name"]
        if self.fail == name or self.fail == "all":
            raise ValueError("simulated transfer failure")
        identity = file_id or str(len(self.files) + 1)
        data = path.read_bytes()
        if name == "papeer-library.json":
            manifest = json.loads(data)
            # Publishing must never expose references to data that has not arrived yet.
            for file in manifest["files"].values():
                assert file["id"] in self.files
                assert hashlib.sha256(self.files[file["id"]][1]).hexdigest() == file["sha256"]
        self.files[identity] = (metadata, data)
        self.calls.append(name)
        return identity

    def manifest(self):
        return next(json.loads(data) for metadata, data in self.files.values() if metadata["name"] == "papeer-library.json")


@pytest.fixture
def library(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    source = tmp_path / "source.pdf"
    with pymupdf.open() as doc:
        doc.new_page().insert_text((40, 40), "A paper")
        doc.save(source)
    identity, _ = lib.import_pdf(source)
    PaperFiles(lib.folder(identity)).translated_pdf.write_bytes(source.read_bytes())
    lib.add_attachment(identity, "md", "考察", "# 日本語のメモ")
    lib.add_attachment(identity, "html", "資料", "<h1>関連資料</h1>")
    lib.add_bookmark(identity, 1, "original", "A paper", "重要", "付箋の本文")
    lib.add_exchange(identity, "質問", "回答")
    book_id = notebook.create(lib, "手書きノート", {}, parent_id=identity)
    lib.save_ink(book_id, "original", 1, [{"id": "ink", "points": [[.1, .2], [.8, .6]],
                                          "color": "#ff0000", "width": .01}])
    remote = MemoryDrive()
    monkeypatch.setattr(cloud, "Drive", lambda: remote)
    monkeypatch.setattr(auth, "status", lambda: {"connected": True, "connecting": False, "supported": True, "auth_error": None})
    return lib, identity, book_id, remote


def publish(lib, **kwargs):
    return cloud.publish(lib, threading.Event(), lambda _: None, **kwargs)


def test_all_library_data_and_visible_ink_are_uploaded(library, tmp_path):
    lib, identity, book_id, remote = library
    result = publish(lib)
    manifest = remote.manifest()
    assert result["files"] == len(manifest["files"])
    assert {item["id"] for item in manifest["items"]} == {identity, book_id}
    assert manifest["attachments"]
    for name in (f"papers/{identity}/original.pdf", f"papers/{identity}/translated.pdf",
                 f"papers/{book_id}/notebook.json", f"web/{book_id}/original-annotated.pdf", "library.sqlite3"):
        assert name in manifest["files"]
    assert not any(name.endswith(("-wal", "-shm", ".dpapi")) for name in manifest["files"])
    db = tmp_path / "copy.sqlite3"
    db.write_bytes(remote.files[manifest["files"]["library.sqlite3"]["id"]][1])
    with sqlite3.connect(db) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("SELECT count(*) FROM messages").fetchone()[0] == 2
        assert connection.execute("SELECT note FROM bookmarks").fetchone()[0] == "付箋の本文"
    annotated = remote.files[manifest["files"][f"web/{book_id}/original-annotated.pdf"]["id"]][1]
    with pymupdf.open(stream=annotated, filetype="pdf") as doc:
        assert len(doc[0].get_drawings()) > 0
    assert remote.calls[-1] == "papeer-library.json"


def test_unchanged_upload_is_skipped_and_changed_memo_reuses_pdf(library):
    lib, identity, _, remote = library
    publish(lib)
    original_id = remote.manifest()["files"][f"papers/{identity}/original.pdf"]["id"]
    count = len(remote.calls)
    assert publish(lib)["uploaded"] == 0
    assert len(remote.calls) == count
    attachment = lib.attachments(identity)[0]
    lib.update_attachment(identity, attachment["id"], content="変更したメモ")
    assert publish(lib)["uploaded"] > 0
    assert remote.manifest()["files"][f"papers/{identity}/original.pdf"]["id"] == original_id


@pytest.mark.parametrize("failure", ["all", "papeer-library.json"])
def test_failed_publish_preserves_previous_view_and_can_retry(library, failure):
    lib, identity, _, remote = library
    publish(lib)
    before = remote.manifest()
    lib.add_attachment(identity, "md", "追加", "new")
    remote.fail = failure
    with pytest.raises(ValueError, match="simulated"):
        publish(lib)
    assert remote.manifest() == before
    assert cloud.status(lib.root)["error"]
    remote.fail = None
    publish(lib)
    assert remote.manifest()["revision"] != before["revision"]
    assert cloud.status(lib.root)["error"] is None


def test_manual_publish_repairs_same_size_corruption(library):
    lib, identity, _, remote = library
    publish(lib)
    name = f"papers/{identity}/original.pdf"
    original = remote.manifest()["files"][name]
    metadata, data = remote.files[original["id"]]
    remote.files[original["id"]] = (metadata, b"x" * len(data))
    publish(lib, force=True)
    repaired = remote.manifest()["files"][name]
    assert repaired["id"] != original["id"]
    assert remote.files[repaired["id"]][1] == data


def test_manual_verification_reuses_unchanged_handwriting(library):
    lib, _, book_id, remote = library
    publish(lib)
    path = f"web/{book_id}/original-annotated.pdf"
    previous = remote.manifest()["files"][path]["id"]
    assert publish(lib, force=True)["uploaded"] == 0
    assert remote.manifest()["files"][path]["id"] == previous


def test_cancellation_never_commits_a_partial_manifest(library):
    lib, _, _, remote = library
    cancel = threading.Event()
    def stop_at_transfer(message):
        if "アップロード" in message:
            cancel.set()
    with pytest.raises(Cancelled):
        cloud.publish(lib, cancel, stop_at_transfer)
    assert "papeer-library.json" not in remote.calls


@pytest.mark.skipif(sys.platform != "win32", reason="Windows DPAPI")
def test_credentials_use_dpapi_and_never_reveal_tokens_in_status():
    secret = {"client_id": "test", "client_secret": "desktop-secret", "refresh_token": "secret-refresh",
              "access_token": "secret-access", "expires_at": 9999999999}
    auth._save(secret)
    raw = auth._path().read_bytes()
    assert b"secret" not in raw
    assert auth._load() == secret
    assert auth.access_token() == "secret-access"
    assert "secret" not in json.dumps(auth.status())
    auth.disconnect()
    assert not auth.status()["connected"]


def test_drive_list_paginates(monkeypatch):
    drive = cloud.Drive()
    urls = []
    def response(url):
        urls.append(url)
        return {"files": [{"id": "b"}]} if "pageToken=next" in url else {"files": [{"id": "a"}], "nextPageToken": "next"}
    monkeypatch.setattr(drive, "json", response)
    assert drive.list("'folder' in parents") == [{"id": "a"}, {"id": "b"}]
    assert len(urls) == 2


@pytest.mark.parametrize("size", [0, 20, 8 * 1024 * 1024 + 1])
def test_resumable_upload_accepts_308_and_sends_all_bytes(tmp_path, monkeypatch, size):
    path = tmp_path / "payload"
    path.write_bytes(b"x" * size)
    drive = cloud.Drive()
    class Response(io.BytesIO):
        headers = {"Location": "https://www.googleapis.com/upload/drive/v3/files?upload_id=test"}
    monkeypatch.setattr(drive, "request", lambda *_a, **_kw: Response())
    monkeypatch.setattr(auth, "access_token", lambda: "test")
    chunks = []
    def upload(request, timeout):
        chunks.append(request.data)
        if sum(map(len, chunks)) < size:
            raise HTTPError(request.full_url, 308, "Resume Incomplete", {"Range": f"bytes=0-{len(request.data) - 1}"}, None)
        return Response(b'{"id":"complete"}')
    monkeypatch.setattr(cloud, "urlopen", upload)
    assert drive.upload(path, {"name": "payload"}, threading.Event()) == "complete"
    assert b"".join(chunks) == path.read_bytes()


def test_api_requires_auth_and_upload_is_exclusive(monkeypatch, library):
    from sidecar import deps
    from sidecar.app import app, allowed_during_snapshot
    from sidecar.job_types import JobKind, SNAPSHOT_KINDS
    lib, *_ = library
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.delenv("PAPEER_DEV_NO_AUTH", raising=False)
    monkeypatch.setenv("PAPEER_TOKEN", "expected")
    with TestClient(app) as client:
        assert client.get("/api/cloud-drive").status_code == 401
        assert client.post("/api/cloud-drive/upload", json={}).status_code == 401
        response = client.get("/api/cloud-drive", headers={"Authorization": "Bearer expected"})
        assert response.status_code == 200
    assert JobKind.CLOUD_UPLOAD in SNAPSHOT_KINDS
    assert allowed_during_snapshot("GET", "/api/cloud-drive")
    assert not allowed_during_snapshot("PUT", "/api/cloud-drive")
    assert not deps.snapshot_running()
