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


class Operation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    version: Literal[1]
    id: str = Field(pattern=r"^[a-f0-9-]{36}$")
    library_id: str = Field(pattern=r"^[\w-]{1,100}$")
    paper_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    side: Literal["original", "translated"]
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    page: int = Field(ge=1, le=100000)
    action: Literal["add", "remove"]
    stroke: InkStroke | None = None
    target: str | None = None

    @model_validator(mode="after")
    def check_action(self):
        if self.action == "add":
            if self.stroke is None or self.target is not None or self.stroke.id != "web-" + self.id:
                raise ValueError("Web書き込みのIDが不正です。")
        elif self.stroke is not None or not self.target or not re.fullmatch(r"web-[a-f0-9-]{36}", self.target):
            raise ValueError("削除するWeb書き込みのIDが不正です。")
        return self


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
        if int(file.get("size", 0)) > 1024 * 1024:
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
    removed = {(op["paper_id"], op["side"], op["source_sha256"], op["page"], op["target"])
               for op in all_ops if op["action"] == "remove"}
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
            if op["action"] == "add" and op["stroke"]["id"] not in deleted and not any(s["id"] == op["stroke"]["id"] for s in strokes):
                strokes.append(op["stroke"])
            if len(strokes) > 3000 or sum(len(s["points"]) for s in strokes) > 200000:
                raise ValueError("Web書き込みの取り込みでページの上限を超えました。")
            db.execute("INSERT INTO pdf_ink(paper_id,side,page,strokes) VALUES(?,?,?,?) "
                       "ON CONFLICT(paper_id,side,page) DO UPDATE SET strokes=excluded.strokes",
                       (*key, json.dumps(strokes, separators=(",", ":"))))
            db.execute("INSERT INTO web_annotation_ops VALUES(?,?)", (op["id"], json.dumps(op)))
    return len(valid)


def drive_api():
    return "https://www.googleapis.com/drive/v3/files"
