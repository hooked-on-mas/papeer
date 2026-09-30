"""Moving a sync folder from the first format to the new one (folder_sync), between two PCs.

Each PC has its own device folder and name, and its own copy of the sync folder; a stand-in for Google Drive
copies what one PC wrote to the other's copy when asked (the whole folder: the first format's revisions and
the new format's files alike). An earlier Papeer is played by drive_sync.sync itself, which is what one that
reads the database version of a revision (T09 and later) runs, but for what its revisions say of the new
format; the last test runs b0b0280 itself.
"""
from __future__ import annotations

from datetime import timedelta
import os
from pathlib import Path
import platform
import random
import shutil
import sys
import threading
import time
import uuid

import pytest

from _isolation import point_pc_folders
from papeer import __version__
from papeer.core import drive_sync, drive_sync_v2, folder_sync, local_history, sync_store
from papeer.core.fileio import is_temporary
from papeer.core.storage import Library, NewerSchemaError
from papeer.core.sync_store import GenerationStore
from papeer.providers import Cancelled

SAMPLE = Path(__file__).parent / "fixtures/sample.pdf"


class PC:
    """One PC: its library, its device folders, its name and its copy of the sync folder."""

    def __init__(self, name: str, tmp_path: Path, monkeypatch):
        self.name, self.monkeypatch = name, monkeypatch
        self.place = tmp_path / f"{name}-pc"
        self.drive = tmp_path / f"{name}-drive"
        self.root = tmp_path / name / "library"
        # What the OS says of the machine (drive_sync_v2.machine_key): unlike its name, renaming leaves it.
        self.machine = f"machine-{name}"
        self.drive.mkdir()

    def __enter__(self) -> Library:
        point_pc_folders(self.monkeypatch.setenv, self.place)
        self.monkeypatch.setattr(platform, "node", lambda: f"PC-{self.name.upper()}")
        self.monkeypatch.setattr(drive_sync_v2, "machine_key", lambda: self.machine)
        return Library(self.root)

    def __exit__(self, *_exc):
        return False

    def connect(self) -> None:
        with self:
            drive_sync.connect(self.root, str(self.drive))

    def sync(self, cancel=None, **kwargs) -> dict:
        """A sync of this (new) Papeer, in whichever format the folder is (folder_sync.sync_connected)."""
        with self:
            return folder_sync.sync_connected(self.root, cancel or threading.Event(), lambda _: None, **kwargs)

    def migrate(self, cancel=None, progress=lambda _: None) -> dict:
        with self:
            return folder_sync.migrate(self.root, cancel or threading.Event(), progress)

    def old_sync(self, **kwargs) -> dict:
        """A sync of an earlier Papeer, in the first format only: its revisions do not say it reads the new one."""
        upload = drive_sync.FolderDrive.upload

        def earlier(remote, path, metadata, cancel, progress):
            return upload(remote, path, {k: v for k, v in metadata.items() if k != "newest_format"}, cancel, progress)
        with self as lib, self.monkeypatch.context() as patch:
            patch.setattr(drive_sync.FolderDrive, "upload", earlier)
            return drive_sync.sync(lib, drive_sync.FolderDrive(self.drive), threading.Event(), lambda _: None, **kwargs)

    def check(self) -> str:
        with self:
            return folder_sync.check_connected(self.root)["action"]

    def state(self) -> dict:
        with self:
            return drive_sync.read_state(self.root)

    def status(self) -> dict:
        with self:
            return folder_sync.status(self.root)

    def formats(self) -> dict:
        with self:
            return folder_sync.format_status(self.root)

    def fingerprint(self) -> str:
        with self as lib:
            return drive_sync.fingerprint(lib)

    def note(self, identity: str) -> str:
        with self as lib:
            return lib.paper(identity)["note"]

    def edit(self, identity: str, note: str) -> None:
        with self as lib:
            lib.update(identity, note=note)

    def history(self) -> list[dict]:
        with self:
            return local_history.entries(self.root)

    def revisions(self) -> list[dict]:
        return drive_sync.FolderDrive(self.drive).revisions(strict=False)

    def markers(self) -> list[dict]:
        return [item for item in self.revisions() if drive_sync.is_marker(item)]

    def view(self):
        return GenerationStore(self.drive).view()

    def files(self) -> list[str]:
        return sorted(path.relative_to(self.drive).as_posix() for path in self.drive.rglob("*")
                      if path.is_file() and not is_temporary(path))


def pending(source: PC, target: PC) -> list[str]:
    """What of source's sync folder target lacks or holds otherwise, first format first, then by kind."""
    order = ("", "v2/format.json", "v2/blobs", "v2/gens", "v2/devices")
    result = []
    for rel in source.files():
        other = target.drive / rel
        if not other.exists() or other.read_bytes() != (source.drive / rel).read_bytes():
            kind = next(index for index, prefix in reversed(list(enumerate(order))) if rel.startswith(prefix))
            result.append((kind, rel))
    return [rel for _kind, rel in sorted(result)]


def deliver(source: PC, target: PC, rel: str) -> None:
    """One file arrives whole (Google Drive for desktop shows a file only once it is downloaded)."""
    destination = target.drive / rel
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    shutil.copy2(source.drive / rel, temporary)
    os.replace(temporary, destination)


