"""Folder sync as the app runs it: the format a sync folder is in, moving it to the new one, and the first
format's data left behind.

A sync folder starts in the first format (drive_sync: a ZIP of the whole library for each revision). Once the
user agrees (the settings ask first: the other PCs must be updated too), migrate() moves it to the new one
(sync_store, drive_sync_v2). Every sync goes by what the folder holds (folder_format): the new format once a
generation is there, the first until then; so a PC that has not synced since another moved the folder follows
it at its next sync, and an earlier Papeer is stopped by the marker (drive_sync.MARKER_SCHEMA).

The migration, on the PC the user asked it on:
1. A sync of the first format settles this PC on the newest revision (drive_sync.sync). When that stops for a
   conflict, a review or a deferred take-in, the migration stops there too; it is remembered
   (state["migration"]), and the sync that settles it goes on with the migration.
2. format.json, then the library's blobs and database chunks (from this PC's history, as any publication).
3. A generation over the newest revision, naming every revision of the first format in its lineage.
4. This PC's device file.
5. A marker over the newest revision (_finish_migration), which stops an earlier Papeer.
6. This PC's state: synced on the generation, in the new format.
Stopped anywhere, the next sync goes on: before 3 the folder is still in the first format, and the migration
starts over (what is in the sync folder already is not written again); after 3 it is in the new format, and
_finish_migration does 5 and 6 before the sync of the new format runs. Its revisions of the first format stay
until the user removes them (remove_old_data), so wherever it stops, nothing is lost.
Two PCs that migrate at once each publish a generation: the same library (both had synced) counts as one head
(drive_sync_v2._single), different ones are offered as a choice. Each also puts a marker; two do no harm.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import datetime
from pathlib import Path
import re
import threading

from papeer.core import drive_sync, drive_sync_v2, local_history, sync_store
from papeer.core.drive_sync import is_marker, read_state, revision_heads, save_state
from papeer.core.storage import SCHEMA_VERSION, Library
from papeer.core.sync_store import GenerationStore, View

Progress = Callable[[str], None]


def folder_format(folder: Path, state: dict) -> int:
    """The format this PC syncs `folder` in: 2 once a generation is there (or this PC last synced in it), or
    when a marker says another PC moved it (Google Drive delivers files in any order: the marker may come
    before the generation it stands for, which is then waited for); else 1."""
    if (folder / sync_store.FOLDER / "format.json").is_file() and (
            state.get("format") == sync_store.FORMAT or GenerationStore(folder).has_generations()):
        return 2
    moved = (folder.is_dir() and any(folder.glob("*.papeer-sync"))
             and any(is_marker(item) for item in drive_sync_v2.legacy_revisions(folder)))
    return 2 if moved else 1


def _pending(state: dict) -> bool:
    return isinstance(state.get("migration"), dict)


def status(root: Path) -> dict:
    """drive_sync.status, with what the sync waits for (drive_sync_v2.waiting_status), the format this PC
    last synced in ("format") and whether a migration it began goes on at the next sync ("migration_pending")."""
    result = drive_sync_v2.status(root)
    state = read_state(root)
    result["format"] = 2 if state.get("format") == sync_store.FORMAT else 1
    result["migration_pending"] = _pending(state)
    return result


def check_connected(root: Path) -> dict:
    """drive_sync.check_connected, in the folder's format; a migration left to go on is "quiet" (the sync
    goes on with it) unless the check has a take-in to tell."""
    state = read_state(root)
    if not state.get("connected") or not state.get("folder"):
        return {"action": "none", "local_version": None}
    try:
        folder = Path(state["folder"])
        if folder_format(folder, state) == 2:
            return drive_sync_v2.check(root, GenerationStore(folder))
        result = drive_sync.check(root, drive_sync.FolderDrive(folder))
        if _pending(state) and result["action"] == "none":
            result["action"] = "quiet"
        return result
    except Exception:  # noqa: BLE001 - as drive_sync.check_connected: the sync reports what is wrong
        return {"action": "quiet", "local_version": None}


def sync_connected(root: Path, cancel: threading.Event, progress: Progress, *, choice: str | None = None,
                   expected_heads: list[str] | None = None, confirm: bool = False, background: bool = False) -> dict:
    """drive_sync.sync_connected in the folder's format, going on with a migration left to go on."""
    options = {"choice": choice, "expected_heads": expected_heads, "confirm": confirm, "background": background}

    def action(folder: Path) -> dict:
        state = read_state(root)
        lib = Library(root)
        if folder_format(folder, state) == 2:
            return _sync_new(lib, folder, state, cancel, progress, **options)
        if _pending(state):
            return _migrate(lib, folder, cancel, progress, **options)
        return drive_sync.sync(lib, drive_sync.FolderDrive(folder), cancel, progress, **options)
    return drive_sync.recording_failure(root, action)


