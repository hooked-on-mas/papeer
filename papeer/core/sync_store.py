"""The sync folder's new format (v2): each content stored once, and generations that list what they use.

Inside the folder the user chose for folder sync (beside the revisions of the first format, drive_sync):

    v2/format.json          the format of what follows (FORMAT), written once
    v2/gens/<id>.gen        a generation: the library at one sync, as a manifest (gzip-compressed JSON).
                            Never rewritten once written.
    v2/blobs/<sha256>[.z]   each content once, named and compressed as in this PC's history (local_history):
                            PDFs and images as they are, the rest zlib-compressed (".z"), the database as
                            chunks of local_history.CHUNK bytes
    v2/devices/<id>.json    one per PC, written by that PC only: the generation it last synced on (its base)
                            and the blobs it found damaged

Google Drive for desktop uploads one file at a time, in no particular order, and a file shows in another
PC's folder only once it has arrived whole. So a generation is written last, after every blob it uses,
each to a temporary file renamed into place; a generation whose blobs have not all arrived is incomplete,
and the sync waits for it (drive_sync_v2) instead of failing.

A generation names its parents (the heads it was made over) and its lineage: its ancestors made within
LINEAGE_DAYS or still in the folder (the parents always), newest first, at most LINEAGE_LIMIT. A head is a
generation in no other generation's lineage, so a generation removed from the folder (by the clean-up at
the end of this module) does not make its descendants look incomplete: that it was taken over is written
in them. The folder keeps the heads and the base of each PC that synced recently; the rest, and the blobs
only they used, are removed by whichever PC cleans up first.

This module reads and writes the folder; what a sync does with it is drive_sync_v2. It is not used by the
sync the app runs yet (the first format stays in use until the migration of a later stage).
"""
from __future__ import annotations

from collections.abc import Iterable
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import tempfile
import threading
from typing import cast
import zlib

from papeer import __version__
from papeer.core import local_history
from papeer.core.backup import _RESERVED_NAMES as _RESERVED, DATABASE_FILES, unsafe_path
from papeer.core.fileio import atomic_write_bytes, atomic_write_json, ensure_free_space, is_temporary, move_file
from papeer.providers import check_cancel

FORMAT = 2
FOLDER = "v2"
# A generation keeps in its lineage the ancestors made this recently (and its parents, however old), at
# most LINEAGE_LIMIT of them; a PC whose base is older than that compares whole libraries (drive_sync_v2).
LINEAGE_DAYS = 60
LINEAGE_LIMIT = 5000
# A generation file larger than this, or unpacking to more, is not read (about 200 KB for 300 papers).
GENERATION_LIMIT = 64 * 1024**2
GENERATION_CONTENT_LIMIT = 64 * 1024**2
# A library larger than this is not put together from a generation (as a backup larger is not restored).
LIBRARY_LIMIT = 20 * 1024**3
# The base of a PC whose device file is older than this is no longer kept for it: the PC may be gone for good.
DEVICE_KEPT = timedelta(days=30)
DEVICE_LIMIT = 1024**2

_ID = re.compile(r"[0-9a-f]{32}")
_DIGEST = re.compile(r"[0-9a-f]{64}")
_BLOB = re.compile(r"[0-9a-f]{64}(\.z)?")

NEWER_FORMAT = "この同期データは新しい形式（{}）で保存されています。Papeerを最新版に更新してください。"


def _now() -> datetime:
    """The time generations and device files are written at (replaced in tests)."""
    return datetime.now(timezone.utc)


def _seconds(value: str) -> int:
    """An ISO time as whole seconds since the epoch (a time without a zone is taken as UTC)."""
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp())


def _age(value: object, now: datetime) -> timedelta | None:
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return now - moment


def _newer_papeer(app_version: object) -> str:
    if isinstance(app_version, str) and re.fullmatch(r"[0-9A-Za-z.+-]{1,40}", app_version):
        return f"Papeer {app_version} 以降"
    return "新しいバージョンのPapeer"