def transfer(source: PC, target: PC) -> list[str]:
    moved = pending(source, target)
    for rel in moved:
        deliver(source, target, rel)
    return moved


def mirror(source: PC, target: PC) -> None:
    """target's copy becomes source's: what source removed goes from it too."""
    transfer(source, target)
    theirs = set(source.files())
    for rel in target.files():
        if rel not in theirs:
            (target.drive / rel).unlink()


@pytest.fixture
def synced(tmp_path, monkeypatch):
    """Two PCs synced in the first format on the same revision (a has published twice, b once)."""
    monkeypatch.setattr(drive_sync, "_now_ns", lambda: time.time_ns() + 10 * drive_sync.RACY_NS)
    a, b = PC("a", tmp_path, monkeypatch), PC("b", tmp_path, monkeypatch)
    a.connect()
    b.connect()
    with a as lib:
        identity, _ = lib.import_pdf(SAMPLE)
    assert a.sync()["status"] == "synced"
    a.edit(identity, "first")
    assert a.sync()["status"] == "synced"
    transfer(a, b)
    result = b.sync()
    assert result["status"] == "conflict"
    head = result["conflicts"][0]["id"]
    assert b.sync(choice=head, expected_heads=[head])["reloaded"] is True
    transfer(b, a)
    assert a.sync()["status"] == "synced"
    assert a.state()["base"] == b.state()["base"] and b.note(identity) == "first"
    return a, b, identity


def first_format_heads(pc: PC) -> list[dict]:
    return drive_sync.revision_heads(pc.revisions())


def test_migrating_moves_the_folder_and_the_other_pc_follows(synced):
    a, b, identity = synced
    before = {item["id"] for item in a.revisions()}
    head = a.state()["base"]
    assert a.status()["format"] == 1 and a.formats()["format"] == 1
    assert a.formats()["revisions"]["count"] == len(before)
    messages = []
    result = a.migrate(progress=messages.append)
    assert result["status"] == "synced" and result["migrated"] is True
    assert "同期の形式を新しくしています…" in messages
    view = a.view()
    [generation] = [view.generations[identity] for identity in view.heads()]
    assert generation["parents"] == [head] and generation["hash"] == a.fingerprint()
    # Every revision of the first format is named, so a PC on any of them goes on from the generation.
    assert before <= {identity for identity, _time in generation["lineage"]}
    # The marker: an ordinary revision of the first format over the one taken over, which an earlier Papeer cannot take in.
    [marker] = a.markers()
    assert marker["parents"] == [head] and marker["schema_version"] == drive_sync.MARKER_SCHEMA
    assert marker["successor"] == {"format": 2, "gen": generation["id"]} and marker["app_version"] == __version__
    assert [item["id"] for item in first_format_heads(a)] == [marker["id"]]
    # The revisions of the first format stay.
    assert before <= {item["id"] for item in a.revisions()}
    state = a.state()
    assert state["format"] == 2 and state["base"] == generation["id"] and "migration" not in state
    assert a.status()["format"] == 2 and not a.status()["migration_pending"]
    assert set(view.devices) == {state["device_id"]} and view.devices[state["device_id"]]["base"] == generation["id"]
    assert a.sync()["status"] == "synced" and a.view().heads() == [generation["id"]]
    assert a.check() == "none"
    # b, which last synced in the first format, finds the generation holds its library: only its base moves.
    transfer(a, b)
    assert b.status()["format"] == 1
    result = b.sync()
    assert result["status"] == "synced" and result["reloaded"] is False
    assert b.state()["base"] == generation["id"] and b.state()["format"] == 2
    # From here on a change travels in the new format.
    a.edit(identity, "second")
    assert a.sync()["status"] == "synced"
    transfer(a, b)
    assert b.check() == "pull"
    assert b.sync()["reloaded"] is True and b.note(identity) == "second"
    assert a.fingerprint() == b.fingerprint()


def test_a_pc_with_changes_when_the_folder_moved_is_offered_the_choice(synced):
    a, b, identity = synced
    b.edit(identity, "b's change")
    assert a.migrate()["migrated"] is True
    transfer(a, b)
    result = b.sync()
    assert result["status"] == "conflict" and [item["legacy"] for item in result["conflicts"]] == [False]
    heads = [item["id"] for item in result["conflicts"]]
    assert b.sync(choice="local", expected_heads=heads)["status"] == "synced"
    transfer(b, a)
    assert a.sync()["reloaded"] is True and a.note(identity) == "b's change"


def test_an_earlier_papeer_stops_at_the_marker(synced):
    a, b, identity = synced
    a.migrate()
    transfer(a, b)
    before = b.fingerprint()
    # Before anything is read or taken in, the automatic sync (in the background) as well.
    for background in (True, False):
        with pytest.raises(NewerSchemaError, match=f"新しいバージョンのPapeer（{__version__}）で作成されたため取り込めません"):
            b.old_sync(background=background)
    assert b.fingerprint() == before and b.note(identity) == "first"


