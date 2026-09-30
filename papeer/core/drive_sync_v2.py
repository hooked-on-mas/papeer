"""Folder sync in the new format (sync_store): what drive_sync.sync does, over generations and blobs.

The app runs it for a sync folder moved to the new format (folder_sync, which also moves one when the user
asks); a folder not moved yet is synced in the first format (drive_sync).

The decision is drive_sync.sync's, three-way as there: this PC's base (the generation it last synced on),
whether this library changed since (its hash), and the heads of the sync folder. What differs:

- A head is a generation no other takes over by its lineage (sync_store.View.heads), not by its parents,
  so a generation removed from the folder does not stop sync ("not arrived yet" in the first format).
- The base need not be in the folder: when a generation there names it in its lineage, it was taken over
  ("inherited"), and the decision is as when it is there. When nothing names it, it has not arrived yet
  (a generation made over it is still on its way), and the sync waits; once it is older than lineages reach
  (sync_store.LINEAGE_DAYS), or when this PC last synced in the first format, the libraries are compared
  whole instead: the same contents move the base, and others are offered as a choice, never taken in unasked.
- A head whose blobs have not all arrived is waited for: {"status": "waiting"}, not an error; nothing is
  taken in or published meanwhile. The user may still go on with this PC's library (choice="local"), which
  keeps the heads it cannot read as not set aside, as a choice over an unreadable revision does now.
- A blob is checked against its name whenever it is read. A damaged one is reported in this PC's device
  file ("bad_blobs") and waited for; the PC whose generation uses it writes it again at its next sync, as it
  writes again any blob its own generations (its base and heads) lack (_repair).
- A revision of the first format that an earlier Papeer published beside the new format is offered as a
  choice (see "The first format's revisions beside the new format" below).

Publishing writes the blobs the sync folder lacks first, from this PC's history (checked against their
names), and the generation last (sync_store). Taking a generation in puts it together beside the library
from the files the library already has, this PC's history and the sync folder, each checked, and swaps it
in once validated as a restore is (backup.restore_folder). A sync that settles then cleans up the folder
(collect_garbage, by sync_store's rules).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import functools
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid

from papeer import __version__
from papeer.core import drive_sync, local_history, sync_store
from papeer.core.backup import restore_folder
from papeer.core.fileio import atomic_write_json, ensure_free_space
from papeer.core.paths import sync_blobs_path
from papeer.core.local_history import BlobDamaged, SourceUnreadable
from papeer.core.storage import SCHEMA_VERSION, Library, NewerSchemaError, database_version, library_missing, newer_papeer
from papeer.core.sync_store import GenerationStore, NewerFormatError, View, blob_names
from papeer.core.sync_client import SYNC_CLIENT
from papeer.providers import Cancelled, check_cancel

# How long a wait goes before the user is told to look at the other PC's Google Drive.
WAIT_WARNING = timedelta(hours=24)
# A base older than this may be missing from every lineage: the libraries are then compared whole.
BASE_EXPIRY = timedelta(days=sync_store.LINEAGE_DAYS)
# The base of a PC whose device file is older than this is no longer kept for it (its blobs are rewritten
# rather than relied on when a new generation uses them again).
DEVICE_KEPT = sync_store.DEVICE_KEPT
# The clean-up of blobs and leftovers runs after a sync at most this often (that of generations, every time).
GC_INTERVAL = timedelta(days=1)
DEVICE_REFRESH = timedelta(days=1)


def _now() -> datetime:
    return sync_store._now()


def _age(value: object) -> timedelta | None:
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return _now() - moment


def _expired(state: dict) -> bool:
    """Whether a base no generation names is compared whole rather than waited for: it is older than lineages
    reach (its time unknown counts as such), or of the first format (this PC last synced in it: the migration's
    generation names the revisions it took over, and one that names none of them cannot be waited for)."""
    if state.get("format") != sync_store.FORMAT:
        return True
    age = _age(state.get("base_created") or state.get("last_sync"))
    return age is None or age > BASE_EXPIRY


@functools.cache
def machine_key() -> str | None:
    """A digest of the ID the OS gives this machine (Windows: MachineGuid; macOS: IOPlatformUUID; Linux:
    machine-id), which a copied device folder does not carry along; None when it cannot be read."""
    value = None
    try:
        if sys.platform == "win32":
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography", 0,
                                winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
                value = str(winreg.QueryValueEx(key, "MachineGuid")[0])
        elif sys.platform == "darwin":
            output = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"], capture_output=True,
                                    text=True, timeout=10, check=False).stdout
            match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', output)
            value = match[1] if match else None
        else:
            for path in (Path("/etc/machine-id"), Path("/var/lib/dbus/machine-id")):
                if path.is_file():
                    value = path.read_text("utf-8").strip()
                    break
    except (OSError, subprocess.SubprocessError, ValueError):
        value = None
    if not value:
        return None
    return hashlib.sha256(b"papeer-machine:" + value.encode("utf-8")).hexdigest()


def _device_id(state: dict) -> str:
    """This PC's ID in the sync folder, made at its first sync in the new format (PC names can collide).

    It stays when the PC is renamed (macOS names itself after the network it is on), so the PC goes on
    repairing the generations it made (_own). A state brought from another PC (its device folder copied)
    gets a new ID, so two PCs never write one device file nor take each other's generations for their own:
    it is told by the machine's own ID (machine_key, recorded in the state as a digest), or, when that cannot
    be read, by the PC's name. A state from before the machine's ID was recorded keeps its ID and records it."""
    value = state.get("device_id")
    name, machine = platform.node(), machine_key()
    recorded = state.get("device_machine")
    if machine is not None and isinstance(recorded, str):
        brought = recorded != machine
    elif machine is None:
        brought = state.get("device_name", name) != name
    else:
        brought = False
    if not (isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value)) or brought:
        value = state["device_id"] = uuid.uuid4().hex
        state["device_created"] = _now().isoformat()
    state["device_name"] = name
    if machine is not None:
        state["device_machine"] = machine
    return value


# --- Waiting ---

def waiting_status(state: dict) -> dict | None:
    """What the sync waits for, told to the user; None when it does not wait."""
    waiting = state.get("waiting")
    if not isinstance(waiting, dict):
        return None
    age = _age(waiting.get("since"))
    overdue = age is not None and age >= WAIT_WARNING
    device = waiting.get("device") if isinstance(waiting.get("device"), str) else None
    name = device or "他のPC"
    missing = waiting.get("missing") if type(waiting.get("missing")) is int else 0
    reason = waiting.get("reason")
    if reason == "base":
        message = (f"前回の同期データが24時間以上届いていません。{SYNC_CLIENT}の同期が止まっていないか確認してください。"
                   if overdue else "前回の同期データが届くのを待っています。")
    elif reason == "damaged":
        message = (f"{name} のデータの一部が壊れていたため、送り直されるのを待っています。"
                   + (f"{name} でPapeerを起動して同期してください。" if overdue else ""))
    else:
        message = (f"{name} のデータが24時間以上届いていません。{name} の{SYNC_CLIENT}の同期が止まっていないか確認してください。"
                   if overdue else f"{name} のデータが届くのを待っています（残り {missing} ファイル）。")
    if overdue:
        message += "待たずに進めるときは「このPCのデータで続ける」を選んでください。"
    return {"reason": reason, "device": device, "missing": missing, "since": waiting.get("since"),
            "overdue": overdue, "heads": waiting.get("heads") or [], "message": message}


def status(root: Path) -> dict:
    """drive_sync.status, with what the sync waits for ("waiting", see waiting_status)."""
    result = drive_sync.status(root)
    result["waiting"] = waiting_status(drive_sync.read_state(root))
    return result


def _write_device(store: GenerationStore, view: View, state: dict) -> None:
    """Write this PC's device file when what it says changed (its base, the blobs it found damaged)."""
    identity = _device_id(state)
    device = {"format": sync_store.FORMAT, "device_id": identity, "device": platform.node(),
              "created": state.get("device_created"), "base": state.get("base"), "updated": _now().isoformat(),
              "app_version": __version__, "bad_blobs": sorted(set(state.get("bad_blobs") or []))}
    current = view.devices.get(identity)
    age = _age(current.get("updated")) if current is not None else None
    # Written again once a day as well, so other PCs keep this PC's base (DEVICE_KEPT) while it syncs.
    if current is not None and age is not None and age < DEVICE_REFRESH and all(
            current.get(key) == device[key] for key in ("device", "base", "app_version", "bad_blobs")):
        return
    try:
        store.write_device(device)
    except OSError:
        pass  # Only other PCs learn of it later: the next sync writes it again.


