import json
from pathlib import Path
import shutil
import threading
import zipfile

import pytest

from _isolation import point_pc_folders
from papeer.core import drive_sync as sync
from papeer.core.storage import Library


def run(lib):
    return sync.sync(lib, sync.FolderDrive(Path(sync.read_state(lib.root)["folder"])),
                     threading.Event(), lambda _: None)


def test_folder_roundtrip_between_two_mirrors(tmp_path, monkeypatch):
    point_pc_folders(monkeypatch.setenv, tmp_path / "settings")
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
    point_pc_folders(monkeypatch.setenv, tmp_path / "settings")
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
    point_pc_folders(monkeypatch.setenv, tmp_path / "settings")
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
    point_pc_folders(monkeypatch.setenv, tmp_path / "settings")
    lib = Library(tmp_path / "data")
    folder = tmp_path / "drive"
    sync.connect(lib.root, str(folder))
    folder.rmdir()
    with pytest.raises(ValueError, match="見つかりません"):
        run(lib)
    assert not folder.exists()


def test_missing_known_revision_does_not_publish_over_it(tmp_path, monkeypatch):
    point_pc_folders(monkeypatch.setenv, tmp_path / "settings")
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

    point_pc_folders(monkeypatch.setenv, tmp_path / "settings")
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
                                         ("schema_version", True), ("app_version", 2),
                                         ("counts", [1]), ("counts", {"papers": -1}), ("counts", {"papers": "1"}),
                                         ("counts", {"papers": True})])
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


def test_conflict_reads_what_differs_in_place_and_keeps_the_side_left_out(tmp_path, monkeypatch):
    from papeer.core import local_history

    point_pc_folders(monkeypatch.setenv, tmp_path / "settings")
    a, b = Library(tmp_path / "a"), Library(tmp_path / "b")
    folder = tmp_path / "drive"
    sync.connect(a.root, str(folder))
    sync.connect(b.root, str(folder))
    sample = Path(__file__).parent / "fixtures/sample.pdf"
    first, _ = a.import_pdf(sample)
    another = tmp_path / "another.pdf"
    another.write_bytes(sample.read_bytes() + b"\n% another paper\n")
    second, _ = b.import_pdf(another)
    run(a)
    remote = sync.FolderDrive(folder)
    head = remote.revisions()[0]
    # Only the database is read from the revision, where it lies in the sync folder.
    with remote.open_library(head["id"]) as stream, zipfile.ZipFile(stream) as archive:
        assert "library.sqlite3" in archive.namelist() and f"papers/{first}/original.pdf" in archive.namelist()
    result = run(b)
    assert result["status"] == "conflict"
    diff = result["conflicts"][0]["diff"]
    assert (diff["local_only"], diff["remote_only"]) == (1, 1)
    assert (diff["local_titles"], diff["remote_titles"]) == ([b.paper(second)["title"]], [a.paper(first)["title"]])

    sync.sync(b, remote, threading.Event(), lambda _: None, choice="local", expected_heads=[head["id"]])
    kept = [entry for entry in local_history.entries(b.root) if entry["kind"] == "set_aside"]
    assert [item["side"] for item in kept] == ["remote"]
    # Recorded from the revision where it lies in the sync folder.
    local_history.materialize(b.root, kept[0]["id"], tmp_path / "kept")
    assert [paper["id"] for paper in Library(tmp_path / "kept").papers()] == [first]


