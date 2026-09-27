"""Folder snapshots with immutable revisions (concurrent writers never overwrite).

The folder selection and last common revision stay device-local, outside the library.
The caller must hold exclusive library access throughout sync().
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import sqlite3
import tempfile
import re
import uuid
import zipfile

from papeer import __version__
from papeer.core.fileio import atomic_output, atomic_write_json, is_temporary
from papeer.core.paths import device_directory
from papeer.core.reading_tools import create_backup, restore_backup
from papeer.core.storage import SCHEMA_VERSION, Library, NewerSchemaError, database_version, newer_papeer
from papeer.providers import check_cancel

FORMAT = "papeer-folder-sync-v1"


def state_path(root: Path) -> Path:
    return device_directory() / (hashlib.sha256(str(root.resolve()).encode()).hexdigest() + ".json")


def read_state(root: Path) -> dict:
    path = state_path(root)
    return json.loads(path.read_text("utf-8")) if path.exists() else {}


def save_state(root: Path, state: dict) -> None:
    path = state_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, state, indent=None)


def status(root: Path) -> dict:
    state = read_state(root)
    result = {key: state.get(key, default) for key, default in {
        "connected": False, "auto_sync": True, "last_sync": None, "error": None,
        "conflicts": [], "previous_path": None, "folder": "",
    }.items()}
    # OAuth state from the earlier prototype is not a folder connection.
    result["connected"] = bool(result["connected"] and result["folder"])
    return result


def connect(root: Path, value: str) -> dict:
    if not value.strip() or not Path(value).expanduser().is_absolute():
        raise ValueError("保存先を絶対パスで指定してください。")
    target = Path(value).expanduser().resolve()
    local = root.resolve()
    if target.is_relative_to(local) or local.is_relative_to(target):
        raise ValueError("作業用データと重ならない別のフォルダーを選択してください。")
    # The parent must already exist: don't recreate a disconnected/missing Drive mount.
    if not target.parent.is_dir():
        raise ValueError("親フォルダーが見つかりません。PC版Google Driveを確認してください。")
    target.mkdir(exist_ok=True)
    probe = target / (".papeer-write-test-" + uuid.uuid4().hex)
    try:
        with probe.open("xb") as stream:
            stream.write(b"ok")
    finally:
        probe.unlink(missing_ok=True)
    FolderDrive(target).revisions()
    state = read_state(root)
    if state.get("folder") != str(target):
        state = {}  # Never reuse another folder's common ancestor.
    state.update(connected=True, folder=str(target), auto_sync=True, error=None)
    save_state(root, state)
    return status(root)


def disconnect(root: Path) -> None:
    # Keep the ancestor so reconnecting to the same folder remains incremental.
    state = read_state(root)
    state.update(connected=False, auto_sync=False)
    save_state(root, state)


class FolderDrive:
    """One complete revision per file, so Drive cannot separate metadata from data.

    Incomplete local writes use a temporary extension; only a finished archive is
    published by rename. Cloud arrival order is checked before accepting history.
    """
    def __init__(self, folder: Path):
        self.folder = folder
        if not folder.is_dir():
            raise ValueError("同期フォルダーが見つかりません。PC版Google Driveを確認してください。")

    def revisions(self) -> list[dict]:
        result = []
        for path in sorted(self.folder.glob("*.papeer-sync")):
            with zipfile.ZipFile(path) as archive:
                info = archive.getinfo("revision.json")
                if info.file_size > 1024 * 1024:
                    raise ValueError("同期履歴の形式が不正です。")
                meta = json.loads(archive.read(info))
                if (meta.get("format") != FORMAT or meta.get("id") != path.stem
                        or not re.fullmatch(r"[0-9a-f]{32}", str(meta.get("id", "")))
                        or not isinstance(meta.get("parents"), list)
                        or not all(isinstance(p, str) for p in meta["parents"])
                        or not all(isinstance(meta.get(k), str) for k in ("hash", "archive_hash", "device", "created"))
                        # Both are absent from revisions made before schema versioning (version 0).
                        or type(meta.get("schema_version", 0)) is not int or meta.get("schema_version", 0) < 0
                        or not isinstance(meta.get("app_version", ""), str)):
                    raise ValueError("同期履歴の形式が不正です。")
                archive.getinfo("library.zip")
                result.append(meta)
        ids = {item["id"] for item in result}
        if any(parent not in ids for item in result for parent in item["parents"]):
            raise ValueError("同期データがまだ揃っていません。Google Driveの同期完了後に再試行してください。")
        return result

    def upload(self, path: Path, metadata: dict, cancel, progress) -> str:
        identity = uuid.uuid4().hex
        # Readers list only *.papeer-sync, so the half-written temporary file is never picked up.
        with atomic_output(self.folder / (identity + ".papeer-sync")) as temporary:
            with zipfile.ZipFile(temporary, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
                archive.writestr("revision.json", json.dumps({**metadata, "format": FORMAT, "id": identity,
                    "created": datetime.now(timezone.utc).isoformat()}, ensure_ascii=False))
                with path.open("rb") as source, archive.open("library.zip", "w", force_zip64=True) as output:
                    self._copy(source, output, cancel)
            check_cancel(cancel)
        return identity

    def download(self, revision: str, path: Path, cancel, progress) -> None:
        if not re.fullmatch(r"[0-9a-f]{32}", revision):
            raise ValueError("同期データのIDが不正です。")
        progress("同期フォルダーから読み込んでいます…")
        with zipfile.ZipFile(self.folder / (revision + ".papeer-sync")) as archive:
            with archive.open("library.zip") as source, path.open("wb") as output:
                self._copy(source, output, cancel)

    @staticmethod
    def _copy(source, output, cancel):
        while chunk := source.read(8 * 1024**2):
            check_cancel(cancel)
            output.write(chunk)


def fingerprint(lib: Library | Path, cancel=None) -> str:
    """Logical DB contents avoid false changes caused by SQLite checkpoint/layout.

    UI state is carried in snapshots, but merely navigating doesn't trigger uploads.
    Given a folder instead of a Library, its database is read as it is, without migrating it.
    """
    root = lib.root if isinstance(lib, Library) else lib
    digest = hashlib.sha256()
    with closing(sqlite3.connect(root / "library.sqlite3", timeout=30)) as db:
        for line in db.iterdump():
            digest.update(line.encode("utf-8"))
            digest.update(b"\n")
    for path in sorted(root.rglob("*")):
        if cancel is not None:
            check_cancel(cancel)
        if path.is_file() and not is_temporary(path) and path.name not in {
            "library.sqlite3", "library.sqlite3-wal", "library.sqlite3-shm", "ui-state.json",
        }:
            digest.update(path.relative_to(root).as_posix().encode("utf-8"))
            with path.open("rb") as stream:
                digest.update(hashlib.file_digest(stream, "sha256").digest())
    return digest.hexdigest()


def revision_heads(revisions: list[dict]) -> list[dict]:
    parents = {parent for revision in revisions for parent in revision["parents"]}
    return [revision for revision in revisions if revision["id"] not in parents]


def sync(lib: Library, remote, cancel, progress, *, choice: str | None = None,
         expected_heads: list[str] | None = None) -> dict:
    """Publish an immutable snapshot or adopt a remote one, retaining both on conflict.

    Resolving a conflict creates a revision with all observed heads as its parents.
    A simultaneous upload remains a separate head and will be offered next time.
    """
    state = read_state(lib.root)
    if not state.get("connected"):
        raise ValueError("同期フォルダーを指定してください。")
    progress("同期フォルダーの変更を確認しています…")
    revisions = remote.revisions()
    heads = revision_heads(revisions)
    ids = sorted(item["id"] for item in heads)
    local_hash = fingerprint(lib, cancel)
    dirty = local_hash != state.get("hash")
    base = state.get("base")
    if base and base not in {item["id"] for item in revisions}:
        raise ValueError("前回の同期データが見つかりません。Google Driveの同期完了と保存先を確認してください。")
    if choice is not None and sorted(expected_heads or []) != ids:
        raise ValueError("別のPCで同期されました。再度同期してから選択してください。")
    conflict = len(heads) > 1 or (bool(heads) and base != heads[0]["id"] and dirty)
    if conflict and choice is None:
        state.update(conflicts=[{k: item[k] for k in ("id", "device", "created")} for item in heads],
                     error="両方のPCに変更があります。保存先・同期で使用するデータを選択してください。")
        save_state(lib.root, state)
        return {"status": "conflict", "conflicts": state["conflicts"]}
    previous = None
    with tempfile.TemporaryDirectory() as directory:
        archive = Path(directory) / "library.zip"
        selected = next((item for item in heads if item["id"] == choice), None)
        if choice is not None and choice != "local" and selected is None:
            raise ValueError("選んだ同期データが見つかりません。")
        pull = selected or (heads[0] if choice is None and heads and base != heads[0]["id"] and not dirty else None)
        # What `archive` holds if it is published: this library, or the revision taken below.
        content_hash, content_schema = local_hash, SCHEMA_VERSION
        if pull:
            if pull.get("schema_version", 0) > SCHEMA_VERSION:
                raise NewerSchemaError(f"この同期データは{newer_papeer(pull.get('app_version'))}で作成されたため取り込めません。"
                                       "このPCのPapeerを最新版に更新してから同期してください。")
            remote.download(pull["id"], archive, cancel, progress)
            check_cancel(cancel)
            with archive.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != pull["archive_hash"]:
                    raise ValueError("同期データの検証に失敗しました。再試行してください。")
            # Validate using the backup restore path before touching the active library.
            staging = Path(directory) / "validation"
            staging.mkdir()
            restore_backup(Library(staging), archive, cancel)
            # Hash the database as the publishing PC did, before this version migrates it.
            content_hash = fingerprint(staging, cancel)
            content_schema = database_version(staging / "library.sqlite3")
            if content_hash != pull["hash"]:
                raise ValueError("同期データの内容が一致しません。")
            local_hash = content_hash
            if content_schema < SCHEMA_VERSION:
                # The library as it is once opened here, so taking an older revision is not published again.
                local_hash = fingerprint(Library(staging), cancel)
            check_cancel(cancel)
            base = pull["id"]
        # Explicit resolutions publish the chosen contents as a merge revision.
        if choice is not None or (not pull and (dirty or not heads)):
            check_cancel(cancel)
            progress("ライブラリ全体の同期データを作成しています…")
            if not pull:
                create_backup(lib, archive, cancel)
            with archive.open("rb") as stream:
                archive_hash = hashlib.file_digest(stream, "sha256").hexdigest()
            # app_version is the Papeer that published this revision; a taken revision published again
            # keeps its own schema_version, since the archive holds its database unmigrated.
            base = remote.upload(archive, {"parents": ids, "hash": content_hash, "archive_hash": archive_hash,
                                          "device": platform.node(), "schema_version": content_schema,
                                          "app_version": __version__}, cancel, progress)
        if pull:
            # All network operations succeeded; only now replace the local copy. Cancellable until the
            # folders are swapped: the state is then left as it was, so the next sync pulls the same
            # revision again (or, when this PC has changes, offers the choice again), and nothing is lost.
            previous = str(restore_backup(lib, archive, cancel))
        state.update(base=base, hash=local_hash, conflicts=[], error=None,
                     last_sync=datetime.now(timezone.utc).isoformat())
        if previous:
            state["previous_path"] = previous
        save_state(lib.root, state)
    return {"status": "synced", "reloaded": bool(previous), "previous_path": previous}
