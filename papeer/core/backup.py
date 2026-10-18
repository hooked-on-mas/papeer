"""Portable snapshots of the whole library: a backup ZIP, and restoring one in place of the library.

Folder sync (drive_sync) publishes and takes its revisions through these too. The database version a
backup may have is read from storage.SCHEMA_VERSION when the restore runs.
"""
from __future__ import annotations

from collections.abc import Callable
from contextlib import closing
from datetime import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
import zipfile

from papeer import __version__
from papeer.core import storage
from papeer.core.destinations import inside_library
from papeer.core.fileio import atomic_output, ensure_free_space, is_temporary
from papeer.core.item_relations import ATTACHMENT_FORMATS, KIND_NOTEBOOK, KIND_PDF
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library, NewerSchemaError, newer_papeer


def _stop_if_cancelled(cancel: threading.Event | None) -> None:
    if cancel is not None:
        from papeer.providers import check_cancel
        check_cancel(cancel)


# Already compressed: deflating them again takes most of a backup's time and saves a few percent at best.
# Stored entries are part of the ZIP format since its first version, so every Papeer reads these backups.
STORED_SUFFIXES = frozenset({".pdf", ".png", ".jpg", ".jpeg"})
DATABASE_FILES = ("library.sqlite3", "library.sqlite3-wal", "library.sqlite3-shm")


def create_backup(lib: Library, destination: Path, cancel: threading.Event | None = None) -> None:
    """Write the whole library to a ZIP; a cancelled backup leaves no file behind (Cancelled is raised)."""
    destination = destination.resolve()
    if inside_library(destination, lib.root):
        raise ValueError("バックアップはデータ保存フォルダーの外に保存してください。")
    destination.parent.mkdir(parents=True, exist_ok=True)
    files = []
    for path in lib.root.rglob("*"):
        _stop_if_cancelled(cancel)
        # Half-written files left by a forced exit must not travel with the backup or sync.
        if path.is_file() and not is_temporary(path) and path.name not in DATABASE_FILES:
            files.append(path)
    database = sum(path.stat().st_size for path in (lib.root / name for name in DATABASE_FILES[:2]) if path.is_file())
    # The ZIP is at most the files as they are (PDFs and images are stored, the rest shrinks) plus the
    # database, whose snapshot also sits in the temporary folder until the ZIP is complete.
    ensure_free_space({destination: sum(path.stat().st_size for path in files) + database,
                       Path(tempfile.gettempdir()): database})
    with atomic_output(destination) as temporary, tempfile.TemporaryDirectory() as directory:
        snapshot = Path(directory) / "library.sqlite3"
        with lib.connection() as source, closing(sqlite3.connect(snapshot)) as target:
            source.backup(target)
            schema_version = target.execute("PRAGMA user_version").fetchone()[0]
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(snapshot, "library.sqlite3")
            # "version" is the archive layout; schema_version lets an older Papeer refuse a newer library.
            archive.writestr("papeer-backup.json", json.dumps(
                {"version": 1, "schema_version": schema_version, "app_version": __version__}))
            for path in files:
                _stop_if_cancelled(cancel)
                archive.write(path, path.relative_to(lib.root).as_posix(),
                              zipfile.ZIP_STORED if path.suffix.lower() in STORED_SUFFIXES else zipfile.ZIP_DEFLATED)


# Names Windows keeps for devices: a file so named cannot be created in any folder.
_RESERVED_NAMES = frozenset({"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)],
                             *[f"LPT{i}" for i in range(1, 10)]})


def unsafe_path(name: str) -> bool:
    """Whether a path given for a file of the library (a backup's entry, another PC's) must not be written.

    It must be relative, stay inside the library, use "/" only, and be a name Windows can create.
    """
    path = PurePosixPath(name)
    return (path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name or not path.parts
            or any(part.endswith((".", " ")) or part.split(".")[0].upper() in _RESERVED_NAMES for part in path.parts))


