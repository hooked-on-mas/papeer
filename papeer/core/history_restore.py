"""Going back: replacing the library with a state from this PC's history, or with a backup ZIP.

Either way the library as it was is first kept in the history, so the restore can itself be undone from
there: as a new "before_restore" state, unless the history already holds that very state, read back whole
(a state synced, or one gone back to earlier): trying several past states in turn then keeps the one the
user started from, rather than pushing it out of the newest SPECIAL_LIMIT "before_restore" states.
The folder the swap moves the old library to is then removed, once that state has been read back whole
from the history (local_history.verified_state); when it cannot be recorded or read back, the folder
stays beside the library as before, and its path is returned. Whatever happens after the swap, the
restore itself has succeeded and is reported so.
"""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import threading

from papeer.core import drive_sync, local_history
from papeer.core.backup import restore_backup, restore_folder
from papeer.core.storage import Library, library_missing
from papeer.providers import Cancelled

Progress = Callable[[str], None]


class _Before:
    """The library as it was before the restore, as the history holds it."""

    def __init__(self, entry: str | None = None, library_hash: str | None = None, *, new: bool = False,
                 verified: bool = False):
        # The state standing for it; whether this restore recorded it (else it was there already, read back
        # whole: `verified`); the library's hash (None when it could not be worked out or recorded).
        self.entry, self.library_hash, self.new, self.verified = entry, library_hash, new, verified


def _record_before(lib: Library, cancel: threading.Event | None, progress: Progress) -> _Before:
    """Keep the library as it is in the history, recording it only when no state read back whole holds it.

    A library without its database (missing, or never used) has nothing to record. Failing to record
    (a full drive, say) does not stop the restore: the old library then stays beside it, as before, and
    what the recording wrote so far is cleaned up.
    """
    if library_missing(lib.root) or not (lib.root / "library.sqlite3").is_file():
        return _Before()
    progress("今のライブラリをこのPCの履歴に記録しています…")
    try:
        library_hash, files = drive_sync.fingerprint_files(lib, cancel)
        try:
            existing = local_history.verified_state(lib.root, library_hash, cancel)
        except Cancelled:
            raise
        except Exception as exc:  # noqa: BLE001 - not read back just now: record it anew instead
            print(f"警告: 履歴の記録を確かめられませんでした: {exc!r}", file=sys.stderr)
            existing = None
        if existing is not None:
            return _Before(existing, library_hash, verified=True)
        # Left as the last restore made it: a past state (with the settings the user kept), not one to keep
        # among the newest "before_restore" states (local_history.retained).
        source = local_history.restored_from(lib.root, library_hash)
        entry = local_history.record_folder(lib.root, lib.root, kind="before_restore", library_hash=library_hash,
                                            counts=drive_sync.library_counts(lib.root), files=files, cancel=cancel,
                                            progress=progress, restored_from=source)
    except Cancelled:
        raise
    except (OSError, ValueError, sqlite3.DatabaseError):
        # Also a damaged database, which a restore is there to mend: the old library stays beside it.
        _prune(lib)
        return _Before()
    return _Before(entry, library_hash, new=entry is not None)


def _prune(lib: Library, protect: list[str] | None = None) -> None:
    """Remove what the settings no longer keep and what a failed recording left (also without folder sync)."""
    try:
        local_history.prune(lib.root, protect=protect or [])
    except Exception as exc:  # noqa: BLE001 - only more stays until the next clean-up
        print(f"警告: 履歴を片付けられませんでした: {exc!r}", file=sys.stderr)


