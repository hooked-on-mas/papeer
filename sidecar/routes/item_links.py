"""Links between a paper and a notebook (many to many, no direction; nothing is removed with a link)."""
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from papeer.core import notebook
from papeer.core.library_list import paper_row
from papeer.core.opened_papers import opened_times
from sidecar import deps
from sidecar.schemas.papers import PaperRow

router = APIRouter(dependencies=[Depends(deps.verify_token)])


class ItemLink(BaseModel):
    """One link, as the table stores it: a < b, whichever item it was made from."""
    a: str
    b: str


class NewLink(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_id: str


class LinkResult(BaseModel):
    status: Literal["linked", "unlinked"]


def changed(first: str, second: str) -> None:
    """Both ends' rows show the count (link_count), so both are reloaded."""
    for identity in (first, second):
        deps.paper_changed(identity, ["link_count"])


@router.get("/api/item-links", response_model=list[ItemLink])
def list_links():
    with deps.get_library().connection() as db:
        return [dict(row) for row in db.execute("SELECT a,b FROM item_links ORDER BY a,b")]


@router.get("/api/papers/{paper_id}/links", response_model=list[PaperRow], response_model_exclude_unset=True)
def linked_items(paper_id: str):
    lib = deps.get_library()
    lib.paper(paper_id)
    papers = sorted((lib.paper(identity) for identity in lib.linked_ids(paper_id)),
                    key=lambda paper: (paper["created_at"], paper["id"]))
    relations = lib.relation_counts([paper["id"] for paper in papers])
    opened = opened_times(lib.root)
    return [paper_row(lib, paper, opened=opened, relations=relations) for paper in papers]


@router.post("/api/papers/{paper_id}/links", response_model=LinkResult)
def link_item(paper_id: str, body: NewLink):
    if notebook.link(deps.get_library(), paper_id, body.target_id):
        changed(paper_id, body.target_id)
    return {"status": "linked"}


@router.delete("/api/papers/{paper_id}/links/{target_id}", response_model=LinkResult)
def unlink_item(paper_id: str, target_id: str):
    if notebook.unlink(deps.get_library(), paper_id, target_id):
        changed(paper_id, target_id)
    return {"status": "unlinked"}