def _wait(root: Path, store: GenerationStore, view: View, state: dict, *, reason: str, ids: list[str],
          device: str | None, missing: int, bad: set[str] | frozenset[str] = frozenset()) -> dict:
    previous = state.get("waiting")
    if not isinstance(previous, dict):
        previous = {}
    same = previous.get("reason") == reason and previous.get("heads") == ids
    since = previous.get("since") if same and isinstance(previous.get("since"), str) else _now().isoformat()
    state.update(waiting={"reason": reason, "heads": ids, "device": device, "missing": missing, "since": since,
                          # The damaged blobs as they were: a change to one is worth another try (check).
                          "blobs": {name: list(view.blobs[name]) for name in sorted(bad) if name in view.blobs}},
                 conflicts=[], error=None, review=None)
    # The copies Google Drive named "<blob> (1)" of what is waited for, as they were (check: only a change
    # to them is worth another try; one found not to hold the blob is not read again at each check). One that
    # could not be read is left out: it is looked at again as soon as it can be.
    names = _lacking(view, ids) | set(bad)
    unreadable = store.unreadable_copies(view, names)
    state["waiting"]["copies"] = {copy: stat for copy, stat in _copies_of(view, names).items()
                                  if copy not in unreadable}
    if bad:
        state["bad_blobs"] = sorted(set(state.get("bad_blobs") or []) | set(bad))
    drive_sync.save_state(root, state)
    _write_device(store, view, state)
    return {"status": "waiting", "waiting": waiting_status(state), "heads": ids}


def _lacking(view: View, ids: list[str]) -> set[str]:
    """The blobs the heads among `ids` lack (View.missing)."""
    return set().union(*(view.missing(view.generations[i]) for i in ids if i in view.generations))


def _copies_of(view: View, names: set[str]) -> dict[str, list[int]]:
    return {copy: list(stat) for name in sorted(names) for copy, stat in sorted(view.copies.get(name, {}).items())}


# --- Where the content of a blob comes from ---

class _NotReady(Exception):
    """Blobs of a generation missing from the sync folder (or that could not be read just now: waited for
    as for one still arriving, so the next sync tries again), or damaged there."""

    def __init__(self, missing: set[str], bad: set[str]):
        super().__init__()
        self.missing, self.bad = missing, bad


def _library_sources(root: Path, local_files: dict[str, tuple[str, int]]) -> dict[str, Path]:
    """The library's files by the blob each would be (as fingerprint_files read them this sync)."""
    return {local_history.blob_name(digest, local_history.compressed(rel)): root.joinpath(*PurePosixPath(rel).parts)
            for rel, (digest, _size) in local_files.items()}


def _plain_content(path: Path, name: str, cancel, limit: int | None):
    """A file of the library as the content of blob `name`: SourceUnreadable when it cannot be read,
    BlobDamaged when it is not that content (it changed)."""
    digest, size = hashlib.sha256(), 0
    try:
        stream = path.open("rb")
    except OSError as exc:
        raise SourceUnreadable() from exc
    with stream:
        while True:
            check_cancel(cancel)
            try:
                piece = stream.read(1024**2)
            except OSError as exc:
                raise SourceUnreadable() from exc
            if not piece:
                break
            size += len(piece)
            if limit is not None and size > limit:
                raise BlobDamaged()
            digest.update(piece)
            yield piece
    if digest.hexdigest() != name.removesuffix(".z"):
        raise BlobDamaged()


def _bounded(pieces, limit: int | None):
    """The content `pieces` of a blob, BlobDamaged once it holds more than `limit` bytes (what the generation
    says it may hold): reading stops there rather than at the end of a blob unpacking to far more."""
    size = 0
    for piece in pieces:
        size += len(piece)
        if limit is not None and size > limit:
            raise BlobDamaged()
        yield piece


