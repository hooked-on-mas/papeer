from pathlib import Path
import shutil
import sqlite3

from fastapi.testclient import TestClient
import pytest

from papeer.core.paths import PaperFiles
from papeer.core.storage import Library, SCHEMA_VERSION, database_version
from papeer.core import memo_migration


@pytest.fixture
def memos(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(Path(__file__).parent / "fixtures" / "sample.pdf")
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    from sidecar.app import app
    with TestClient(app) as client:
        yield lib, identity, client


def test_memo_crud_reorder_and_owner_isolation(memos):
    lib, owner, client = memos
    base = f"/api/papers/{owner}/attachments"
    first = client.post(base, json={"title": "最初.md", "content": "## 見出し\n\n- 候補"}).json()
    second = client.post(base, json={"title": "追加.md", "source": "imported"}).json()
    assert first["format"] == "md" and second["source"] == "imported"
    assert client.get(f"/api/papers/{owner}").json()["attachment_count"] == 2
    assert "note" not in client.get(f"/api/papers/{owner}").json()
    assert client.patch(f"/api/papers/{owner}", json={"note": "旧 API"}).status_code == 422
    edited = client.patch(f"{base}/{first['id']}", json={"title": "改名.md", "content": "変更"}).json()
    assert edited["title"] == "改名.md" and edited["content"] == "変更" and edited["updated_at"] != first["updated_at"]
    assert not (lib.folder(owner) / "note.md").exists()
    assert PaperFiles(lib.folder(owner)).attachment(first["id"], "md").read_text("utf-8") == "変更"
    assert client.put(f"{base}/order", json={"ids": [second["id"], first["id"]]}).status_code == 200
    assert [row["id"] for row in client.get(base).json()] == [second["id"], first["id"]]
    assert client.put(f"{base}/order", json={"ids": [first["id"], first["id"]]}).status_code == 400
    assert client.put(f"{base}/order", json={"ids": [first["id"]]}).status_code == 400
    assert client.patch(f"{base}/{first['id']}", json={"title": " "}).status_code == 400
    other = "a" * 32
    with lib.connection() as db:
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages) VALUES(?,?,?,?,1)", (other, "different", "other", "other.pdf"))
    foreign = f"/api/papers/{other}/attachments/{first['id']}"
    assert client.get(foreign).status_code == 404
    assert client.patch(foreign, json={"content": "不正"}).status_code == 404
    assert client.delete(foreign).status_code == 404
    assert client.delete(f"{base}/{first['id']}").status_code == 200
    assert not PaperFiles(lib.folder(owner)).attachment(first["id"], "md").exists()
    assert client.get(f"/api/papers/{owner}").json()["attachment_count"] == 1
    lib.delete_paper(owner)
    assert client.get("/api/attachments").json() == []


def test_import_validation_and_utf8(memos, tmp_path):
    lib, owner, client = memos
    base = f"/api/papers/{owner}/attachments/import"
    path = tmp_path / "持込.md"
    path.write_text("見出し\n本文", "utf-8-sig")
    rows = client.post(base, json={"paths": [str(path)]}).json()
    assert rows[0]["title"] == "持込.md" and rows[0]["source"] == "imported"
    assert lib.attachment_text(rows[0]["id"]) == "見出し\n本文"
    path.write_bytes(b"\xff")
    assert client.post(base, json={"paths": [str(path)]}).status_code == 400
    assert client.post(base, json={"paths": [str(path.with_suffix('.pdf'))]}).status_code == 400
    assert len(lib.attachments(owner)) == 1


@pytest.mark.parametrize("database,disk,count", [("DB", "DB", 1), ("DB", "ファイル", 2), ("", "ファイル", 1), ("DB", None, 1), ("", "", 0)])
def test_one_way_migration_on_already_version8(memos, database, disk, count):
    lib, owner, _ = memos
    with lib.connection() as db:
        db.execute("UPDATE papers SET note=? WHERE id=?", (database, owner))
    legacy = lib.folder(owner) / "note.md"
    if disk is not None:
        legacy.write_text(disk, "utf-8")
    converted = Library(lib.root)
    rows = converted.attachments(owner)
    assert len(rows) == count
    assert {converted.attachment_text(row["id"]) for row in rows} == {text for text in (database, disk) if text}
    assert not legacy.exists()
    assert "note" not in converted.paper(owner)
    with converted.connection() as db:
        assert db.execute("SELECT note FROM papers WHERE id=?", (owner,)).fetchone()[0] == ""
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION == 8
    assert Library(lib.root).attachments(owner) == rows


