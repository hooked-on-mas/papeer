"""Two PCs syncing through folders a stand-in for Google Drive copies between, each with its own device folder.

Folder sync itself is unchanged (a ZIP per revision); what is tested is this PC's history (local_history)
that each sync records: set-aside libraries go there instead of ZIPs beside the library, and a library
taken in no longer leaves the one it replaced in a folder beside it, unless the history cannot stand for it.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import shutil
import threading
import zlib

import pytest

from papeer.core import drive_sync as sync
from papeer.core import local_history
from papeer.core.paths import history_directory
from papeer.core.storage import Library
from papeer.providers import Cancelled

SAMPLE = Path(__file__).parent / "fixtures/sample.pdf"


class PC:
    """One PC: its library, its device folder (LOCALAPPDATA) and its copy of the sync folder."""

    def __init__(self, name: str, tmp_path: Path, monkeypatch):
        self.name, self.monkeypatch = name, monkeypatch
        self.device = tmp_path / f"{name}-device"
        self.drive = tmp_path / f"{name}-drive"
        self.root = tmp_path / name / "library"

    def __enter__(self) -> Library:
        """Act as this PC: its device folder is the one papeer reads."""
        self.monkeypatch.setenv("LOCALAPPDATA", str(self.device))
        return Library(self.root)

    def __exit__(self, *_exc):
        return False

    def connect(self):
        with self:
            sync.connect(self.root, str(self.drive))

    def sync(self, cancel=None, **kwargs):
        with self as lib:
            return sync.sync(lib, sync.FolderDrive(self.drive), cancel or threading.Event(), lambda _: None, **kwargs)

    def history(self) -> list[dict]:
        with self:
            return local_history.entries(self.root)

    def state(self, entry_id: str, target: Path) -> Library:
        with self:
            local_history.materialize(self.root, entry_id, target)
            return Library(target)

    def moved_aside(self) -> list[Path]:
        return sorted(path for path in self.root.parent.iterdir() if "-before-restore-" in path.name)

    def blobs(self) -> set[str]:
        with self:
            folder = history_directory(self.root) / "blobs"
        return {path.name for path in folder.iterdir()}


def transfer(source: PC, target: PC) -> None:
    """Google Drive for desktop: the revisions one PC wrote appear in the other's folder."""
    for path in source.drive.glob("*.papeer-sync"):
        if not (target.drive / path.name).exists():
            shutil.copy2(path, target.drive / path.name)


@pytest.fixture
def pcs(tmp_path, monkeypatch):
    a, b = PC("a", tmp_path, monkeypatch), PC("b", tmp_path, monkeypatch)
    a.connect()
    b.connect()
    with a as lib:
        identity, _ = lib.import_pdf(SAMPLE)
        (lib.folder(identity) / "article.md").write_text("summary one", "utf-8")
    assert a.sync()["status"] == "synced"
    transfer(a, b)
    # b has never synced: it chooses the sync folder's library, which is recorded as taken in.
    head = sync.revision_heads(sync.FolderDrive(b.drive).revisions())[0]["id"]
    assert b.sync()["status"] == "conflict"
    first = b.sync(choice=head, expected_heads=[head])
    # Its history was empty, so the (empty) library it replaced stays beside it, as before.
    assert first["previous_path"] and len(b.moved_aside()) == 1
    transfer(b, a)
    assert a.sync()["reloaded"] is False  # The merge holds a's library: only the ancestor moves.
    return a, b, identity


def edit(pc: PC, identity: str, **values) -> None:
    with pc as lib:
        article = values.pop("article", None)
        if article is not None:
            (lib.folder(identity) / "article.md").write_text(article, "utf-8")
        if values:
            lib.update(identity, **values)


def note(pc: PC, identity: str) -> str:
    with pc as lib:
        return lib.paper(identity)["note"]


