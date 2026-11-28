"""Raw, content-addressed migration backup. Never initializes/replays the source Library.

All files are preserved, including SQLite WAL/SHM, notebook journals and interrupted
atomic outputs. A backup is published only after a second complete source scan.
This detects drift; the migration coordinator must separately stop all writers.
"""
from __future__ import annotations

from copy import deepcopy
from contextlib import contextmanager
from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile

from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_contracts import (validate_id, validate_legacybackupmanifest, validate_legacybackupplan,
                                       validate_legacybackupsource, validate_legacybackupentry)
from papeer.core import file_lock
from papeer.core.fileio import replace_file, sync_directory


@dataclass(frozen=True)
class BackupReadLimits:
    """Limits for an optional bounded analysis, not a claim of complete migration."""
    metadata_bytes: int
    entries: int
    total_bytes: int

    def __post_init__(self):
        if any(type(value) is not int or value < 0 for value in
               (self.metadata_bytes, self.entries, self.total_bytes)):
            raise ValueError("backup-read-limit-invalid")


def assert_read_limits(manifests, limits):
    if limits is not None:
        if not isinstance(limits, BackupReadLimits):
            raise ValueError("backup-read-limit-invalid")
        if (sum(len(manifest["entries"]) + len(manifest["containers"]) for manifest in manifests) > limits.entries
                or sum(entry["byteLength"] for manifest in manifests for entry in manifest["entries"]) > limits.total_bytes):
            raise ValueError("backup-read-limit")


# A database file of a working copy: the database itself and its WAL companions (nothing else is ever copied by name).
_SQLITE_FILE = re.compile(r"^[A-Za-z0-9._-]{1,128}\.sqlite3(?:-wal|-shm)?$")


def sqlite_family(name):
    """The three file names of one SQLite database: the database, its -wal and its -shm."""
    return (name, name + "-wal", name + "-shm")


def assert_free_space(path, needed_bytes, margin_bytes):
    """Refuse (`backup-disk-insufficient`) unless the volume of `path` has `needed_bytes + margin_bytes` free."""
    if any(type(value) is not int or value < 0 for value in (needed_bytes, margin_bytes)):
        raise ValueError("backup-disk-limit-invalid")
    if shutil.disk_usage(path).free < needed_bytes + margin_bytes:
        raise ValueError("backup-disk-insufficient")


def inventory_hash(manifest):
    return edit_content_hash({key: manifest[key] for key in ("source", "entries", "containers")})


def assert_backup_manifest(manifest):
    validate_legacybackupmanifest(manifest)
    files = [tuple(entry["key"]) for entry in manifest["entries"]]
    directories = [tuple(key) for key in manifest["containers"]]
    for keys in (files, directories):
        if keys != sorted(set(keys)):
            raise ValueError("backup-key-order-or-duplicate")
    parents = set(directories)
    if any(len(key) > 1 and key[:-1] not in parents for key in files + directories):
        raise ValueError("backup-parent-missing")
    if set(files) & parents:
        raise ValueError("backup-file-container-collision")
    if inventory_hash(manifest) != manifest["inventorySha256"]:
        raise ValueError("backup-inventory-hash")


def assert_backup_plan(plan):
    validate_legacybackupplan(plan)
    assert_backup_manifest(plan["manifest"])


def _safe_stat(path, directory=False):
    value = path.lstat()
    if stat.S_ISLNK(value.st_mode) or getattr(value, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 1024):
        raise ValueError("backup-link-refused")
    if not (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode)):
        raise ValueError("backup-unsupported-file")
    return value


