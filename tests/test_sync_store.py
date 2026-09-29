"""The sync folder's new format (sync_store): blobs checked against their names, generations and their lineage."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import uuid
import zlib

import pytest

from papeer.core import drive_sync_v2 as v2, local_history, sync_store
from papeer.core.local_history import SourceUnreadable
from papeer.core.sync_client import SYNC_CLIENT
from papeer.core.sync_store import GenerationStore, NewerFormatError, View

NOW = datetime(2026, 9, 29, tzinfo=timezone.utc)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def generation(identity: str | None = None, *, parents=(), lineage=(), files=None, created=NOW, **values) -> dict:
    database = b"db"
    return {"format": 2, "id": identity or uuid.uuid4().hex, "created": created if isinstance(created, str) else created.isoformat(), "device_id": "d" * 32,
            "device": "pc", "app_version": "1.0.0", "schema_version": 1, "parents": list(parents),
            "lineage": [list(item) for item in lineage], "hash": "a" * 64, "counts": {"papers": 1},
            "db": {"chunk": 262144, "size": len(database), "sha256": digest(database), "chunks": [digest(database)]},
            "files": files if files is not None else {"papers/x/original.pdf": [digest(b"pdf"), 3]}, **values}


@pytest.fixture
def store(tmp_path) -> GenerationStore:
    folder = tmp_path / "drive"
    folder.mkdir()
    return GenerationStore.initialize(folder)


def put(store: GenerationStore, data: bytes, compress: bool) -> str:
    name = local_history.blob_name(digest(data), compress)
    (store.blobs / name).write_bytes(zlib.compress(data) if compress else data)
    return name


def seconds(moment: datetime) -> int:
    return int(moment.timestamp())


# --- Blobs ---

def test_a_blob_is_copied_only_when_its_content_matches_its_name(store, tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    good = local_history.blob_name(digest(b"text"), True)
    (source / good).write_bytes(zlib.compress(b"text"))
    assert local_history.copy_blob(source / good, store.blobs) == 4
    assert b"".join(local_history.stored_content(store.blobs / good)) == b"text"
    bad = local_history.blob_name(digest(b"other"), True)
    (source / bad).write_bytes(zlib.compress(b"garbage"))
    with pytest.raises(SourceUnreadable):
        local_history.copy_blob(source / bad, store.blobs)
    with pytest.raises(SourceUnreadable):
        local_history.copy_blob(source / ("0" * 64), store.blobs)  # Missing.
    # Nothing but the good blob, and no temporary file, is left.
    assert [path.name for path in store.blobs.iterdir()] == [good]
    (store.blobs / good).write_bytes(zlib.compress(b"damaged"))
    with pytest.raises(SourceUnreadable):
        b"".join(local_history.stored_content(store.blobs / good))
    # Copying the good one again mends it in place.
    local_history.copy_blob(source / good, store.blobs)
    assert b"".join(local_history.stored_content(store.blobs / good)) == b"text"


def test_a_file_is_stored_as_the_blob_its_content_names(store, tmp_path):
    path = tmp_path / "note.md"
    path.write_bytes(b"memo")
    store.put_content(digest(b"memo") + ".z", path)
    assert zlib.decompress((store.blobs / (digest(b"memo") + ".z")).read_bytes()) == b"memo"
    store.put_content(digest(b"memo"), path)
    assert (store.blobs / digest(b"memo")).read_bytes() == b"memo"
    with pytest.raises(ValueError):
        store.put_content(digest(b"changed") + ".z", path)
    assert sorted(item.name for item in store.blobs.iterdir()) == sorted([digest(b"memo") + ".z", digest(b"memo")])


def test_the_view_leaves_out_temporary_files_and_copies_drive_named_again(store):
    name = put(store, b"pdf", False)
    (store.blobs / f".{name}.123.tmp").write_bytes(b"half")
    (store.blobs / f"{name} (1)").write_bytes(b"pdf")
    item = generation()
    store.write_generation(item)
    (store.gens / f"{item['id']} (1).gen").write_bytes((store.gens / f"{item['id']}.gen").read_bytes())
    view = store.view()
    assert set(view.blobs) == {name} and set(view.generations) == {item["id"]}


# --- The folder ---

def test_the_new_format_is_not_started_beside_revisions_of_the_first(tmp_path):
    (tmp_path / ("0" * 32 + ".papeer-sync")).write_bytes(b"")
    with pytest.raises(ValueError, match="以前の形式"):
        GenerationStore.initialize(tmp_path)
    with pytest.raises(ValueError, match="新しい形式の同期データがありません"):
        GenerationStore(tmp_path).check_format()


def test_a_folder_of_a_newer_format_is_refused(store):
    (store.root / "format.json").write_text(json.dumps({"format": 3, "app_version": "9.0.0"}), "utf-8")
    with pytest.raises(NewerFormatError, match="Papeer 9.0.0 以降"):
        store.check_format()


# --- Generations ---

def test_a_generation_is_read_back_as_written(store):
    item = generation()
    store.write_generation(item)
    assert store.view().generations == {item["id"]: item}
    assert json.loads(gzip.decompress((store.gens / f"{item['id']}.gen").read_bytes())) == item


@pytest.mark.parametrize("change", [
    {"files": {"../outside": ["0" * 64, 1]}},
    {"files": {"library.sqlite3": ["0" * 64, 1]}},
    {"files": {"A.md": ["0" * 64, 1], "a.md": ["1" * 64, 1]}},
    {"parents": ["not an id"]},
    {"hash": "short"},
    {"created": "yesterday"},
])
def test_a_generation_that_must_not_be_trusted_counts_as_unreadable(store, change):
    item = generation(**{key: value for key, value in change.items() if key != "files"},
                      files=change.get("files"))
    store.write_generation(item)
    view = store.view()
    assert view.unreadable == {item["id"]} and view.heads() == [item["id"]]


def test_a_damaged_generation_is_a_head_until_one_takes_it_over(store):
    (store.gens / ("1" * 32 + ".gen")).write_bytes(b"not gzip")
    assert store.view().heads() == ["1" * 32]
    store.write_generation(generation("2" * 32, parents=["1" * 32], lineage=[("1" * 32, seconds(NOW))]))
    assert store.view().heads() == ["2" * 32]


def test_a_generation_of_a_newer_format_is_told_apart(store):
    identity = "3" * 32
    (store.gens / f"{identity}.gen").write_bytes(gzip.compress(json.dumps({"format": 3, "app_version": "9.1"}).encode()))
    assert store.view().newer == {identity: "9.1"}


# --- Heads, lineage and the base ---

def test_heads_and_the_base_are_judged_by_lineage(store):
    first, second, third = "1" * 32, "2" * 32, "3" * 32
    store.write_generation(generation(first))
    store.write_generation(generation(second, parents=[first], lineage=[(first, seconds(NOW))]))
    view = store.view()
    assert view.heads() == [second]
    assert view.base_status(first) == "visible" and view.base_status(None) is None
    # The first removed: the second still says it took it over.
    (store.gens / f"{first}.gen").unlink()
    view = store.view()
    assert view.heads() == [second] and view.base_status(first) == "inherited"
    assert view.base_status(third) == "unknown"
    # A generation made over the first by another PC at the same time is a second head.
    store.write_generation(generation(third, parents=[first], lineage=[(first, seconds(NOW))]))
    assert store.view().heads() == [second, third]


def test_the_lineage_keeps_the_parents_and_what_is_recent_enough(store):
    old, parent = "1" * 32, "2" * 32
    now = NOW + timedelta(days=100)
    recent, stale = seconds(now - timedelta(days=10)), seconds(now - timedelta(days=61))
    store.write_generation(generation(parent, created=NOW, lineage=[("4" * 32, recent), ("5" * 32, stale)]))
    view = store.view()
    # The parent is 100 days old but always kept; of its lineage, only what is recent enough.
    assert sync_store.lineage(view, [parent], now) == [[parent, seconds(NOW)], ["4" * 32, recent]]
    # A parent that cannot be read counts as made now.
    assert sync_store.lineage(view, [old], now) == [[old, seconds(now)]]


def test_the_lineage_is_limited_to_the_newest(store, monkeypatch):
    ancestors = [(f"{n:032x}", seconds(NOW) - n) for n in range(1, 5)]
    parent = "f" * 32
    store.write_generation(generation(parent, lineage=ancestors))
    view = store.view()
    monkeypatch.setattr(sync_store, "LINEAGE_LIMIT", 2)
    result = sync_store.lineage(view, [parent], NOW)
    assert [identity for identity, _time in result] == [parent, ancestors[0][0], ancestors[1][0]]


# --- Complete or still arriving ---

def test_a_generation_is_complete_once_every_blob_it_uses_is_there(store):
    item = generation(files={"papers/x/original.pdf": [digest(b"pdf"), 3], "papers/x/note.md": [digest(b"memo"), 4]})
    store.write_generation(item)
    assert len(store.view().missing(item)) == 3 and not store.view().complete(item["id"])
    put(store, b"db", True)
    put(store, b"memo", True)
    (store.blobs / digest(b"pdf")).write_bytes(b"pd")  # Still arriving: shorter than the size named.
    assert store.view().missing(item) == {digest(b"pdf")}
    put(store, b"pdf", False)
    assert store.view().complete(item["id"])


# --- Device files ---

def test_a_device_file_is_read_with_only_what_it_may_say(store):
    identity = "e" * 32
    store.write_device({"device_id": identity, "device": "pc", "updated": NOW.isoformat(), "base": "1" * 32,
                        "bad_blobs": ["0" * 64, "../x", 3]})
    (store.devices / ("f" * 32 + ".json")).write_text("{broken", "utf-8")
    devices = store.view().devices
    assert list(devices) == [identity] and devices[identity]["bad_blobs"] == ["0" * 64]


# --- Recording another PC's generation in this PC's history ---

def test_a_generation_is_recorded_in_the_history_from_the_blobs_it_lacks(store, tmp_path):
    root = tmp_path / "library"
    item = generation(files={"papers/x/original.pdf": [digest(b"pdf"), 3]})
    for data, compress in ((b"pdf", False), (b"db", True)):
        put(store, data, compress)
    entry = local_history.record_manifest(root, item["files"], item["db"], store.blob_path, kind="set_aside",
                                          library_hash=item["hash"], counts=item["counts"], schema_version=1)
    listed = next(value for value in local_history.entries(root) if value["id"] == entry)
    assert listed["complete"] and listed["verified"] is False
    local_history.materialize(root, entry, tmp_path / "state")
    assert (tmp_path / "state" / "papers" / "x" / "original.pdf").read_bytes() == b"pdf"
    # A damaged blob in the sync folder is not recorded.
    other = generation(files={"papers/y/original.pdf": [digest(b"other"), 5]})
    (store.blobs / digest(b"other")).write_bytes(b"wrong")
    with pytest.raises(SourceUnreadable):
        local_history.record_manifest(root, other["files"], other["db"], store.blob_path, kind="set_aside",
                                      library_hash=other["hash"], counts=None, schema_version=1)
    assert len(local_history.entries(root)) == 1


# --- What the user is told while waiting ---

def test_a_wait_is_told_more_firmly_after_a_day(monkeypatch):
    monkeypatch.setattr(sync_store, "_now", lambda: NOW)
    state = {"waiting": {"reason": "arrival", "device": "PC-A", "missing": 12, "heads": ["1" * 32],
                         "since": (NOW - timedelta(hours=1)).isoformat()}}
    told = v2.waiting_status(state)
    assert told["message"] == "PC-A のデータが届くのを待っています（残り 12 ファイル）。" and not told["overdue"]
    state["waiting"]["since"] = (NOW - timedelta(hours=25)).isoformat()
    told = v2.waiting_status(state)
    assert told["overdue"] and f"PC-A の{SYNC_CLIENT}の同期が止まっていないか" in told["message"]
    assert v2.waiting_status({"waiting": {"reason": "base", "since": NOW.isoformat()}})["message"] \
        == "前回の同期データが届くのを待っています。"
    assert v2.waiting_status({}) is None


def test_a_view_of_nothing_has_no_heads():
    assert View().heads() == [] and View().base_status("1" * 32) == "unknown"


def test_the_store_needs_the_sync_folder(tmp_path):
    with pytest.raises(ValueError):
        GenerationStore(Path(tmp_path / "missing"))


# --- Review follow-ups: what counts as damaged, limits, paths ---

def test_a_blob_that_cannot_be_opened_is_unreadable_but_not_damaged(tmp_path):
    name = local_history.blob_name(digest(b"text"), True)
    with pytest.raises(SourceUnreadable) as missing:
        b"".join(local_history.stored_content(tmp_path / name))
    assert not isinstance(missing.value, local_history.BlobDamaged)
    (tmp_path / name).write_bytes(zlib.compress(b"other"))
    with pytest.raises(local_history.BlobDamaged):
        b"".join(local_history.stored_content(tmp_path / name))
    (tmp_path / name).write_bytes(b"not zlib")
    with pytest.raises(local_history.BlobDamaged):
        b"".join(local_history.stored_content(tmp_path / name))
    target = tmp_path / "target"
    target.mkdir()
    with pytest.raises(SourceUnreadable) as unreadable:
        local_history.copy_blob(tmp_path / "missing" / name, target)
    assert not isinstance(unreadable.value, local_history.BlobDamaged)
    with pytest.raises(local_history.BlobDamaged):
        local_history.copy_blob(tmp_path / name, target)


def test_a_blob_is_unpacked_a_little_at_a_time_and_no_further_than_its_limit(tmp_path):
    data = b"\0" * (40 * 1024**2)
    name = digest(data) + ".z"
    (tmp_path / name).write_bytes(zlib.compress(data, 9))  # About 40 KB unpacking to 40 MB.
    assert max(len(piece) for piece in local_history.stored_content(tmp_path / name)) <= 1024**2
    with pytest.raises(local_history.BlobDamaged):
        for _piece in local_history.stored_content(tmp_path / name, limit=1024**2):
            pass
    target = tmp_path / "target"
    target.mkdir()
    with pytest.raises(local_history.BlobDamaged):
        local_history.copy_blob(tmp_path / name, target, limit=1024**2)
    assert list(target.iterdir()) == []
    assert local_history.copy_blob(tmp_path / name, target, limit=len(data)) == len(data)


@pytest.mark.parametrize("files", [
    {"a/./b": 1}, {"a//b": 1}, {"a/b/": 1}, {"a": 1, "a/b": 1}, {"A/b": 1, "a": 1}, {"CON .txt": 1},
    {"a/b?": 1}, {"a<b": 1}, {'a"b': 1}, {"a|b": 1}, {"a*b": 1}, {"a\x00b": 1}, {"a\x1fb": 1},
    {"//server/share/x": 1}, {"C:/x": 1}, {"LIBRARY.SQLITE3-WAL": 1}, {"papers/x/aux.md": 1}, {"": 1},
    {".": 1}, {"a/b": 1, "A/B": 1},
])
def test_paths_a_library_folder_cannot_hold_are_refused(files):
    assert not sync_store._valid_files({rel: ["0" * 64, size] for rel, size in files.items()})


def test_ordinary_paths_are_accepted():
    files = {"papers/x/original.pdf": 1, "papers/x/media/fig 1.png": 1, "prompts/custom.txt": 1,
             "ui-state.json": 1, "papers/xy/original.pdf": 1}
    assert sync_store._valid_files({rel: ["0" * 64, size] for rel, size in files.items()})


def test_a_generation_that_cannot_be_read_is_not_read_again_while_it_stays_as_it_is(store, monkeypatch):
    (store.gens / ("1" * 32 + ".gen")).write_bytes(b"not gzip")
    calls = []
    read = sync_store._read_generation

    def counting(path):
        calls.append(path.name)
        return read(path)

    monkeypatch.setattr(sync_store, "_read_generation", counting)
    for _ in range(3):
        assert store.view().unreadable == {"1" * 32}
    assert len(calls) == 1
    # Mended in place: its size changes, so it is read again.
    item = generation("1" * 32)
    store.write_generation(item)
    assert set(store.view().generations) == {item["id"]} and len(calls) == 2


# --- The clean-up (S5) ---

def ids(n: int) -> str:
    return f"{n:032x}"


def view_of(*generations, devices=None, now=NOW, blobs=None, unreadable=()) -> View:
    return View(generations={item["id"]: item for item in generations}, devices=devices or {},
                blobs=blobs or {}, unreadable=set(unreadable), now=now)


def device(base: str | None, *, updated=NOW, identity="e" * 32) -> dict:
    return {"device_id": identity, "device": "pc", "base": base, "updated": updated.isoformat(), "bad_blobs": []}


def test_generations_taken_over_go_and_the_heads_and_recent_bases_stay():
    first = generation(ids(1))
    second = generation(ids(2), parents=[ids(1)], lineage=[(ids(1), seconds(NOW))])
    third = generation(ids(3), parents=[ids(2)], lineage=[(ids(2), seconds(NOW)), (ids(1), seconds(NOW))])
    view = view_of(first, second, third)
    assert view.heads() == [ids(3)] and sync_store.removable_generations(view) == {ids(1), ids(2)}
    # The base of a PC that synced within 30 days stays, and this PC's own.
    view = view_of(first, second, third, devices={"e" * 32: device(ids(1))})
    assert sync_store.removable_generations(view) == {ids(2)}
    assert sync_store.removable_generations(view, own_base=ids(2)) == set()
    # A PC away for longer is no longer kept for.
    view = view_of(first, second, third, devices={"e" * 32: device(ids(1), updated=NOW - timedelta(days=31))})
    assert sync_store.removable_generations(view) == {ids(1), ids(2)}


def test_a_generation_that_cannot_be_read_is_never_removed_and_blocks_blob_removal():
    head = generation(ids(2), parents=[ids(1)], lineage=[(ids(1), seconds(NOW))])
    view = view_of(head, unreadable=[ids(1)], blobs={"f" * 64: (1, 0)})
    assert sync_store.removable_generations(view) == set()
    assert sync_store.removable_blobs(view, {"f" * 64: [1, 0, 0]}, NOW) == []


def test_a_generation_that_alone_takes_over_another_stays():
    """Removing the middle one would bring back the old one as a head (the head's lineage lacks it)."""
    old = generation(ids(1))
    middle = generation(ids(2), parents=[ids(1)], lineage=[(ids(1), seconds(NOW))])
    head = generation(ids(3), parents=[ids(2)], lineage=[(ids(2), seconds(NOW))])
    # The old one is kept as a recent PC's base, so only the middle one is a candidate.
    view = view_of(old, middle, head, devices={"e" * 32: device(ids(1))})
    assert view.heads() == [ids(3)]
    assert sync_store.removable_generations(view) == set()


def test_a_generation_its_own_pc_has_gone_past_is_no_head_once_its_lineage_aged_out():
    now = NOW + timedelta(days=70)
    later = NOW + timedelta(days=5)
    old = generation(ids(1), device_id="e" * 32)
    head = generation(ids(3), created=now, parents=[ids(4)], lineage=[(ids(4), seconds(now)), (ids(2), seconds(later))])
    # Its PC's device file names a later base: taken over, and cleaned up.
    view = view_of(old, head, devices={"e" * 32: device(ids(2), updated=now)}, now=now)
    assert view.heads() == [ids(3)] and ids(1) in sync_store.removable_generations(view)
    # Its PC still stands on it: a head (a choice), however old.
    view = view_of(old, head, devices={"e" * 32: device(ids(1), updated=now)}, now=now)
    assert view.heads() == [ids(1), ids(3)]
    # Without a device file, nothing tells: a head.
    assert view_of(old, head, now=now).heads() == [ids(1), ids(3)]
    # Within the lineage's reach it is judged by lineage only.
    assert view_of(old, head, devices={"e" * 32: device(ids(2))}, now=NOW + timedelta(days=10)).heads() \
        == [ids(1), ids(3)]


def test_the_lineage_keeps_an_ancestor_still_in_the_folder_however_old():
    old = seconds(NOW - timedelta(days=100))
    parent = generation(ids(2), lineage=[(ids(1), old), (ids(5), old)])
    view = view_of(parent, generation(ids(1)))
    assert sync_store.lineage(view, [ids(2)], NOW) == [[ids(2), seconds(NOW)], [ids(1), old]]


def test_a_blob_goes_only_when_unused_and_seen_and_written_long_enough_ago():
    long_ago = seconds(NOW - timedelta(days=4))
    recent = seconds(NOW - timedelta(days=1))
    used = generation(ids(1))
    names = {"a" * 64: (5, long_ago * 10**9), "b" * 64: (5, long_ago * 10**9), "c" * 64: (5, recent * 10**9),
             digest(b"pdf"): (3, long_ago * 10**9)}
    view = view_of(used, blobs=names)
    # Just seen: nothing goes.
    assert sync_store.removable_blobs(view, sync_store.remember_blobs({}, view, NOW), NOW) == []
    seen = {name: [size, modified, long_ago] for name, (size, modified) in names.items()}
    seen["b" * 64] = [5, long_ago * 10**9, recent]  # This PC saw it only a day ago.
    assert sync_store.removable_blobs(view, seen, NOW) == ["a" * 64]
    # Written again (another time): seen anew.
    again = view_of(used, blobs={**names, "a" * 64: (5, recent * 10**9)})
    assert sync_store.remember_blobs(seen, again, NOW)["a" * 64] == [5, recent * 10**9, seconds(NOW)]


def test_blob_removal_is_limited_a_day(monkeypatch):
    long_ago = seconds(NOW - timedelta(days=4))
    names = {f"{n:064x}": (10, (long_ago + n) * 10**9) for n in range(5)}
    seen = {name: [size, modified, long_ago] for name, (size, modified) in names.items()}
    monkeypatch.setattr(sync_store, "BLOB_REMOVE_LIMIT", 3)
    assert sync_store.removable_blobs(view_of(blobs=names), seen, NOW) == sorted(names)[:3]
    monkeypatch.setattr(sync_store, "BLOB_REMOVE_LIMIT", 100)
    monkeypatch.setattr(sync_store, "BLOB_REMOVE_BYTES", 25)
    assert len(sync_store.removable_blobs(view_of(blobs=names), seen, NOW)) == 2


def test_the_cleaner_leaves_a_blob_written_again_since_it_looked(store):
    name = put(store, b"old", True)
    view = store.view()
    path = store.blobs / name
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 10**9))  # Another PC wrote it again.
    cleaner = sync_store.Cleaner(store, view)
    cleaner.blobs([name])
    assert path.exists() and cleaner.removed == []
    cleaner = sync_store.Cleaner(store, store.view())
    cleaner.blobs([name, "0" * 64])  # One already gone is no failure.
    assert not path.exists() and cleaner.removed == [f"blobs/{name}"]


