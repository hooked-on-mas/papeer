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
from papeer.core.paths import sync_state_path
from papeer.core.reading_tools import create_backup, restore_backup
from papeer.core.storage import (SCHEMA_VERSION, Library, NewerSchemaError, database_version, library_missing,
                                  newer_papeer)
from papeer.providers import check_cancel

FORMAT = "papeer-folder-sync-v1"


def state_path(root: Path) -> Path:
    return sync_state_path(root)


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
        "conflicts": [], "previous_path": None, "folder": "", "restored": False,
    }.items()}
    # OAuth state from the earlier prototype is not a folder connection.
    result["connected"] = bool(result["connected"] and result["folder"])
    review = state.get("review")
    # The screen needs the reason, the counts, and the heads it saw (to take the sync folder's library
    # instead, or publish this PC's over it, through the usual choice). The hash stays here; sync()
    # checks a confirmation against its own copy of both.
    result["review"] = {k: v for k, v in review.items() if k != "hash"} if isinstance(review, dict) else None
    result["library_missing"] = library_missing(root)
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


def mark_restored(root: Path) -> None:
    """After a backup was restored: the next sync asks before publishing it (it may be older than the synced one)."""
    state = read_state(root)
    if state.get("base"):
        state["restored"] = True
        save_state(root, state)


def dismiss_review(root: Path) -> dict:
    """「同期しない」: drop the pending confirmation and stop automatic sync until the user turns it on again.

    Nothing else changes, so the next sync (manual, or automatic once enabled) checks the same way again.
    """
    state = read_state(root)
    state.update(review=None, auto_sync=False)
    save_state(root, state)
    return status(root)


def start_new_library(root: Path) -> dict:
    """Forget what this PC last synced, so a missing data folder may be created anew.

    The next sync then treats the library like one connected for the first time: when the sync
    folder holds revisions, the user chooses which library to use (the empty new one is never
    published over them without that choice).
    """
    if not library_missing(root):
        raise ValueError("データフォルダーは見つかっています。")
    state = read_state(root)
    for key in ("base", "hash", "counts", "restored", "review"):
        state.pop(key, None)
    state.update(error=None, conflicts=[])
    save_state(root, state)
    return status(root)


# --- Guarding against publishing (or taking in) a library that lost most of its contents ---
#
# Each revision records how much the library holds, and this PC remembers the counts it last synced.
# A sync that would publish, or take in, a library with far fewer items stops and asks first.
COUNT_LABELS = {"papers": "論文", "notes": "メモ", "stickies": "付箋", "ink": "書き込み"}
# "Far fewer" is at least SHRINK_MIN_ITEMS items and at least half of a kind. The absolute floor keeps
# ordinary deletions in a small library (1 of 2 papers) from stopping sync; the ratio keeps a clean-up
# in a large one (30 of 300) from doing so. Losing every paper always asks: an empty library is how a
# missing folder or a broken restore looks.
SHRINK_MIN_ITEMS = 5


def library_counts(root: Path) -> dict[str, int]:
    """Papers, papers with a memo, sticky notes and pages with ink: a few COUNTs, without migrating the database."""
    with closing(sqlite3.connect(root / "library.sqlite3", timeout=30)) as db:
        tables = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}

        def count(table: str, where: str = "") -> int:
            return db.execute(f"SELECT COUNT(*) FROM {table} {where}").fetchone()[0] if table in tables else 0
        return {"papers": count("papers"), "notes": count("papers", "WHERE trim(note)<>''"),
                "stickies": count("bookmarks"), "ink": count("pdf_ink", "WHERE strokes NOT IN ('','[]')")}


def shrunk_kinds(before: dict | None, after: dict) -> list[str]:
    """The kinds (COUNT_LABELS keys) that went down by SHRINK_MIN_ITEMS or more and by half or more."""
    if not isinstance(before, dict):
        return []
    result = []
    for kind in COUNT_LABELS:
        old, new = before.get(kind), after.get(kind)
        if type(old) is not int or type(new) is not int:
            continue
        if (old - new >= SHRINK_MIN_ITEMS and new * 2 <= old) or (kind == "papers" and old > 0 and new == 0):
            result.append(kind)
    return result


def _review(reason: str, message: str, before: dict | None, after: dict, labels: tuple[str, str],
            heads: list[str], local_hash: str) -> dict:
    # heads and hash bind a later 「このまま同期する」 to exactly what was shown (see sync()).
    return {"reason": reason, "message": message, "before": before, "after": after,
            "before_label": labels[0], "after_label": labels[1], "heads": heads, "hash": local_hash}


def _kinds_text(kinds: list[str]) -> str:
    return "・".join(COUNT_LABELS[kind] for kind in kinds)


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
                        or not isinstance(meta.get("app_version", ""), str)
                        # Absent from revisions made before the counts were recorded.
                        or not _valid_counts(meta.get("counts", {}))):
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


