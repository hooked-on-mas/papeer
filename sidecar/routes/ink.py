"""Freehand ink on PDF pages: strokes per page, region capture, and PDFs with the ink (and highlights) painted in."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from papeer.core import ink
from sidecar import deps
from sidecar.schemas.ink import InkCaptureRequest, InkExportRequest, InkPageRequest, Side

router = APIRouter(dependencies=[Depends(deps.verify_token)])


@router.get("/api/papers/{paper_id}/ink-pages")
def ink_pages(paper_id: str):
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    return lib.ink_pages(paper_id)

@router.post("/api/papers/{paper_id}/ink-capture-v2")
def capture(paper_id: str, body: InkCaptureRequest):
    return ink.save_capture(deps.get_library(), paper_id, body.side, body.page,
                            (body.x, body.y, body.width, body.height), body.include_ink)

@router.get("/api/papers/{paper_id}/ink-v2/{side}/{page}")
def get_ink(paper_id: str, side: Side, page: int):
    lib = deps.get_library()
    ink.check_page(lib, paper_id, side, page)
    return {"strokes": lib.ink(paper_id, side, page)}

@router.put("/api/papers/{paper_id}/ink-v2/{side}/{page}")
def put_ink(paper_id: str, side: Side, page: int, body: InkPageRequest):
    lib = deps.get_library()
    ink.check_page(lib, paper_id, side, page)
    lib.save_ink(paper_id, side, page, [stroke.model_dump(exclude_unset=True) for stroke in body.strokes])
    return {"status": "saved"}

@router.post("/api/papers/{paper_id}/ink-export")
def export_ink(paper_id: str, body: InkExportRequest):
    data, destination = ink.export_annotated(deps.get_library(), paper_id, body.side, body.destination)
    if destination:
        return {"status": "exported", "destination": str(destination)}
    return Response(data, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="{body.side}-annotated.pdf"'})