def test_each_pc_records_what_it_syncs_and_moves_nothing_aside(pcs, tmp_path):
    a, b, identity = pcs
    before_b = b.moved_aside()
    for n in range(3):
        edit(a, identity, note=f"a{n}")
        a.sync()
        transfer(a, b)
        assert b.sync()["reloaded"] is True and note(b, identity) == f"a{n}"
        edit(b, identity, note=f"b{n}")
        b.sync()
        transfer(b, a)
        result = a.sync()
        assert result["reloaded"] is True and result["previous_path"] is None
    assert a.moved_aside() == [] and b.moved_aside() == before_b
    # Each PC's own history, in its own device folder.
    with a:
        assert history_directory(a.root).is_relative_to(a.device)
    kinds_a = [entry["kind"] for entry in a.history()]
    assert kinds_a[0] == "pull" and "publish" in kinds_a and len(kinds_a) == 5  # The newest 5 by default.
    # The PDF is stored once however many states use it.
    pdf = [name for name in a.blobs() if not name.endswith(".z")]
    assert len(pdf) == 1
    # The newest states hold what each sync settled on.
    assert a.state(a.history()[1]["id"], tmp_path / "a-state").paper(identity)["note"] == "a2"


def test_a_choice_keeps_the_other_side_in_the_history_of_the_pc_that_chose(pcs, tmp_path):
    a, b, identity = pcs
    edit(a, identity, note="from a")
    edit(b, identity, note="from b")
    a.sync()
    b.sync()
    transfer(a, b)
    transfer(b, a)
    result = b.sync()
    assert result["status"] == "conflict"
    heads = [item["id"] for item in result["conflicts"]]
    chosen = b.sync(choice="local", expected_heads=heads)
    # a's side, as the sync folder holds it, is kept on b.
    assert chosen["set_aside"] and chosen["not_set_aside"] == []
    kept = [entry for entry in b.history() if entry["kind"] == "set_aside"]
    assert [entry["side"] for entry in kept] == ["remote"] and kept[0]["revision"] in heads
    assert b.state(kept[0]["id"], tmp_path / "kept").paper(identity)["note"] == "from a"
    assert sync.side_backups(b.root) == []
    # a takes b's choice in; its own library (the state it last synced) is in its history.
    transfer(b, a)
    taken = a.sync()
    assert taken["reloaded"] is True and taken["previous_path"] is None and note(a, identity) == "from b"
    assert a.moved_aside() == []


def test_a_sync_stopped_while_recording_changes_nothing_and_the_next_one_goes_through(pcs, monkeypatch):
    a, b, identity = pcs
    edit(a, identity, note="new")
    a.sync()
    transfer(a, b)
    with b:
        state = sync.read_state(b.root)
    entries = b.history()
    write_entry = local_history._write_entry

    def stopped(*_args):
        raise Cancelled("stopped")

    monkeypatch.setattr(local_history, "_write_entry", stopped)
    with pytest.raises(Cancelled):
        b.sync()
    # The blobs were written, the entry was not: the library, its state and its history are as they were.
    assert note(b, identity) == "" and b.history() == entries
    with b:
        assert sync.read_state(b.root) == state
    monkeypatch.setattr(local_history, "_write_entry", write_entry)
    result = b.sync()
    assert result["reloaded"] is True and note(b, identity) == "new"
    # What the stopped sync wrote and no state uses is gone.
    with b:
        manifests = local_history._read_entries(history_directory(b.root))[0]
    assert b.blobs() == set().union(*(local_history._referenced(entry) for entry in manifests))


def test_a_choice_stopped_while_setting_aside_keeps_nothing_and_is_offered_again(pcs, monkeypatch):
    a, b, identity = pcs
    edit(a, identity, note="from a")
    edit(b, identity, note="from b")
    a.sync()
    transfer(a, b)
    result = b.sync()
    assert result["status"] == "conflict"
    heads = [item["id"] for item in result["conflicts"]]
    record_folder = local_history.record_folder

    def stopped_on_publish(*args, **kwargs):
        if kwargs["kind"] == "publish":
            raise Cancelled("stopped")
        return record_folder(*args, **kwargs)

    monkeypatch.setattr(local_history, "record_folder", stopped_on_publish)
    with pytest.raises(Cancelled):
        b.sync(choice="local", expected_heads=heads)
    # The remote side was recorded, then removed again: a choice that fails keeps nothing.
    assert [entry for entry in b.history() if entry["kind"] == "set_aside"] == []
    monkeypatch.setattr(local_history, "record_folder", record_folder)
    assert b.sync()["status"] == "conflict"
    assert b.sync(choice="local", expected_heads=heads)["status"] == "synced"
    assert [entry["side"] for entry in b.history() if entry["kind"] == "set_aside"] == ["remote"]