class _Sources:
    """Reads a blob's content from the library, this PC's history, or the sync folder, in that order."""

    def __init__(self, root: Path, store: GenerationStore, view: View, local_files: dict, cancel):
        self.root, self.store, self.view, self.cancel = root, store, view, cancel
        self.library = _library_sources(root, local_files)

    def write(self, output, name: str, size: int | None, limit: int) -> str:
        """Write the content `name` (`size` bytes when known, at most `limit`) into the open file `output` at
        its position; "ok", "missing" (in no source), "unavailable" (the sync folder's copy could not be read
        just now) or "bad" (the sync folder's copy is damaged, and no other source holds it).

        Only content that does not match its name counts as damaged (a blob of the history so found is
        moved aside); a file that cannot be opened or read is left as it is, and tried again next time.
        ValueError when the content found is the one named but not of the size the generation says.
        """
        start = output.tell()
        result = "missing"
        sources = []
        if name in self.library:
            sources.append(("library", lambda: _plain_content(self.library[name], name, self.cancel, limit)))
        history = local_history.blob_file(self.root, name)
        if history is not None:
            sources.append(("history", lambda: _bounded(local_history.stored_content(history, self.cancel), limit)))
        if name in self.view.blobs:
            sources.append(("remote", lambda: _bounded(
                local_history.stored_content(self.store.blob_path(name), self.cancel), limit)))
        for kind, source in sources:
            output.seek(start)
            output.truncate()
            written = 0
            try:
                for piece in source():
                    written += output.write(piece)
            except BlobDamaged:
                if kind == "history":
                    local_history.quarantine(self.root, [name])
                elif kind == "remote":
                    result = "bad"
                continue
            except SourceUnreadable:
                if kind == "remote":
                    result = "unavailable"
                continue
            if size is not None and written != size:
                raise ValueError("同期データの内容が一致しません。")
            return "ok"
        output.seek(start)
        output.truncate()
        return result