# The library's settings (settings.json: connection, model, effort, ...) and the user's prompt texts.
# A restore may keep the current ones instead of taking those in the backup.
SETTINGS_ENTRIES = ("settings.json", "prompts")


def restore_backup(lib: Library, source: Path, cancel: threading.Event | None = None, *,
                   import_settings: bool = True) -> Path:
    """Replace the library with a validated backup and return where the old one was moved.

    With import_settings=False the current settings.json and prompts are kept instead of the backup's.
    Options tied to this PC (cli_path, base_url) are never taken from a backup either way; see config.Settings.load.
    `cancel` is honoured only until the folders are swapped: a cancelled restore leaves the library as it was.
    """
    root = lib.root.resolve()
    staging, previous = _staging_names(root)
    staging.mkdir()
    try:
        with zipfile.ZipFile(source) as archive:
            # The restored copy is written beside the library before the two are swapped.
            ensure_free_space({staging: sum(item.file_size for item in archive.infolist())})
            total = 0
            names = set()
            for item in archive.infolist():
                _stop_if_cancelled(cancel)
                name = item.filename
                path = PurePosixPath(name)
                normalized = "/".join(path.parts).casefold()
                total += item.file_size
                if (unsafe_path(name) or (item.external_attr >> 16) & 0o170000 == 0o120000
                        or total > 20 * 1024**3 or normalized in names):
                    raise ValueError("バックアップに不正なパスまたは大きすぎるデータが含まれます。")
                names.add(normalized)
                target = staging.joinpath(*path.parts)
                if not target.resolve().is_relative_to(staging.resolve()):
                    raise ValueError("バックアップのパスが不正です。")
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as stream, target.open("wb") as output:
                        shutil.copyfileobj(stream, output)
        manifest_path = staging / "papeer-backup.json"
        if not manifest_path.is_file():
            manifest_path = staging / "paperdesk-backup.json"
        if not manifest_path.is_file() or not (staging / "library.sqlite3").is_file():
            raise ValueError("Papeerのバックアップを選択してください。")
        manifest = json.loads(manifest_path.read_text("utf-8"))
        if manifest.get("version") != 1:
            raise ValueError("Papeerのバックアップを選択してください。")
        # Backups made before schema versioning have neither field and are at user_version 0.
        schema_version = manifest.get("schema_version", 0)
        if not isinstance(schema_version, int) or isinstance(schema_version, bool):
            raise ValueError("Papeerのバックアップを選択してください。")
        validate_library(staging, cancel, schema_version=schema_version, app_version=manifest.get("app_version"))
        manifest_path.unlink()
        return _swap_in(root, staging, previous, cancel, import_settings=import_settings)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def validate_library(folder: Path, cancel: threading.Event | None = None, *, schema_version: int = 0,
                     app_version: object = None) -> None:
    """Refuse a library folder about to replace the library unless it is whole: a database this Papeer can
    open (not from a newer one) that passes SQLite's own checks, and the files of every item: a PDF paper's
    original PDF matching the SHA-256 the database records, a notebook's notebook.json and original.pdf
    (made from it, with no recorded digest), and the file of every memo and document an item holds.
    `schema_version` and `app_version` are what the copy says of itself.

    The database may be of an older schema: before papers.kind every row is a PDF paper, and a library
    without the attachments table holds none.
    """
    database = folder / "library.sqlite3"
    if not database.is_file():
        raise ValueError("Papeerのバックアップを選択してください。")
    with closing(sqlite3.connect(database)) as db:
        if max(schema_version, db.execute("PRAGMA user_version").fetchone()[0]) > storage.SCHEMA_VERSION:
            made_by = newer_papeer(app_version if schema_version > storage.SCHEMA_VERSION else None)
            # Neutral wording: sync validates a pulled revision through this path as well.
            raise NewerSchemaError(f"このデータは{made_by}で作成されたため読み込めません。"
                                   "Papeerを最新版に更新してから、もう一度お試しください。")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or db.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("バックアップのデータベースが破損しています。")
        has_kind = "kind" in {row[1] for row in db.execute("PRAGMA table_info(papers)")}
        for paper_id, digest, kind in db.execute(f"SELECT id,sha256,{'kind' if has_kind else repr(KIND_PDF)} FROM papers"):
            _stop_if_cancelled(cancel)
            files = PaperFiles(folder / "papers" / paper_id)
            if not re.fullmatch(r"[0-9a-f]{32}", paper_id) or not files.original_pdf.is_file():
                raise ValueError("バックアップの論文ファイルが不足しています。")
            if kind == KIND_PDF:
                with files.original_pdf.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                        raise ValueError("バックアップの原文PDFが破損しています。")
            elif kind == KIND_NOTEBOOK:
                # sha256 of a notebook is not a digest of its PDF, which is made again whenever its pages change.
                if not files.notebook_json.is_file():
                    raise ValueError("バックアップのノートのファイルが不足しています。")
            else:
                raise ValueError("バックアップのデータベースが破損しています。")
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachments'").fetchone():
            for attachment_id, owner_id, format in db.execute("SELECT id,owner_id,format FROM attachments"):
                _stop_if_cancelled(cancel)
                if (not re.fullmatch(r"[0-9a-f]{32}", attachment_id) or not re.fullmatch(r"[0-9a-f]{32}", owner_id)
                        or format not in ATTACHMENT_FORMATS
                        or not PaperFiles(folder / "papers" / owner_id).attachment(attachment_id, format).is_file()):
                    raise ValueError("バックアップのメモ・資料のファイルが不足しています。")