def test_a_blob_missing_from_the_history_keeps_the_replaced_library_beside_it(pcs):
    a, b, identity = pcs
    # b's current state holds article.md "summary one"; that content goes missing from b's history.
    edit(a, identity, article="summary two", note="second")
    with b:
        folder = history_directory(b.root) / "blobs"
    missing = hashlib.sha256(b"summary one").hexdigest() + ".z"
    (folder / missing).unlink()
    assert not b.history()[0]["complete"]
    a.sync()
    transfer(a, b)
    before = b.moved_aside()
    result = b.sync()
    assert result["reloaded"] is True and note(b, identity) == "second"
    # The history cannot stand for the library replaced, so it stays beside it as before.
    kept = [path for path in b.moved_aside() if path not in before]
    assert len(kept) == 1 and result["previous_path"] == str(kept[0])
    assert (kept[0] / "papers" / identity / "article.md").read_text("utf-8") == "summary one"
    # The state taken in is complete, so the next one moves nothing aside.
    edit(a, identity, note="third")
    a.sync()
    transfer(a, b)
    result = b.sync()
    assert result["previous_path"] is None and len(b.moved_aside()) == len(before) + 1


def test_a_damaged_compressed_blob_keeps_the_replaced_library_beside_it(pcs, tmp_path):
    """Its name is there, so only reading it shows the damage; the folder is kept, the blob moved aside."""
    a, b, identity = pcs
    with b:
        folder = history_directory(b.root)
    name = hashlib.sha256(b"summary one").hexdigest() + ".z"
    (folder / "blobs" / name).write_bytes(zlib.compress(b"garbage"))
    edit(a, identity, note="from a")
    a.sync()
    transfer(a, b)
    before = b.moved_aside()
    result = b.sync()
    assert result["reloaded"] is True and note(b, identity) == "from a"
    kept = [path for path in b.moved_aside() if path not in before]
    assert len(kept) == 1 and result["previous_path"] == str(kept[0])
    assert (kept[0] / "papers" / identity / "article.md").read_text("utf-8") == "summary one"
    assert (folder / "damaged" / name).exists()


def test_a_choice_over_a_damaged_blob_keeps_this_pcs_library_beside_it(pcs):
    """b's unpublished edit is set aside, but the state set aside shares a damaged blob: reading it back
    shows it, so the folder the swap moves aside is kept, and it holds b's edit."""
    a, b, identity = pcs
    with b:
        folder = history_directory(b.root)
    name = hashlib.sha256(b"summary one").hexdigest() + ".z"
    (folder / "blobs" / name).write_bytes(zlib.compress(b"garbage"))
    edit(a, identity, note="from a")
    edit(b, identity, note="from b (unpublished)")
    a.sync()
    transfer(a, b)
    heads = [item["id"] for item in b.sync()["conflicts"]]
    result = b.sync(choice=heads[0], expected_heads=heads)
    assert note(b, identity) == "from a" and result["set_aside"]
    assert result["previous_path"] and Path(result["previous_path"]).is_dir()
    with b:
        assert Library(Path(result["previous_path"])).paper(identity)["note"] == "from b (unpublished)"


def test_the_state_that_stands_for_the_replaced_library_outlives_the_clean_up(pcs, tmp_path):
    a, b, identity = pcs
    with b:
        local_history.save_history_settings(1, 0)
        before_hash = sync.fingerprint(b.root)
    edit(a, identity, note="second")
    a.sync()
    transfer(a, b)
    result = b.sync()
    assert result["reloaded"] is True and result["previous_path"] is None
    # recent=1 keeps only the newest, but the state the folder was removed for stays until the next sync.
    replaced = next(entry for entry in b.history() if entry["hash"] == before_hash)
    assert b.state(replaced["id"], tmp_path / "replaced").paper(identity)["note"] == ""


def test_a_history_that_cannot_be_read_back_just_now_keeps_the_folder(pcs, monkeypatch):
    a, b, identity = pcs
    edit(a, identity, note="second")
    a.sync()
    transfer(a, b)

    def held(*_args, **_kwargs):
        raise PermissionError("a virus scan holds a blob")

    monkeypatch.setattr(local_history, "verified_state", held)
    before = b.moved_aside()
    result = b.sync()
    assert result["reloaded"] is True and note(b, identity) == "second"
    assert result["previous_path"] and len(b.moved_aside()) == len(before) + 1