def _valid_counts(value: object) -> bool:
    return isinstance(value, dict) and all(isinstance(k, str) and type(v) is int and v >= 0 for k, v in value.items())


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
         expected_heads: list[str] | None = None, confirm: bool = False) -> dict:
    """Publish an immutable snapshot or adopt a remote one, retaining both on conflict.

    Resolving a conflict creates a revision with all observed heads as its parents.
    A simultaneous upload remains a separate head and will be offered next time.
    Publishing a library that shrank a lot or was just restored from a backup, or taking in one that
    shrank a lot, returns {"status": "review"} instead (see shrunk_kinds); confirm=True then goes
    ahead, as long as neither the sync folder nor this library changed since. To back out without
    losing anything, the review's heads serve as expected_heads for a choice: the head itself (take
    the sync folder's library, even when it is the common ancestor) or "local" (publish this PC's).
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
    counts = library_counts(lib.root)
    review = state.get("review")
    confirmed = bool(confirm and isinstance(review, dict) and review.get("heads") == ids
                     and review.get("hash") == local_hash)

    def finish(**values) -> None:
        state.update(**values, counts=library_counts(lib.root), conflicts=[], error=None, review=None,
                     last_sync=datetime.now(timezone.utc).isoformat())
        state.pop("restored", None)
        save_state(lib.root, state)

    def ask(value: dict) -> dict:
        state.update(review=value, conflicts=[], error=None)
        save_state(lib.root, state)
        return {"status": "review", "review": status(lib.root)["review"]}

    if (choice is None and len(heads) == 1 and heads[0]["id"] != base and heads[0]["hash"] == local_hash
            and heads[0].get("schema_version", 0) <= SCHEMA_VERSION):
        # The newest revision already holds exactly this library: another PC published the same contents,
        # typically after both were updated to a Papeer whose migration changed the database the same way.
        # Nothing to take in or publish; only the common ancestor moves (not a conflict).
        finish(base=heads[0]["id"], hash=local_hash)
        return {"status": "synced", "reloaded": False, "previous_path": None}
    conflict = len(heads) > 1 or (bool(heads) and base != heads[0]["id"] and dirty)
    if conflict and choice is None:
        state.update(conflicts=[{k: item[k] for k in ("id", "device", "created")} for item in heads],
                     error="両方のPCに変更があります。保存先・同期で使用するデータを選択してください。", review=None)
        save_state(lib.root, state)
        return {"status": "conflict", "conflicts": state["conflicts"]}
    # This library is about to become the newest revision (as opposed to taking one in, or a choice).
    publish_local = choice is None and (dirty or not heads) and not (heads and base != heads[0]["id"])
    if publish_local and not confirmed:
        base_revision = next((item for item in revisions if item["id"] == base), {})
        reference = state.get("counts") or base_revision.get("counts")
        if state.get("restored"):
            return ask(_review("restored", "バックアップから復元したデータです。同期すると、同期フォルダーと他のPCもこの内容になります。"
                               "復元した内容で問題なければ「このまま同期する」を選んでください。",
                               reference, counts, ("前回の同期", "このPC（復元後）"), ids, local_hash))
        if kinds := shrunk_kinds(reference, counts):
            return ask(_review("shrunk", f"前回の同期から{_kinds_text(kinds)}が大きく減っています。"
                               "意図した削除でなければ「同期しない」を選び、データを確認してください。",
                               reference, counts, ("前回の同期", "このPC"), ids, local_hash))
    previous = None
    with tempfile.TemporaryDirectory() as directory:
        archive = Path(directory) / "library.zip"
        selected = next((item for item in heads if item["id"] == choice), None)
        if choice is not None and choice != "local" and selected is None:
            raise ValueError("選んだ同期データが見つかりません。")
        pull = selected or (heads[0] if choice is None and heads and base != heads[0]["id"] and not dirty else None)
        # What `archive` holds if it is published: this library, or the revision taken below.
        content_hash, content_schema, content_counts = local_hash, SCHEMA_VERSION, counts
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
            content_counts = library_counts(staging)
            if choice is None and not confirmed and (kinds := shrunk_kinds(counts, content_counts)):
                # Counted from the verified contents, not from what the revision says about itself.
                return ask(_review("remote_shrunk", f"{pull['device']} で保存された同期データでは{_kinds_text(kinds)}が大きく減っています。"
                                   "取り込むと、このPCのデータもこの内容に置き換わります（元のデータは別フォルダーに残します）。",
                                   counts, content_counts, ("このPC", "同期フォルダー"), ids, local_hash))
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
                                          "app_version": __version__, "counts": content_counts}, cancel, progress)
        if pull:
            # All network operations succeeded; only now replace the local copy. Cancellable until the
            # folders are swapped: the state is then left as it was, so the next sync pulls the same
            # revision again (or, when this PC has changes, offers the choice again), and nothing is lost.
            previous = str(restore_backup(lib, archive, cancel))
        if previous:
            state["previous_path"] = previous
        finish(base=base, hash=local_hash)
    return {"status": "synced", "reloaded": bool(previous), "previous_path": previous}
