"""Native connection for canonical edits, separate from the frozen legacy input.

The injected repository remains unaware of paths. This footprint must travel with
the library through the new storage/move/backup service before production cutover.
"""
from contextlib import closing, contextmanager
from pathlib import Path
import sqlite3


def edit_storage_root(legacy_root: Path) -> Path:
    source = Path(legacy_root).resolve()
    if not source.name:
        raise ValueError("edit-storage-library-root")
    return source.with_name("." + source.name + "-shared-app")


def canonical_edit_connection(legacy_root: Path):
    root = edit_storage_root(legacy_root)

    @contextmanager
    def connect():
        if root.is_symlink() or root.is_junction():
            raise ValueError("edit-storage-link-refused")
        root.mkdir(mode=0o700, exist_ok=True)
        path = root / "content.sqlite3"
        if path.is_symlink() or path.is_junction():
            raise ValueError("edit-storage-link-refused")
        with closing(sqlite3.connect(path, timeout=30)) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA foreign_keys=ON")
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise

    return connect
