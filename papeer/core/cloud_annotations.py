"""Append-only browser ink operations. Import into SQLite atomically, never replace a PC page.

The optional ledger is created on first use, like collection_undo. It travels with backups and
prevents a PC-erased imported stroke from being resurrected on the next sync.
"""
from __future__ import annotations

import hashlib
import json
import re

import pymupdf
from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing import Literal

from papeer.core.paths import PaperFiles
from papeer.providers import check_cancel
from papeer.core.ink_model import InkStroke

MAX_INK_OPERATION_BYTES = 32 * 1024 * 1024

class InkChange(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["add", "remove"]
    stroke: InkStroke | None = None
    target: str | None = None

    @model_validator(mode="after")
    def check_change(self):
        if self.action == "add":
            if self.stroke is None or self.target is not None or not re.fullmatch(r"web-[a-f0-9-]{36}", self.stroke.id):
                raise ValueError("追加するWeb書き込みが不正です。")
        elif self.stroke is not None or not self.target or not re.fullmatch(r"web-[a-f0-9-]{36}", self.target):
            raise ValueError("削除するWeb書き込みが不正です。")
        return self


class Operation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1, 2]
    id: str = Field(pattern=r"^[a-f0-9-]{36}$", min_length=36, max_length=36)
    library_id: str = Field(pattern=r"^[\w-]{1,100}$")
    paper_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    side: Literal["original", "translated"]
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    page: int = Field(ge=1, le=100000)
    action: Literal["add", "remove", "edit"]
    stroke: InkStroke | None = None
    target: str | None = None
    changes: list[InkChange] | None = Field(default=None, min_length=1, max_length=3000)

    @model_validator(mode="before")
    @classmethod
    def check_fields(cls, value):
        if not isinstance(value, dict) or type(value.get('version')) is not int:
            raise ValueError("Web書き込みの版が不正です。")
        action = value.get('action')
        if value['version'] == 1 and (action not in ('add', 'remove') or 'changes' in value or (action == 'add' and 'target' in value) or (action == 'remove' and 'stroke' in value)):
            raise ValueError("Web書き込みの操作fieldが不正です。")
        if value['version'] == 2 and (action != 'edit' or 'stroke' in value or 'target' in value):
            raise ValueError("Web書き込みの一括操作fieldが不正です。")
        changes = value.get('changes')
        if changes is not None and not isinstance(changes, list):
            raise ValueError("Web書き込みの一括操作は配列で指定してください。")
        for change in changes or []:
            if not isinstance(change, dict) or (change.get('action') == 'add' and 'target' in change) or (change.get('action') == 'remove' and 'stroke' in change):
                raise ValueError("Web書き込みの一括操作fieldが不正です。")
        return value

    @model_validator(mode="after")
    def check_action(self):
        if self.version == 2:
            if not self.changes:
                raise ValueError("Web書き込みの一括操作が空です。")
            ids = [change.stroke.id if change.stroke else change.target for change in self.changes]
            if len(set(ids)) != len(ids):
                raise ValueError("一括操作の書き込みIDが重複しています。")
        elif self.action == "add":
            if self.stroke is None or self.target is not None or self.stroke.id != "web-" + self.id:
                raise ValueError("Web書き込みのIDが不正です。")
        elif self.stroke is not None or not self.target or not re.fullmatch(r"web-[a-f0-9-]{36}", self.target):
            raise ValueError("削除するWeb書き込みのIDが不正です。")
        return self


def operation_changes(op):
    return op['changes'] if op['version'] == 2 else [{key: op[key] for key in ('action', 'stroke', 'target') if key in op}]