class NewerFormatError(ValueError):
    """The sync folder, or a generation, was written in a format newer than this Papeer reads."""


def blob_names(manifest: dict) -> set[str]:
    """The blobs a generation (or any manifest with "files" and "db") uses."""
    return local_history.referenced(manifest)


# Characters Windows does not allow in a file name, and control characters.
_FORBIDDEN = re.compile(r'[\x00-\x1f\x7f<>:"|?*]')
_DATABASE_KEYS = frozenset(name.casefold() for name in DATABASE_FILES)


def _valid_files(files: object) -> bool:
    """Whether every path of a generation may be written in a library folder on any PC: relative, in its
    plain form ("a/b", not "a/./b" or "a//b"), a name Windows can create (backup.unsafe_path, and none of
    the characters it refuses, nor a device name before a space), not the database, and no two paths
    Windows cannot tell apart, nor a file where another path needs a folder."""
    if not isinstance(files, dict):
        return False
    keys = set()
    for rel, item in files.items():
        if (not isinstance(rel, str) or unsafe_path(rel) or _FORBIDDEN.search(rel)
                or "/".join(PurePosixPath(rel).parts) != rel
                or any(part.split(".")[0].rstrip(" ").upper() in _RESERVED for part in PurePosixPath(rel).parts)
                or not isinstance(item, list) or len(item) != 2 or not isinstance(item[0], str)
                or not _DIGEST.fullmatch(item[0]) or type(item[1]) is not int or item[1] < 0):
            return False
        key = rel.casefold()
        if key in keys or key in _DATABASE_KEYS:
            return False
        keys.add(key)
    folders = {"/".join(key.split("/")[:end]) for key in keys for end in range(1, key.count("/") + 1)}
    return not keys & folders


def _valid_generation(value: object, identity: str) -> bool:
    if not isinstance(value, dict):
        return False
    db, lineage = value.get("db"), value.get("lineage")
    return (value.get("format") == FORMAT and value.get("id") == identity
            and all(isinstance(value.get(key), str) for key in ("created", "device_id", "device", "app_version"))
            and isinstance(value.get("hash"), str) and bool(_DIGEST.fullmatch(value["hash"]))
            and type(value.get("schema_version")) is int and value["schema_version"] >= 0
            and isinstance(value.get("parents"), list)
            and all(isinstance(p, str) and _ID.fullmatch(p) for p in value["parents"])
            and isinstance(lineage, list) and len(lineage) <= LINEAGE_LIMIT + len(value["parents"])
            and all(isinstance(item, list) and len(item) == 2 and isinstance(item[0], str) and _ID.fullmatch(item[0])
                    and type(item[1]) is int for item in lineage)
            and (value.get("counts") is None or _valid_counts(value["counts"]))
            and isinstance(db, dict) and type(db.get("size")) is int and db["size"] >= 0
            and isinstance(db.get("sha256"), str) and bool(_DIGEST.fullmatch(db["sha256"]))
            and isinstance(db.get("chunks"), list)
            and all(isinstance(c, str) and _DIGEST.fullmatch(c) for c in db["chunks"])
            and _valid_files(value.get("files"))
            and sum(size for _digest, size in value["files"].values()) + db["size"] <= LIBRARY_LIMIT
            and _valid_created(value["created"]))


def _valid_counts(value: object) -> bool:
    return isinstance(value, dict) and all(isinstance(k, str) and type(v) is int and v >= 0 for k, v in value.items())


def _valid_created(value: str) -> bool:
    try:
        _seconds(value)
    except (ValueError, OverflowError, OSError):
        return False
    return True


# What was read from each generation file, by (path, size, modification time): a generation is never
# rewritten, so the automatic check need not read every one each minute. Shared by every store.
_CACHE: dict[tuple[str, int, int], tuple[str, object]] = {}
_CACHE_LOCK = threading.Lock()