def test_a_revision_an_earlier_papeer_published_is_offered_and_can_be_taken(synced):
    a, b, identity = synced
    a.migrate()
    transfer(a, b)
    b.edit(identity, "written on the old Papeer")
    result = b.old_sync()
    assert result["status"] == "conflict"
    [marker] = result["conflicts"]
    assert marker["diff"] is None  # Its archive holds no library.
    assert b.old_sync(choice="local", expected_heads=[marker["id"]])["status"] == "synced"
    revision = b.state()["base"]
    transfer(b, a)
    # The new Papeer offers it beside the generation, never taking it in unasked.
    assert a.check() == "quiet"
    result = a.sync()
    assert result["status"] == "conflict"
    offered = {item["id"]: item for item in result["conflicts"]}
    assert offered[revision]["legacy"] is True and offered[revision]["device"] == "PC-B"
    assert offered[revision]["diff"]["notes"] == 1
    assert "PC-B の古いバージョンのPapeerで保存された同期データがあります" in a.state()["error"]
    assert a.note(identity) == "first"
    result = a.sync(choice=revision, expected_heads=sorted(offered))
    assert result["status"] == "synced" and result["reloaded"] is True
    assert a.note(identity) == "written on the old Papeer"
    view = a.view()
    [head] = view.heads()
    assert revision in view.generations[head]["parents"]
    # a's library, which the choice left out, is kept in its history.
    assert result["set_aside"] and any(item["kind"] == "set_aside" for item in a.history())
    # A marker over the revision taken: an earlier Papeer stops again, and nothing is offered any more.
    assert all(drive_sync.is_marker(item) for item in first_format_heads(a))
    assert any(revision in item["parents"] for item in a.markers())
    assert a.sync()["status"] == "synced" and a.check() == "none"
    transfer(a, b)
    with pytest.raises(NewerSchemaError):
        b.old_sync()
    # Once updated, b goes on from the generation made over its revision without taking anything in.
    result = b.sync()
    assert result["status"] == "synced" and result["reloaded"] is False
    assert b.state()["base"] == head


def test_choosing_this_pc_over_an_earlier_papeer_s_revision_sets_it_aside(synced):
    a, b, identity = synced
    a.migrate()
    transfer(a, b)
    b.edit(identity, "old")
    marker = b.old_sync()["conflicts"][0]["id"]
    b.old_sync(choice="local", expected_heads=[marker])
    revision = b.state()["base"]
    transfer(b, a)
    ids = [item["id"] for item in a.sync()["conflicts"]]
    result = a.sync(choice="local", expected_heads=ids)
    assert result["status"] == "synced" and result["reloaded"] is False and not result["not_set_aside"]
    kept = [item for item in a.history() if item["kind"] == "set_aside"]
    assert [item.get("revision") for item in kept] == [revision]
    assert a.note(identity) == "first"
    assert a.sync()["status"] == "synced" and a.check() == "none"


