"""Choose the library's local folder, copying it at the next launch before any work starts.

The source is kept. Both libraries are locked while copying, and the setting changes only once the
complete copy has been published. A failed copy leaves the current library selected and reports why.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

from papeer.core import paths
from papeer.core.device_authority import device_writer
from papeer.core.fileio import atomic_write_bytes, atomic_write_json, ensure_free_space, is_temporary, sync_directory
from papeer.core.instance import LibraryLock
from papeer.core.storage import library_missing


@device_writer
def _save(value: dict) -> None:
    folder = paths.device_directory()
    folder.mkdir(parents=True, exist_ok=True)
    atomic_write_json(folder / "storage-location.json", value)


def status(root: Path) -> dict:
    saved = paths.storage_location_settings()
    pending = saved.get("pending")
    return {"path": str(root), "pending_path": pending.get("destination") if pending else None,
            "error": saved.get("error"), "overridden": bool(paths.app_env("DATA_DIR")),
            "missing": library_missing(root)}


def _destination(root: Path, value: str) -> Path:
    if not value.strip() or not Path(value.strip()).expanduser().is_absolute():
        raise ValueError("保存先にはフォルダーの絶対パスを指定してください。")
    target = Path(value.strip()).expanduser().resolve()
    root = root.resolve()
    if target == root or target.is_relative_to(root) or root.is_relative_to(target):
        raise ValueError("現在の保存先とは別の、互いに含まれないフォルダーを選んでください。")
    device = paths.device_directory().resolve()
    if target == device or target.is_relative_to(device) or device.is_relative_to(target):
        raise ValueError("このPCの設定フォルダーとは別の保存先を選んでください。")
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise ValueError("保存先には空のフォルダー、またはまだ存在しないフォルダーを指定してください。")
    return target


@device_writer
def schedule(root: Path, value: str) -> dict:
    if paths.app_env("DATA_DIR"):
        raise ValueError("環境変数 PAPEER_DATA_DIR / PAPERDESK_DATA_DIR で保存先が指定されています。環境変数を外してから変更してください。")
    if not (root / "library.sqlite3").is_file():
        raise ValueError("現在のデータフォルダーが見つかりません。元の場所に戻してから保存先を変更してください。")
    target = _destination(root, value)
    saved = paths.storage_location_settings()
    _save({"path": str(root.resolve()), "history_key": saved.get("history_key", paths.library_key(root)),
           "pending": {"source": str(root.resolve()), "destination": str(target)}})
    return status(root)


@device_writer
def cancel(root: Path) -> dict:
    saved = paths.storage_location_settings()
    if saved:
        _save({key: value for key, value in saved.items() if key not in {"pending", "error"}})
    return status(root)


def _files(root: Path) -> list[Path]:
    result = []
    # Do not follow directory junctions/symlinks or copy files from outside the library.
    for folder, directories, files in root.walk(follow_symlinks=False):
        for name in directories + files:
            item = folder / name
            if item.is_symlink() or item.is_junction():
                raise ValueError(f"リンクがあるため保存先を変更できません：{item}")
        result.extend(folder / name for name in files if not is_temporary(Path(name)))
    return result


def _copy_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    with source.open("rb") as a, target.open("rb+") as b:
        if hashlib.file_digest(a, "sha256").digest() != hashlib.file_digest(b, "sha256").digest():
            raise ValueError(f"コピーしたファイルを確認できませんでした：{source.name}")
        os.fsync(b.fileno())


@device_writer
def apply_pending(root: Path, source_lock: LibraryLock) -> Path:
    """Called with the source lock held, before the server accepts requests. Failure keeps the source."""
    saved = paths.storage_location_settings()
    pending = saved.get("pending")
    if not pending or paths.app_env("DATA_DIR"):
        return root
    lock = LibraryLock()
    staging: Path | None = None
    target = root
    try:
        if not source_lock.held:
            raise ValueError("変更元のライブラリの排他ロックを取得できませんでした。")
        if Path(pending["source"]).resolve() != root.resolve():
            raise ValueError("変更元の保存先が一致しません。保存先を選び直してください。")
        target = _destination(root, pending["destination"])
        if not (root / "library.sqlite3").is_file():
            raise ValueError("変更元のライブラリが見つかりません。元のフォルダーを戻してください。")
        if not lock.try_acquire(target):
            raise ValueError("変更先は別のPapeerが使用中です。終了してから再試行してください。")
        files = _files(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        ensure_free_space({target.parent: sum(file.stat().st_size for file in files)})
        staging = Path(tempfile.mkdtemp(prefix=".papeer-storage-", dir=target.parent)).resolve()
        for file in files:
            if file.name in {"library.sqlite3", "library.sqlite3-wal", "library.sqlite3-shm"} and file.parent == root:
                continue
            _copy_file(file, staging / file.relative_to(root))
        with closing(sqlite3.connect(root / "library.sqlite3")) as source, closing(sqlite3.connect(staging / "library.sqlite3")) as db:
            source.backup(db)
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("コピーしたデータベースを確認できませんでした。")
        with (staging / "library.sqlite3").open("rb+") as stream:
            os.fsync(stream.fileno())
        for directory, _, _ in staging.walk(top_down=False):
            sync_directory(directory)
        # Keep the direct Drive connection and this PC's reading information across the path change.
        # The history keeps its existing key, without copying or deleting historical data.
        for suffix in (".cloud-drive.json", ".opened.json", ".review-pages.json"):
            device = paths.device_directory()
            source_state = device / (paths.library_key(root) + suffix)
            target_state = device / (paths.library_key(target) + suffix)
            if source_state.is_file():
                atomic_write_bytes(target_state, source_state.read_bytes())
        if target.exists():
            target.rmdir()  # Only an empty folder can be replaced; never overwrite another library.
        staging.rename(target)
        staging = None
        sync_directory(target.parent)
        _save({"path": str(target), "history_key": saved.get("history_key", paths.library_key(root))})
        return target
    except (OSError, ValueError, sqlite3.Error) as exc:
        _save(saved | {"error": f"保存先を変更できませんでした。元の保存先を使っています。{exc}"})
        return root
    finally:
        lock.release()
        if staging is not None:
            # The only recursive deletion is our private staging folder under the selected parent.
            assert staging.parent == target.parent.resolve() and staging.name.startswith(".papeer-storage-")
            # A virus scanner holding a temporary file must not prevent opening the original library.
            shutil.rmtree(staging, ignore_errors=True)