def test_failed_migration_keeps_content_and_retries(memos, monkeypatch):
    lib, owner, _ = memos
    with lib.connection() as db:
        db.execute("UPDATE papers SET note='大切な内容' WHERE id=?", (owner,))
    def fail(*args):
        raise OSError("disk full")
    with monkeypatch.context() as context:
        context.setattr(memo_migration, "atomic_write_text", fail)
        with pytest.raises(OSError):
            Library(lib.root)
    with sqlite3.connect(lib.root / "library.sqlite3") as db:
        assert db.execute("SELECT note FROM papers WHERE id=?", (owner,)).fetchone()[0] == "大切な内容"
    converted = Library(lib.root)
    assert len(converted.attachments(owner)) == 1


def test_retry_after_commit_does_not_duplicate_or_overwrite(memos, monkeypatch):
    lib, owner, _ = memos
    with lib.connection() as db:
        db.execute("UPDATE papers SET note='元の内容' WHERE id=?", (owner,))
    legacy = lib.folder(owner) / "note.md"
    legacy.write_text("元の内容", "utf-8")
    original = Path.unlink
    def fail(path, *args, **kwargs):
        if path == legacy:
            raise OSError("locked file")
        return original(path, *args, **kwargs)
    with monkeypatch.context() as context:
        context.setattr(Path, "unlink", fail)
        with pytest.raises(OSError):
            Library(lib.root)
    rows = lib.attachments(owner)
    assert len(rows) == 1
    lib.update_attachment(owner, rows[0]["id"], content="移行後の編集")
    converted = Library(lib.root)
    assert len(converted.attachments(owner)) == 1
    assert converted.attachment_text(rows[0]["id"]) == "移行後の編集"


def test_partial_file_conversion_retries_without_duplicate_rows(memos, monkeypatch):
    lib, owner, _ = memos
    with lib.connection() as db:
        db.execute("UPDATE papers SET note='DBの内容' WHERE id=?", (owner,))
    legacy = lib.folder(owner) / "note.md"
    legacy.write_text("別のファイル内容", "utf-8")
    write = memo_migration.atomic_write_text
    calls = []
    def fail_second(path, content):
        calls.append(path)
        if len(calls) == 2:
            raise OSError("disk full after the first file")
        return write(path, content)
    with monkeypatch.context() as context:
        context.setattr(memo_migration, "atomic_write_text", fail_second)
        with pytest.raises(OSError):
            Library(lib.root)
    assert calls[0].exists() and legacy.exists()
    assert lib.attachments(owner) == []
    with lib.connection() as db:
        assert db.execute("SELECT note FROM papers WHERE id=?", (owner,)).fetchone()[0] == "DBの内容"
    converted = Library(lib.root)
    rows = converted.attachments(owner)
    assert len(rows) == 2
    assert {converted.attachment_text(row["id"]) for row in rows} == {"DBの内容", "別のファイル内容"}
    assert Library(lib.root).attachments(owner) == rows


def test_sync_comparison_does_not_convert_or_write_snapshot(memos, tmp_path):
    from papeer.core.drive_sync import library_difference
    lib, owner, _ = memos
    with lib.connection() as db:
        db.execute("UPDATE papers SET note='旧内容' WHERE id=?", (owner,))
    (lib.folder(owner) / "note.md").write_text("旧内容", "utf-8")
    snapshot = tmp_path / "snapshot"
    shutil.copytree(lib.root, snapshot)
    before = {path.relative_to(snapshot): path.read_bytes() for path in snapshot.rglob("*") if path.is_file()}
    difference = library_difference(lib.root / "library.sqlite3", snapshot / "library.sqlite3")
    assert difference["attachments"] == 0
    assert {path.relative_to(snapshot): path.read_bytes() for path in snapshot.rglob("*") if path.is_file()} == before
    with sqlite3.connect(snapshot / "library.sqlite3") as db:
        assert db.execute("SELECT note FROM papers WHERE id=?", (owner,)).fetchone()[0] == "旧内容"
