from pathlib import Path
import shutil
import threading

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
    assert not list(folder_a.glob("*.partial"))
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
