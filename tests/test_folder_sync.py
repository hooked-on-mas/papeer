import json
from pathlib import Path
import shutil
import threading
import zipfile

import pytest

from papeer.core import drive_sync as sync
from papeer.core.storage import Library


def run(lib):
    return sync.sync(lib, sync.FolderDrive(Path(sync.read_state(lib.root)["folder"])),
                     threading.Event(), lambda _: None)


def test_folder_roundtrip_between_two_mirrors(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "settings"))
    a, b = Library(tmp_path / "a"), Library(tmp_path / "b")
    folder_a, folder_b = tmp_path / "drive-a", tmp_path / "drive-b"
    sync.connect(a.root, str(folder_a))
    sync.connect(b.root, str(folder_b))
    identity, _ = a.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    a.save_ink(identity, "original", 1, [{"id": "ink"}])
    (a.folder(identity) / "article.md").write_text("summary")
    run(a)
    assert len(list(folder_a.glob("*.papeer-sync"))) == 1
    shutil.copytree(folder_a, folder_b, dirs_exist_ok=True)  # Simulate Drive for desktop.
    assert run(b)["status"] == "conflict"
    remote = sync.FolderDrive(folder_b)
    head = remote.revisions()[0]["id"]
    sync.sync(b, remote, threading.Event(), lambda _: None, choice=head, expected_heads=[head])
    assert b.ink(identity, "original", 1) == [{"id": "ink"}]
    assert (b.folder(identity) / "article.md").read_text() == "summary"
    assert sync.fingerprint(a) == sync.fingerprint(b)
    assert not list(folder_a.glob("*.partial")) and not list(folder_a.glob("*.tmp"))
    assert sync.status(a.root)["folder"] == str(folder_a)


def test_partial_and_out_of_order_arrival(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "settings"))
    lib = Library(tmp_path / "data")
    folder = tmp_path / "drive"
    sync.connect(lib.root, str(folder))
    run(lib)
    first = next(folder.glob("*.papeer-sync"))
    lib.save_note_template("one", "note")
    run(lib)
    first.rename(tmp_path / first.name)
    with pytest.raises(ValueError, match="まだ揃って"):
        run(lib)
    (tmp_path / first.name).rename(first)
    (folder / "interrupted.partial").write_bytes(b"half a file")
    assert run(lib)["status"] == "synced"


def test_path_validation_and_reconnect(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "settings"))
    lib = Library(tmp_path / "data")
    for value in ("", "relative", str(lib.root), str(lib.root / "nested"), str(tmp_path)):
        with pytest.raises(ValueError):
            sync.connect(lib.root, value)
    folder = tmp_path / "drive"
    sync.connect(lib.root, str(folder))
    run(lib)
    base = sync.read_state(lib.root)["base"]
    sync.disconnect(lib.root)
    assert not sync.status(lib.root)["connected"]
    sync.connect(lib.root, str(folder))
    assert sync.read_state(lib.root)["base"] == base
    sync.connect(lib.root, str(tmp_path / "other"))
    assert "base" not in sync.read_state(lib.root)


def test_missing_folder_is_not_recreated(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "settings"))
    lib = Library(tmp_path / "data")
    folder = tmp_path / "drive"
    sync.connect(lib.root, str(folder))
    folder.rmdir()
    with pytest.raises(ValueError, match="見つかりません"):
        run(lib)
    assert not folder.exists()


def test_missing_known_revision_does_not_publish_over_it(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "settings"))
    lib = Library(tmp_path / "data")
    folder = tmp_path / "drive"
    sync.connect(lib.root, str(folder))
    run(lib)
    first = next(folder.glob("*.papeer-sync"))
    first.rename(tmp_path / first.name)
    with pytest.raises(ValueError, match="前回の同期"):
        run(lib)
    assert not list(folder.glob("*.papeer-sync"))


def test_leftover_temporary_files_do_not_spread(tmp_path, monkeypatch):
    # A forced exit can leave atomic_output's ".<name>.<random>.tmp" behind in the library or the sync folder.
    import zipfile
    from papeer.core.reading_tools import create_backup

    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "settings"))
    lib = Library(tmp_path / "data")
    folder = tmp_path / "drive"
    sync.connect(lib.root, str(folder))
    identity, _ = lib.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    assert run(lib)["status"] == "synced"
    revisions = sync.FolderDrive(folder).revisions()
    before = sync.fingerprint(lib)

    (lib.folder(identity) / ".note.md.k3j9x2.tmp").write_text("half a note")
    (lib.root / ".settings.json.a1b2c3.tmp").write_text("{")
    head = revisions[0]["id"]
    (folder / f".{head}.papeer-sync.q8w7e6.tmp").write_bytes(b"half a revision")

    assert sync.fingerprint(lib) == before
    assert sync.FolderDrive(folder).revisions() == revisions
    assert run(lib)["status"] == "synced"
    assert len(list(folder.glob("*.papeer-sync"))) == 1  # Nothing changed, so nothing new was uploaded.

    create_backup(lib, tmp_path / "backup.zip")
    with zipfile.ZipFile(tmp_path / "backup.zip") as archive:
        names = archive.namelist()
    assert not [name for name in names if name.endswith(".tmp")]
    assert f"papers/{identity}/original.pdf" in names


@pytest.mark.parametrize("field,value", [("schema_version", "1"), ("schema_version", -1),
                                         ("schema_version", True), ("app_version", 2)])
def test_malformed_version_fields_are_rejected(tmp_path, field, value):
    folder = tmp_path / "drive"
    folder.mkdir()
    identity = "0" * 32
    with zipfile.ZipFile(folder / (identity + ".papeer-sync"), "w") as archive:
        archive.writestr("revision.json", json.dumps({
            "format": sync.FORMAT, "id": identity, "parents": [], "hash": "h", "archive_hash": "a",
            "device": "pc", "created": "2026-09-27T00:00:00Z", field: value}))
        archive.writestr("library.zip", b"")
    with pytest.raises(ValueError, match="形式が不正"):
        sync.FolderDrive(folder).revisions()
