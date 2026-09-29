"""The sync folder's new format (sync_store): blobs checked against their names, generations and their lineage."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import json
from pathlib import Path
import uuid
import zlib

import pytest

from papeer.core import drive_sync_v2 as v2, local_history, sync_store
from papeer.core.local_history import SourceUnreadable
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
    assert told["overdue"] and "PC-A のPC版Google Driveの同期が止まっていないか" in told["message"]
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