def migrate(root: Path, cancel: threading.Event, progress: Progress) -> dict:
    """Move the sync folder to the new format (the user agreed): the result of a sync, with "migrated" true
    once the folder is in the new format. A folder another PC moved already is synced as it is."""
    def action(folder: Path) -> dict:
        state = read_state(root)
        lib = Library(root)
        if folder_format(folder, state) == 2:
            return {**_sync_new(lib, folder, state, cancel, progress), "migrated": True}
        if not _pending(state):
            # Remembered first: whatever stops the migration from here, the next sync goes on with it.
            state["migration"] = {"started": _now().isoformat()}
            save_state(root, state)
        return _migrate(lib, folder, cancel, progress)
    return drive_sync.recording_failure(root, action)


def _now() -> datetime:
    return sync_store._now()


def _sync_new(lib: Library, folder: Path, state: dict, cancel, progress, **options) -> dict:
    store = GenerationStore(folder)
    if state.get("format") != sync_store.FORMAT and not (store.exists() and store.has_generations()):
        # A marker came before what it stands for: waited for as any generation still arriving.
        marker = next((item for item in drive_sync_v2.legacy_revisions(folder) if is_marker(item)), None)
        return drive_sync_v2._wait(lib.root, store, View(), state, reason="arrival", ids=[],
                                   device=marker["device"] if marker else None, missing=0)
    if _pending(state):
        _finish_migration(lib.root, store, state, cancel)
    return drive_sync_v2.sync(lib, store, cancel, progress, **options)


def _migrate(lib: Library, folder: Path, cancel, progress, *, choice: str | None = None,
             expected_heads: list[str] | None = None, confirm: bool = False, background: bool = False) -> dict:
    root = lib.root
    remote = drive_sync.FolderDrive(folder)
    revisions = remote.revisions()
    state = read_state(root)
    settled = {"status": "synced", "reloaded": False, "previous_path": None}
    if revisions or state.get("base") or choice is not None:
        # 1. On the newest revision first, as any sync of the first format leaves this PC.
        settled = drive_sync.sync(lib, remote, cancel, progress, choice=choice, expected_heads=expected_heads,
                                  confirm=confirm, background=background)
        if settled["status"] != "synced":
            return {**settled, "migrated": False}
        revisions = remote.revisions()
        state = read_state(root)
    parents = sorted(item["id"] for item in revision_heads(revisions))
    if parents != ([state["base"]] if revisions else []):
        # Another PC published meanwhile: the next sync settles on it, then goes on with the migration.
        return {**settled, "migrated": False}
    progress("同期の形式を新しくしています…")
    local_hash, local_files = drive_sync.fingerprint_files(lib, cancel, remember=True)
    if revisions and local_hash != state.get("hash"):
        raise ValueError("同期中にライブラリが変わりました。もう一度同期してください。")
    drive_sync_v2._device_id(state)
    save_state(root, state)  # The device ID, before a generation is made with it (_finish_migration finds it by it).
    # 2. The new format's folder, beside the revisions of the first format.
    store = GenerationStore.initialize(folder, migrate=True)
    view = store.view()
    if view.ids():
        # Another PC moved the folder meanwhile (its generation arrived after this sync began): the next sync
        # follows it (_finish_migration).
        return {**settled, "migrated": False}
    counts = drive_sync.library_counts(root)
    entry = local_history.record_folder(root, root, kind="publish", library_hash=local_hash, counts=counts,
                                        files=local_files, cancel=cancel, progress=progress)
    state_id = entry or local_history.current_state(root, local_hash)
    manifest = local_history.manifest(root, state_id) if state_id else None
    if manifest is None:
        raise ValueError("このPCの履歴に記録できませんでした。もう一度同期してください。")
    # 3. The generation, over the newest revision; its lineage names every revision, so any PC whose base is
    # one of them goes on from it as from a generation it took over.
    drive_sync_v2._publish(root, store, view, manifest, parents=parents, library_hash=local_hash,
                           schema_version=SCHEMA_VERSION, counts=counts, device_id=state["device_id"],
                           local_files=local_files, cancel=cancel, progress=progress,
                           lineage=first_format_lineage(revisions, parents))
    # 4-6.
    _finish_migration(root, store, state, cancel, library_hash=local_hash)
    state.update(counts=counts, last_sync=_now().isoformat(), conflicts=[], error=None, review=None, waiting=None)
    save_state(root, state)
    return {**settled, "migrated": True}


