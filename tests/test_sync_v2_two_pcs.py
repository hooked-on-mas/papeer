"""Two PCs syncing in the new format (drive_sync_v2) through folders a stand-in for Google Drive copies between.

The stand-in delivers the files one PC wrote to the other's folder when asked: all of them, only some
(a generation before its blobs, or the other way round), or one at a time in a random order. Each PC has
its own device folder (LOCALAPPDATA), so its own sync state and history.
"""
from __future__ import annotations

from datetime import timedelta
import gzip
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import threading
import time
import uuid
import zlib

import pymupdf
import pytest

from papeer.core import drive_sync, drive_sync_v2 as v2, local_history, sync_store
from papeer.core.fileio import is_temporary
from papeer.core.storage import Library
from papeer.core.sync_store import GenerationStore
from papeer.providers import Cancelled

SAMPLE = Path(__file__).parent / "fixtures/sample.pdf"


class PC:
    """One PC: its library, its device folder (LOCALAPPDATA) and its copy of the sync folder."""

    def __init__(self, name: str, tmp_path: Path, monkeypatch):
        self.name, self.monkeypatch = name, monkeypatch
        self.device = tmp_path / f"{name}-device"
        self.drive = tmp_path / f"{name}-drive"
        self.root = tmp_path / name / "library"
        self.drive.mkdir()
        self.known: set[str] = set()
        # What this PC's clean-up removed from its sync folder, with the size and time each had:
        # Google Drive removes the same file (that version of it) from the other PCs' folders.
        self.removed: dict[str, tuple[int, int]] = {}
        # With by_file, a removal takes the file of that name whatever version the other folder holds (the
        # harsher way Google Drive may deliver one); removals_done: those that reached this PC's folder.
        self.by_file = False
        self.removals_done: set[tuple[str, tuple[int, int]]] = set()

    def __enter__(self) -> Library:
        self.monkeypatch.setenv("LOCALAPPDATA", str(self.device))
        return Library(self.root)

    def __exit__(self, *_exc):
        return False

    def connect(self):
        with self:
            drive_sync.connect(self.root, str(self.drive))
            GenerationStore.initialize(self.drive)

    def store(self) -> GenerationStore:
        return GenerationStore(self.drive)

    def sync(self, cancel=None, **kwargs) -> dict:
        with self as lib:
            return v2.sync(lib, self.store(), cancel or threading.Event(), lambda _: None, **kwargs)

    def check(self) -> str:
        with self:
            return v2.check(self.root, self.store())["action"]

    def state(self) -> dict:
        with self:
            return drive_sync.read_state(self.root)

    def history(self) -> list[dict]:
        with self:
            return local_history.entries(self.root)

    def fingerprint(self) -> str:
        with self as lib:
            return drive_sync.fingerprint(lib)

    def note(self, identity: str) -> str:
        with self as lib:
            return lib.paper(identity)["note"]

    def edit(self, identity: str, *, note: str | None = None, article: str | None = None) -> None:
        with self as lib:
            if article is not None:
                (lib.folder(identity) / "article.md").write_text(article, "utf-8")
            if note is not None:
                lib.update(identity, note=note)

    def files(self, place: str) -> set[str]:
        folder = self.drive / "v2" / place
        return {path.name for path in folder.iterdir() if not is_temporary(path)}

    def leftovers(self) -> list[str]:
        """What lies beside the library that was not there when the test began (see pcs)."""
        return sorted(path.name for path in self.root.parent.iterdir()
                      if path.name != self.root.name and path.name not in self.known)


# The order pending() lists files in: by kind, then in the order they were written. Names are digests and
# random IDs, which differ from one run to the next; this order does not, so a seed gives the same run.
KINDS = ("blobs", "gens", "devices", "format.json")


def pending(source: PC, target: PC) -> list[str]:
    """What of source's sync folder has not reached target's, as paths below "v2": the files target lacks or
    holds otherwise, and, marked "-", those source's clean-up removed that target still holds as they were."""
    result = []
    base = source.drive / "v2"
    for path in base.rglob("*"):
        if not path.is_file() or is_temporary(path):
            continue
        rel = path.relative_to(base).as_posix()
        other = target.drive / "v2" / rel
        if not other.exists() or other.read_bytes() != path.read_bytes():
            # Not the version target's clean-up removed: Google Drive removed that one everywhere.
            if target.removed.get(rel) != _version(path):
                result.append((KINDS.index(rel.split("/")[0]), path.stat().st_mtime_ns, rel))
    for rel, version in source.removed.items():
        other = target.drive / "v2" / rel
        if source.by_file:
            if (rel, version) not in target.removals_done and other.exists():
                result.append((KINDS.index(rel.split("/")[0]), version[1], "-" + rel))
        elif not (base / rel).exists() and other.exists() and _version(other) == version:
            result.append((KINDS.index(rel.split("/")[0]), version[1], "-" + rel))
    return [rel for _kind, _time, rel in sorted(result)]