def _finish(lib: Library, moved: Path, before: _Before, progress: Progress) -> str | None:
    """Remove the old library the swap moved aside when the history holds it whole; else its path.

    Runs after the swap, so it never fails: anything going wrong (a virus scan holding a blob, say)
    leaves the folder where it is.
    """
    if before.library_hash is None:
        return str(moved)
    try:
        if not before.verified:
            progress("このPCの履歴を確かめています…")
            if local_history.verified_state(lib.root, before.library_hash) is None:
                return str(moved)
        shutil.rmtree(moved, ignore_errors=True)
        # What could not be removed (a file held open for a moment) stays, and is told.
        return str(moved) if moved.exists() else None
    except Exception:  # noqa: BLE001 - the restore has succeeded; the folder simply stays
        return str(moved)


def _restore(lib: Library, cancel: threading.Event | None, progress: Progress,
             replace: Callable[[], Path], source_entry: str | None = None) -> dict:
    with local_history.holding(lib.root):
        before = _record_before(lib, cancel, progress)
        try:
            moved = replace()
        except BaseException:
            # Nothing was replaced: a state just recorded for it stands for nothing new.
            if before.new and before.entry:
                try:
                    local_history.remove_entries(lib.root, [before.entry])
                except Exception as exc:  # noqa: BLE001 - only an unused state stays; the failure is what is reported
                    print(f"警告: 使われない履歴の記録を削除できませんでした: {exc!r}", file=sys.stderr)
            raise
        previous = _finish(lib, moved, before, progress)
        _remember(lib, source_entry)
        _prune(lib, [before.entry] if before.entry else [])
    return {"previous_path": previous, "before_restore": before.entry}


def _remember(lib: Library, source_entry: str | None) -> None:
    """Note the state the library was restored from, with the library's hash as it is now opened here."""
    if source_entry is None:
        return
    try:
        local_history.remember_restored(lib.root, source_entry, drive_sync.fingerprint(Library(lib.root)))
    except Exception as exc:  # noqa: BLE001 - only the next restore keeps one more "before_restore" state
        print(f"警告: 復元した時点を記録できませんでした: {exc!r}", file=sys.stderr)


def restore_zip(lib: Library, source: Path, cancel: threading.Event | None, progress: Progress, *,
                import_settings: bool) -> dict:
    """Replace the library with a backup ZIP (backup.restore_backup); {"previous_path", "before_restore"}.

    "previous_path" is the old library's folder when it had to stay beside the library, else None.
    """
    def replace() -> Path:
        progress("バックアップを検証して復元しています…")
        return restore_backup(lib, source, cancel, import_settings=import_settings)
    return _restore(lib, cancel, progress, replace)


def restore_entry(lib: Library, entry_id: str, cancel: threading.Event | None, progress: Progress, *,
                  import_settings: bool) -> dict:
    """Replace the library with a state from this PC's history, written out and validated as a backup is."""
    listed = next((item for item in local_history.entries(lib.root) if item["id"] == entry_id), None)
    if listed is None:
        raise ValueError("選んだ時点の記録が見つかりません。")
    if not listed["complete"]:
        raise ValueError("この時点のデータの一部が見つからないため戻せません。")

    def fill(staging: Path) -> None:
        progress("このPCの履歴から組み立てています…")
        try:
            local_history.materialize(lib.root, entry_id, staging, cancel)
        except local_history.HistoryDataMissing as exc:
            local_history.verify_entry(lib.root, entry_id)  # Moves the damaged blobs aside.
            raise ValueError("この時点のデータの一部が見つからないか破損しているため戻せません。") from exc
        progress("組み立てたデータを検証しています…")

    def replace() -> Path:
        return restore_folder(lib, fill, cancel, import_settings=import_settings,
                              schema_version=listed.get("schema_version") or 0, app_version=listed.get("app_version"))
    return _restore(lib, cancel, progress, replace, entry_id)


def difference(lib: Library, entry_id: str, cancel: threading.Event | None = None) -> dict:
    """What differs between the library and a state of the history (drive_sync.library_difference):
    only that state's database is written out, to a temporary file."""
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory) / "library.sqlite3"
        local_history.materialize_database(lib.root, entry_id, target, cancel)
        return drive_sync.library_difference(lib.root / "library.sqlite3", target)