def _assemble(root: Path, store: GenerationStore, view: View, generation: dict, target: Path,
              local_files: dict, cancel, *, database_only: bool = False) -> None:
    """Write a generation as a library folder at `target`: _NotReady when a blob is missing or damaged in the
    sync folder (and not held on this PC), ValueError when the database put together is not the one named."""
    files = {} if database_only else generation["files"]
    ensure_free_space({target.parent: sum(size for _digest, size in files.values()) + generation["db"]["size"]})
    target.mkdir(parents=True, exist_ok=True)
    sources = _Sources(root, store, view, local_files, cancel)
    missing, bad = set(), set()

    def note(result: str, name: str) -> None:
        if result in ("missing", "unavailable"):
            missing.add(name)
        elif result == "bad":
            bad.add(name)
    with local_history.holding(root):
        for rel, (digest, size) in files.items():
            name = local_history.blob_name(digest, local_history.compressed(rel))
            path = target.joinpath(*PurePosixPath(rel).parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("wb") as output:
                note(sources.write(output, name, size, size), name)
        database = target / "library.sqlite3"
        with database.open("w+b") as output:
            chunk_size = generation["db"].get("chunk") if type(generation["db"].get("chunk")) is int \
                else local_history.CHUNK
            for chunk in generation["db"]["chunks"]:
                name = local_history.blob_name(chunk, True)
                note(sources.write(output, name, None, chunk_size), name)
    if missing or bad:
        raise _NotReady(missing, bad)
    with database.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != generation["db"]["sha256"] or database.stat().st_size != generation["db"]["size"]:
        raise ValueError("同期データの内容が一致しません。")


# --- Writing ---

def _supply(root: Path, store: GenerationStore, name: str, library: dict[str, Path], cancel,
            limit: int | None = None) -> bool:
    """Write the blob `name` to the sync folder from this PC's history, else from the library's file with that
    content; False when neither holds it whole. A blob of the history found damaged is moved aside; one that
    cannot be read just now (held by a virus scan, say) is left as it is."""
    source = local_history.blob_file(root, name)
    if source is not None:
        try:
            store.put_blob(source, cancel, limit)
            return True
        except BlobDamaged:
            local_history.quarantine(root, [name])
        except SourceUnreadable:
            pass
    path = library.get(name)
    if path is not None:
        try:
            store.put_content(name, path, cancel)
            return True
        except ValueError:  # The file changed meanwhile.
            pass
    return False


def _kept(view: View) -> set[str]:
    """The blobs the generations kept in the folder use (View.kept): a blob only others use may be removed
    by any PC's clean-up at any time."""
    return set().union(*(blob_names(view.generations[i]) for i in view.kept() if i in view.generations))


def _publish(root: Path, store: GenerationStore, view: View, manifest: dict, *, parents: list[str],
             library_hash: str, schema_version: int, counts: dict, device_id: str, local_files: dict,
             cancel, progress, lineage: list[list] | None = None) -> dict:
    """Write a generation of `manifest` over `parents`: the blobs first, then the generation; the generation.

    Blobs the folder lacks are written, and those it has but no kept generation uses, which may be on
    their way out (written again, their clean-up starts over). `lineage` is given for a generation made over
    revisions of the first format (the migration's, folder_sync); else it is worked out from the parents'.
    """
    needed = sorted(view.missing(manifest) | (blob_names(manifest) - _kept(view)))
    library = _library_sources(root, local_files)
    if needed:
        sizes = 0
        for name in needed:
            source = local_history.blob_file(root, name) or library.get(name)
            try:
                sizes += source.stat().st_size if source is not None else 0
            except OSError:
                pass
        ensure_free_space({store.blobs: sizes})
        progress(f"同期フォルダーに書き込んでいます（{len(needed)} 個のファイル）…")
    limits = local_history.blob_limits(manifest)
    with local_history.holding(root):
        for name in needed:
            check_cancel(cancel)
            if not _supply(root, store, name, library, cancel, limits.get(name)):
                raise ValueError("このPCの履歴の一部が見つからないか破損していたため、同期フォルダーに書き込めませんでした。"
                                 "もう一度同期してください。")
    if store.view().missing(manifest):
        raise ValueError(f"同期フォルダーに書き込んだデータが見つかりません。保存先と{SYNC_CLIENT}を確認して再試行してください。")
    check_cancel(cancel)
    now = _now()
    generation = {"format": sync_store.FORMAT, "id": uuid.uuid4().hex, "created": now.isoformat(),
                  "device_id": device_id, "device": platform.node(), "app_version": __version__,
                  "schema_version": schema_version, "parents": list(parents),
                  "lineage": sync_store.lineage(view, parents, now) if lineage is None else lineage,
                  "hash": library_hash, "counts": counts,
                  "db": manifest["db"], "files": manifest["files"]}
    store.write_generation(generation)
    return generation


def _own(view: View, state: dict) -> list[dict]:
    """This PC's own generations the folder keeps: its base, and the heads it made."""
    heads, base = set(view.heads()), state.get("base")
    return [generation for identity, generation in view.generations.items()
            if generation["device_id"] == state.get("device_id") and (identity == base or identity in heads)]


def _checked(state: dict) -> dict:
    value = state.get("checked_blobs")
    return value if isinstance(value, dict) else {}


def _unchecked_reports(view: View, state: dict, own: list[dict]) -> dict[str, list[int]]:
    """The blobs this PC's generations use that another PC (one that synced within DEVICE_KEPT) reports
    damaged, and that this PC has not read whole as they are now (its size and time); each with those."""
    uses = set().union(*(blob_names(generation) for generation in own)) if own else set()
    reported = set()
    for identity, device in view.devices.items():
        age = _age(device.get("updated"))
        if identity != state.get("device_id") and age is not None and age <= DEVICE_KEPT:
            reported.update(device["bad_blobs"])
    checked = _checked(state)
    return {name: list(view.blobs[name]) for name in sorted(reported & uses & set(view.blobs))
            if checked.get(name) != list(view.blobs[name])}


def _repair(root: Path, store: GenerationStore, view: View, state: dict, local_files: dict, cancel,
            progress) -> int:
    """Write again what this PC's own generations (its base, and the heads it made) lack in the folder, or
    what another PC reported damaged among what they use and this PC finds so, from this PC; how many
    blobs were written. A reported blob read whole is remembered as it was ("checked_blobs", saved with the
    state), so it is not read again at each sync while the report stays."""
    own = _own(view, state)
    wanted = set().union(*(view.missing(generation) for generation in own)) if own else set()
    limits: dict[str, int] = {}
    for generation in own:
        limits.update(local_history.blob_limits(generation))
    checked = _checked(state)
    unchecked = _unchecked_reports(view, state, own)
    # What was read whole and is still reported, as it still is; the rest is forgotten.
    kept = {name: value for name, value in checked.items()
            if name in view.blobs and value == list(view.blobs[name]) and name not in wanted}
    for name, seen in unchecked.items():
        if name in wanted:
            continue
        try:
            for _piece in _bounded(local_history.stored_content(store.blob_path(name), cancel), limits.get(name)):
                pass
        except BlobDamaged:
            wanted.add(name)
            continue
        except SourceUnreadable:
            continue  # Not readable just now: tried again at the next sync.
        kept[name] = seen
    state["checked_blobs"] = kept
    if not wanted:
        return 0
    progress("同期フォルダーの欠けたデータを書き直しています…")
    library = _library_sources(root, local_files)
    written = 0
    with local_history.holding(root):
        for name in sorted(wanted):
            check_cancel(cancel)
            try:
                written += _supply(root, store, name, library, cancel, limits.get(name))
            except OSError:
                continue  # Writing to the sync folder failed: the next sync tries again.
    return written


def _recover_names(store: GenerationStore, names: set[str], cancel) -> set[str]:
    try:
        return store.recover(names, cancel)
    except OSError:
        return set()  # Tried again at the next sync.


def _recover(store: GenerationStore, view: View, incomplete: list[str], heads: dict, cancel) -> set[str]:
    """Put back the blobs the incomplete heads lack that are here only as a copy Google Drive renamed
    ("<name> (1)"): another PC's clean-up may have removed the right name, taking it for the copy."""
    names = set().union(*(view.missing(heads[identity]) for identity in incomplete if identity in heads))
    if not names & set(view.copies):
        return set()
    return _recover_names(store, names, cancel)


# --- The clean-up (sync_store) ---

def _read_seen(root: Path, folder: Path) -> dict:
    """When this PC first saw each blob of `folder` (sync_store.remember_blobs); empty for another folder."""
    try:
        value = json.loads(sync_blobs_path(root).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(value, dict) or value.get("folder") != str(folder) or not isinstance(value.get("blobs"), dict):
        return {}
    return value["blobs"]


def collect_garbage(root: Path, store: GenerationStore, state: dict, cancel=None, progress=None) -> list[str]:
    """The clean-up after a sync that settled (never after a choice left open, a review or a wait): the
    generations taken over every time; once a day (GC_INTERVAL) the leftovers, then the blobs nothing uses.
    The paths removed, below "v2".

    It never fails the sync it follows: a file held, the folder gone offline or a stop leaves the rest
    for the next time, which removes it by the same rules (sync_store). The day's run counts as done
    once it starts, so a failure does not make every sync try again.
    """
    cleaner = None
    try:
        view = store.view()
        cleaner = sync_store.Cleaner(store, view, cancel)
        generations = sync_store.removable_generations(view, state.get("base"))
        if generations and progress is not None:
            progress("同期フォルダーの古いデータを片付けています…")
        cleaner.generations(generations)
        if cleaner.removed:
            view = cleaner.view = store.view()
        now = _now()
        earlier = _read_seen(root, store.folder)
        seen = sync_store.remember_blobs(earlier, view, now)
        if seen != earlier:
            atomic_write_json(sync_blobs_path(root), {"folder": str(store.folder), "blobs": seen}, indent=None)
        age = _age(state.get("gc_last"))
        if age is None or age >= GC_INTERVAL or age < timedelta(0):
            state["gc_last"] = now.isoformat()
            drive_sync.save_state(root, state)
            # The copies and leftovers first: a copy put in its place is a blob some generation may use.
            try:
                cleaner.leftovers(state.get("device_id"), now)
            except OSError:
                pass  # The blobs are cleaned up all the same.
            if len(cleaner.removed) or any(view.copies.values()):
                view = cleaner.view = store.view()
            names = sync_store.removable_blobs(view, seen, now)
            if names and progress is not None:
                progress(f"同期フォルダーの使われなくなったデータを片付けています（{len(names)} 個）…")
            cleaner.blobs(names)
    except (OSError, Cancelled):
        pass
    return cleaner.removed if cleaner is not None else []


# --- The first format's revisions beside the new format ---
#
# A folder moved to the new format (folder_sync) keeps the first format's revisions until the user removes
# them, and a marker over those the new format took over (drive_sync.MARKER_SCHEMA), which stops an earlier
# Papeer. One with changes of its own may still choose to publish them over the marker: such a revision is
# a head of the first format that no generation names, and each sync offers it as a choice beside the heads
# (_legacy_heads), never taken in unasked. Chosen or not, the generation that settles the choice names it
# among its parents, and a marker is put over it (_mark_taken_over), so an earlier Papeer stops again.

def legacy_revisions(folder: Path) -> list[dict]:
    """The first format's revisions in `folder`, those that can be read (drive_sync.FolderDrive(strict=False))."""
    try:
        return drive_sync.FolderDrive(folder).revisions(strict=False)
    except (OSError, ValueError):
        return []  # The folder cannot be listed just now: the generations' side says so, if anything.


def _legacy_heads(revisions: list[dict], view: View) -> dict[str, dict]:
    """The revisions an earlier Papeer published that no generation took over, by ID."""
    covered = view.covered() | view.ids()
    return {revision["id"]: revision for revision in drive_sync.revision_heads(revisions)
            if not drive_sync.is_marker(revision) and revision["id"] not in covered}


def _moving(revision: dict) -> bool:
    """Whether a revision of the first format was published by a Papeer that reads the new format as well
    (drive_sync.sync says so): made while the folder was being moved, before the new format reached it."""
    return type(revision.get("newest_format")) is int and revision["newest_format"] >= sync_store.FORMAT


def _mark_taken_over(store: GenerationStore, view: View, revisions: list[dict], cancel) -> str | None:
    """Put a marker over the heads of the first format that a generation took over (in its lineage) but no
    marker stands over yet (a migration stopped before its marker, a revision of an earlier Papeer just
    chosen or left out); its ID, None when there is none to write or it could not be written."""
    covered = view.covered()
    parents = [revision["id"] for revision in drive_sync.revision_heads(revisions)
               if not drive_sync.is_marker(revision) and revision["id"] in covered]
    ids = [identity for identity in view.heads() if identity in view.generations]
    if not parents or not ids:
        return None
    successor = view.generations[_newest(view, ids)]
    try:
        return drive_sync.FolderDrive(store.folder).write_marker(parents, successor["id"], cancel)
    except OSError:
        return None  # Written at the next sync; an earlier Papeer's revision meanwhile is offered as a choice.


def _take_legacy(folder: Path, revision: dict, staging: Path, directory: Path, cancel, progress) -> None:
    """Write a revision of the first format as a library folder at `staging`, checked as drive_sync.sync
    checks one it takes in (its archive's digest, then restored as a backup is)."""
    remote = drive_sync.FolderDrive(folder)
    archive = directory / "legacy.zip"
    remote.download(revision["id"], archive, cancel, progress)
    check_cancel(cancel)
    with archive.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != revision["archive_hash"]:
            raise ValueError("同期データの検証に失敗しました。再試行してください。")
    staging.mkdir()
    drive_sync.restore_backup(Library(staging), archive, cancel)
    archive.unlink()


# --- Choosing between libraries ---

def conflict_differences(root: Path, store: GenerationStore, view: View, ids: list[str], local_files: dict,
                         cancel) -> dict[str, dict | None]:
    """drive_sync.conflict_differences for generations: only each head's database is put together."""
    result: dict[str, dict | None] = {}
    with tempfile.TemporaryDirectory() as directory:
        for identity in ids:
            check_cancel(cancel)
            generation = view.generations.get(identity)
            if generation is None or not view.complete(identity):
                result[identity] = None
                continue
            target = Path(directory) / identity
            try:
                _assemble(root, store, view, generation, target, local_files, cancel, database_only=True)
                result[identity] = drive_sync.library_difference(root / "library.sqlite3", target / "library.sqlite3")
            except Cancelled:
                raise
            except Exception:  # noqa: BLE001 - damaged, still arriving...: the choice is offered without it.
                result[identity] = None
    return result


def _set_aside(lib: Library, store: GenerationStore, view: View, ids: list[str], choice: str, library_hash: str,
               chosen_hash: str, counts: dict, local_files: dict, cancel, progress, recorded: list[str]) -> list[dict]:
    """drive_sync._set_aside for generations: each other head is recorded in this PC's history from the sync
    folder's blobs (only those the history lacks are copied). A head that cannot be read whole is returned
    ({id, device, created}) as not set aside."""
    skipped = []
    for identity in ids:
        generation = view.generations.get(identity)
        if identity == choice or (generation is not None and (
                generation["hash"] == chosen_hash or (generation.get("counts") or {}).get("papers") == 0)):
            continue
        check_cancel(cancel)
        progress("選ばなかったデータを退避しています…")
        entry = None
        if generation is not None and view.complete(identity):
            try:
                entry = local_history.record_manifest(
                    lib.root, generation["files"], generation["db"], store.blob_path, kind="set_aside",
                    library_hash=generation["hash"], counts=generation.get("counts"),
                    schema_version=generation["schema_version"], cancel=cancel, side="remote", revision=identity,
                    source_device=generation["device"], source_created=generation["created"])
            except SourceUnreadable:
                entry = None
        if entry is None:
            skipped.append({"id": identity, "device": generation["device"] if generation else None,
                            "created": generation["created"] if generation else None})
            continue
        recorded.append(entry)
    if choice != "local" and library_hash != chosen_hash and counts.get("papers"):
        check_cancel(cancel)
        progress("選ばなかったデータを退避しています…")
        entry = local_history.record_folder(lib.root, lib.root, kind="set_aside", library_hash=library_hash,
                                            counts=counts, files=local_files, cancel=cancel, progress=progress,
                                            side="local")
        if entry is not None:
            recorded.append(entry)
    return skipped


# --- Sync ---

def _newest(view: View, ids: list[str]) -> str:
    return max(ids, key=lambda identity: (view.created(identity) or 0, identity))


def _single(view: View, ids: list[str], base: str | None) -> str | None:
    """The one head the sync goes by: the only one, or, of heads that all hold the same library (two PCs
    that published the same contents at once), this PC's base or else the newest. None when heads differ
    (a choice) or there is none. The generation this PC publishes next takes over all of them."""
    if len(ids) == 1:
        return ids[0]
    alike = ids and all(identity in view.generations for identity in ids) \
        and len({view.generations[identity]["hash"] for identity in ids}) == 1
    if not alike:
        return None
    return base if base in ids else _newest(view, ids)


def sync(lib: Library, store: GenerationStore, cancel: threading.Event, progress, *, choice: str | None = None,
         expected_heads: list[str] | None = None, confirm: bool = False, background: bool = False) -> dict:
    """drive_sync.sync over a store of the new format (see the module's description for what differs).

    Returns {"status": "synced" | "conflict" | "review" | "deferred" | "waiting", ...} as drive_sync.sync
    does; "waiting" carries what is waited for (waiting_status) and the heads, which serve as
    expected_heads for choice="local" to go on without waiting.
    """
    root = lib.root
    state = drive_sync.read_state(root)
    if not state.get("connected"):
        raise ValueError("同期フォルダーを指定してください。")
    store.check_format()
    device_id = _device_id(state)
    progress("同期フォルダーの変更を確認しています…")
    local_hash, local_files = drive_sync.fingerprint_files(lib, cancel, remember=True)
    dirty = local_hash != state.get("hash")
    base = state.get("base")
    view = store.view()
    if _repair(root, store, view, state, local_files, cancel, progress):
        view = store.view()
    revisions = legacy_revisions(store.folder)
    _mark_taken_over(store, view, revisions, cancel)
    # The heads, and the revisions an earlier Papeer published beside them (offered as choices): together
    # they are what a choice names (expected_heads) and what the generation that settles it takes over.
    current = view.heads()
    legacy = _legacy_heads(revisions, view)
    ids = sorted(current + list(legacy))
    if choice is not None and sorted(expected_heads or []) != ids:
        raise ValueError("別のPCで同期されました。再度同期してから選択してください。")
    if newer := [identity for identity in current if identity in view.newer]:
        raise NewerFormatError(sync_store.NEWER_FORMAT.format(sync_store._newer_papeer(view.newer[newer[0]])))
    heads = {identity: view.generations[identity] for identity in current if identity in view.generations}
    where = view.base_status(base)
    expired = where == "unknown" and _expired(state)
    known_base = base if where in ("visible", "inherited") else None
    counts = drive_sync.library_counts(root)
    review = state.get("review")
    confirmed = bool(confirm and isinstance(review, dict) and review.get("heads") == ids
                     and review.get("hash") == local_hash)

    def finish(**values) -> None:
        values.setdefault("not_set_aside", [])
        state.update(**values, counts=drive_sync.library_counts(root), conflicts=[], error=None, review=None,
                     waiting=None, bad_blobs=[], format=sync_store.FORMAT, last_sync=_now().isoformat())
        state.pop("restored", None)
        drive_sync.save_state(root, state)
        _write_device(store, view, state)

    def ask(value: dict) -> dict:
        state.update(review=value, conflicts=[], error=None, waiting=None)
        drive_sync.save_state(root, state)
        return {"status": "review", "review": drive_sync.status(root)["review"]}

    if (choice is None and ids and len(heads) == len(ids)
            and all(item["hash"] == local_hash and item["schema_version"] <= SCHEMA_VERSION for item in heads.values())):
        # Every head already holds exactly this library (drive_sync.sync's rule, for any number of heads,
        # as two PCs that published the same contents leave): only the base moves, even one no longer known.
        chosen = base if base in ids else _newest(view, ids)
        finish(base=chosen, hash=local_hash, base_created=heads[chosen]["created"])
        collect_garbage(root, store, state, cancel, progress)
        return {"status": "synced", "reloaded": False, "previous_path": None}
    incomplete = [identity for identity in current if not view.complete(identity)]
    if incomplete and _recover(store, view, incomplete, heads, cancel):
        view = store.view()
        incomplete = [identity for identity in current if not view.complete(identity)]
    if choice is None and incomplete:
        first = heads.get(incomplete[0])
        missing = sum(len(view.missing(heads[identity])) if identity in heads else 1 for identity in incomplete)
        return _wait(root, store, view, state, reason="arrival", ids=ids,
                     device=first["device"] if first else None, missing=missing)
    if choice is None and where == "unknown" and not expired:
        return _wait(root, store, view, state, reason="base", ids=ids, device=None, missing=0)
    if choice not in (None, "local"):
        if choice not in ids:
            raise ValueError("選んだ同期データが見つかりません。")
        if choice in incomplete:
            raise ValueError(f"選んだ同期データはまだ届いていません。{SYNC_CLIENT}の同期完了後に再試行してください。")
    single = _single(view, current, base)
    # With no base known (never synced, or one older than any lineage), a differing head is always a choice;
    # so is a revision an earlier Papeer published.
    conflict = bool(legacy) or (single is None and bool(current)) or (
        single is not None and known_base != single and (dirty or known_base is None))
    if conflict and choice is None:
        differences = conflict_differences(root, store, view, current, local_files, cancel)
        earlier = sorted(identity for identity in legacy if not _moving(legacy[identity]))
        if legacy:
            differences.update(drive_sync.conflict_differences(
                root, drive_sync.FolderDrive(store.folder), [legacy[identity] for identity in sorted(legacy)], cancel))
        if earlier:
            device = legacy[earlier[0]]["device"]
            message = (f"{device} の古いバージョンのPapeerで保存された同期データがあります。そのPCのPapeerを更新してください。"
                       "このデータを使うこともできます。保存先・同期で使用するデータを選択してください。")
        elif legacy:
            device = legacy[sorted(legacy)[0]]["device"]
            message = (f"同期の形式を新しくしている途中に、{device} で保存された変更があります。"
                       "保存先・同期で使用するデータを選択してください。")
        elif expired and state.get("format") != sync_store.FORMAT:
            message = "同期の形式が新しくなったため、どちらのデータを使うか確認が必要です。保存先・同期で使用するデータを選択してください。"
        elif expired:
            message = "前回の同期から長い期間がたったため、どちらのデータを使うか確認が必要です。保存先・同期で使用するデータを選択してください。"
        else:
            message = "両方のPCに変更があります。保存先・同期で使用するデータを選択してください。"
        conflicts = []
        for identity in ids:
            item = heads.get(identity) or legacy.get(identity) or {}
            # "legacy": published in the first format beside the new one; "old_papeer": by an earlier Papeer
            # (the choice says to update it), not by one that published before the new format reached it.
            conflicts.append({"id": identity, "device": item.get("device"), "created": item.get("created"),
                              "diff": differences.get(identity), "legacy": identity in legacy,
                              "old_papeer": identity in earlier})
        state.update(conflicts=conflicts, error=message, review=None, waiting=None)
        drive_sync.save_state(root, state)
        return {"status": "conflict", "conflicts": state["conflicts"]}
    publish_local = choice is None and (dirty or not ids) and not (ids and known_base != single)
    if publish_local and not confirmed:
        reference = state.get("counts") or (view.generations.get(base or "") or {}).get("counts")
        if state.get("restored"):
            return ask(drive_sync._review(
                "restored", "バックアップから復元したデータです。同期すると、同期フォルダーと他のPCもこの内容になります。"
                "復元した内容で問題なければ「このまま同期する」を選んでください。",
                reference, counts, ("前回の同期", "このPC（復元後）"), ids, local_hash))
        if kinds := drive_sync.shrunk_kinds(reference, counts):
            return ask(drive_sync._review(
                "shrunk", f"前回の同期から{drive_sync._kinds_text(kinds)}が大きく減っています。"
                "意図した削除でなければ「同期しない」を選び、データを確認してください。",
                reference, counts, ("前回の同期", "このPC"), ids, local_hash))
    previous = None
    library_hash = local_hash
    recorded: list[str] = []
    set_aside: list[str] = []
    spared: list[str] = []
    not_set_aside: list[dict] = []
    uploaded = replaced = False
    base_created = (view.generations.get(base or "") or {}).get("created") or state.get("base_created")
    folder = root.resolve()
    try:
        # Put together beside the library, so the swap renames it rather than copying it across drives.
        with tempfile.TemporaryDirectory(dir=folder.parent, prefix=f".{folder.name}-sync-", suffix=".tmp") as directory:
            selected = heads.get(choice) if choice not in (None, "local") else None
            # A revision of the first format chosen: taken in from its archive, and published as a generation.
            earlier = legacy.get(choice) if choice not in (None, "local") else None
            pull = selected or earlier or (heads[single] if choice is None and single and known_base != single
                                           and not dirty else None)
            content_hash, content_schema, content_counts = local_hash, SCHEMA_VERSION, counts
            staging = Path(directory) / "library"
            if pull:
                if pull.get("schema_version", 0) > SCHEMA_VERSION:
                    raise NewerSchemaError(f"この同期データは{newer_papeer(pull.get('app_version'))}で作成されたため取り込めません。"
                                           "このPCのPapeerを最新版に更新してから同期してください。")
                if background and choice is None:
                    return {"status": "deferred", "reloaded": False, "previous_path": None}
                progress("同期データを組み立てています…")
                try:
                    if earlier is not None:
                        _take_legacy(store.folder, earlier, staging, Path(directory), cancel, progress)
                    else:
                        _assemble(root, store, view, pull, staging, local_files, cancel)
                except _NotReady as exc:
                    _recover_names(store, exc.missing | exc.bad, cancel)  # The next sync (or check) takes it in then.
                    return _wait(root, store, view, state, reason="damaged" if exc.bad else "arrival", ids=ids,
                                 device=pull["device"], missing=len(exc.missing | exc.bad), bad=exc.bad)
                # Hash the database as the publishing PC did, before this version migrates it.
                content_hash, content_files = drive_sync.fingerprint_files(staging, cancel)
                content_schema = database_version(staging / "library.sqlite3")
                if content_hash != pull["hash"]:
                    raise ValueError("同期データの内容が一致しません。")
                content_counts = drive_sync.library_counts(staging)
                if choice is None and not confirmed and (kinds := drive_sync.shrunk_kinds(counts, content_counts)):
                    return ask(drive_sync._review(
                        "remote_shrunk", f"{pull['device']} で保存された同期データでは{drive_sync._kinds_text(kinds)}が大きく減っています。"
                        "取り込むと、このPCのデータもこの内容に置き換わります（元のデータはこのPCに残します）。",
                        counts, content_counts, ("このPC", "同期フォルダー"), ids, local_hash))
                local_hash = content_hash
                if content_schema < SCHEMA_VERSION:
                    # The library as it is once opened here, so taking an older generation is not published again.
                    local_hash, content_files = drive_sync.fingerprint_files(Library(staging), cancel)
                check_cancel(cancel)
                base, base_created = pull["id"], pull["created"]
            else:
                content_files = local_files
            if choice is not None:
                not_set_aside = _set_aside(lib, store, view, current, choice, library_hash, content_hash, counts,
                                           local_files, cancel, progress, set_aside)
                if legacy:
                    not_set_aside += drive_sync.set_aside_revisions(
                        lib, drive_sync.FolderDrive(store.folder), [legacy[identity] for identity in sorted(legacy)],
                        choice, content_hash, cancel, progress, set_aside)
                recorded += set_aside
            publish_hash, publish_schema = content_hash, content_schema
            if choice is not None or (not pull and (dirty or not ids)):
                check_cancel(cancel)
                if earlier is not None:
                    # A revision of the first format has no manifest: it is recorded in this PC's history as
                    # taken in, and published from there as it is once opened here (like this PC's library).
                    progress("このPCの履歴に記録しています…")
                    entry = local_history.record_folder(
                        root, staging, kind="pull", library_hash=local_hash, counts=content_counts,
                        files=content_files, cancel=cancel, progress=progress, revision=earlier["id"],
                        source_device=earlier["device"], source_created=earlier["created"])
                    drive_sync._recorded(recorded, entry)
                    state_id = entry or local_history.current_state(root, local_hash)
                    manifest = local_history.manifest(root, state_id) if state_id else None
                    if manifest is None:
                        raise ValueError("このPCの履歴に記録できませんでした。もう一度同期してください。")
                    publish_hash, publish_schema = local_hash, database_version(staging / "library.sqlite3")
                elif pull:
                    manifest = {"files": pull["files"], "db": pull["db"]}
                else:
                    progress("このPCの履歴に記録しています…")
                    entry = local_history.record_folder(root, root, kind="publish", library_hash=local_hash,
                                                        counts=counts, files=local_files, cancel=cancel,
                                                        progress=progress)
                    drive_sync._recorded(recorded, entry)
                    state_id = entry or local_history.current_state(root, local_hash)
                    manifest = local_history.manifest(root, state_id) if state_id else None
                    if manifest is None:
                        raise ValueError("このPCの履歴に記録できませんでした。もう一度同期してください。")
                generation = _publish(root, store, view, manifest, parents=ids, library_hash=publish_hash,
                                      schema_version=publish_schema, counts=content_counts, device_id=device_id,
                                      local_files=local_files, cancel=cancel, progress=progress)
                uploaded = True
                base, base_created = generation["id"], generation["created"]
            if pull:
                if earlier is None:
                    progress("このPCの履歴に記録しています…")
                    drive_sync._recorded(recorded, local_history.record_folder(
                        root, staging, kind="pull", library_hash=local_hash, counts=content_counts,
                        files=content_files, cancel=cancel, progress=progress, revision=pull["id"],
                        source_device=pull["device"], source_created=pull["created"]))
                progress("このPCの履歴を確かめています…")
                try:
                    kept = local_history.verified_state(root, library_hash, cancel)
                except (OSError, local_history.HistoryBusy):
                    kept = None
                if kept is not None:
                    spared.append(kept)
                def fill(target: Path) -> None:
                    shutil.move(os.fspath(staging), os.fspath(target))
                moved = restore_folder(lib, fill, cancel, schema_version=pull.get("schema_version", 0),
                                       app_version=pull.get("app_version"))
                replaced = True
                if kept is not None:
                    drive_sync._discard_previous(moved)
                else:
                    previous = str(moved)
            if previous:
                state["previous_path"] = previous
            finish(base=base, hash=local_hash, not_set_aside=not_set_aside, base_created=base_created)
    except BaseException:
        if not replaced and not uploaded:
            try:
                local_history.remove_entries(root, recorded)
            except OSError:
                pass
        raise
    if legacy:
        # The revisions of an earlier Papeer the choice took over (or left out): a marker over them stops it again.
        _mark_taken_over(store, store.view(), legacy_revisions(store.folder), cancel)
    collect_garbage(root, store, state, cancel, progress)
    try:
        local_history.prune(root, protect=recorded + spared)
    except OSError:
        pass
    return {"status": "synced", "reloaded": replaced, "previous_path": previous,
            "set_aside": set_aside, "not_set_aside": not_set_aside}


def check(root: Path, store: GenerationStore) -> dict:
    """drive_sync.check for a store of the new format: "none", "pull" or "quiet", reading no library file.

    While the sync waits, only a change in what it waits for (a head, a damaged blob written again, the
    heads now complete) is worth another sync: each would read the whole library to wait again.
    """
    state = drive_sync.read_state(root)
    if not state.get("connected") or library_missing(root):
        return {"action": "none", "local_version": None}
    store.check_format()
    view = store.view()
    ids = view.heads()
    base = state.get("base")
    local_hash, version = drive_sync.recorded_fingerprint(root) if str(root) in drive_sync._VERIFIED else (None, None)

    def answer(action: str) -> dict:
        return {"action": action, "local_version": version}
    if local_hash is None:
        return answer("quiet")
    dirty = local_hash != state.get("hash")
    if _legacy_heads(legacy_revisions(store.folder), view):
        return answer("quiet")  # A revision an earlier Papeer published: the sync offers it as a choice.
    heads = {identity: view.generations[identity] for identity in ids if identity in view.generations}
    own = _own(view, state)
    if any(view.missing(generation) for generation in own) or _unchecked_reports(view, state, own):
        # This PC's own generation lacks a blob, or another PC reports one damaged: the sync looks at it.
        return answer("quiet")
    if ids and len(heads) == len(ids) and all(item["hash"] == local_hash for item in heads.values()):
        return answer("none" if base in ids and not dirty else "quiet")
    where = view.base_status(base)
    waiting = state.get("waiting") if isinstance(state.get("waiting"), dict) else None
    blobs = waiting.get("blobs") if waiting and isinstance(waiting.get("blobs"), dict) else {}
    rewritten = any(list(view.blobs.get(name, ())) != value for name, value in blobs.items())
    # A copy Google Drive renamed ("<blob> (1)") of what is waited for, new or changed since the wait
    # began: the sync puts it back when it holds the blob.
    copies = waiting.get("copies") if waiting and isinstance(waiting.get("copies"), dict) else {}
    rewritten = rewritten or _copies_of(view, _lacking(view, ids) | set(blobs)) != copies
    still = any(not view.complete(identity) for identity in ids) or (where == "unknown" and not _expired(state)) \
        or (waiting is not None and waiting.get("reason") == "damaged")
    if still:
        return answer("none" if waiting and waiting.get("heads") == ids and not rewritten else "quiet")
    known_base = base if where in ("visible", "inherited") else None
    single = _single(view, ids, base)
    if single and known_base and single != known_base and not dirty and heads[single]["hash"] != local_hash:
        action = "pull"
    elif dirty or (bool(ids) and single != known_base):
        action = "quiet"
    else:
        action = "none"
    return answer(action)
