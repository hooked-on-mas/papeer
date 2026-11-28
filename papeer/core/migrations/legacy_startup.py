"""Durable admission of the old runtime before recovery/migration can change its input.

This hold is not proof that existing jobs, tabs or remote writers have quiesced.
It stays outside every old input root, has no timeout, and has no unverified release path.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import stat
from typing import Literal

from papeer.core.edit_contracts import validate_legacymigrationhold
from papeer.core.errors import Conflict
from papeer.core.migrations.legacy_backup import _directory, _publish, _read_bounded_bytes, _safe_stat


def read_native_legacy_presence(library_root: Path) -> Literal['clear', 'legacy-present']:
    """Observe the raw Library footprint without opening SQL or reading any source body.

    This is a startup gate, not an inventory or migration-completion proof. Any file,
    including an empty/corrupt database, WAL, journal, note or ink, needs recovery or
    migration. Empty directories alone are clear. A linked/unreadable/changing tree
    cannot prove absence. Canonical storage and instance locks live outside this root.
    """
    source = Path(library_root).absolute()
    # Do not resolve a linked root/ancestor before checking it.
    for parent in reversed((source, *source.parents)):
        try:
            _safe_stat(parent, directory=True)
        except FileNotFoundError:
            return 'clear'
    pending = [source]
    observed = []
    examined = 0
    while pending:
        folder = pending.pop()
        before = _safe_stat(folder, directory=True)
        with os.scandir(folder) as entries:
            for entry in entries:
                examined += 1
                if examined > 10_000:
                    raise ValueError('legacy-presence-unverifiable')
                path = Path(entry.path)
                value = path.lstat()
                directory = stat.S_ISDIR(value.st_mode)
                _safe_stat(path, directory=directory)
                if not directory:
                    return 'legacy-present'
                pending.append(path)
        after = _safe_stat(folder, directory=True)
        if (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('legacy-presence-changed')
        observed.append((folder, after))
    # Recheck earlier parents after visiting empty descendants. This is still an
    # observation, not proof that an external writer has quiesced.
    for folder, before in observed:
        after = _safe_stat(folder, directory=True)
        if (before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('legacy-presence-changed')
    return 'clear'


class LegacyMigrationRequired(Conflict):
    def __init__(self):
        super().__init__("データを移行中のため、以前の形式のライブラリを開けません。移行画面で状態を確認してください。", code="legacy_migration_required")


class NativeLegacyStartup:
    def __init__(self, library_root: Path):
        source = library_root.resolve()
        self.root = source.with_name("." + source.name + "-shared-app-backups")
        self.path = self.root / "bootstrap" / "hold.json"

    def read(self):
        if not self.path.exists() and not self.path.is_symlink() and not self.path.is_junction():
            return None
        for parent in (self.path.parent, *self.path.parent.parents):
            _safe_stat(parent, directory=True)
        value = json.loads(_read_bounded_bytes(self.path, 65_536).decode("utf-8"))
        validate_legacymigrationhold(value)
        return value

    def hold(self, value):
        stable = deepcopy(value)
        validate_legacymigrationhold(stable)
        for parent in reversed((self.path.parent, *self.path.parent.parents)):
            _directory(parent)
        try:
            _publish(self.path, json.dumps(stable, sort_keys=True, separators=(",", ":")).encode())
        except ValueError as exc:
            if str(exc) != "backup-id-reused":
                raise
            raise LegacyMigrationRequired() from exc
        return self.read()


def legacy_startup_allowed(root: Path) -> bool:
    try:
        startup = NativeLegacyStartup(root)
        if startup.read() is not None:
            return False
        # A journal can predate the hold, or survive its removal during cancel.
        # Persisted evidence never grants a live lease; unknown state blocks.
        from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal, selection_binding
        from papeer.core import paths
        journal = NativePreparationJournal(root)
        record = journal.read()
        if record is None:
            # An orphan InputSet, event or incomplete journal is not empty state.
            return not (journal.folder.exists() or journal.folder.is_symlink() or journal.folder.is_junction())
        return (journal.event(record['runId'], 'cancel-intent') and journal.event(record['runId'], 'cancel-complete')
                and journal.cleanup_state(record['runId']) == 'complete'
                and selection_binding(root, paths.device_directory()) == record['selectionSha256'])
    except (OSError, ValueError, TypeError, RecursionError):
        return False


def assert_legacy_startup(root: Path):
    if not legacy_startup_allowed(root):
        raise LegacyMigrationRequired()
