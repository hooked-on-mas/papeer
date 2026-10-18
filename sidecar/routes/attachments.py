"""Memos (md) and documents (html) held by an item.

A document's text is never read or edited here: sidecar/html_documents.py describes it and shows it
under a sandbox. What is common (listing, import, order, rename, delete) works on both formats.
"""
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from papeer.core.errors import Invalid, NotFound
from sidecar import deps

router = APIRouter(dependencies=[Depends(deps.verify_token)])


class Attachment(BaseModel):
    id: str
    owner_id: str
    format: Literal["md", "html"]
    title: str
    source: str
    position: int
    created_at: str
    updated_at: str


class MemoContent(Attachment):
    content: str


# What a document's text is imported from, by suffix.
IMPORT_FORMATS = {".md": "md", ".html": "html"}


class NewMemo(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="メモ.md", min_length=1, max_length=200)
    content: str = ""
    source: Literal["user", "imported"] = "user"


class EditMemo(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = None


class OrderMemos(BaseModel):
    ids: list[str] = Field(max_length=10000)


class ImportMemos(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=100)


def library(owner: str):
    lib = deps.get_library()
    lib.paper_folder(owner)
    return lib


def memo(lib, owner: str, identity: str) -> dict:
    row = next((item for item in lib.attachments(owner) if item["id"] == identity and item["format"] == "md"), None)
    if row is None:
        raise NotFound("メモが見つかりません。")
    return row


def attachment(lib, owner: str, identity: str) -> dict:
    row = next((item for item in lib.attachments(owner) if item["id"] == identity), None)
    if row is None:
        raise NotFound("メモ・資料が見つかりません。")
    return row


def read_source(path: Path) -> str:
    """A file's UTF-8 text; a document keeps its line endings as they are (a BOM aside), a memo's are the editor's."""
    if path.suffix.lower() == ".html":
        return path.read_bytes().decode("utf-8-sig")
    return path.read_text("utf-8-sig")


def changed(owner: str) -> None:
    deps.paper_changed(owner, ["attachment_count"])


@router.get("/api/papers/{paper_id}/attachments", response_model=list[Attachment])
def list_attachments(paper_id: str):
    return library(paper_id).attachments(paper_id)


@router.get("/api/attachments", response_model=list[Attachment])
def all_attachments():
    lib = deps.get_library()
    with lib.connection() as db:
        return [dict(row) for row in db.execute("SELECT * FROM attachments ORDER BY owner_id,position,created_at,id")]


@router.post("/api/papers/{paper_id}/attachments", response_model=MemoContent)
def create_memo(paper_id: str, body: NewMemo):
    lib = library(paper_id)
    if not body.title.strip():
        raise Invalid("メモの名前を入力してください。")
    row = lib.add_attachment(paper_id, "md", body.title, body.content, body.source)
    changed(paper_id)
    return {**row, "content": body.content}


@router.post("/api/papers/{paper_id}/attachments/import", response_model=list[Attachment])
def import_memos(paper_id: str, body: ImportMemos):
    lib = library(paper_id)
    paths = [Path(path) for path in body.paths]
    if any(path.suffix.lower() not in IMPORT_FORMATS or not path.is_file() for path in paths):
        raise Invalid("存在する .md または .html ファイルを選んでください。")
    try:
        contents = [(path.name, IMPORT_FORMATS[path.suffix.lower()], read_source(path)) for path in paths]
    except UnicodeError:
        raise Invalid("UTF-8 で保存した .md または .html ファイルを選んでください。") from None
    rows = []
    try:
        for title, format, content in contents:
            rows.append(lib.add_attachment(paper_id, format, title, content, "imported"))
    finally:
        if rows:
            changed(paper_id)
    return rows


@router.put("/api/papers/{paper_id}/attachments/order")
def order_memos(paper_id: str, body: OrderMemos):
    library(paper_id).reorder_attachments(paper_id, body.ids)
    changed(paper_id)
    return {"status": "updated"}


@router.get("/api/papers/{paper_id}/attachments/{attachment_id}", response_model=MemoContent)
def get_memo(paper_id: str, attachment_id: str):
    lib = library(paper_id)
    return {**memo(lib, paper_id, attachment_id), "content": lib.attachment_text(attachment_id)}


@router.patch("/api/papers/{paper_id}/attachments/{attachment_id}", response_model=MemoContent | Attachment)
def edit_memo(paper_id: str, attachment_id: str, body: EditMemo):
    """Rename a memo or a document, or save a memo's text (a document's text is Invalid: 400)."""
    lib = library(paper_id)
    row = lib.update_attachment(paper_id, attachment_id, title=body.title, content=body.content)
    changed(paper_id)
    if row["format"] != "md":
        return row
    return {**row, "content": lib.attachment_text(attachment_id)}


@router.delete("/api/papers/{paper_id}/attachments/{attachment_id}")
def delete_memo(paper_id: str, attachment_id: str):
    lib = library(paper_id)
    attachment(lib, paper_id, attachment_id)
    lib.remove_attachment(attachment_id)
    changed(paper_id)
    return {"status": "deleted"}