def test_a_migration_stopped_while_writing_goes_on_at_the_next_sync(synced, monkeypatch):
    a, b, identity = synced
    supply = drive_sync_v2._supply
    calls = []

    def failing(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("the PC went off")
        return supply(*args, **kwargs)
    monkeypatch.setattr(drive_sync_v2, "_supply", failing)
    with pytest.raises(ValueError, match="同期フォルダーを読み書きできませんでした"):
        a.migrate()
    monkeypatch.setattr(drive_sync_v2, "_supply", supply)
    # Nothing of the new format stands yet: the folder is still in the first format, for both Papeers.
    assert not a.view().ids() and not a.markers() and a.formats()["format"] == 1
    assert a.status()["migration_pending"] and a.state()["error"]
    transfer(a, b)
    assert b.sync()["status"] == "synced" and b.state().get("format") != 2
    assert b.old_sync()["status"] == "synced"
    # The next sync goes on with the migration, unasked.
    assert a.check() == "quiet"
    result = a.sync()
    assert result["migrated"] is True and a.state()["format"] == 2 and not a.status()["migration_pending"]
    assert len(a.view().heads()) == 1 and len(a.markers()) == 1


def test_a_migration_stopped_before_its_marker(synced, monkeypatch):
    a, b, identity = synced
    write = drive_sync.FolderDrive.write_marker

    def failing(self, *args, **kwargs):
        raise OSError("the sync folder went offline")
    monkeypatch.setattr(drive_sync.FolderDrive, "write_marker", failing)
    with pytest.raises(ValueError):
        a.migrate()
    monkeypatch.setattr(drive_sync.FolderDrive, "write_marker", write)
    assert a.view().heads() and not a.markers() and a.status()["migration_pending"]
    # An earlier Papeer can still publish meanwhile: its revision is offered as a choice, not lost.
    transfer(a, b)
    b.edit(identity, "old, before the marker")
    assert b.old_sync()["status"] == "synced"
    revision = b.state()["base"]
    transfer(b, a)
    result = a.sync()
    assert result["status"] == "conflict"
    assert {item["id"]: item["legacy"] for item in result["conflicts"]}[revision] is True
    # The marker was put by that sync, over nothing the new format did not take over.
    [marker] = a.markers()
    assert marker["parents"] == [] and not a.status()["migration_pending"] and a.state()["format"] == 2
    ids = [item["id"] for item in result["conflicts"]]
    assert a.sync(choice=revision, expected_heads=ids)["reloaded"] is True
    assert a.note(identity) == "old, before the marker"


def test_a_migration_stopped_before_its_state(synced):
    """The generation and the marker are written, but this PC's state still says the first format."""
    a, b, identity = synced
    head = a.state()["base"]
    a.migrate()
    state = a.state()
    generation = state["base"]
    for key in ("format", "base_created"):
        state.pop(key)
    state.update(base=head, migration={"started": "2026-09-30T00:00:00+00:00"})
    with a:
        drive_sync.save_state(a.root, state)
    result = a.sync()
    assert result["status"] == "synced" and result["reloaded"] is False
    state = a.state()
    assert state["base"] == generation and state["format"] == 2 and "migration" not in state
    assert a.view().heads() == [generation] and len(a.markers()) == 1


def test_cancelling_a_migration_keeps_the_first_format(synced):
    a, b, identity = synced
    cancel = threading.Event()

    def progress(message: str) -> None:
        if message.startswith("同期フォルダーに書き込んでいます"):
            cancel.set()
    with pytest.raises(Cancelled):
        a.migrate(cancel=cancel, progress=progress)
    assert not a.view().ids() and not a.markers()
    assert not [path for path in a.drive.rglob("*") if path.is_file() and is_temporary(path)]
    assert a.state()["error"] is None and a.status()["migration_pending"]
    assert a.sync()["migrated"] is True


def test_two_pcs_migrating_at_once_with_the_same_library(synced):
    a, b, identity = synced
    assert a.migrate()["migrated"] is True
    assert b.migrate()["migrated"] is True
    transfer(a, b)
    transfer(b, a)
    # Two generations, both of the library both PCs hold: no choice to make.
    assert len(a.view().heads()) == 2 and len(a.markers()) == 2
    assert all(drive_sync.is_marker(item) for item in first_format_heads(a))
    assert a.sync()["status"] == "synced" and b.sync()["status"] == "synced"
    a.edit(identity, "after both moved")
    assert a.sync()["status"] == "synced"
    [head] = a.view().heads()
    transfer(a, b)
    assert b.sync()["reloaded"] is True and b.note(identity) == "after both moved"
    assert b.view().heads() == [head]


def test_two_pcs_migrating_at_once_with_different_libraries(synced):
    a, b, identity = synced
    a.edit(identity, "A")
    b.edit(identity, "B")
    assert a.migrate()["migrated"] is True
    assert b.migrate()["migrated"] is True
    transfer(a, b)
    transfer(b, a)
    result = a.sync()
    assert result["status"] == "conflict" and len(result["conflicts"]) == 2
    assert not any(item["legacy"] for item in result["conflicts"])
    theirs = next(item["id"] for item in result["conflicts"] if item["device"] == "PC-B")
    result = a.sync(choice=theirs, expected_heads=sorted(item["id"] for item in result["conflicts"]))
    assert result["reloaded"] is True and a.note(identity) == "B"
    # a's own library is in its history.
    assert any(item["kind"] == "set_aside" for item in a.history())
    transfer(a, b)
    assert b.sync()["status"] == "synced" and b.fingerprint() == a.fingerprint()


def test_a_marker_that_arrives_before_the_generation_is_waited_for(synced):
    a, b, identity = synced
    a.migrate()
    for rel in pending(a, b):
        if rel.endswith(".papeer-sync"):
            deliver(a, b, rel)
    result = b.sync()
    assert result["status"] == "waiting" and b.status()["waiting"]["device"] == "PC-A"
    # Nothing is known of what is still to come: no count is told ("残り 0 ファイル").
    assert b.status()["waiting"]["message"] == "PC-A のデータが届くのを待っています。"
    assert b.status()["error"] is None
    transfer(a, b)
    assert b.sync()["status"] == "synced" and b.state()["format"] == 2


def test_a_first_format_base_no_generation_names_is_compared_whole(synced):
    """A PC whose base of the first format no generation names (older than any lineage) is not left waiting."""
    a, b, identity = synced
    a.migrate()
    transfer(a, b)
    state = b.state()
    state["base"] = uuid.uuid4().hex
    with b:
        drive_sync.save_state(b.root, state)
    # The same library: only the base moves.
    assert b.sync()["status"] == "synced" and b.state()["base"] == a.state()["base"]
    state = b.state()
    state.update(base=uuid.uuid4().hex, format=None)
    with b:
        drive_sync.save_state(b.root, state)
    b.edit(identity, "changed")
    result = b.sync()
    assert result["status"] == "conflict"
    assert "同期の形式が新しくなったため" in b.state()["error"]


def test_a_first_format_revision_older_than_lineages_reach_is_taken_over_for_a_while(synced, monkeypatch):
    """The folder had not been used for over LINEAGE_DAYS when a moved it; a publishes once more. b, still on
    the old revision and without changes, takes a's library in rather than being asked to choose: the
    migration names the revisions it took over as of its own time."""
    a, b, identity = synced
    later = sync_store._now() + timedelta(days=70)
    monkeypatch.setattr(sync_store, "_now", lambda: later)
    assert a.migrate()["migrated"] is True
    a.edit(identity, "after moving")
    assert a.sync()["status"] == "synced"
    mirror(a, b)
    result = b.sync()
    assert result["status"] == "synced" and result["reloaded"] is True
    assert b.note(identity) == "after moving"


def test_the_migrating_pc_not_coming_back_before_its_marker_leaves_it_to_another(synced, monkeypatch):
    """a stopped after its generation, before the marker, and does not sync again: b puts the marker."""
    a, b, identity = synced

    def failing(self, *args, **kwargs):
        raise OSError("the sync folder went offline")
    with monkeypatch.context() as patch:
        patch.setattr(drive_sync.FolderDrive, "write_marker", failing)
        with pytest.raises(ValueError):
            a.migrate()
    transfer(a, b)
    assert not b.markers()
    assert b.sync()["status"] == "synced" and b.state()["format"] == 2
    [marker] = b.markers()
    assert marker["parents"] == [a.state()["base"]]
    assert all(drive_sync.is_marker(item) for item in first_format_heads(b))


def test_a_revision_published_just_after_settling_stops_the_migration(synced, monkeypatch):
    """Another PC's revision arrives between the sync that settles this PC and the migration: the migration
    waits for the next sync, which takes it in first, rather than moving the folder over it."""
    a, b, identity = synced
    b.edit(identity, "b's, just published")
    assert b.sync()["status"] == "synced"
    settle = drive_sync.sync

    def arriving(*args, **kwargs):
        result = settle(*args, **kwargs)
        transfer(b, a)
        return result
    with monkeypatch.context() as patch:
        patch.setattr(drive_sync, "sync", arriving)
        result = a.migrate()
    assert result["status"] == "synced" and result["migrated"] is False
    assert not a.view().ids() and a.status()["migration_pending"]
    result = a.sync()
    assert result["migrated"] is True and a.note(identity) == "b's, just published"
    [head] = a.view().heads()
    assert a.view().generations[head]["hash"] == a.fingerprint()


def test_a_generation_arriving_just_after_settling_is_followed(synced, monkeypatch):
    """b moved the folder, and its generation reaches a after a's sync settled but before a writes its own:
    a publishes none, and follows b's."""
    a, b, identity = synced
    assert b.migrate()["migrated"] is True
    [theirs] = b.view().heads()
    settle = drive_sync.sync

    def arriving(*args, **kwargs):
        result = settle(*args, **kwargs)
        for rel in pending(b, a):
            if rel.startswith("v2/"):
                deliver(b, a, rel)
        return result
    with monkeypatch.context() as patch:
        patch.setattr(drive_sync, "sync", arriving)
        result = a.migrate()
    assert result["migrated"] is False and a.view().heads() == [theirs]
    assert a.sync()["status"] == "synced"
    assert a.view().heads() == [theirs] and a.state()["base"] == theirs and a.state()["format"] == 2


def test_a_change_this_papeer_published_in_the_first_format_while_moving_is_not_called_old(synced):
    """b (this Papeer) has only format.json of the migration when it publishes its change, in the first format."""
    a, b, identity = synced
    b.edit(identity, "b, while moving")
    assert a.migrate()["migrated"] is True
    deliver(a, b, "v2/format.json")
    assert b.sync()["status"] == "synced" and b.state().get("format") != 2
    transfer(b, a)
    result = a.sync()
    assert result["status"] == "conflict"
    [offered] = [item for item in result["conflicts"] if item["legacy"]]
    assert offered["old_papeer"] is False and offered["device"] == "PC-B"
    error = a.state()["error"]
    assert "古いバージョン" not in error and "同期の形式を新しくしている途中に、PC-B で保存された変更があります" in error
    assert a.formats()["later"][0]["old_papeer"] is False
    ids = [item["id"] for item in result["conflicts"]]
    assert a.sync(choice=offered["id"], expected_heads=ids)["reloaded"] is True
    assert a.note(identity) == "b, while moving"


def test_a_renamed_pc_goes_on_repairing_what_it_published(synced):
    a, b, identity = synced
    a.migrate()
    a.edit(identity, "to repair")
    a.sync()
    identity_before = a.state()["device_id"]
    [head] = a.view().heads()
    victim = sorted(sync_store.blob_names(a.view().generations[head]))[0]
    (a.drive / "v2" / "blobs" / victim).unlink()
    a.name = "a2"  # macOS names itself after the network it is on.
    assert a.sync()["status"] == "synced"
    assert (a.drive / "v2" / "blobs" / victim).exists()
    assert a.state()["device_id"] == identity_before and a.state()["device_name"] == "PC-A2"
    # A copy of a's device folder on another machine is another PC.
    c_state = dict(a.state())
    c_state["device_machine"] = "someone else's"
    assert drive_sync_v2._device_id(c_state) != identity_before


def test_old_data_is_listed_and_removed_once_every_pc_moved(synced, tmp_path, monkeypatch):
    a, b, identity = synced
    count = len(a.revisions())
    a.migrate()
    formats = a.formats()
    assert formats["format"] == 2 and formats["removable"]["count"] == count and formats["removable"]["size"] > 0
    # b published in the first format lately and has not synced in the new one yet.
    assert formats["unmigrated"] == ["PC-B"] and not formats["ready"] and not formats["later"]
    transfer(a, b)
    b.sync()
    transfer(b, a)
    formats = a.formats()
    assert formats["unmigrated"] == [] and formats["ready"] is True
    with a:
        result = folder_sync.remove_old_data(a.root, formats["removable"]["ids"])
    assert result == {"removed": count, "size": formats["removable"]["size"], "failed": 0}
    # One marker is left, over nothing: an earlier Papeer still stops, with the message asking to update it.
    [marker] = drive_sync.FolderDrive(a.drive).revisions()
    assert drive_sync.is_marker(marker) and marker["parents"] == []
    assert a.formats()["removable"]["count"] == 0 and a.formats()["revisions"]["count"] == 0
    c = PC("c", tmp_path, monkeypatch)
    c.connect()
    mirror(a, c)
    result = c.old_sync()
    assert result["status"] == "conflict"
    with pytest.raises(NewerSchemaError):
        c.old_sync(choice=marker["id"], expected_heads=[marker["id"]])
    # The folder can still be chosen, and synced in the new format.
    a.connect()
    assert a.sync()["status"] == "synced"
    mirror(a, b)
    a.edit(identity, "after the clean-up")
    a.sync()
    transfer(a, b)
    assert b.sync()["reloaded"] is True and b.note(identity) == "after the clean-up"


def test_old_data_keeps_what_an_earlier_papeer_published(synced):
    a, b, identity = synced
    a.migrate()
    transfer(a, b)
    b.edit(identity, "old")
    marker = b.old_sync()["conflicts"][0]["id"]
    b.old_sync(choice="local", expected_heads=[marker])
    revision = b.state()["base"]
    transfer(b, a)
    formats = a.formats()
    assert [item["id"] for item in formats["later"]] == [revision] and not formats["ready"]
    assert revision not in formats["removable"]["ids"]
    with a:
        folder_sync.remove_old_data(a.root, formats["removable"]["ids"] + [revision])
    assert {item["id"] for item in a.revisions()} == {marker, revision}
    assert a.sync()["status"] == "conflict"


def test_old_data_is_not_removed_before_the_folder_moved(synced):
    a, b, identity = synced
    with a, pytest.raises(ValueError, match="まだ新しい形式に移っていません"):
        folder_sync.remove_old_data(a.root, [item["id"] for item in a.revisions()])
    assert a.formats()["removable"] == {"count": 0, "size": 0, "ids": []}


def test_the_api_moves_the_folder_and_removes_the_old_data(synced, monkeypatch):
    from fastapi.testclient import TestClient
    from sidecar import deps
    from sidecar.app import app
    from sidecar.jobs import JobManager

    a, b, identity = synced
    monkeypatch.setattr(deps, "get_data_dir", lambda: a.root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())

    def finished(client, job: str) -> dict:
        deadline = time.monotonic() + 30
        while deps.job_manager.get_job(job).running and time.monotonic() < deadline:
            time.sleep(0.02)
        info = client.get(f"/api/jobs/{job}").json()
        assert info["status"] == "succeeded", info
        return info["result"]
    with a, TestClient(app) as client:
        assert client.get("/api/drive").json()["format"] == 1
        assert client.get("/api/drive/format").json()["format"] == 1
        result = finished(client, client.post("/api/drive/migrate").json()["job_id"])
        assert result["status"] == "synced" and result["migrated"] is True
        status = client.get("/api/drive").json()
        assert status["format"] == 2 and status["migration_pending"] is False and status["waiting"] is None
        formats = client.get("/api/drive/format").json()
        assert formats["format"] == 2 and formats["removable"]["count"] > 0
        assert finished(client, client.post("/api/drive/sync", json={}).json()["job_id"])["status"] == "synced"
        assert client.get("/api/drive/check").json()["action"] == "none"
        removed = client.post("/api/drive/legacy/remove", json={"ids": formats["removable"]["ids"]}).json()
        assert removed["removed"] == formats["removable"]["count"] and removed["failed"] == 0
        assert client.get("/api/drive/format").json()["revisions"]["count"] == 0


@pytest.mark.parametrize("closing", [False, True])
def test_stopping_a_migration_gives_it_up_unless_the_app_is_closing(synced, monkeypatch, closing):
    """The user's 中止 gives the migration up (the next sync does not take it up unasked); the app closing
    (cancel-all, as AppShell does) leaves it to go on."""
    from fastapi.testclient import TestClient
    from sidecar import deps
    from sidecar.app import app
    from sidecar.jobs import JobManager

    a, b, identity = synced
    monkeypatch.setattr(deps, "get_data_dir", lambda: a.root)
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr(deps, "job_manager", JobManager())
    started = threading.Event()

    def publish(*args, cancel, **kwargs):
        started.set()
        cancel.wait(10)
        raise Cancelled("stopped")
    with a, TestClient(app) as client, monkeypatch.context() as patch:
        patch.setattr(drive_sync_v2, "_publish", publish)
        job = client.post("/api/drive/migrate").json()["job_id"]
        assert started.wait(30)
        client.post("/api/jobs/cancel-all" if closing else f"/api/jobs/{job}/cancel")
        deadline = time.monotonic() + 30
        while deps.job_manager.get_job(job).running and time.monotonic() < deadline:
            time.sleep(0.02)
        assert client.get(f"/api/jobs/{job}").json()["status"] == "cancelled"
        assert client.get("/api/drive").json()["migration_pending"] is closing
    assert a.state()["error"] is None and not a.view().ids()
    result = a.sync()
    if closing:
        assert result["migrated"] is True and a.state()["format"] == 2
    else:
        # A sync of the first format, as before the user asked; asked again, the migration runs.
        assert "migrated" not in result and not a.view().ids() and a.status()["format"] == 1
        assert a.migrate()["migrated"] is True


def test_an_empty_folder_chosen_in_the_settings_starts_in_the_new_format(tmp_path, monkeypatch):
    """folder_sync.connect (the settings): the first sync in an empty folder moves it without asking, and puts
    a marker stopping an earlier Papeer; the user's 中止 of that sync does not undo it."""
    monkeypatch.setattr(drive_sync, "_now_ns", lambda: time.time_ns() + 10 * drive_sync.RACY_NS)
    a, b = PC("a", tmp_path, monkeypatch), PC("b", tmp_path, monkeypatch)
    with a as lib:
        folder_sync.connect(a.root, str(a.drive))
        identity, _ = lib.import_pdf(SAMPLE)
    # Not told as a migration the user asked for; stopped, it goes on all the same.
    assert "migration" in a.state() and a.status()["migration_pending"] is False
    with a:
        folder_sync.abandon_migration(a.root)
    assert "migration" in a.state()
    result = a.sync()
    assert result["status"] == "synced" and result["migrated"] is True
    state = a.state()
    assert state["format"] == 2 and "migration" not in state
    [marker] = a.markers()
    assert marker["parents"] == [] and [item["id"] for item in a.revisions()] == [marker["id"]]
    formats = a.formats()
    assert formats["format"] == 2 and formats["revisions"]["count"] == 0 and not formats["ready"]
    # Another PC choosing the same folder (in its copy, not arrived yet) follows it once it arrives.
    with b:
        folder_sync.connect(b.root, str(b.drive))
    transfer(a, b)
    result = b.sync()
    assert result["status"] == "conflict" and "migration" not in b.state()
    heads = [item["id"] for item in result["conflicts"]]
    assert b.sync(choice=heads[0], expected_heads=heads)["reloaded"] is True
    assert b.fingerprint() == a.fingerprint() and b.state()["format"] == 2


def test_a_folder_chosen_empty_where_an_earlier_papeer_published_first_asks_before_moving(tmp_path, monkeypatch):
    monkeypatch.setattr(drive_sync, "_now_ns", lambda: time.time_ns() + 10 * drive_sync.RACY_NS)
    a, b = PC("a", tmp_path, monkeypatch), PC("b", tmp_path, monkeypatch)
    with a:
        folder_sync.connect(a.root, str(a.drive))
    b.connect()
    with b as lib:
        lib.import_pdf(SAMPLE)
    assert b.old_sync()["status"] == "synced"
    transfer(b, a)
    result = a.sync()
    assert "migrated" not in result and a.status()["format"] == 1 and not a.status()["migration_pending"]
    assert not a.view().ids() and not a.markers()


def test_a_device_folder_brought_from_another_pc_gets_its_own_id(monkeypatch):
    monkeypatch.setattr(platform, "node", lambda: "PC-B")
    monkeypatch.setattr(drive_sync_v2, "machine_key", lambda: "machine-b")
    # Brought from another machine: a new ID, whatever the name says.
    state = {"device_id": "a" * 32, "device_name": "PC-B", "device_machine": "machine-a"}
    assert drive_sync_v2._device_id(state) != "a" * 32
    assert state["device_machine"] == "machine-b" and state["device_created"]
    identity = state["device_id"]
    assert drive_sync_v2._device_id(state) == identity
    # Renamed on the same machine: the same ID.
    state["device_name"] = "PC-B-OLD"
    assert drive_sync_v2._device_id(state) == identity and state["device_name"] == "PC-B"
    # A state from before the machine was recorded keeps its ID, and records the machine.
    older = {"device_id": "b" * 32, "device_name": "PC-A"}
    assert drive_sync_v2._device_id(older) == "b" * 32 and older["device_machine"] == "machine-b"
    # When the machine cannot be told, the name tells instead.
    monkeypatch.setattr(drive_sync_v2, "machine_key", lambda: None)
    assert drive_sync_v2._device_id({"device_id": "c" * 32, "device_name": "PC-A"}) != "c" * 32
    assert drive_sync_v2._device_id({"device_id": "c" * 32, "device_name": "PC-B"}) == "c" * 32


def test_starting_a_new_library_forgets_the_new_format_s_state(tmp_path, monkeypatch):
    point_pc_folders(monkeypatch.setenv, tmp_path / "pc")
    root = tmp_path / "library"
    root.mkdir()
    drive_sync.save_state(root, {"connected": True, "folder": str(tmp_path), "base": "a" * 32, "hash": "h",
                                 "base_created": "x", "waiting": {}, "bad_blobs": ["b"], "checked_blobs": {},
                                 "gc_last": "x", "migration": {}, "device_id": "c" * 32, "format": 2})
    drive_sync.start_new_library(root)
    state = drive_sync.read_state(root)
    assert not {"base", "hash", "base_created", "waiting", "bad_blobs", "checked_blobs", "gc_last",
                "migration"} & set(state)
    assert state["device_id"] == "c" * 32


@pytest.mark.slow
@pytest.mark.parametrize("seed", range(12))
def test_a_migration_arriving_in_any_order(synced, seed):
    """Whatever order the migration's files reach b in, b syncing after each one never fails nor loses its
    library, takes in nothing but a's, and ends on a's generation (b with changes: offered a choice)."""
    a, b, identity = synced
    rng = random.Random(seed)
    changed = seed % 2 == 1
    if changed:
        b.edit(identity, "b's own")
    a.edit(identity, "a's, moved")
    a.migrate()
    files = pending(a, b)
    rng.shuffle(files)
    for rel in files:
        deliver(a, b, rel)
        result = b.sync()
        assert result["status"] in ("synced", "waiting", "conflict"), result
        note = b.note(identity)
        assert note in (("b's own",) if changed else ("first", "a's, moved"))
        if result["status"] == "conflict":
            assert changed
    result = b.sync()
    if changed:
        assert result["status"] == "conflict"
        ids = [item["id"] for item in result["conflicts"]]
        mine = b.fingerprint()
        assert b.sync(choice="local", expected_heads=ids)["status"] == "synced"
        assert b.fingerprint() == mine and b.state()["format"] == 2
    else:
        assert result["status"] == "synced"
        assert b.note(identity) == "a's, moved" and b.fingerprint() == a.fingerprint()
        assert b.state()["base"] == a.state()["base"]


# --- An earlier Papeer itself (b0b0280, before the history and the new format), run in its own process ---

OLD_COMMIT = "b0b0280"
OLD_SCRIPT = r'''
import json, os, platform, sys, threading
from pathlib import Path

old, phase, root, drive, place, name = sys.argv[1:7]
sys.path.insert(0, old)
for variable in ("LOCALAPPDATA", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
    os.environ[variable] = place
platform.node = lambda: name

from papeer.core import drive_sync
from papeer.core.storage import Library

assert Path(drive_sync.__file__).is_relative_to(old), drive_sync.__file__
root, drive = Path(root), Path(drive)
cancel = threading.Event()


def sync(**options):
    return drive_sync.sync(Library(root), drive_sync.FolderDrive(drive), cancel, lambda _: None, **options)


if phase == "join":
    drive_sync.connect(root, str(drive))
    heads = [item["id"] for item in sync()["conflicts"]]
    result = sync(choice=heads[0], expected_heads=heads)
elif phase == "keep_mine":
    identity = sys.argv[7]
    Library(root).update(identity, note="written on the earlier Papeer")
    heads = [item["id"] for item in sync()["conflicts"]]
    result = sync(choice="local", expected_heads=heads)
folder = drive_sync.side_backup_folder(root)
print(json.dumps({"status": result["status"], "base": drive_sync.read_state(root)["base"],
                  "side_backups": sorted(path.name for path in folder.glob("*.zip")) if folder.is_dir() else []}))
'''


@pytest.fixture(scope="module")
def earlier_papeer(tmp_path_factory) -> Path:
    """The papeer package of OLD_COMMIT, taken out of this repository (skipped where the clone lacks it)."""
    import io
    import subprocess
    import tarfile
    target = tmp_path_factory.mktemp("earlier-papeer")
    try:
        archive = subprocess.run(["git", "-C", str(Path(__file__).resolve().parents[1]), "archive", OLD_COMMIT,
                                  "papeer"], capture_output=True, check=True, timeout=120).stdout
    except (OSError, subprocess.SubprocessError):
        pytest.skip(f"{OLD_COMMIT} is not in this clone")
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(target, filter="data")
    (target / "run_old.py").write_text(OLD_SCRIPT, "utf-8")
    return target


def run_earlier(old: Path, pc: PC, phase: str, *extra: str) -> dict:
    import json
    import subprocess
    completed = subprocess.run([sys.executable, str(old / "run_old.py"), str(old), phase, str(pc.root),
                                str(pc.drive), str(pc.place / "earlier"), f"PC-{pc.name.upper()}", *extra],
                               capture_output=True, text=True, encoding="utf-8", cwd=old, timeout=300,
                               env={key: value for key, value in os.environ.items() if key != "PYTHONPATH"})
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout.strip().splitlines()[-1])


