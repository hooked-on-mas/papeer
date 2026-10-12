"""Notebook creation, ownership and stable page operations."""
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from papeer.core import notebook
from papeer.core.library_list import paper_row
from sidecar import deps
from sidecar.schemas.ink import InkPageRequest
from sidecar.schemas.papers import PaperRow

router = APIRouter(dependencies=[Depends(deps.verify_token)])


class NotebookPaper(BaseModel):
    model_config = ConfigDict(extra="forbid")
    size: Literal["A4", "B5", "A5", "Letter", "16:9"] = "A4"
    orientation: Literal["portrait", "landscape"] = "portrait"
    template: Literal["blank", "ruled7", "ruled6", "ruled5", "grid5", "grid10", "dot5", "cornell"] = "ruled7"
    color: Literal["white", "cream", "dark"] = "white"


class NotebookPage(NotebookPaper):
    id: str
    width_mm: float
    height_mm: float


class NotebookDocument(BaseModel):
    version: Literal[1]
    revision: int
    pages: list[NotebookPage]


class NewNotebook(NotebookPaper):
    title: str = Field(default="ノート", min_length=1, max_length=200)
    collection: str = ""
    parent_id: str | None = None


class NotebookChange(BaseModel):
    revision: int
    action: Literal["append", "insert", "duplicate", "delete", "paper", "reorder"]
    page_id: str | None = None
    order: list[str] | None = None
    spec: NotebookPaper | None = None


class NotebookMove(BaseModel):
    parent_id: str | None = None
    collection: str = ""


@router.get("/api/notebooks", response_model=list[PaperRow], response_model_exclude_unset=True)
def list_notebooks():
    lib = deps.get_library()
    with lib.connection() as db:
        identities = [row[0] for row in db.execute("SELECT id FROM papers WHERE kind='notebook' ORDER BY created_at,id")]
    return [paper_row(lib, lib.paper(identity)) for identity in identities]


@router.post("/api/notebooks", response_model=PaperRow, response_model_exclude_unset=True)
def create_notebook(body: NewNotebook):
    lib = deps.get_library()
    spec = body.model_dump(include=set(NotebookPaper.model_fields))
    identity = notebook.create(lib, body.title, spec, body.collection, body.parent_id)
    deps.library_changed()
    return paper_row(lib, lib.paper(identity))


@router.get("/api/notebooks/{notebook_id}", response_model=NotebookDocument)
def get_notebook(notebook_id: str):
    return notebook.read(deps.get_library(), notebook_id)


@router.post("/api/notebooks/{notebook_id}/pages", response_model=NotebookDocument)
def change_pages(notebook_id: str, body: NotebookChange):
    lib = deps.get_library()
    with deps.job_manager.idle("処理中のためページを変更できません。", {notebook_id}):
        result = notebook.change(lib, notebook_id, body.revision, body.action, body.page_id, body.order,
                                 body.spec.model_dump() if body.spec else None)
    deps.paper_changed(notebook_id, ["pages"])
    return result


@router.post("/api/notebooks/{notebook_id}/placement")
def move_notebook(notebook_id: str, body: NotebookMove):
    notebook.move(deps.get_library(), notebook_id, body.parent_id, body.collection)
    deps.library_changed()
    return {"status": "moved"}


@router.get("/api/notebooks/{notebook_id}/pages/{page_id}/ink")
def get_page_ink(notebook_id: str, page_id: str):
    lib = deps.get_library()
    with notebook.lock(lib.root, notebook_id):
        number = notebook.page_number(lib, notebook_id, page_id)
        return {"strokes": lib.ink(notebook_id, "original", number)}


@router.get("/api/notebooks/{notebook_id}/ink", response_model=dict[str, InkPageRequest])
def notebook_ink(notebook_id: str):
    lib = deps.get_library()
    with notebook.lock(lib.root, notebook_id):
        document = notebook.read(lib, notebook_id)
        with lib.connection() as db:
            import json
            rows = {row["page"]: json.loads(row["strokes"]) for row in db.execute(
                "SELECT page,strokes FROM pdf_ink WHERE paper_id=? AND side='original'", (notebook_id,))}
        return {page["id"]: {"strokes": rows.get(number, [])} for number, page in enumerate(document["pages"], 1)}


@router.put("/api/notebooks/{notebook_id}/pages/{page_id}/ink")
def put_page_ink(notebook_id: str, page_id: str, body: InkPageRequest):
    lib = deps.get_library()
    with notebook.lock(lib.root, notebook_id):
        number = notebook.page_number(lib, notebook_id, page_id)
        lib.save_ink(notebook_id, "original", number, [stroke.model_dump(exclude_unset=True) for stroke in body.strokes])
    return {"status": "saved"}