def _read_generation(path: Path, identity: str | None = None) -> tuple[str, object]:
    """("ok", generation), ("newer", app_version) or ("unreadable", None); the generation must have the ID
    `identity` (by default the one its file name says)."""
    try:
        with path.open("rb") as stream:
            packed = stream.read(GENERATION_LIMIT + 1)
        if len(packed) > GENERATION_LIMIT:
            return "unreadable", None
        with gzip.GzipFile(fileobj=io.BytesIO(packed)) as unpacked:
            data = unpacked.read(GENERATION_CONTENT_LIMIT + 1)
        if len(data) > GENERATION_CONTENT_LIMIT:
            return "unreadable", None
        value = json.loads(data)
    except Exception:  # noqa: BLE001 - damaged in any way (gzip, zlib, JSON, UTF-8...): that generation only
        return "unreadable", None
    if isinstance(value, dict) and type(value.get("format")) is int and value["format"] > FORMAT:
        return "newer", value.get("app_version")
    return ("ok", value) if _valid_generation(value, identity or path.stem) else ("unreadable", None)


@dataclass
class View:
    """What the sync folder held when it was looked at."""
    generations: dict[str, dict] = field(default_factory=dict)
    # Generation files that could not be read (damaged, or still being replaced), and those of a newer format.
    unreadable: set[str] = field(default_factory=set)
    newer: dict[str, object] = field(default_factory=dict)
    # Each blob present, with its size and modification time.
    blobs: dict[str, tuple[int, int]] = field(default_factory=dict)
    devices: dict[str, dict] = field(default_factory=dict)
    # When it was looked at (None: never compared with the time, as in a view made by hand).
    now: datetime | None = None
    # The copies Google Drive named "<blob> (1)", by the blob name they stand for, each with its size and
    # modification time (see GenerationStore.recover).
    copies: dict[str, dict[str, tuple[int, int]]] = field(default_factory=dict)

    def ids(self) -> set[str]:
        return set(self.generations) | self.unreadable | set(self.newer)

    def covered(self) -> set[str]:
        """The generations some generation was made over: its parents and the rest of its lineage."""
        result: set[str] = set()
        for generation in self.generations.values():
            result.update(generation["parents"])
            result.update(identity for identity, _time in generation["lineage"])
        return result

    def heads(self) -> list[str]:
        """The generations no other takes over, sorted; one normally, more when PCs synced at once.

        A generation that cannot be read is a head unless one that can be read takes it over: what it
        holds must not be dropped unseen. One its own PC has since gone past (superseded) is not a head.
        """
        covered = self.covered() | self.superseded()
        return sorted(identity for identity in self.ids() if identity not in covered)

    def superseded(self) -> set[str]:
        """Generations made before LINEAGE_DAYS that no generation here names any more, but whose own PC has
        since synced on a later generation (its device file says so): that PC took it over, and the lineage
        that said so aged out. Left from before generations kept their visible ancestors in their lineage
        (see lineage), or by a PC that was away; without this they would come back as heads.

        Only the PC that made a generation can tell: it moves its base on only by publishing over every head
        it sees (this one among them), or by taking in a generation made over it.
        """
        if self.now is None:
            return set()
        horizon = int((self.now - timedelta(days=LINEAGE_DAYS)).timestamp())
        times = {identity: made for generation in self.generations.values() for identity, made in generation["lineage"]}
        times.update({identity: _seconds(generation["created"]) for identity, generation in self.generations.items()})
        covered = self.covered()
        result = set()
        for identity, generation in self.generations.items():
            made = _seconds(generation["created"])
            if identity in covered or made >= horizon:
                continue
            device = self.devices.get(generation["device_id"])
            base = device.get("base") if device else None
            if base and base != identity and times.get(base, made) > made:
                result.add(identity)
        return result

    def kept(self, own_base: str | None = None) -> set[str]:
        """The generations the folder keeps: the heads, this PC's base, and the base of every PC whose device
        file was written within DEVICE_KEPT (a PC away longer compares whole libraries when it is back).
        Only those here count; the time is this view's (every PC's base when it has none)."""
        keep = set(self.heads())
        if own_base:
            keep.add(own_base)
        for device in self.devices.values():
            age = None if self.now is None else _age(device.get("updated"), self.now)
            if device.get("base") and (self.now is None or (age is not None and age <= DEVICE_KEPT)):
                keep.add(device["base"])
        return keep & self.ids()

    def base_status(self, base: str | None) -> str | None:
        """How this PC's base stands: None (no base), "visible" (its file is here), "inherited" (not here,
        but a generation here was made over it: taken over, and removed since) or "unknown" (neither: not
        arrived yet, or older than any lineage reaches)."""
        if not base:
            return None
        if base in self.ids():
            return "visible"
        return "inherited" if base in self.covered() else "unknown"

    def missing(self, generation: dict) -> set[str]:
        """The blobs a generation uses that are not here, or (stored as they are, so of a known size) are
        here with another size: still arriving."""
        wanted = blob_names(generation)
        result = {name for name in wanted if name not in self.blobs}
        for rel, (digest, size) in generation["files"].items():
            name = local_history.blob_name(digest, local_history.compressed(rel))
            if not name.endswith(".z") and name in self.blobs and self.blobs[name][0] != size:
                result.add(name)
        return result

    def complete(self, identity: str) -> bool:
        generation = self.generations.get(identity)
        return generation is not None and not self.missing(generation)

    def created(self, identity: str) -> int | None:
        generation = self.generations.get(identity)
        return _seconds(generation["created"]) if generation is not None else None