def test_open_library_refuses_a_malformed_revision(tmp_path):
    folder = tmp_path / "drive"
    folder.mkdir()
    identity = "0" * 32
    with zipfile.ZipFile(folder / (identity + ".papeer-sync"), "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("library.zip", b"x" * 1000)  # Compressed: not readable in place.
    with pytest.raises(ValueError, match="形式が不正"):
        with sync.FolderDrive(folder).open_library(identity):
            pass
    with pytest.raises(ValueError, match="ID"):
        with sync.FolderDrive(folder).open_library("../x"):
            pass


def test_broken_or_unwritable_sync_folder_is_refused_for_the_user(tmp_path, monkeypatch):
    from papeer.core.errors import Invalid

    point_pc_folders(monkeypatch.setenv, tmp_path / "settings")
    lib = Library(tmp_path / "data")
    broken = tmp_path / "broken"
    broken.mkdir()
    (broken / ("0" * 32 + ".papeer-sync")).write_bytes(b"not a zip archive")
    with pytest.raises(Invalid, match="壊れているため"):
        sync.connect(lib.root, str(broken))
    (tmp_path / "a-file").write_text("not a folder")
    with pytest.raises(Invalid):
        sync.connect(lib.root, str(tmp_path / "a-file"))
    assert not sync.status(lib.root)["connected"]


def test_auto_sync_option_and_check_of_the_chosen_folder(tmp_path, monkeypatch):
    point_pc_folders(monkeypatch.setenv, tmp_path / "settings")
    lib = Library(tmp_path / "data")
    assert sync.check_connected(lib.root) == {"action": "none", "local_version": None}
    sync.connect(lib.root, str(tmp_path / "drive"))
    assert sync.set_auto_sync(lib.root, False)["auto_sync"] is False
    assert sync.read_state(lib.root)["auto_sync"] is False
    assert sync.set_auto_sync(lib.root, True)["auto_sync"] is True

    # check() looks at the chosen folder. The first check since launch cannot rely on the records of
    # the last sync, so it is "quiet" by check() itself (were it an error, check() here would raise).
    looked_at = []
    real_check = sync.check

    def recording(root, remote):
        looked_at.append(remote.folder.resolve())
        return real_check(root, remote)
    monkeypatch.setattr(sync, "check", recording)
    assert real_check(lib.root, sync.FolderDrive(tmp_path / "drive")) == {"action": "quiet", "local_version": None}
    assert sync.check_connected(lib.root) == {"action": "quiet", "local_version": None}
    assert looked_at == [(tmp_path / "drive").resolve()]
    # Once synced, nothing has changed on either side.
    run(lib)
    assert sync.check_connected(lib.root)["action"] == "none"
    assert len(looked_at) == 2

    def unreadable(root, remote):
        raise OSError("the folder is still arriving")
    monkeypatch.setattr(sync, "check", unreadable)
    assert sync.check_connected(lib.root) == {"action": "quiet", "local_version": None}


def test_sync_of_the_chosen_folder_records_its_failure(tmp_path, monkeypatch):
    from papeer.providers import Cancelled

    point_pc_folders(monkeypatch.setenv, tmp_path / "settings")
    lib = Library(tmp_path / "data")
    never = threading.Event()
    with pytest.raises(ValueError, match="同期フォルダーを指定してください"):
        sync.sync_connected(lib.root, never, lambda _: None)
    assert sync.status(lib.root)["error"] == "同期フォルダーを指定してください。"

    folder = tmp_path / "drive"
    sync.connect(lib.root, str(folder))
    assert sync.status(lib.root)["error"] is None
    assert sync.sync_connected(lib.root, never, lambda _: None)["status"] == "synced"
    shutil.rmtree(folder)
    with pytest.raises(ValueError, match="見つかりません") as failed:
        sync.sync_connected(lib.root, never, lambda _: None)
    assert sync.status(lib.root)["error"] == str(failed.value)
    folder.mkdir()

    def broken(*_args, **_kwargs):
        raise RuntimeError("disk gone")
    monkeypatch.setattr(sync, "sync", broken)
    with pytest.raises(ValueError) as failed:
        sync.sync_connected(lib.root, never, lambda _: None)
    assert str(failed.value) == sync.SYNC_FAILED == sync.status(lib.root)["error"]

    # Stopping is not a failure: the last error stays as it was, and nothing new is recorded.
    sync.set_auto_sync(lib.root, True)
    state = sync.read_state(lib.root)
    state["error"] = None
    sync.save_state(lib.root, state)

    def stopped(*_args, **_kwargs):
        raise Cancelled("中止")
    monkeypatch.setattr(sync, "sync", stopped)
    with pytest.raises(Cancelled, match=sync.SYNC_CANCELLED):
        sync.sync_connected(lib.root, never, lambda _: None)
    assert sync.status(lib.root)["error"] is None