def import_operations(lib, drive, manifest_id: str, cancel) -> int:
    """Read immutable operations; validate everything before applying any of them.

    Stale PDF operations stay in Drive, never get painted on a replacement translation.
    Removed IDs are tombstones, independent of listing/upload order or device clocks.
    """
    remote = drive.list("properties has { key='papeer' and value='ink-v1' } and "
                        f"properties has {{ key='library' and value='{manifest_id}' }}")
    if not remote:
        return 0
    with lib.connection() as db:
        db.execute("CREATE TABLE IF NOT EXISTS web_annotation_ops (id TEXT PRIMARY KEY, operation TEXT NOT NULL)")
        known = {row[0]: json.loads(row[1]) for row in db.execute("SELECT id,operation FROM web_annotation_ops")}
    pending = {}
    for file in remote:
        check_cancel(cancel)
        # These are immutable; an already imported operation never needs a second download.
        if file.get("name", "").removeprefix("ink-").removesuffix(".json") in known:
            continue
        if int(file.get("size", 0)) > MAX_INK_OPERATION_BYTES:
            raise ValueError("Web書き込みが大きすぎます。Driveの書き込みファイルを確認してください。")
        if not re.fullmatch(r"[\w-]+", file["id"]):
            raise ValueError("Web書き込みのファイルIDが不正です。")
        value = Operation.model_validate(drive.json(drive_api() + "/" + file["id"] + "?alt=media")).model_dump(mode="json", exclude_none=True)
        if value["library_id"] != manifest_id:
            raise ValueError("別ライブラリのWeb書き込みです。")
        previous = known.get(value["id"]) or pending.get(value["id"])
        if previous is not None and previous != value:
            raise ValueError("同じIDのWeb書き込みの内容が一致しません。")
        if value["id"] not in known:
            pending[value["id"]] = value
    if not pending:
        return 0
    valid = []
    sources = {}
    for op in pending.values():
        key = (op["paper_id"], op["side"])
        if key not in sources:
            files = PaperFiles(lib.folder(op["paper_id"]))
            source = files.original_pdf if op["side"] == "original" else files.translated_pdf
            if not source.is_file():
                sources[key] = ("", 0)
            else:
                with source.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                with pymupdf.open(source) as pdf:
                    sources[key] = (digest, len(pdf))
        digest, pages = sources[key]
        if op["source_sha256"] == digest and op["page"] <= pages:
            valid.append(op)
    all_ops = list(known.values()) + valid
    removed = {(op["paper_id"], op["side"], op["source_sha256"], op["page"], change["target"])
               for op in all_ops for change in operation_changes(op) if change["action"] == "remove"}
    with lib.connection() as db:
        db.execute("BEGIN IMMEDIATE")
        for op in valid:
            check_cancel(cancel)
            if db.execute("SELECT 1 FROM web_annotation_ops WHERE id=?", (op["id"],)).fetchone():
                continue
            key = (op["paper_id"], op["side"], op["page"])
            row = db.execute("SELECT strokes FROM pdf_ink WHERE paper_id=? AND side=? AND page=?", key).fetchone()
            strokes = json.loads(row[0]) if row else []
            deleted = {target for paper, side, sha, page, target in removed
                       if (paper, side, sha, page) == (*key[:2], op["source_sha256"], key[2])}
            strokes = [stroke for stroke in strokes if stroke["id"] not in deleted]
            for change in operation_changes(op):
                if change["action"] == "add" and change["stroke"]["id"] not in deleted and not any(s["id"] == change["stroke"]["id"] for s in strokes):
                    strokes.append(change["stroke"])
            if len(strokes) > 3000 or sum(len(s["points"]) for s in strokes) > 200000:
                raise ValueError("Web書き込みの取り込みでページの上限を超えました。")
            db.execute("INSERT INTO pdf_ink(paper_id,side,page,strokes) VALUES(?,?,?,?) "
                       "ON CONFLICT(paper_id,side,page) DO UPDATE SET strokes=excluded.strokes",
                       (*key, json.dumps(strokes, separators=(",", ":"))))
            db.execute("INSERT INTO web_annotation_ops VALUES(?,?)", (op["id"], json.dumps(op)))
    return len(valid)


def drive_api():
    return "https://www.googleapis.com/drive/v3/files"