class GenerationStore:
    """The v2 folder of one sync folder."""

    def __init__(self, folder: Path):
        if not folder.is_dir():
            raise ValueError("同期フォルダーが見つかりません。PC版Google Driveを確認してください。")
        self.folder = folder
        self.root = folder / FOLDER
        self.gens, self.blobs, self.devices = self.root / "gens", self.root / "blobs", self.root / "devices"

    @classmethod
    def initialize(cls, folder: Path) -> GenerationStore:
        """Start the new format in `folder`: format.json, written once, and the folders.

        A folder that holds revisions of the first format is left alone: moving it to the new format is the
        migration's to do (a later stage), which keeps them readable meanwhile.
        """
        store = cls(folder)
        if not store.exists() and any(folder.glob("*.papeer-sync")):
            raise ValueError("この同期フォルダーには以前の形式の同期データがあります。")
        for place in (store.root, store.gens, store.blobs, store.devices):
            place.mkdir(exist_ok=True)
        if not store.exists():
            atomic_write_json(store.root / "format.json", {"format": FORMAT, "app_version": __version__}, indent=None)
        store.check_format()
        return store

    def exists(self) -> bool:
        return (self.root / "format.json").is_file()

    def check_format(self) -> None:
        """Refuse a folder of another format: NewerFormatError when newer, ValueError when not started."""
        try:
            value = json.loads((self.root / "format.json").read_text("utf-8"))
        except FileNotFoundError:
            raise ValueError("この同期フォルダーには新しい形式の同期データがありません。") from None
        except (OSError, ValueError) as exc:
            raise ValueError("同期フォルダーの形式を読み取れませんでした。PC版Google Driveの同期完了後に再試行してください。") from exc
        if not isinstance(value, dict) or type(value.get("format")) is not int:
            raise ValueError("同期フォルダーの形式を読み取れませんでした。")
        if value["format"] > FORMAT:
            raise NewerFormatError(NEWER_FORMAT.format(_newer_papeer(value.get("app_version"))))
        if value["format"] != FORMAT:
            raise ValueError("同期フォルダーの形式を読み取れませんでした。")

    # --- Reading ---

    def view(self) -> View:
        result = View(now=_now())
        seen = set()
        for entry in _scan(self.gens):
            name = entry.name
            if not name.endswith(".gen") or not _ID.fullmatch(name[:-4]):
                continue  # A temporary file, or a copy Drive named "<name> (1)".
            stat = entry.stat()
            key = (entry.path, stat.st_size, stat.st_mtime_ns)
            seen.add(key)
            with _CACHE_LOCK:
                cached = _CACHE.get(key)
            if cached is None:
                # One that cannot be read is remembered too: mended in place, its size or time changes.
                cached = _read_generation(Path(entry.path))
                with _CACHE_LOCK:
                    _CACHE[key] = cached
            status, value = cached
            identity = name[:-4]
            if status == "ok":
                result.generations[identity] = cast(dict, deepcopy(value))
            elif status == "newer":
                result.newer[identity] = value
            else:
                result.unreadable.add(identity)
        with _CACHE_LOCK:
            for key in [key for key in _CACHE if Path(key[0]).parent == self.gens and key not in seen]:
                del _CACHE[key]
        for entry in _scan(self.blobs):
            if _BLOB.fullmatch(entry.name):
                stat = entry.stat()
                result.blobs[entry.name] = (stat.st_size, stat.st_mtime_ns)
            elif (match := _DUPLICATE.fullmatch(entry.name)) and _BLOB.fullmatch(name := match[1] + (match[3] or "")):
                stat = entry.stat()
                result.copies.setdefault(name, {})[entry.name] = (stat.st_size, stat.st_mtime_ns)
        for entry in _scan(self.devices):
            name = entry.name
            if name.endswith(".json") and _ID.fullmatch(name[:-5]):
                device = _read_device(Path(entry.path), name[:-5])
                if device is not None:
                    result.devices[name[:-5]] = device
        return result

    def recover(self, names: Iterable[str], cancel=None) -> set[str]:
        """Put in place of each blob of `names` that is missing, or here but not whole (the rule of the
        clean-up's copies), a copy Google Drive named "<name> (1)" whose content is that blob's: when a PC's
        clean-up removed the file of the right name as a copy, only the renamed one may be left. The names
        put back."""
        view = self.view()
        result = set()
        for name in names:
            copies = sorted(view.copies.get(name, {}))
            if not copies or (name in view.blobs and _intact(self.blobs / name, name)):
                continue
            for copy in copies:
                if cancel is not None:
                    check_cancel(cancel)
                if _intact(self.blobs / copy, name):
                    try:
                        move_file(self.blobs / copy, self.blobs / name)
                    except FileNotFoundError:
                        continue  # Removed meanwhile.
                    result.add(name)
                    break
        return result

    def blob_path(self, name: str) -> Path:
        if not _BLOB.fullmatch(name):
            raise ValueError("同期データの名前が不正です。")
        return self.blobs / name

    # --- Writing ---

    def put_blob(self, source: Path, cancel=None, limit: int | None = None) -> None:
        """Copy a blob of this PC's history (its file `source`) as it is stored, checked against its name
        (local_history.copy_blob: nothing is written unless it matches)."""
        local_history.copy_blob(source, self.blobs, cancel, limit)

    def put_content(self, name: str, path: Path, cancel=None) -> None:
        """Store the file `path` (of the library) as the blob `name`, compressed when the name says so;
        ValueError when its content is not the one named (the file changed)."""
        descriptor, temporary_name = tempfile.mkstemp(dir=self.blobs, prefix=".blob.", suffix=".tmp")
        temporary = Path(temporary_name)
        try:
            digest = hashlib.sha256()
            compressor = zlib.compressobj(local_history.COMPRESSION) if name.endswith(".z") else None
            with os.fdopen(descriptor, "wb") as output, path.open("rb") as source:
                while piece := source.read(1024**2):
                    if cancel is not None:
                        check_cancel(cancel)
                    digest.update(piece)
                    output.write(compressor.compress(piece) if compressor else piece)
                if compressor:
                    output.write(compressor.flush())
                output.flush()
                os.fsync(output.fileno())
            if digest.hexdigest() != name.removesuffix(".z"):
                raise ValueError("記録中にライブラリのファイルが変わりました。もう一度同期してください。")
            move_file(temporary, self.blobs / name)
        finally:
            temporary.unlink(missing_ok=True)

    def write_generation(self, generation: dict) -> None:
        """Write a generation: the last step of publishing, once every blob it names is here."""
        data = gzip.compress(json.dumps(generation, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), mtime=0)
        ensure_free_space({self.gens: len(data)})
        atomic_write_bytes(self.gens / (generation["id"] + ".gen"), data)

    def write_device(self, device: dict) -> None:
        atomic_write_json(self.devices / (device["device_id"] + ".json"), device, indent=None)