def test_leftovers_and_copies_google_drive_named_again_are_tidied(store):
    stale = store.blobs / ".blob.old.tmp"
    stale.write_bytes(b"half")
    old = seconds(NOW - timedelta(days=2))
    os.utime(stale, (old, old))
    fresh = store.gens / ".x.gen.new.tmp"
    fresh.write_bytes(b"half")
    os.utime(fresh, (seconds(NOW), seconds(NOW)))
    name = put(store, b"text", True)
    (store.blobs / (digest(b"text") + " (1).z")).write_bytes((store.blobs / name).read_bytes())
    lone = local_history.blob_name(digest(b"alone"), True)
    (store.blobs / (digest(b"alone") + " (1).z")).write_bytes(zlib.compress(b"alone"))
    wrong = digest(b"wrong")
    (store.blobs / (wrong + " (1).z")).write_bytes(zlib.compress(b"not it"))
    store.write_generation(generation(ids(7)))
    (store.gens / f"{ids(7)} (1).gen").write_bytes((store.gens / f"{ids(7)}.gen").read_bytes())
    store.write_generation(generation(ids(8)))
    (store.gens / f"{ids(8)}.gen").rename(store.gens / f"{ids(8)} (1).gen")
    mine, theirs = "a" * 32, "b" * 32
    for identity in (mine, theirs):
        (store.devices / f"{identity} (1).json").write_text("{}", "utf-8")
    for folder in (store.blobs, store.gens, store.devices):
        for path in folder.glob("* (1)*"):
            os.utime(path, (old, old))  # Copies written a while ago.
    cleaner = sync_store.Cleaner(store, store.view())
    cleaner.leftovers(mine, NOW)
    assert not stale.exists() and fresh.exists()
    # The copy of a blob that is there goes, a lone right copy takes its name, a wrong one stays.
    assert sorted(path.name for path in store.blobs.iterdir()) == sorted([name, lone, wrong + " (1).z"])
    assert sorted(path.name for path in store.gens.iterdir() if not path.name.startswith(".")) \
        == [f"{ids(7)}.gen", f"{ids(8)}.gen"]
    assert sorted(path.name for path in store.devices.iterdir()) == [f"{theirs} (1).json"]