@pytest.mark.slow
def test_the_earlier_papeer_itself_keeps_no_side_backup_of_the_marker(earlier_papeer, tmp_path, monkeypatch):
    """b0b0280, choosing its own library over the marker, keeps no side backup of it (the marker holds no
    paper): an empty one would push out one of the side backups it keeps (at most 3). Its revision is then
    offered by this Papeer as one an earlier Papeer published."""
    monkeypatch.setattr(drive_sync, "_now_ns", lambda: time.time_ns() + 10 * drive_sync.RACY_NS)
    a, b = PC("a", tmp_path, monkeypatch), PC("b", tmp_path, monkeypatch)
    a.connect()
    with a as lib:
        identity, _ = lib.import_pdf(SAMPLE)
    assert a.sync()["status"] == "synced"
    transfer(a, b)
    joined = run_earlier(earlier_papeer, b, "join")
    assert joined["status"] == "synced" and joined["side_backups"] == []
    transfer(b, a)
    assert a.sync()["status"] == "synced"
    assert a.migrate()["migrated"] is True
    transfer(a, b)
    kept = run_earlier(earlier_papeer, b, "keep_mine", identity)
    assert kept["status"] == "synced" and kept["side_backups"] == []
    transfer(b, a)
    result = a.sync()
    assert result["status"] == "conflict"
    [offered] = [item for item in result["conflicts"] if item["legacy"]]
    assert offered["id"] == kept["base"] and offered["old_papeer"] is True and offered["diff"]["notes"] == 1