def _version(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


def deliver(source: PC, target: PC, rel: str) -> None:
    """One file arrives whole (Google Drive for desktop shows a file only once it is downloaded), or one
    removal ("-" and the path): the version of the file source removed goes from target's folder."""
    if rel.startswith("-"):
        path = target.drive / "v2" / rel[1:]
        version = source.removed.get(rel[1:])
        if source.by_file:
            target.removals_done.add((rel[1:], version))
            path.unlink(missing_ok=True)
        elif path.exists() and _version(path) == version:
            path.unlink()
        return
    origin = source.drive / "v2" / rel
    if not origin.exists():
        return  # Removed since by source's clean-up.
    destination = target.drive / "v2" / rel
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    shutil.copy2(origin, temporary)
    os.replace(temporary, destination)


def transfer(source: PC, target: PC, *, only=lambda rel: True) -> list[str]:
    moved = [rel for rel in pending(source, target) if only(rel)]
    for rel in moved:
        deliver(source, target, rel)
    return moved


def remove(pc: PC, rel: str) -> None:
    (pc.drive / "v2" / rel).unlink()


def is_blob(rel: str) -> bool:
    return rel.lstrip("-").startswith("blobs/")


@pytest.fixture
def pcs(tmp_path, monkeypatch):
    # Files are recorded for the check at once, as if written long before (drive_sync.RACY_NS).
    monkeypatch.setattr(drive_sync, "_now_ns", lambda: time.time_ns() + 10 * drive_sync.RACY_NS)
    a, b = PC("a", tmp_path, monkeypatch), PC("b", tmp_path, monkeypatch)
    unlink = sync_store.Cleaner._unlink

    def logged(self, path):
        for pc in (a, b):
            if path.is_relative_to(pc.drive) and path.exists():
                pc.removed[path.relative_to(pc.drive / "v2").as_posix()] = _version(path)
        unlink(self, path)

    monkeypatch.setattr(sync_store.Cleaner, "_unlink", logged)
    a.connect()
    b.connect()
    with a as lib:
        identity, _ = lib.import_pdf(SAMPLE)
        (lib.folder(identity) / "article.md").write_text("summary one", "utf-8")
    assert a.sync()["status"] == "synced"
    transfer(a, b)
    # b has never synced: it chooses the sync folder's library (as with the first format).
    result = b.sync()
    assert result["status"] == "conflict"
    head = result["conflicts"][0]["id"]
    assert b.sync(choice=head, expected_heads=[head])["reloaded"] is True
    transfer(b, a)
    # The generation b made over a's holds a's library: only a's base moves.
    assert a.sync() == {"status": "synced", "reloaded": False, "previous_path": None}
    assert a.state()["base"] == b.state()["base"]
    # b's history was empty, so the (empty) library it replaced stays beside it, as with the first format.
    assert len(b.leftovers()) == 1
    for pc in (a, b):
        pc.known = set(pc.leftovers())
    return a, b, identity


def heads(pc: PC) -> list[str]:
    return pc.store().view().heads()


def test_a_change_travels_as_the_blobs_it_changed(pcs):
    a, b, identity = pcs
    blobs = a.files("blobs")
    pdfs = {name for name in blobs if not name.endswith(".z")}
    a.edit(identity, note="読書メモ")
    assert a.sync()["status"] == "synced"
    # Only database chunks were written: the PDF and the other files are there already.
    new = a.files("blobs") - blobs
    assert new and all(name.endswith(".z") for name in new) and pdfs <= a.files("blobs")
    moved = transfer(a, b)
    assert sum(is_blob(rel) for rel in moved) == len(new)
    result = b.sync()
    assert result["reloaded"] is True and result["previous_path"] is None
    assert b.note(identity) == "読書メモ" and a.fingerprint() == b.fingerprint()
    assert b.leftovers() == []
    # Nothing more to do on either side: no new generation.
    gens = a.files("gens")
    assert b.sync()["reloaded"] is False
    transfer(b, a)
    assert a.sync()["reloaded"] is False and not a.files("gens") - gens
    assert a.check() == "none" and b.check() == "none"
    # Both PCs are on the head, so the clean-up left only it; its lineage names those it took over.
    generations = a.store().view().generations
    head = generations[heads(a)[0]]
    assert set(generations) == {head["id"]} and len(head["lineage"]) >= 2


def test_a_generation_that_arrives_before_its_blobs_is_waited_for(pcs):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    a.sync()
    transfer(a, b, only=lambda rel: not is_blob(rel))
    result = b.sync()
    assert result["status"] == "waiting"
    waiting = result["waiting"]
    assert waiting["reason"] == "arrival" and waiting["missing"] > 0 and "残り" in waiting["message"]
    assert not waiting["overdue"] and result["heads"] == heads(b)
    # Nothing was taken in, and it is not an error.
    assert b.note(identity) == "" and b.state()["error"] is None
    with b:
        assert v2.status(b.root)["waiting"]["reason"] == "arrival"
    # The check does not start the same wait again.
    assert b.check() == "none"
    transfer(a, b)
    assert b.check() == "pull"
    assert b.sync()["reloaded"] is True and b.note(identity) == "second"
    assert b.state()["waiting"] is None


def test_blobs_that_arrive_before_their_generation_change_nothing(pcs):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    a.sync()
    transfer(a, b, only=is_blob)
    result = b.sync()
    assert result["status"] == "synced" and result["reloaded"] is False
    transfer(a, b)
    assert b.sync()["reloaded"] is True and b.note(identity) == "second"


def test_a_wait_that_lasts_a_day_tells_to_look_at_the_other_pc(pcs, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, article="summary two")
    a.sync()
    transfer(a, b, only=lambda rel: not is_blob(rel))
    assert b.sync()["status"] == "waiting"
    later = sync_store._now() + timedelta(hours=25)
    monkeypatch.setattr(sync_store, "_now", lambda: later)
    result = b.sync()
    waiting = result["waiting"]
    assert waiting["overdue"] and "24時間以上" in waiting["message"] and "このPCのデータで続ける" in waiting["message"]
    # Going on without waiting: this PC's library is published over the head it could not read whole,
    # which is told as not set aside.
    b.edit(identity, note="b goes on")
    resumed = b.sync(choice="local", expected_heads=result["heads"])
    assert resumed["status"] == "synced" and [item["id"] for item in resumed["not_set_aside"]] == result["heads"]
    assert heads(b) != result["heads"] and b.state()["waiting"] is None


def test_a_missing_blob_is_written_again_by_the_pc_whose_generation_uses_it(pcs):
    a, b, identity = pcs
    a.edit(identity, article="summary two")
    a.sync()
    transfer(a, b)
    name = local_history.blob_name(hashlib.sha256(b"summary two").hexdigest(), True)
    for pc in (a, b):
        remove(pc, "blobs/" + name)  # Lost from Google Drive.
    result = b.sync()
    assert result["status"] == "waiting" and result["waiting"]["missing"] == 1
    # a's next sync finds its own head lacking it, and writes it from its history.
    assert a.check() == "quiet"
    assert a.sync()["status"] == "synced"
    assert name in a.files("blobs")
    transfer(a, b)
    assert b.sync()["reloaded"] is True
    with b as lib:
        assert (lib.folder(identity) / "article.md").read_text("utf-8") == "summary two"


def test_a_damaged_blob_is_reported_and_written_again(pcs):
    a, b, identity = pcs
    a.edit(identity, article="summary two")
    a.sync()
    transfer(a, b)
    name = local_history.blob_name(hashlib.sha256(b"summary two").hexdigest(), True)
    for pc in (a, b):
        (pc.drive / "v2" / "blobs" / name).write_bytes(zlib.compress(b"garbage"))
    result = b.sync()
    assert result["status"] == "waiting" and result["waiting"]["reason"] == "damaged"
    assert article(b, identity) == "summary one"  # Nothing damaged was taken in.
    device = b.store().view().devices[b.state()["device_id"]]
    assert device["bad_blobs"] == [name]
    assert b.check() == "none"
    transfer(b, a)
    assert a.sync()["status"] == "synced"  # Reads its copy, finds it damaged, writes it again.
    transfer(a, b)
    assert b.check() == "quiet"
    assert b.sync()["reloaded"] is True and article(b, identity) == "summary two"
    transfer(b, a)
    assert a.store().view().devices[b.state()["device_id"]]["bad_blobs"] == []


def article(pc: PC, identity: str) -> str:
    return (pc.root / "papers" / identity / "article.md").read_text("utf-8")


def test_both_pcs_publishing_at_once_offer_a_choice_that_keeps_the_other_side(pcs, tmp_path):
    a, b, identity = pcs
    a.edit(identity, note="from a")
    b.edit(identity, note="from b")
    assert a.sync()["status"] == "synced"
    assert b.sync()["status"] == "synced"
    transfer(a, b)
    transfer(b, a)
    result = a.sync()
    assert result["status"] == "conflict" and len(result["conflicts"]) == 2
    ids = [item["id"] for item in result["conflicts"]]
    other = next(item for item in result["conflicts"] if item["device"] and item["diff"] and item["diff"]["notes"])
    assert other["diff"]["notes"] == 1
    chosen = a.sync(choice="local", expected_heads=ids)
    assert chosen["status"] == "synced" and len(chosen["set_aside"]) == 1 and chosen["not_set_aside"] == []
    kept = next(entry for entry in a.history() if entry["kind"] == "set_aside")
    with a:
        local_history.materialize(a.root, kept["id"], tmp_path / "kept")
        assert Library(tmp_path / "kept").paper(identity)["note"] == "from b"
    # The merge takes over both heads.
    generation = a.store().view().generations[heads(a)[0]]
    assert sorted(generation["parents"]) == sorted(ids)
    transfer(a, b)
    assert b.sync()["reloaded"] is True and b.note(identity) == "from a"


def test_heads_that_all_hold_this_library_are_synced(pcs):
    """Two PCs that published the same contents at once (both migrating, say) leave two heads alike."""
    a, b, identity = pcs
    a.edit(identity, note="same")
    a.sync()
    transfer(a, b)
    b.sync()
    view = b.store().view()
    head = view.generations[heads(b)[0]]
    twin = {**head, "id": uuid.uuid4().hex, "device_id": uuid.uuid4().hex, "device": "other"}
    for pc in (a, b):
        pc.store().write_generation(twin)
    assert len(heads(b)) == 2
    assert b.sync() == {"status": "synced", "reloaded": False, "previous_path": None}
    assert b.check() == "none"
    # The next change takes over both.
    b.edit(identity, note="after")
    b.sync()
    assert len(heads(b)) == 1


def test_a_base_removed_from_the_folder_is_known_as_taken_over(pcs):
    a, b, identity = pcs
    base = b.state()["base"]
    # The check trusts only the records of a sync made on the library as it is (not the one b took in).
    assert b.sync()["reloaded"] is False
    a.edit(identity, note="second")
    a.sync()
    transfer(a, b)
    # The clean-up of a later stage removes what the head takes over (here by hand, on both).
    for pc in (a, b):
        for name in pc.files("gens"):
            if name[:-4] not in heads(pc):
                remove(pc, "gens/" + name)
    assert b.store().view().base_status(base) == "inherited"
    assert b.check() == "pull"
    assert b.sync()["reloaded"] is True and b.note(identity) == "second"


def test_a_base_that_has_not_arrived_is_waited_for(pcs):
    a, b, identity = pcs
    a.edit(identity, note="second")
    a.sync()
    # The removal of the old generations reaches b before the generation that takes them over.
    for name in b.files("gens"):
        remove(b, "gens/" + name)
    result = b.sync()
    assert result["status"] == "waiting" and result["waiting"]["reason"] == "base"
    assert b.check() == "none"
    transfer(a, b)
    assert b.sync()["reloaded"] is True and b.note(identity) == "second"


def test_a_base_older_than_any_lineage_compares_the_libraries_whole(pcs, monkeypatch):
    a, b, identity = pcs
    start = sync_store._now()
    clock = {"now": start}
    monkeypatch.setattr(sync_store, "_now", lambda: clock["now"])
    clock["now"] = start + timedelta(days=1)
    a.edit(identity, note="second")
    a.sync()
    # b has not synced for 62 days: its base is no longer kept, and a's clean-up removes it.
    clock["now"] = start + timedelta(days=62)
    a.edit(identity, note="third")
    a.sync()
    assert b.state()["base"] + ".gen" not in a.files("gens")
    # Still named in the lineage of the generation made while it was in the folder, but not in the next.
    clock["now"] = start + timedelta(days=63)
    a.edit(identity, note="fourth")
    a.sync()
    head = a.store().view().generations[heads(a)[0]]
    assert b.state()["base"] not in {identity for identity, _time in head["lineage"]}
    # Only the newest generation is left (the clean-up removed the rest).
    for pc in (a, b):
        for name in pc.files("gens"):
            if name != head["id"] + ".gen":
                remove(pc, "gens/" + name)
    deliver(a, b, "gens/" + head["id"] + ".gen")
    transfer(a, b, only=is_blob)
    # b did not change, but its base is too old to know the head descends from it: it is asked.
    result = b.sync()
    assert result["status"] == "conflict" and b.note(identity) == ""
    assert "長い期間" in b.state()["error"]
    assert b.sync(choice=head["id"], expected_heads=[head["id"]])["reloaded"] is True
    assert b.note(identity) == "fourth"


def test_emptying_the_library_asks_on_both_pcs_and_an_automatic_sync_takes_nothing_in(pcs):
    a, b, identity = pcs
    with a as lib:
        lib.delete_paper(identity)
    gens = a.files("gens")
    result = a.sync()
    assert result["status"] == "review" and result["review"]["reason"] == "shrunk" and a.files("gens") == gens
    assert a.sync(confirm=True)["status"] == "synced"
    transfer(a, b)
    # An automatic sync leaves taking in to a sync with the waiting screen.
    assert b.sync(background=True)["status"] == "deferred" and b.note(identity) == ""
    result = b.sync()
    assert result["status"] == "review" and result["review"]["reason"] == "remote_shrunk"
    assert b.sync(confirm=True)["reloaded"] is True
    with b as lib:
        assert lib.papers() == []


# --- Reading that fails for a moment, and blobs reported damaged ---

def test_a_blob_that_cannot_be_read_for_a_moment_is_tried_again_not_reported(pcs, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, article="summary two")
    a.sync()
    transfer(a, b)
    name = local_history.blob_name(hashlib.sha256(b"summary two").hexdigest(), True)
    original = local_history.stored_content

    def offline(path, cancel=None, limit=None, **kwargs):
        if path.name == name and path.is_relative_to(b.drive):
            raise local_history.SourceUnreadable() from OSError("Google Drive is offline for a moment")
        return original(path, cancel, limit, **kwargs)

    monkeypatch.setattr(local_history, "stored_content", offline)
    result = b.sync()
    # Waited for as a blob still arriving: nothing reported damaged, nothing taken in.
    assert result["status"] == "waiting" and result["waiting"]["reason"] == "arrival"
    assert b.state()["bad_blobs"] == [] and article(b, identity) == "summary one"
    assert b.store().view().devices[b.state()["device_id"]]["bad_blobs"] == []
    monkeypatch.setattr(local_history, "stored_content", original)
    # The automatic check tries again, and the sync takes it in.
    assert b.check() == "pull"
    assert b.sync()["reloaded"] is True and article(b, identity) == "summary two"


def test_a_blob_of_the_history_is_moved_aside_only_when_damaged(pcs, monkeypatch, tmp_path):
    _a, b, _identity = pcs
    with b:
        folder = local_history.history_directory(b.root)
    name = local_history.blob_name(hashlib.sha256(b"summary one").hexdigest(), True)
    view = sync_store.View()  # Nothing in the sync folder: the history is the only source.
    original = local_history.stored_content

    def held(path, cancel=None, limit=None, **kwargs):
        if path.parent == folder / "blobs":
            raise local_history.SourceUnreadable() from PermissionError("held by a virus scan")
        return original(path, cancel, limit, **kwargs)

    with b:
        sources = v2._Sources(b.root, b.store(), view, {}, None)
        monkeypatch.setattr(local_history, "stored_content", held)
        with (tmp_path / "out").open("w+b") as output:
            assert sources.write(output, name, 11, 11) == "missing"
        assert (folder / "blobs" / name).exists() and not (folder / "damaged").exists()
        monkeypatch.setattr(local_history, "stored_content", original)
        with (tmp_path / "out").open("w+b") as output:
            assert sources.write(output, name, 11, 11) == "ok"
        # Damaged content is moved aside.
        (folder / "blobs" / name).write_bytes(zlib.compress(b"garbage"))
        with (tmp_path / "out").open("w+b") as output:
            assert sources.write(output, name, 11, 11) == "missing"
        assert not (folder / "blobs" / name).exists() and (folder / "damaged" / name).exists()


def test_publishing_over_a_history_blob_held_for_a_moment_writes_it_from_the_library(pcs, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    name = local_history.blob_name(hashlib.sha256(b"summary two").hexdigest(), True)
    copy_blob = local_history.copy_blob

    def held(source, *args, **kwargs):
        if source.name == name:
            raise local_history.SourceUnreadable() from PermissionError("held by a virus scan")
        return copy_blob(source, *args, **kwargs)

    monkeypatch.setattr(local_history, "copy_blob", held)
    assert a.sync()["status"] == "synced" and name in a.files("blobs")
    with a:
        folder = local_history.history_directory(a.root)
    assert (folder / "blobs" / name).exists() and not (folder / "damaged").exists()
    monkeypatch.setattr(local_history, "copy_blob", copy_blob)
    transfer(a, b)
    assert b.sync()["reloaded"] is True and article(b, identity) == "summary two"


def reads_of_the_sync_folder(pc: PC, monkeypatch) -> list[str]:
    reads = []
    original = local_history.stored_content

    def counting(path, cancel=None, limit=None, **kwargs):
        if path.is_relative_to(pc.drive):
            reads.append(kwargs.get("expected") or path.name)  # The blob's name (its file's may differ).
        return original(path, cancel, limit, **kwargs)

    monkeypatch.setattr(local_history, "stored_content", counting)
    return reads


def report(pc: PC, names, *, updated) -> None:
    """A third PC's device file reporting `names` damaged."""
    pc.store().write_device({"device_id": "c" * 32, "device": "third", "updated": updated.isoformat(),
                             "base": None, "bad_blobs": sorted(names)})


def own_blobs(pc: PC) -> set[str]:
    """The blobs of the generations this PC keeps an eye on: its base, and the heads it made."""
    own = v2._own(pc.store().view(), pc.state())
    return set().union(*(sync_store.blob_names(item) for item in own))


def test_blobs_reported_damaged_are_read_once_while_they_stay_as_they_are(pcs, monkeypatch):
    a, _b, identity = pcs
    a.edit(identity, note="x")
    a.sync()
    uses = own_blobs(a)
    report(a, uses, updated=sync_store._now())
    reads = reads_of_the_sync_folder(a, monkeypatch)
    assert a.check() == "quiet"
    a.sync()
    assert sorted(reads) == sorted(uses)  # Each read whole once, and found as named: nothing written.
    reads.clear()
    for n in range(2):
        a.edit(identity, note=f"x{n}")
        a.sync()
    assert reads == []  # Remembered as read, while they stay as they are.
    a.sync()
    assert a.check() == "none"


def test_reports_from_a_pc_that_has_not_synced_for_long_are_ignored(pcs, monkeypatch):
    a, _b, identity = pcs
    a.edit(identity, note="x")
    a.sync()
    report(a, own_blobs(a), updated=sync_store._now() - timedelta(days=31))
    reads = reads_of_the_sync_folder(a, monkeypatch)
    a.sync()
    assert reads == []


def test_the_device_file_is_written_again_once_a_day(pcs, monkeypatch):
    a, _b, _identity = pcs
    identity = a.state()["device_id"]
    before = a.store().view().devices[identity]["updated"]
    a.sync()
    assert a.store().view().devices[identity]["updated"] == before
    later = sync_store._now() + timedelta(hours=25)
    monkeypatch.setattr(sync_store, "_now", lambda: later)
    a.sync()
    assert a.store().view().devices[identity]["updated"] == later.isoformat()


# --- Stopping halfway ---

def test_a_publish_stopped_while_writing_blobs_publishes_nothing(pcs, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    gens, entries, state = a.files("gens"), a.history(), a.state()
    put_blob = GenerationStore.put_blob
    calls = []

    def stopped(self, source, *args):
        calls.append(source.name)
        if len(calls) == 2:
            raise Cancelled("stopped")
        return put_blob(self, source, *args)

    monkeypatch.setattr(GenerationStore, "put_blob", stopped)
    with pytest.raises(Cancelled):
        a.sync()
    # A blob was written, the generation was not: to b there is nothing new.
    assert a.files("gens") == gens and a.history() == entries and a.state() == state
    transfer(a, b)
    assert b.sync()["reloaded"] is False
    monkeypatch.setattr(GenerationStore, "put_blob", put_blob)
    assert a.sync()["status"] == "synced" and a.files("gens") != gens
    transfer(a, b)
    assert b.sync()["reloaded"] is True and b.note(identity) == "second"


def test_a_publish_stopped_after_its_generation_moves_the_base_next_time(pcs, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, note="second")
    gens = a.files("gens")
    write = GenerationStore.write_generation

    def stopped(self, generation):
        write(self, generation)
        raise Cancelled("stopped")

    monkeypatch.setattr(GenerationStore, "write_generation", stopped)
    with pytest.raises(Cancelled):
        a.sync()
    monkeypatch.setattr(GenerationStore, "write_generation", write)
    published = a.files("gens") - gens
    assert len(published) == 1 and a.state()["base"] + ".gen" not in published
    # The head holds this library already: only the base moves, and no generation is added.
    assert a.sync()["reloaded"] is False
    assert a.files("gens") - gens == published and a.state()["base"] + ".gen" in published
    transfer(a, b)
    assert b.sync()["reloaded"] is True and b.note(identity) == "second"


def test_taking_in_stopped_while_putting_together_leaves_the_library(pcs, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    a.sync()
    transfer(a, b)
    state = b.state()
    write = v2._Sources.write
    calls = []

    def stopped(self, output, name, *args):
        calls.append(name)
        if len(calls) == 3:
            raise Cancelled("stopped")
        return write(self, output, name, *args)

    monkeypatch.setattr(v2._Sources, "write", stopped)
    with pytest.raises(Cancelled):
        b.sync()
    assert b.note(identity) == "" and b.state() == state and b.leftovers() == []
    monkeypatch.setattr(v2._Sources, "write", write)
    assert b.sync()["reloaded"] is True and b.note(identity) == "second"


def test_a_generation_whose_contents_do_not_match_its_hash_is_not_taken_in(pcs):
    a, b, identity = pcs
    a.edit(identity, note="second")
    a.sync()
    transfer(a, b)
    view = b.store().view()
    head = view.generations[heads(b)[0]]
    remove(b, "gens/" + head["id"] + ".gen")
    b.store().write_generation({**head, "hash": "0" * 64})
    with pytest.raises(ValueError, match="一致しません"):
        b.sync()
    assert b.note(identity) == "" and b.leftovers() == []


# --- Deliveries in any order ---

@pytest.mark.parametrize("seed", range(4))
def test_any_order_of_arrival_loses_nothing_and_ends_alike(pcs, seed, tmp_path):
    a, b, identity = pcs
    rng = random.Random(seed)
    a.edit(identity, note=f"a{seed}", article=f"a article {seed}")
    b.edit(identity, note=f"b{seed}")
    statuses = set()
    for pc in (a, b):
        statuses.add(pc.sync()["status"])
    # Deliver one file at a time, both ways mixed, a sync every few files.
    queue = [(a, b, rel) for rel in pending(a, b)] + [(b, a, rel) for rel in pending(b, a)]
    rng.shuffle(queue)
    # Printed, so a failure shows the order the files arrived in (pytest shows what a failed test printed).
    print("arrival order:", [f"{source.name}->{target.name} {rel.split('/')[0]}" for source, target, rel in queue])
    for step, (source, target, rel) in enumerate(queue):
        deliver(source, target, rel)
        if step % 3 == 2:
            pc = rng.choice((a, b))
            status = pc.sync()["status"]
            print(f"after {step + 1}: {pc.name} {status}")
            statuses.add(status)
    assert statuses <= {"synced", "waiting", "conflict"}
    # Everything delivered: settle it as the user would, choosing this PC's library on a.
    for _round in range(3):
        transfer(a, b)
        transfer(b, a)
        result = a.sync()
        if result["status"] == "conflict":
            ids = [item["id"] for item in result["conflicts"]]
            a.sync(choice="local", expected_heads=ids)
        transfer(a, b)
        b.sync()
    assert a.fingerprint() == b.fingerprint()
    # b's note is in the library or kept in a history.
    kept = {a.note(identity)}
    for pc in (a, b):
        for entry in pc.history():
            target = tmp_path / f"{pc.name}-{entry['id']}"
            with pc:
                local_history.materialize(pc.root, entry["id"], target)
                kept.add(Library(target).paper(identity)["note"])
    assert {f"a{seed}", f"b{seed}"} <= kept


# --- The clean-up (S5) ---

@pytest.fixture
def eager(monkeypatch):
    """The clean-up at every sync, with no grace: the harshest it can be."""
    monkeypatch.setattr(sync_store, "BLOB_GRACE", timedelta(0))
    monkeypatch.setattr(v2, "GC_INTERVAL", timedelta(0))


def unused_blobs(pc: PC) -> set[str]:
    view = pc.store().view()
    return set(view.blobs) - set().union(*(sync_store.blob_names(item) for item in view.generations.values()))


def test_the_clean_up_leaves_the_head_and_what_it_uses(pcs, eager):
    a, b, identity = pcs
    for n in range(3):
        a.edit(identity, note=f"n{n}", article=f"article {n}")
        a.sync()
        transfer(a, b)
        assert b.sync()["reloaded"] is True
        transfer(b, a)
        a.sync()
    for pc in (a, b):
        assert pc.files("gens") == {heads(pc)[0] + ".gen"} and unused_blobs(pc) == set()
    assert a.files("blobs") == b.files("blobs") and article(b, identity) == "article 2"
    # What was removed went to Drive's trash as a few files a sync, never the PDF.
    assert all(not rel.endswith(".pdf") for rel in a.removed)


def test_by_default_blobs_wait_three_days_and_the_clean_up_runs_once_a_day(pcs, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, article="replaced")
    a.sync()
    transfer(a, b)
    b.sync()  # b moves on too, so its base (which used the old article) is no longer kept.
    transfer(b, a)
    a.sync()
    old = local_history.blob_name(hashlib.sha256(b"summary one").hexdigest(), True)
    assert old in unused_blobs(a)
    start = sync_store._now()
    written = start.timestamp() - 5 * 86400
    os.utime(a.drive / "v2" / "blobs" / old, (written, written))  # Written long ago.
    for days, present in ((1, True), (2, True), (4.5, False)):
        later = start + timedelta(days=days)
        monkeypatch.setattr(sync_store, "_now", lambda moment=later: moment)
        a.sync()
        # First seen as it is now at day 1: kept for three days from then.
        assert (old in a.files("blobs")) is present, days


def test_a_clean_up_stopped_halfway_goes_on_next_time(pcs, eager, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    unlink = sync_store.Cleaner._unlink
    calls = []

    def stopped(self, path):
        calls.append(path)
        if len(calls) == 2:
            raise Cancelled("stopped")
        return unlink(self, path)

    monkeypatch.setattr(sync_store.Cleaner, "_unlink", stopped)
    # The sync itself went through: only the clean-up stopped.
    assert a.sync()["status"] == "synced"
    assert len(a.files("gens")) >= 2 or unused_blobs(a)
    monkeypatch.setattr(sync_store.Cleaner, "_unlink", unlink)
    assert a.sync()["status"] == "synced"
    assert a.files("gens") == {heads(a)[0] + ".gen"} or b.state()["base"] + ".gen" in a.files("gens")
    assert unused_blobs(a) == set()
    transfer(a, b)
    assert b.sync()["reloaded"] is True and article(b, identity) == "summary two"


def test_two_pcs_cleaning_up_at_once_keep_what_either_needs(pcs, eager):
    a, b, identity = pcs
    # Both change and clean up before seeing each other's.
    a.edit(identity, note="from a", article="summary two")
    b.edit(identity, note="from b")
    a.sync()
    b.sync()
    transfer(a, b)
    transfer(b, a)
    result = a.sync()
    ids = [item["id"] for item in result["conflicts"]]
    assert a.sync(choice="local", expected_heads=ids)["status"] == "synced"
    transfer(a, b)
    transfer(b, a)
    assert b.sync()["reloaded"] is True and b.note(identity) == "from a"
    transfer(b, a)
    transfer(a, b)
    for pc in (a, b):
        assert pc.sync()["status"] == "synced"
    assert a.fingerprint() == b.fingerprint() and a.files("blobs") == b.files("blobs")


def test_a_blob_one_pc_removes_while_the_other_uses_it_again_is_written_anew(pcs, eager):
    """§2.4: b puts back contents a's clean-up removes meanwhile; b writes the blob anew, so a's removal,
    arriving later, does not take b's copy, and a's folder gets it back."""
    a, b, identity = pcs
    old = local_history.blob_name(hashlib.sha256(b"summary one").hexdigest(), True)
    a.edit(identity, article="summary two")
    a.sync()
    transfer(a, b, only=lambda rel: not rel.startswith("-"))
    assert b.sync()["reloaded"] is True
    transfer(b, a)  # b's device file: b stands on a's generation now.
    a.sync()  # a removes the blob of "summary one" (no generation uses it).
    assert old not in a.files("blobs")
    b.edit(identity, article="summary one")
    b.sync()
    assert old in b.files("blobs")
    transfer(a, b)  # a's removal of the old version arrives late: b's new copy stays.
    assert old in b.files("blobs")
    transfer(b, a)
    assert a.sync()["reloaded"] is True and article(a, identity) == "summary one"


def test_a_clean_up_while_blobs_are_on_their_way(pcs, eager):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    a.sync()
    # The generation reaches b, its blobs do not yet: b waits and does not clean up.
    transfer(a, b, only=lambda rel: rel.startswith("gens/"))
    before = b.files("blobs")
    assert b.sync()["status"] == "waiting" and b.files("blobs") == before
    # a cleans up meanwhile: the head uses them, so they stay.
    a.sync()
    transfer(a, b)
    assert b.sync()["reloaded"] is True and b.note(identity) == "second"


def test_blobs_that_arrive_before_their_generation_and_are_cleaned_up_are_written_again(pcs, eager):
    """With no grace at all, b removes blobs no generation it has uses yet; a writes its own again."""
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    a.sync()
    transfer(a, b, only=is_blob)
    b.edit(identity, note="b meanwhile")  # b syncs (and cleans up) before a's generation arrives.
    b.sync()
    transfer(b, a)
    transfer(a, b)
    statuses = []
    for _round in range(3):
        for pc, other in ((a, b), (b, a)):
            result = pc.sync()
            if result["status"] == "conflict":
                ids = [item["id"] for item in result["conflicts"]]
                result = pc.sync(choice="local", expected_heads=ids)
            statuses.append(result["status"])
            transfer(pc, other)
    assert a.fingerprint() == b.fingerprint()
    assert set(statuses) <= {"synced", "waiting"}


def contents(pc: PC) -> dict[str, bytes]:
    base = pc.drive / "v2"
    return {path.relative_to(base).as_posix(): path.read_bytes() for path in base.rglob("*")
            if path.is_file() and not is_temporary(path)}


def arrive_in_any_order(pcs, seed: int, tmp_path: Path, *, by_file: bool = False) -> None:
    """Files and removals arrive one at a time, in an order the seed picks, with syncs (each cleaning up)
    in between; then everything arrives and the user settles any choice. Nothing either PC saved is lost,
    both end alike, their sync folders too, and every generation kept has all its blobs."""
    a, b, identity = pcs
    a.by_file = b.by_file = by_file
    rng = random.Random(seed)
    for turn in range(2):
        for pc in rng.sample((a, b), 2):
            pc.edit(identity, note=f"{pc.name}{seed}-{turn}", article=f"{pc.name} article {seed}-{turn}")
            pc.sync()
        for step in range(30):
            queue = [(a, b, rel) for rel in pending(a, b)] + [(b, a, rel) for rel in pending(b, a)]
            if not queue:
                break
            source, target, rel = rng.choice(queue)
            print(f"{source.name}->{target.name} {rel}")
            deliver(source, target, rel)
            if step % 3 == 2:
                pc = rng.choice((a, b))
                result = pc.sync()
                print(f"  {pc.name} {result['status']}")
                assert result["status"] in ("synced", "waiting", "conflict")
    for _round in range(4):
        transfer(a, b)
        transfer(b, a)
        result = a.sync()
        print("settle a", result["status"], result.get("waiting"))
        if result["status"] == "conflict":
            ids = [item["id"] for item in result["conflicts"]]
            a.sync(choice="local", expected_heads=ids)
        transfer(a, b)
        transfer(b, a)
        result = b.sync()
        print("settle b", result["status"], b.state().get("waiting"))
        if result["status"] == "conflict":  # b's own change, not published yet, against a's choice.
            ids = [item["id"] for item in result["conflicts"]]
            b.sync(choice="local", expected_heads=ids)
    assert a.fingerprint() == b.fingerprint()
    kept = {a.note(identity)}
    for pc in (a, b):
        for entry in pc.history():
            target = tmp_path / f"{pc.name}-{entry['id']}"
            with pc:
                local_history.materialize(pc.root, entry["id"], target)
                kept.add(Library(target).paper(identity)["note"])
    assert {f"a{seed}-1", f"b{seed}-1"} <= kept
    # Everything delivered: the two sync folders hold the same, and what they keep is whole.
    for _round in range(3):
        if not (transfer(a, b) + transfer(b, a)):
            break
    assert contents(a) == contents(b)
    for pc in (a, b):
        view = pc.store().view()
        assert [identity for identity in view.kept(pc.state().get("base")) if not view.complete(identity)] == []
        assert unused_blobs(pc) == set()


@pytest.mark.parametrize("seed", range(8))
def test_any_order_of_arrival_with_the_clean_up_loses_nothing(pcs, eager, seed, tmp_path):
    arrive_in_any_order(pcs, seed, tmp_path)


@pytest.mark.slow
@pytest.mark.parametrize("seed", range(8, 40))
def test_any_order_of_arrival_with_the_clean_up_more_seeds(pcs, eager, seed, tmp_path):
    arrive_in_any_order(pcs, seed, tmp_path)


@pytest.mark.slow
@pytest.mark.parametrize("seed", range(16))
def test_any_order_of_arrival_with_removals_that_take_any_version(pcs, eager, seed, tmp_path):
    """The harsher delivery: a removal takes the file of that name, even a copy written anew since.
    The PC whose generation uses it writes it again (drive_sync_v2._repair)."""
    arrive_in_any_order(pcs, seed, tmp_path, by_file=True)


def test_a_failing_clean_up_still_counts_as_the_day_s(pcs, eager, monkeypatch):
    a, _b, identity = pcs
    monkeypatch.setattr(v2, "GC_INTERVAL", timedelta(days=1))

    def held(self, own_device, now):
        raise PermissionError("a file held by Google Drive")

    monkeypatch.setattr(sync_store.Cleaner, "leftovers", held)
    runs = []
    removable = sync_store.removable_blobs
    monkeypatch.setattr(sync_store, "removable_blobs", lambda *args: runs.append(1) or removable(*args))
    with a:
        state = drive_sync.read_state(a.root)
        state.pop("gc_last", None)
        drive_sync.save_state(a.root, state)
    for n in range(3):
        a.edit(identity, note=f"n{n}")
        assert a.sync()["status"] == "synced"
    # Counted as the day's at once: the next syncs of the day do not clean up blobs again.
    assert a.state().get("gc_last") is not None and len(runs) == 1


def test_a_file_that_cannot_be_removed_is_passed_over(pcs, eager, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    a.sync()
    transfer(a, b)
    b.sync()
    # b's device file reaches a, b's own removals not yet: a cleans up the same itself.
    transfer(b, a, only=lambda rel: not rel.startswith("-"))
    held = []
    unlink = Path.unlink

    def refusing(self, missing_ok=False):
        if self.parent.name == "blobs" and not held:
            held.append(self.name)
            raise PermissionError("held by Google Drive")
        return unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", refusing)
    assert a.sync()["status"] == "synced"
    monkeypatch.setattr(Path, "unlink", unlink)
    # The one held stays, the others went; the next clean-up takes it.
    assert held and held[0] in a.files("blobs") and unused_blobs(a) == {held[0]}
    a.sync()
    assert unused_blobs(a) == set()


def test_a_copy_that_does_not_hold_the_blob_starts_one_sync_not_one_each_check(pcs, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    a.sync()
    name = local_history.blob_name(hashlib.sha256(b"summary two").hexdigest(), True)
    transfer(a, b, only=lambda rel: rel != "blobs/" + name)
    assert b.sync()["status"] == "waiting" and b.check() == "none"
    (b.drive / "v2" / "blobs" / (name.removesuffix(".z") + " (1).z")).write_bytes(zlib.compress(b"not it"))
    reads = []
    recover = sync_store.GenerationStore.recover
    monkeypatch.setattr(sync_store.GenerationStore, "recover",
                        lambda self, names, cancel=None: reads.append(1) or recover(self, names, cancel))
    # The new copy is worth one look; found not to hold the blob, it is not looked at again.
    assert b.check() == "quiet"
    assert b.sync()["status"] == "waiting" and len(reads) == 1
    assert [b.check() for _ in range(3)] == ["none"] * 3
    # The blob itself arrives: taken in.
    transfer(a, b)
    assert b.check() == "pull" and b.sync()["reloaded"] is True


def test_a_blob_left_only_under_a_copy_name_is_put_back(pcs):
    """Another PC's clean-up removed "X (1)" as a copy, and that removal took this folder's X: only the
    copy Google Drive named "X (1)" is left here. The sync puts it back rather than wait for ever."""
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    a.sync()
    name = local_history.blob_name(hashlib.sha256(b"summary two").hexdigest(), True)
    transfer(a, b, only=lambda rel: rel != "blobs/" + name)
    assert b.sync()["status"] == "waiting" and b.check() == "none"
    shutil.copy2(a.drive / "v2" / "blobs" / name, b.drive / "v2" / "blobs" / (name.removesuffix(".z") + " (1).z"))
    assert b.check() == "quiet"
    result = b.sync()
    assert result["status"] == "synced" and b.note(identity) == "second" and name in b.files("blobs")
    assert not any("(" in item for item in b.files("blobs"))


def test_a_right_copy_that_could_not_be_read_at_the_sync_is_tried_again_by_the_check(pcs, monkeypatch):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    a.sync()
    name = local_history.blob_name(hashlib.sha256(b"summary two").hexdigest(), True)
    transfer(a, b, only=lambda rel: rel != "blobs/" + name)
    assert b.sync()["status"] == "waiting" and b.check() == "none"
    shutil.copy2(a.drive / "v2" / "blobs" / name, b.drive / "v2" / "blobs" / (name.removesuffix(".z") + " (1).z"))
    state = sync_store._content_state
    held = [True]
    monkeypatch.setattr(sync_store, "_content_state",
                        lambda path, n: "unreadable" if held[0] and " (1)" in path.name else state(path, n))
    # Held for a moment: the sync waits on, and does not take the copy as seen.
    assert b.check() == "quiet" and b.sync()["status"] == "waiting"
    held[0] = False
    assert b.check() == "quiet"
    result = b.sync()
    assert result["status"] == "synced" and b.note(identity) == "second" and name in b.files("blobs")


def test_a_right_copy_beside_a_blob_that_is_damaged_is_put_back(pcs):
    a, b, identity = pcs
    a.edit(identity, note="second", article="summary two")
    a.sync()
    name = local_history.blob_name(hashlib.sha256(b"summary two").hexdigest(), True)
    transfer(a, b)
    blobs = b.drive / "v2" / "blobs"
    shutil.copy2(blobs / name, blobs / (name.removesuffix(".z") + " (1).z"))
    (blobs / name).write_bytes(zlib.compress(b"garbage!"))
    result = b.sync()
    if result["status"] == "waiting":  # The copy is taken in by the next sync.
        result = b.sync()
    assert result["status"] == "synced" and b.note(identity) == "second"


# --- Names Google Drive gives files (checked on Google Drive) ---

def drive_renames_pdfs(pc: PC) -> list[str]:
    """What Google Drive for desktop does to a PDF file without an extension a few seconds after uploading it
    (and to nothing else: not a file with an extension, not other contents): renames it "<name>.pdf", or
    "<name> (1).pdf" when that name is taken. The names given."""
    renamed = []
    folder = pc.drive / "v2" / "blobs"
    for path in sorted(folder.iterdir()):
        if is_temporary(path) or "." in path.name or not path.read_bytes().startswith(b"%PDF"):
            continue
        target, n = path.with_name(path.name + ".pdf"), 0
        while target.exists():
            n += 1
            target = path.with_name(f"{path.name} ({n}).pdf")
        path.rename(target)
        renamed.append(target.name)
    return renamed


def another_pdf(path: Path) -> Path:
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((40, 70), "Another paper")
        pdf.save(path)
    return path


def test_a_pdf_is_written_so_google_drive_leaves_its_name(pcs, tmp_path):
    a, b, _identity = pcs
    with a as lib:
        lib.import_pdf(another_pdf(tmp_path / "another.pdf"))
    assert a.sync()["status"] == "synced"
    assert drive_renames_pdfs(a) == []
    transfer(a, b)
    result = b.sync()
    assert result["status"] == "synced" and result["reloaded"] is True
    assert a.fingerprint() == b.fingerprint()
    # Nothing is written again at the next syncs, so no copies pile up.
    blobs = a.files("blobs")
    for _round in range(2):
        assert a.sync()["status"] == "synced" and drive_renames_pdfs(a) == []
    assert a.files("blobs") == blobs and not any(" (" in name for name in blobs)


def test_a_blob_file_google_drive_gave_another_extension_is_put_back(pcs, tmp_path):
    """Should Google Drive rename a blob's file all the same ("<sha256>.pdf", or "<sha256> (1).pdf" beside a
    file of that name), each PC puts it back once its content is checked: the PC taking it in does not wait
    for ever, and the PC that wrote it does not write it again at each sync."""
    a, b, identity = pcs
    before = a.files("blobs")
    with a as lib:
        lib.import_pdf(another_pdf(tmp_path / "another.pdf"))
    assert a.sync()["status"] == "synced"
    [file] = [name for name in a.files("blobs") - before if not name.endswith(".z")]
    digest = file.split(".")[0]
    transfer(a, b, only=lambda rel: rel != "blobs/" + file)
    shutil.copy2(a.drive / "v2" / "blobs" / file, b.drive / "v2" / "blobs" / f"{digest}.pdf")
    result = b.sync()
    assert result["status"] == "synced" and result["reloaded"] is True and a.fingerprint() == b.fingerprint()
    assert file in b.files("blobs") and not any(".pdf" in name for name in b.files("blobs"))
    # On a's side, renamed beside another file of that name: put back, not written again.
    (a.drive / "v2" / "blobs" / f"{digest}.pdf").write_bytes(b"another file")
    (a.drive / "v2" / "blobs" / file).rename(a.drive / "v2" / "blobs" / f"{digest} (1).pdf")
    assert a.check() == "quiet"
    a.edit(identity, note="a changed")
    assert a.sync()["status"] == "synced"
    assert file in a.files("blobs") and f"{digest} (1).pdf" not in a.files("blobs")


# --- The first format is left as it is ---

def test_the_first_format_ignores_the_new_folder(pcs):
    a, _b, _identity = pcs
    assert drive_sync.FolderDrive(a.drive).revisions() == []
    with a:
        assert drive_sync.check_connected(a.root)["action"] in ("none", "quiet")


def test_a_generation_file_is_gzip_json_with_the_manifest(pcs):
    a, _b, _identity = pcs
    path = next((a.drive / "v2" / "gens").iterdir())
    value = json.loads(gzip.decompress(path.read_bytes()))
    assert value["format"] == 2 and value["id"] == path.stem and "files" in value and "chunks" in value["db"]