def _scan(folder: Path) -> list[os.DirEntry]:
    """The files of a folder of the store, leaving out temporary files; none when the folder is missing."""
    try:
        with os.scandir(folder) as entries:
            return [entry for entry in entries if entry.is_file() and not is_temporary(Path(entry.name))]
    except FileNotFoundError:
        return []


def _read_device(path: Path, identity: str) -> dict | None:
    try:
        with path.open("rb") as stream:
            data = stream.read(DEVICE_LIMIT + 1)
        value = json.loads(data) if len(data) <= DEVICE_LIMIT else None
    except (OSError, ValueError):
        return None
    if (not isinstance(value, dict) or value.get("device_id") != identity
            or not all(isinstance(value.get(key), str) for key in ("device", "updated"))
            or not (value.get("base") is None or (isinstance(value["base"], str) and _ID.fullmatch(value["base"])))
            or not isinstance(value.get("bad_blobs", []), list)):
        return None
    value["bad_blobs"] = [name for name in value.get("bad_blobs", []) if isinstance(name, str) and _BLOB.fullmatch(name)]
    return value


def lineage(view: View, parents: Iterable[str], now: datetime) -> list[list]:
    """The lineage of a generation made now over `parents`: each parent (however old), and every ancestor
    the parents' lineages name that was made within LINEAGE_DAYS or is still in the folder (kept as some
    PC's base: it must not come back as a head once older), newest first, at most LINEAGE_LIMIT besides
    the parents. [ID, seconds since the epoch] each; a parent that cannot be read counts as made now."""
    moment = int(now.timestamp())
    horizon = int((now - timedelta(days=LINEAGE_DAYS)).timestamp())
    parents = list(dict.fromkeys(parents))
    own: dict[str, int] = {identity: view.created(identity) or moment for identity in parents}
    ancestors: dict[str, int] = {}
    for identity in parents:
        generation = view.generations.get(identity)
        for ancestor, made in generation["lineage"] if generation else []:
            if ancestor not in own and (made >= horizon or ancestor in view.ids()):
                ancestors[ancestor] = max(int(made), ancestors.get(ancestor, 0))
    # Those still in the folder first: dropping one would bring it back as a head.
    visible = view.ids()
    chosen = sorted(ancestors.items(), key=lambda item: (item[0] not in visible, -item[1], item[0]))[:LINEAGE_LIMIT]
    newest = sorted(chosen, key=lambda item: (-item[1], item[0]))
    ordered = sorted(own.items(), key=lambda item: (-item[1], item[0])) + newest
    return [[identity, made] for identity, made in ordered]