def test_a_pc_taken_off_the_list_is_no_longer_kept_for(store):
    store.write_device(device(ids(1), identity="e" * 32))
    assert sync_store.forget_device(store, "e" * 32) and store.view().devices == {}
    assert not sync_store.forget_device(store, "e" * 32)
    with pytest.raises(ValueError):
        sync_store.forget_device(store, "../x")


def test_one_blob_larger_than_the_day_s_bytes_does_not_hold_up_the_rest(monkeypatch):
    long_ago = seconds(NOW - timedelta(days=4))
    names = {f"{n:064x}": ((30 if n == 0 else 10), (long_ago + n) * 10**9) for n in range(4)}
    seen = {name: [size, modified, long_ago] for name, (size, modified) in names.items()}
    monkeypatch.setattr(sync_store, "BLOB_REMOVE_BYTES", 25)
    ordered = sorted(names)
    # The large one goes on a day of its own; the others are not held up behind it.
    assert sync_store.removable_blobs(view_of(blobs=names), seen, NOW) == [ordered[0]]
    del names[ordered[0]]
    assert sync_store.removable_blobs(view_of(blobs=names), seen, NOW) == ordered[1:3]


def test_a_blob_left_only_under_a_copy_name_is_put_back_when_its_content_is_right(store):
    name = local_history.blob_name(digest(b"text"), True)
    (store.blobs / (digest(b"text") + " (2).z")).write_bytes(zlib.compress(b"wrong"))
    (store.blobs / (digest(b"text") + " (1).z")).write_bytes(zlib.compress(b"text"))
    assert {key: sorted(value) for key, value in store.view().copies.items()}         == {name: [digest(b"text") + " (1).z", digest(b"text") + " (2).z"]}
    assert store.recover({name, "0" * 64}) == {name}
    assert name in store.view().blobs
    assert store.recover({name}) == set()  # Already there.