def _staging_names(root: Path) -> tuple[Path, Path]:
    """(where a restored copy is put together, where the library as it was is moved): beside the library."""
    return (root.with_name(root.name + "-restore-" + uuid.uuid4().hex),
            root.with_name(root.name + "-before-restore-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]))


def _swap_in(root: Path, staging: Path, previous: Path, cancel: threading.Event | None, *, import_settings: bool) -> Path:
    """Put the validated copy at `staging` in place of the library, which moves to `previous`."""
    if not import_settings:
        _keep_current_settings(root, staging)
    # The last point to stop; once the folders are swapped the restore runs to the end.
    _stop_if_cancelled(cancel)
    _rename_folder(root, previous)
    try:
        staging.rename(root)
    except Exception:
        previous.rename(root)
        raise
    return previous


def restore_folder(lib: Library, fill: Callable[[Path], None], cancel: threading.Event | None = None, *,
                   import_settings: bool = True, schema_version: int = 0, app_version: object = None) -> Path:
    """Replace the library with the folder `fill` writes (given a path that does not exist yet, beside the
    library), validated as a backup is (validate_library); where the old one was moved, as restore_backup."""
    root = lib.root.resolve()
    staging, previous = _staging_names(root)
    try:
        fill(staging)
        validate_library(staging, cancel, schema_version=schema_version, app_version=app_version)
        return _swap_in(root, staging, previous, cancel, import_settings=import_settings)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def _rename_folder(source: Path, target: Path, attempts: int = 50, wait: float = 0.1) -> None:
    """Rename a folder, waiting a few seconds while Windows refuses it.

    The sidecar holds no file of the library open by now (a restore waits for every request), but a
    virus scan, the search indexer or Explorer's preview may still have one open for a moment.
    """
    for _ in range(attempts - 1):
        try:
            source.rename(target)
            return
        except PermissionError:
            time.sleep(wait)
    source.rename(target)


def _keep_current_settings(root: Path, staging: Path) -> None:
    """Put the library's current settings and prompts in the restored copy in place of the backup's."""
    for name in SETTINGS_ENTRIES:
        restored, current = staging / name, root / name
        if restored.is_dir():
            shutil.rmtree(restored)
        else:
            restored.unlink(missing_ok=True)
        if current.is_dir():
            shutil.copytree(current, restored)
        elif current.is_file():
            shutil.copy2(current, restored)