def _stamp(value):
    # Nanosecond/inode values exceed binary64's exact integer range; serialize them losslessly.
    return [str(getattr(value, name)) for name in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")]


def _directory_stamp(value):
    """Identity and times of a folder, without st_size.

    On NTFS a folder's st_size is the allocation of its index, not a description of its contents. CPython 3.12
    reads it through a by-name call that returns 0 while the folder is not cached and the real value (4096, ...)
    once the folder has been listed, so the same unchanged folder can show two sizes between two reads. Added,
    removed and renamed children are caught by listing the names again (see _scan.visit); child contents by each
    child's own stamp and hash.
    """
    return [str(getattr(value, name)) for name in ("st_dev", "st_ino", "st_mtime_ns", "st_ctime_ns")]


def _same_handle(left, right):
    # Windows CPython can report creation time from lstat but modification time
    # through fstat's deprecated ctime field. Keep path-to-path checks complete.
    count = 4 if os.name == "nt" else 5
    return _stamp(left)[:count] == _stamp(right)[:count]


def _read_bounded_bytes(path, max_bytes):
    """Read no more than the limit plus one byte, even if the file grows."""
    if type(max_bytes) is not int or max_bytes < 0:
        raise ValueError("backup-read-limit-invalid")
    before = _safe_stat(path)
    if before.st_size > max_bytes:
        raise ValueError("backup-read-limit")
    with path.open("rb") as stream:
        if not _same_handle(os.fstat(stream.fileno()), before):
            raise ValueError("backup-source-changed")
        data = stream.read(max_bytes + 1)
        after = os.fstat(stream.fileno())
    if len(data) > max_bytes:
        raise ValueError("backup-read-limit")
    if (len(data) != before.st_size or not _same_handle(before, after)
            or _stamp(before) != _stamp(_safe_stat(path))):
        raise ValueError("backup-source-changed")
    return data


def _read_metadata(path, limits):
    """Read a bounded record without trusting a prior path-only size check."""
    if limits is None:
        return path.read_text("utf-8")
    if not isinstance(limits, BackupReadLimits):
        raise ValueError("backup-read-limit-invalid")
    return _read_bounded_bytes(path, limits.metadata_bytes).decode("utf-8")


def _check_cancel(cancel):
    """Raise when an optional Event-like cancel is set; None keeps the previous behavior."""
    if cancel is not None and cancel.is_set():
        raise ValueError("backup-read-cancelled")


def _hash_file(path, *, expected_size=None, cancel=None):
    _check_cancel(cancel)
    before = _safe_stat(path)
    if expected_size is not None and before.st_size != expected_size:
        raise ValueError("backup-object-hash")
    with path.open("rb") as stream:
        if not _same_handle(os.fstat(stream.fileno()), before):
            raise ValueError("backup-source-changed")
        if expected_size is None and cancel is None:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        elif expected_size is None:
            hasher = hashlib.sha256()
            while True:
                _check_cancel(cancel)
                block = stream.read(1024 * 1024)
                if not block:
                    break
                hasher.update(block)
            digest = hasher.hexdigest()
        else:
            hasher = hashlib.sha256()
            remaining = expected_size
            while True:
                _check_cancel(cancel)
                block = stream.read(min(1024 * 1024, remaining + 1))
                if not block:
                    break
                if len(block) > remaining:
                    raise ValueError("backup-object-hash")
                hasher.update(block)
                remaining -= len(block)
            if remaining:
                raise ValueError("backup-object-hash")
            digest = hasher.hexdigest()
        after = os.fstat(stream.fileno())
    if not _same_handle(before, after) or _stamp(before) != _stamp(_safe_stat(path)):
        raise ValueError("backup-source-changed")
    return digest, before.st_size, _stamp(before)


def _directory(path):
    path.mkdir(mode=0o700, exist_ok=True)
    _safe_stat(path, directory=True)


@contextmanager
def _publication_lock(root):
    _safe_stat(root, directory=True)
    path = root / ".publish.lock"
    if path.exists() or path.is_symlink():
        _safe_stat(path)
    handle = file_lock.acquire(path, 5, lambda: OSError("backup-store-busy-or-unlockable"))
    try:
        yield
    finally:
        file_lock.unlock(handle)


def _publish(path, content):
    """Atomic create, without replacing an existing manifest/object with the same identity."""
    _directory(path.parent)
    fd, name = tempfile.mkstemp(prefix=".backup-", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        with _publication_lock(path.parent.parent):
            if path.exists() or path.is_symlink():
                _safe_stat(path)
                if path.read_bytes() != content:
                    raise ValueError("backup-id-reused")
                sync_directory(path.parent)
            else:
                # Cooperative cross-process exclusion + atomic rename also works without hard-link support.
                replace_file(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class FileLegacyBackupStore:
    """Immutable local artifacts for any migration source; no source reads or adoption policy."""
    def __init__(self, root, source):
        validate_legacybackupsource(source)
        self.root, self.source = Path(root).absolute(), deepcopy(source)
        for parent in (self.root, *self.root.parents):
            if parent.exists():
                _safe_stat(parent, directory=True)

    def folders(self):
        for parent in reversed((self.root, *self.root.parents)):
            _directory(parent)
        for name in ("objects", "manifests", "plans"):
            _directory(self.root / name)

    def object_path(self, entry, *, cancel=None):
        validate_legacybackupentry(entry)
        _safe_stat(self.root, directory=True)
        _safe_stat(self.root / "objects", directory=True)
        path = self.root / "objects" / entry["sha256"]
        digest, size, _ = _hash_file(path, expected_size=entry["byteLength"], cancel=cancel)
        if digest != entry["sha256"] or size != entry["byteLength"]:
            raise ValueError("backup-object-hash")
        return path

    def prepare(self, plan):
        stable = deepcopy(plan)
        assert_backup_plan(stable)
        if stable["manifest"]["source"] != self.source:
            raise ValueError("backup-source-identity")
        self.folders()
        _publish(self.root / "plans" / (stable["manifest"]["id"] + ".json"),
                 json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))

    def put_object(self, entry, data):
        stable, content = deepcopy(entry), bytes(data)
        validate_legacybackupentry(stable)
        if len(content) != stable["byteLength"] or hashlib.sha256(content).hexdigest() != stable["sha256"]:
            raise ValueError("backup-object-hash")
        self.folders()
        _publish(self.root / "objects" / stable["sha256"], content)

    def publish(self, manifest):
        stable = deepcopy(manifest)
        assert_backup_manifest(stable)
        if stable["source"] != self.source:
            raise ValueError("backup-source-identity")
        plan = self.plan(stable["id"])
        if plan is None or plan["manifest"] != stable:
            raise ValueError("backup-plan-changed")
        for entry in stable["entries"]:
            self.object_path(entry)
        _publish(self.root / "manifests" / (stable["id"] + ".json"),
                 json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))

    def _record(self, identity, kind, *, limits=None):
        validate_id(identity)
        if not self.root.exists():
            return None
        _safe_stat(self.root, directory=True)
        parent = self.root / kind
        if not parent.exists():
            return None
        _safe_stat(parent, directory=True)
        path = parent / (identity + ".json")
        if not path.exists():
            return None
        _safe_stat(path)
        value = json.loads(_read_metadata(path, limits))
        if kind == "plans":
            assert_backup_plan(value)
            manifest = value["manifest"]
        else:
            assert_backup_manifest(value)
            manifest = value
        if manifest["id"] != identity or manifest["source"] != self.source:
            raise ValueError("backup-source-identity")
        assert_read_limits([manifest], limits)
        return value

    def plan(self, identity, *, limits=None):
        return self._record(identity, "plans", limits=limits)

    def reference(self, identity, *, limits=None):
        return self._record(identity, "manifests", limits=limits)

    def manifest(self, identity, *, limits=None, cancel=None):
        manifest = self.reference(identity, limits=limits)
        if manifest is not None:
            for entry in manifest["entries"]:
                _check_cancel(cancel)
                self.object_path(entry, cancel=cancel)
        return manifest

    def object(self, entry):
        return self.object_path(entry).read_bytes()


class NativeLegacyBackup:
    def __init__(self, source_root: Path, backup_root: Path | None = None, *, source_kind="desktop-library",
                 select: Callable[[tuple[str, ...]], bool] | None = None, selection_id: str | None = None, allow_missing=False):
        source = Path(source_root).absolute()
        if source.exists() or source.is_symlink() or source.is_junction():
            _safe_stat(source, directory=True)
        # Refuse a linked ancestor too; source traversal must not escape through a junction.
        for parent in source.parents:
            if parent.exists():
                _safe_stat(parent, directory=True)
        self.source = source.resolve()
        destination = Path(backup_root).absolute() if backup_root is not None else self.source.with_name("." + self.source.name + "-shared-app-backups")
        for parent in (destination, *destination.parents):
            if parent.exists():
                _safe_stat(parent, directory=True)
        resolved = destination.resolve()
        if resolved.is_relative_to(self.source) or self.source.is_relative_to(resolved):
            raise ValueError("backup-destination-overlaps-source")
        self.root = resolved
        self.source_id = hashlib.sha256(os.path.normcase(str(self.source)).encode("utf-8")).hexdigest()
        if select is not None and not selection_id:
            raise ValueError("backup-selection-identity")
        if source_kind != "desktop-library" or selection_id is not None:
            self.source_id = edit_content_hash([source_kind, os.path.normcase(str(self.source)), selection_id])
        self.store = FileLegacyBackupStore(self.root, {"kind": source_kind, "id": self.source_id})
        self._select, self._allow_missing = select, allow_missing

    def _scan(self, identity):
        validate_id(identity)
        entries, containers, stamps = [], [], []

        def children(folder, key):
            return sorted((path for path in folder.iterdir() if self._select is None or self._select((*key, path.name))), key=lambda path: path.name)

        def directory_stamp(value):
            # A selected footprint ignores unrelated credentials/log/other-library churn,
            # but still checks directory identity and the complete selected name set.
            return _stamp(value)[:2] if self._select is not None else _directory_stamp(value)

        def visit(folder, key):
            before = _safe_stat(folder, directory=True)
            selected = children(folder, key)
            names = [path.name for path in selected]
            stamps.append([key, directory_stamp(before), names] if self._select is not None else [key, directory_stamp(before)])
            for path in selected:
                status = path.lstat()
                child = [*key, path.name]
                if stat.S_ISDIR(status.st_mode):
                    _safe_stat(path, directory=True)
                    containers.append(child)
                    visit(path, child)
                else:
                    digest, size, stamp = _hash_file(path)
                    entries.append({"key": child, "sha256": digest, "byteLength": size})
                    stamps.append([child, stamp])
            if (directory_stamp(before) != directory_stamp(_safe_stat(folder, directory=True))
                    or names != [path.name for path in children(folder, key)]):
                raise ValueError("backup-source-changed")

        if self._allow_missing and not self.source.exists() and not self.source.is_symlink() and not self.source.is_junction():
            stamps.append([[], "missing"])
        else:
            visit(self.source, [])
        entries.sort(key=lambda entry: entry["key"])
        containers.sort()
        manifest = {"version": 1, "id": identity, "source": deepcopy(self.store.source),
                    "entries": entries, "containers": containers, "inventorySha256": ""}
        manifest["inventorySha256"] = inventory_hash(manifest)
        assert_backup_manifest(manifest)
        return {"manifest": manifest, "observationSha256": edit_content_hash(stamps)}

    def inventory(self, identity):
        return self._scan(identity)

    def assert_current(self, plan):
        assert_backup_plan(plan)
        if self._scan(plan["manifest"]["id"]) != plan:
            raise ValueError("backup-source-changed")

    def _folders(self):
        self.store.folders()

    def _object(self, entry, *, cancel=None):
        return self.store.object_path(entry, cancel=cancel)

    def _copy(self, entry):
        target = self.root / "objects" / entry["sha256"]
        if target.exists():
            self._object(entry)
            sync_directory(target.parent)
            return
        source = self.source.joinpath(*entry["key"])
        before = _safe_stat(source)
        fd, name = tempfile.mkstemp(prefix=".backup-", suffix=".tmp", dir=target.parent)
        temporary = Path(name)
        digest = hashlib.sha256()
        size = 0
        try:
            with os.fdopen(fd, "wb") as output, source.open("rb") as incoming:
                if not _same_handle(os.fstat(incoming.fileno()), before):
                    raise ValueError("backup-source-changed")
                for block in iter(lambda: incoming.read(1024 * 1024), b""):
                    output.write(block)
                    digest.update(block)
                    size += len(block)
                output.flush()
                os.fsync(output.fileno())
                after = os.fstat(incoming.fileno())
            if not _same_handle(before, after) or _stamp(before) != _stamp(_safe_stat(source)):
                raise ValueError("backup-source-changed")
            if digest.hexdigest() != entry["sha256"] or size != entry["byteLength"]:
                raise ValueError("backup-source-changed")
            with _publication_lock(self.root):
                if target.exists() or target.is_symlink():
                    self._object(entry)
                    sync_directory(target.parent)
                else:
                    replace_file(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    def capture(self, plan):
        stable = deepcopy(plan)
        assert_backup_plan(stable)
        # Clients cannot inject arbitrary filesystem paths through manifest keys.
        self.assert_current(stable)
        self._folders()
        self.store.prepare(stable)
        for entry in stable["manifest"]["entries"]:
            self._copy(entry)
        self.assert_current(stable)
        manifest = stable["manifest"]
        self.store.publish(manifest)
        result = self.load(manifest["id"])
        if result is None:
            raise ValueError("backup-completion-missing")
        return result

    def _manifest(self, identity):
        return self.store.reference(identity)

    def load(self, identity, *, limits=None, cancel=None):
        return self.store.manifest(identity, limits=limits, cancel=cancel)

    def plan(self, identity, *, limits=None):
        return self.store.plan(identity, limits=limits)

    def object(self, identity, entry):
        manifest = self._manifest(identity)
        if manifest is None or entry not in manifest["entries"]:
            raise ValueError("backup-entry-missing")
        return self._object(entry).read_bytes()

    def _assert_native_keys(self, manifest):
        # A generic backup key is not necessarily a native filesystem component. Validate
        # every component before creating any working files, including on a forged manifest.
        for key in [entry["key"] for entry in manifest["entries"]] + manifest["containers"]:
            for component in key:
                if component in (".", "..") or any(char in component for char in ("/", "\\", ":", "\0")):
                    raise ValueError("backup-native-key")
                if os.name == "nt":
                    stem = component.split(".", 1)[0].upper()
                    if component.endswith((".", " ")) or stem in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}:
                        raise ValueError("backup-native-key")

    @contextmanager
    def _working_directory(self):
        """A fresh private `.analysis-*` folder under the backup root; removed (and only it) when the block ends."""
        _safe_stat(self.root, directory=True)
        directory = Path(tempfile.mkdtemp(prefix=".analysis-", dir=self.root))
        expected_parent = self.root.resolve()
        try:
            yield directory
        finally:
            # The recursive delete is limited to the fresh private working directory.
            # In particular, never follow a replaced root/junction into input or backup objects.
            _safe_stat(directory, directory=True)
            resolved = directory.resolve()
            if self.root.resolve() != expected_parent or resolved == expected_parent or not resolved.is_relative_to(expected_parent):
                raise ValueError("backup-analysis-cleanup-path")
            shutil.rmtree(directory)

    def _copy_into(self, directory, entry, cancel=None):
        """Copy one verified backup object to its key under `directory`, re-hashing the written file."""
        target = directory.joinpath(*entry["key"])
        incoming = self._object(entry) if cancel is None else self._object(entry, cancel=cancel)
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            before = _safe_stat(incoming)
            if before.st_size != entry["byteLength"]:
                raise ValueError("backup-object-hash")
            with incoming.open("rb") as stream:
                if not _same_handle(os.fstat(stream.fileno()), before):
                    raise ValueError("backup-source-changed")
                remaining = entry["byteLength"]
                while True:
                    _check_cancel(cancel)
                    block = stream.read(min(1024 * 1024, remaining + 1))
                    if not block:
                        break
                    if len(block) > remaining:
                        raise ValueError("backup-object-hash")
                    output.write(block)
                    remaining -= len(block)
                if remaining:
                    raise ValueError("backup-object-hash")
                after = os.fstat(stream.fileno())
            if not _same_handle(before, after) or _stamp(before) != _stamp(_safe_stat(incoming)):
                raise ValueError("backup-source-changed")
        digest, size, _ = _hash_file(target, expected_size=entry["byteLength"], cancel=cancel)
        if digest != entry["sha256"] or size != entry["byteLength"]:
            raise ValueError("backup-object-hash")

    @contextmanager
    def analysis_copy(self, identity, *, limits=None, cancel=None):
        """Verified, disposable input for SQL recovery/parsing. Never hard-link immutable backup bodies.

        This is not rollback into the old source: the migration coordinator must separately
        quarantine active edits and restore the entire registered source set for that operation.
        """
        if limits is None and cancel is None:
            manifest = self.load(identity)
        else:
            manifest = self.load(identity, limits=limits, cancel=cancel)
        if manifest is None:
            raise ValueError("backup-completion-missing")
        self._assert_native_keys(manifest)
        with self._working_directory() as directory:
            for key in manifest["containers"]:
                _directory(directory.joinpath(*key))
            for entry in manifest["entries"]:
                _check_cancel(cancel)
                self._copy_into(directory, entry, cancel)
            _check_cancel(cancel)
            yield directory

    @contextmanager
    def sqlite_working_copy(self, identity, names, *, limits=None, cancel=None, free_margin=None):
        """A verified, disposable copy of only the named SQLite files (a database and its -wal/-shm) of one backup.

        For analysis that must open a database but needs no other file (work B7-b, DESIGN-r161-b7-staging.md 7.2): the
        files are top-level entries of the manifest, copied the way `analysis_copy` copies them (same checks, same `.analysis-*`
        folder, same cleanup), so the first analysis of the copy can still require its tree to equal the manifest's
        entries restricted to `names`. Names the manifest does not hold are skipped. Every other file stays in the immutable
        backup: `load` below verifies all objects (size and sha256) once, and `read_object` verifies each object it reads.

        A copy that has been opened is no longer equal to the manifest (SQLite writes `-shm`, and for a cleanly closed WAL
        database `-wal` too, inside the copy): check the tree before the first open, then share the copy.
        `free_margin` (bytes) refuses before anything is created when the volume of the backup root has less free space than
        the files to copy plus the margin (`backup-disk-insufficient`).
        """
        names = tuple(names)
        if not all(isinstance(name, str) and _SQLITE_FILE.fullmatch(name) for name in names):
            raise ValueError("backup-working-copy-name")
        if limits is None and cancel is None:
            manifest = self.load(identity)
        else:
            manifest = self.load(identity, limits=limits, cancel=cancel)
        if manifest is None:
            raise ValueError("backup-completion-missing")
        self._assert_native_keys(manifest)
        wanted = [entry for entry in manifest["entries"] if len(entry["key"]) == 1 and entry["key"][0] in names]
        if free_margin is not None:
            assert_free_space(self.root, sum(entry["byteLength"] for entry in wanted), free_margin)
        with self._working_directory() as directory:
            for entry in wanted:
                _check_cancel(cancel)
                self._copy_into(directory, entry, cancel)
            _check_cancel(cancel)
            yield directory

    def read_object(self, identity, entry, *, limits=None, cancel=None, max_bytes=None):
        """The bytes of one object of this backup's manifest, read once and verified (size and sha256) before they are returned.

        `entry` must be an entry of the manifest `identity`. An object larger than `max_bytes` (default: the limits' total_bytes,
        when limits are given) is refused with `backup-read-limit` before anything is read. The read is cancellable every MiB.
        The whole object is held in memory (and copied once more when it is returned): the caller bounds `max_bytes`.
        """
        manifest = self.store.reference(identity, limits=limits)
        if manifest is None or entry not in manifest["entries"]:
            raise ValueError("backup-entry-missing")
        limit = max_bytes if max_bytes is not None else (limits.total_bytes if limits is not None else None)
        if limit is not None and (type(limit) is not int or limit < 0):
            raise ValueError("backup-read-limit-invalid")
        if limit is not None and entry["byteLength"] > limit:
            raise ValueError("backup-read-limit")
        _check_cancel(cancel)
        _safe_stat(self.root, directory=True)
        _safe_stat(self.root / "objects", directory=True)
        path = self.root / "objects" / entry["sha256"]
        before = _safe_stat(path)
        if before.st_size != entry["byteLength"]:
            raise ValueError("backup-object-hash")
        data = bytearray(entry["byteLength"])
        hasher = hashlib.sha256()
        with path.open("rb") as stream:
            if not _same_handle(os.fstat(stream.fileno()), before):
                raise ValueError("backup-source-changed")
            view, filled = memoryview(data), 0
            while filled < len(data):
                _check_cancel(cancel)
                count = stream.readinto(view[filled:filled + 1024 * 1024])
                if not count:
                    raise ValueError("backup-object-hash")
                hasher.update(view[filled:filled + count])
                filled += count
            if stream.read(1):
                raise ValueError("backup-object-hash")
            after = os.fstat(stream.fileno())
        if not _same_handle(before, after) or _stamp(before) != _stamp(_safe_stat(path)):
            raise ValueError("backup-source-changed")
        if hasher.hexdigest() != entry["sha256"]:
            raise ValueError("backup-object-hash")
        return bytes(data)