def _seconds(value: object) -> int | None:
    try:
        return sync_store._seconds(value) if isinstance(value, str) else None
    except (ValueError, OverflowError, OSError):
        return None


def first_format_lineage(revisions: list[dict], parents: list[str]) -> list[list]:
    """The lineage of the migration's generation: its parents, then every other revision of the first format,
    newest first, at most sync_store.LINEAGE_LIMIT ([ID, seconds] as sync_store.lineage)."""
    now = int(_now().timestamp())
    times = {item["id"]: _seconds(item["created"]) for item in revisions}
    own = [[identity, times.get(identity) or now] for identity in parents]
    rest = sorted(((identity, made) for identity, made in times.items() if identity not in parents and made is not None),
                  key=lambda item: (-item[1], item[0]))[:sync_store.LINEAGE_LIMIT]
    return own + [[identity, made] for identity, made in rest]


def _finish_migration(root: Path, store: GenerationStore, state: dict, cancel, *,
                      library_hash: str | None = None) -> None:
    """The end of a migration this PC began, in a folder now in the new format: the marker, when there is
    none yet, over the revisions its generation took over, and this PC synced on that generation (made
    here over this PC's base, holding the library last synced, or `library_hash`, the one just published).
    A migration another PC finished first leaves this PC's base to the sync (drive_sync_v2: the generation
    names it, or holds the same library). Saves the state."""
    view = store.view()
    revisions = drive_sync_v2.legacy_revisions(store.folder)
    parents = [state["base"]] if state.get("base") else []
    own = next((generation for generation in view.generations.values()
                if generation["device_id"] == state.get("device_id") and sorted(generation["parents"]) == parents
                and generation["hash"] == (library_hash or state.get("hash"))), None)
    if own is not None:
        # 4. Other PCs keep this PC's base from now on.
        drive_sync_v2._write_device(store, view, {**state, "base": own["id"]})
    if not any(is_marker(item) for item in revisions):
        heads = [identity for identity in view.heads() if identity in view.generations]
        successor = own or (view.generations[drive_sync_v2._newest(view, heads)] if heads else None)
        if successor is not None:
            covered = view.covered()
            taken = [item["id"] for item in revision_heads(revisions) if not is_marker(item) and item["id"] in covered]
            # 5. Put even over no revision (the folder of the first format was empty): it keeps an earlier
            # Papeer from publishing there. A revision no generation took over stays a head beside it.
            drive_sync.FolderDrive(store.folder).write_marker(taken, successor["id"], successor.get("counts") or {}, cancel)
    if own is not None:
        # 6. The generation holds the library this PC last synced (and still holds, unless changed since:
        # then that change is published over it, as any change is).
        state.update(base=own["id"], base_created=own["created"], hash=own["hash"], format=sync_store.FORMAT)
    state.pop("migration", None)
    save_state(root, state)


# --- What the first format left in the sync folder (the settings' 「古い形式の同期データ」) ---

def _removable(revisions: list[dict], view: View) -> list[dict]:
    """The revisions of the first format the new format no longer needs: every one but the markers, and
    those an earlier Papeer published that no generation took over (still offered as choices)."""
    heads = {item["id"] for item in revision_heads(revisions)}
    covered = view.covered()
    return [item for item in revisions
            if not is_marker(item) and (item["id"] not in heads or item["id"] in covered)]


def _files_of(folder: Path, identities: Iterable[str]) -> list[Path]:
    """The files of these revisions: each "<id>.papeer-sync", and the copies Google Drive named "<id> (1).papeer-sync"."""
    wanted = set(identities)
    result = []
    for path in sorted(folder.glob("*.papeer-sync")):
        match = re.fullmatch(r"([0-9a-f]{32})(?: \(\d+\))?", path.stem)
        if match and match[1] in wanted:
            result.append(path)
    return result


def _size(paths: Iterable[Path]) -> int:
    total = 0
    for path in paths:
        try:
            total += path.stat().st_size
        except OSError:
            pass  # Removed meanwhile.
    return total