# --- Removing what no generation kept uses (the clean-up) ---
#
# Google Drive for desktop moves what is removed from the folder to Drive's trash, where it still counts
# against the storage for 30 days, so the clean-up removes what syncing leaves behind and little else: the
# generations taken over (about 200 KB each) after each sync, and once a day the blobs nothing uses any
# more (mostly database chunks an edit replaced), at most BLOB_REMOVE_LIMIT files or BLOB_REMOVE_BYTES a day.
#
# Two PCs may clean up at once, and Google Drive delivers what each removes late and in any order, so no
# lock is taken; each rule instead holds whichever PC removes what, in whatever order:
# - A generation is removed only when a generation that stays names it in its lineage (taken over), or its
#   own PC has gone past it (View.superseded), and nothing it alone names would come back as a head.
#   Removing it again, or late, changes nothing; the heads and every recent PC's base stay (View.kept).
# - A blob is removed only when no generation here uses it, this PC first saw it (as it is: same size and
#   time) BLOB_GRACE ago, and it was written BLOB_GRACE ago. A generation and its blobs arrive about
#   together, so a blob of a generation still on its way is not taken for unused. A PC that uses a blob
#   again writes it anew when no kept generation used it (its time starts over), and a PC whose own
#   generation lacks a blob writes it again at its next sync (drive_sync_v2._repair); others wait meanwhile.
# - No blob is removed while a generation file cannot be read (it may use any blob).
BLOB_GRACE = timedelta(days=3)
TEMPORARY_GRACE = timedelta(days=1)
BLOB_REMOVE_LIMIT = 2000
BLOB_REMOVE_BYTES = 2 * 1024**3
# "<name> (1)", "<name> (2).gen": what Google Drive names a second file of one name in one folder.
_DUPLICATE = re.compile(r"(.+) \((\d+)\)(\.[a-z]+)?")