def test_a_copy_written_just_now_is_left_for_later(store):
    """Two PCs tidying the same pair at once could each remove the file the other keeps: a copy is
    tidied only once it was written TEMPORARY_GRACE ago."""
    name = put(store, b"text", True)
    copy = store.blobs / (digest(b"text") + " (1).z")
    copy.write_bytes((store.blobs / name).read_bytes())
    now = datetime.now(timezone.utc)
    sync_store.Cleaner(store, store.view()).leftovers(None, now)
    assert copy.exists()
    old = seconds(now - timedelta(days=2))
    os.utime(copy, (old, old))
    sync_store.Cleaner(store, store.view()).leftovers(None, now)
    assert not copy.exists() and (store.blobs / name).exists()


def test_a_blob_here_but_cut_short_is_replaced_by_a_right_copy(store):
    name = put(store, b"content of the blob", False)
    right = (store.blobs / name).read_bytes()
    (store.blobs / (name + " (1)")).write_bytes(right)
    (store.blobs / name).write_bytes(right[:5])  # Cut short (the other size: "missing" to a generation).
    assert store.recover({name}) == {name}
    assert (store.blobs / name).read_bytes() == right
    # A whole one is left as it is.
    (store.blobs / (name + " (1)")).write_bytes(right)
    assert store.recover({name}) == set()