def format_status(root: Path) -> dict:
    """The sync folder's format and what the first format left there, for the settings.

    "format": 1 or 2 (folder_format), None when not connected; "migration_pending": a migration this PC
    began goes on at the next sync; "revisions": the first format's revisions but the markers (count, size);
    "removable": those remove_old_data removes (their IDs, count and size), none until the folder is in the
    new format; "later": revisions an earlier Papeer published that no generation took over ({id, device,
    created}: offered as choices, never removed); "unmigrated": the PCs (their names) that published in the
    first format within sync_store.DEVICE_KEPT and have not synced in the new one; "ready": the folder is in
    the new format and every PC synced in it, so the removal may be suggested (it may be done at any time).
    """
    state = read_state(root)
    empty = {"count": 0, "size": 0}
    result = {"format": None, "migration_pending": _pending(state), "revisions": dict(empty),
              "removable": {**empty, "ids": []}, "later": [], "unmigrated": [], "ready": False}
    if not state.get("connected") or not state.get("folder"):
        return result
    folder = Path(state["folder"])
    try:
        form = folder_format(folder, state)
    except (OSError, ValueError):
        return result  # The folder cannot be looked at just now (the sync tells why).
    revisions = drive_sync_v2.legacy_revisions(folder)
    plain = [item for item in revisions if not is_marker(item)]
    result.update(format=form, revisions={"count": len(plain), "size": _size(_files_of(folder, (item["id"] for item in plain)))})
    if form != 2:
        return result
    view = GenerationStore(folder).view()
    removable = _removable(revisions, view)
    later = drive_sync_v2._legacy_heads(revisions, view)
    names = {device["device"] for device in view.devices.values()}
    recent: dict[str, int] = {}
    horizon = int((_now() - sync_store.DEVICE_KEPT).timestamp())
    for item in plain:
        made = _seconds(item["created"])
        if made is not None and made >= horizon:
            recent[item["device"]] = max(made, recent.get(item["device"], 0))
    unmigrated = sorted(name for name in recent if name not in names)
    ids = sorted(item["id"] for item in removable)
    result.update(removable={"count": len(ids), "size": _size(_files_of(folder, ids)), "ids": ids},
                  later=[{key: later[identity][key] for key in ("id", "device", "created")} for identity in sorted(later)],
                  unmigrated=unmigrated, ready=bool(ids) and not later and not unmigrated)
    return result


def remove_old_data(root: Path, ids: Iterable[str], cancel: threading.Event | None = None) -> dict:
    """Remove the revisions of the first format the user confirmed (their IDs as format_status listed them),
    those still removable: {"removed": how many, "size": their bytes, "failed": how many could not be}.

    Google Drive moves them to its trash, where they count against the storage for 30 days (the settings say
    so). Once no revision an earlier Papeer published is left to offer, the markers, whose parents are gone,
    are replaced by one of their own (written first), so an earlier Papeer still stops with the message
    asking to update it rather than one saying the data has not all arrived.
    """
    state = read_state(root)
    if not state.get("connected") or not state.get("folder"):
        raise ValueError("同期フォルダーを指定してください。")
    folder = Path(state["folder"])
    if folder_format(folder, state) != 2:
        raise ValueError("同期フォルダーはまだ新しい形式に移っていません。")
    cancel = cancel or threading.Event()
    store = GenerationStore(folder)
    view = store.view()
    revisions = drive_sync_v2.legacy_revisions(folder)
    wanted = set(ids) & {item["id"] for item in _removable(revisions, view)}
    removed = failed = size = 0
    for path in _files_of(folder, wanted):
        try:
            length = path.stat().st_size
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError:
            failed += 1
            continue
        removed += 1
        size += length
    remaining = drive_sync_v2.legacy_revisions(folder)
    present = {item["id"] for item in remaining}
    markers = [item for item in remaining if is_marker(item)]
    heads = [identity for identity in view.heads() if identity in view.generations]
    if (heads and markers and not drive_sync_v2._legacy_heads(remaining, view)
            and any(parent not in present for item in markers for parent in item["parents"])):
        successor = view.generations[drive_sync_v2._newest(view, heads)]
        try:
            drive_sync.FolderDrive(folder).write_marker([], successor["id"], successor.get("counts") or {}, cancel)
        except OSError:
            return {"removed": removed, "size": size, "failed": failed}  # The markers stay as they are.
        for path in _files_of(folder, (item["id"] for item in markers)):
            try:
                path.unlink()
            except OSError:
                pass  # Its parents are gone: an earlier Papeer stops all the same.
    return {"removed": removed, "size": size, "failed": failed}