def _cover(view: View, identities: Iterable[str]) -> set[str]:
    result: set[str] = set()
    for identity in identities:
        generation = view.generations.get(identity)
        if generation is not None:
            result.update(generation["parents"])
            result.update(item for item, _time in generation["lineage"])
    return result


def removable_generations(view: View, own_base: str | None = None) -> set[str]:
    """The generations the clean-up removes: taken over by one that stays (in its lineage), or superseded
    (View.superseded), and none of those kept (View.kept). One that cannot be read is never removed.

    One is kept after all when removing it would leave a generation it alone takes over as a head.
    """
    keep = view.kept(own_base)
    heads = set(view.heads())
    superseded = view.superseded()
    covered = _cover(view, keep)
    candidates = {identity for identity in view.generations
                  if identity not in keep and (identity in covered or identity in superseded)}
    while candidates:
        remaining = View(generations={identity: generation for identity, generation in view.generations.items()
                                      if identity not in candidates},
                         unreadable=view.unreadable, newer=view.newer, blobs=view.blobs, devices=view.devices,
                         now=view.now)
        uncovered = set(remaining.heads()) - heads
        rescued = {identity for identity in candidates if _cover(view, [identity]) & uncovered}
        if not rescued:
            break
        candidates -= rescued
    return candidates


def remember_blobs(seen: dict, view: View, now: datetime) -> dict:
    """When this PC first saw each blob of the view as it is ({name: [size, time, seconds]}): one written
    anew (another size or time) is seen anew, and one gone is forgotten."""
    moment = int(now.timestamp())
    result = {}
    for name, (size, modified) in view.blobs.items():
        earlier = seen.get(name)
        if isinstance(earlier, list) and len(earlier) == 3 and all(type(n) is int for n in earlier) \
                and earlier[:2] == [size, modified]:
            result[name] = earlier
        else:
            result[name] = [size, modified, moment]
    return result


def removable_blobs(view: View, seen: dict, now: datetime) -> list[str]:
    """The blobs the clean-up removes (see above), written longest ago first, at most BLOB_REMOVE_LIMIT
    and BLOB_REMOVE_BYTES."""
    if view.unreadable or view.newer:
        return []
    used = set().union(*(blob_names(generation) for generation in view.generations.values()))
    latest = int((now - BLOB_GRACE).timestamp())
    candidates = []
    for name, (size, modified) in view.blobs.items():
        first = seen.get(name)
        if (name in used or not isinstance(first, list) or len(first) != 3 or first[:2] != [size, modified]
                or first[2] > latest or modified // 10**9 > latest):
            continue
        candidates.append((modified, name, size))
    result, total = [], 0
    for _modified, name, size in sorted(candidates):
        if len(result) >= BLOB_REMOVE_LIMIT:
            break
        # One larger than the day's bytes goes on a day of its own, rather than hold up every other.
        if result and total + size > BLOB_REMOVE_BYTES:
            continue
        result.append(name)
        total += size
    return result


class Cleaner:
    """Removes files from one store, a blob only while it is as the view saw it; "removed" lists them."""

    def __init__(self, store: GenerationStore, view: View, cancel=None):
        self.store, self.view, self.cancel = store, view, cancel
        self.removed: list[str] = []

    def _check(self) -> None:
        if self.cancel is not None:
            check_cancel(self.cancel)

    def generations(self, identities: Iterable[str]) -> None:
        for identity in sorted(identities):
            self._check()
            self._unlink(self.store.gens / f"{identity}.gen")

    def blobs(self, names: Iterable[str]) -> None:
        for name in names:
            self._check()
            path = self.store.blobs / name
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            # Written again since it was looked at (another PC uses it again): it stays.
            if (stat.st_size, stat.st_mtime_ns) != tuple(self.view.blobs.get(name, ())):
                continue
            self._unlink(path)

    def leftovers(self, own_device: str | None, now: datetime) -> None:
        """Temporary files a forced exit left (older than TEMPORARY_GRACE), and the copies Google Drive names
        "<name> (1)": removed when the file of the right name holds the same, put in its place when that is
        missing (or, for a blob, damaged) and the copy is right. Of device files, this PC's own only:
        another PC's copies are that PC's to tidy."""
        oldest = (now - TEMPORARY_GRACE).timestamp()
        for folder in (self.store.root, self.store.gens, self.store.blobs, self.store.devices):
            try:
                paths = sorted(folder.iterdir())
            except FileNotFoundError:
                continue
            for path in paths:
                self._check()
                try:
                    if not path.is_file():
                        continue
                    if is_temporary(path):
                        if path.stat().st_mtime < oldest:
                            self._unlink(path)
                        continue
                except FileNotFoundError:
                    continue
                match = _DUPLICATE.fullmatch(path.name)
                try:
                    # Written a while ago only: two PCs tidying the same pair at once might otherwise each
                    # remove the file the other keeps.
                    settled = path.stat().st_mtime < oldest
                except FileNotFoundError:
                    continue
                if match and folder != self.store.root and settled:
                    try:
                        self._duplicate(folder, path, match[1] + (match[3] or ""), own_device)
                    except OSError:
                        continue  # Held, or removed meanwhile: the next clean-up looks again.

    def _duplicate(self, folder: Path, path: Path, name: str, own_device: str | None) -> None:
        target = folder / name
        if folder == self.store.blobs:
            if not _BLOB.fullmatch(name):
                return
            if _intact(target, name):
                self._unlink(path)
            elif _intact(path, name):
                move_file(path, target)
        elif folder == self.store.gens:
            if not (name.endswith(".gen") and _ID.fullmatch(name[:-4])):
                return
            if target.is_file() and target.read_bytes() == path.read_bytes():
                self._unlink(path)
            elif not target.exists() and _read_generation(path, name[:-4])[0] == "ok":
                move_file(path, target)  # Checked against the ID its name says (_valid_generation).
        elif own_device and name == f"{own_device}.json":
            self._unlink(path)  # This PC writes its own again when it changes.

    def _unlink(self, path: Path) -> None:
        try:
            path.unlink()
        except OSError:
            return  # Removed by another PC meanwhile, or held for a moment: the next clean-up tries again.
        self.removed.append(path.relative_to(self.store.root).as_posix())


def _intact(path: Path, name: str) -> bool:
    """Whether the file at `path` holds the content the blob name `name` says."""
    try:
        for _piece in local_history.stored_content(path, None, expected=name):
            pass
    except local_history.SourceUnreadable:
        return False
    return True


def forget_device(store: GenerationStore, device_id: str) -> bool:
    """Take a PC off the list (its device file), so its base is no longer kept; whether there was one."""
    if not _ID.fullmatch(device_id):
        raise ValueError("端末のIDが不正です。")
    try:
        (store.devices / f"{device_id}.json").unlink()
    except FileNotFoundError:
        return False
    return True
