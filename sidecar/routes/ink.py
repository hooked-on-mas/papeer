"""Freehand ink on PDF pages: strokes per page, region capture, and PDFs with the ink painted in."""
from __future__ import annotations

import os
import io
from pathlib import Path
import tempfile
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, model_validator
from PIL import Image

from paperdesk.core.paths import PaperFiles
from paperdesk.pdf.pdf_ink import annotated_page, annotated_pdf
from paperdesk.pdf.pdf_viewer import page_png, pdf_page_count
from paperdesk.translation.translation_preview import read_preview, translated_page
from sidecar import deps

Side = Literal["original", "translated"]
Coordinate = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class InkStroke(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    width: float = Field(gt=0, le=0.08, allow_inf_nan=False)
    points: list[tuple[Coordinate, Coordinate]] = Field(min_length=1, max_length=20000)
    kind: Literal["pen", "highlighter", "line", "arrow", "rectangle", "ellipse", "text"] = "pen"
    text: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def validate_text(self):
        if self.kind == "text":
            if not self.text or not self.text.strip() or len(self.points) != 4:
                raise ValueError("テキストと4つの枠座標が必要です。")
            a, b, c, d = self.points
            if abs((b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0])) < 1e-10:
                raise ValueError("テキストのサイズが小さすぎます。")
            if abs(c[0] - b[0] - d[0] + a[0]) > 1e-6 or abs(c[1] - b[1] - d[1] + a[1]) > 1e-6:
                raise ValueError("テキストの枠座標が不正です。")
        return self


class InkPageRequest(BaseModel):
    strokes: list[InkStroke] = Field(max_length=3000)

    @model_validator(mode="after")
    def validate_strokes(self):
        if len({s.id for s in self.strokes}) != len(self.strokes):
            raise ValueError("書き込みのIDが重複しています。")
        if sum(len(s.points) for s in self.strokes) > 200000:
            raise ValueError("このページの書き込みが多すぎます。")
        return self


class InkExportRequest(BaseModel):
    side: Side
    destination: str | None = None


class InkCaptureRequest(BaseModel):
    side: Side
    include_ink: bool = False
    page: int = Field(ge=1)
    x: Coordinate
    y: Coordinate
    width: float = Field(gt=0, le=1, allow_inf_nan=False)
    height: float = Field(gt=0, le=1, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_box(self):
        if self.x + self.width > 1.000001 or self.y + self.height > 1.000001:
            raise ValueError("選択範囲がページの外にはみ出しています。")
        return self

router = APIRouter(dependencies=[Depends(deps.verify_token)])



def check_page(lib, paper_id, side, page):
    folder = deps.paper_folder(lib, paper_id)
    if page < 1:
        raise HTTPException(400, "ページが範囲外です。")
    source, index = (PaperFiles(folder).original_pdf, page - 1) if side == "original" else translated_page(folder, page - 1)
    if source is None or not source.is_file() or index >= (pdf_page_count(source) or 0):
        raise HTTPException(400, "書き込めるPDFページがありません。")
    return source, index

@router.get("/api/papers/{paper_id}/ink-pages")
def ink_pages(paper_id: str):
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    return lib.ink_pages(paper_id)

@router.post("/api/papers/{paper_id}/ink-capture")
@router.post("/api/papers/{paper_id}/ink-capture-v2")
def capture(paper_id: str, body: InkCaptureRequest):
    lib = deps.get_library()
    source, index = check_page(lib, paper_id, body.side, body.page)
    if body.include_ink:
        data = annotated_page(source, index, lib.ink(paper_id, body.side, body.page))
        rendered = page_png(data, 0, 1800)
    else:
        rendered = page_png(source, index, 1800)
    if rendered is None:
        raise HTTPException(400, "ページを画像にできませんでした。")
    with Image.open(io.BytesIO(rendered)) as image:
        box = (round(body.x * image.width), round(body.y * image.height),
               round((body.x + body.width) * image.width), round((body.y + body.height) * image.height))
        if box[2] <= box[0] or box[3] <= box[1]:
            raise HTTPException(400, "もう少し広い範囲を選択してください。")
        name = f"ink-capture-{uuid.uuid4().hex}.png"
        folder = PaperFiles(deps.paper_folder(lib, paper_id)).media
        folder.mkdir(exist_ok=True)
        image.crop(box).save(folder / name, format="PNG")
    return {"file": f"media/{name}", "page": body.page, "side": body.side}

@router.get("/api/papers/{paper_id}/ink/{side}/{page}")
@router.get("/api/papers/{paper_id}/ink-v2/{side}/{page}")
def get_ink(paper_id: str, side: Side, page: int):
    lib = deps.get_library()
    check_page(lib, paper_id, side, page)
    return {"strokes": lib.ink(paper_id, side, page)}

@router.put("/api/papers/{paper_id}/ink/{side}/{page}")
@router.put("/api/papers/{paper_id}/ink-v2/{side}/{page}")
def put_ink(paper_id: str, side: Side, page: int, body: InkPageRequest):
    lib = deps.get_library()
    check_page(lib, paper_id, side, page)
    lib.save_ink(paper_id, side, page, [stroke.model_dump(exclude_unset=True) for stroke in body.strokes])
    return {"status": "saved"}

@router.post("/api/papers/{paper_id}/ink-export")
def export_ink(paper_id: str, body: InkExportRequest):
    lib = deps.get_library()
    folder = deps.paper_folder(lib, paper_id)
    if body.side == "translated":
        preview = read_preview(folder)
        if preview and not preview["complete"]:
            raise HTTPException(400, "翻訳が完了してから書き込み付きPDFを保存してください。")
    files = PaperFiles(folder)
    source = files.original_pdf if body.side == "original" else files.translated_pdf
    if not source.is_file():
        raise HTTPException(400, "保存するPDFがありません。")
    destination = Path(body.destination).resolve() if body.destination else None
    if destination and (destination.is_relative_to((lib.root / "papers").resolve()) or destination.suffix.lower() != ".pdf"):
        raise HTTPException(400, "ライブラリの外に、拡張子 .pdf の保存先を選んでください。")
    try:
        data = annotated_pdf(source, lib.ink_by_page(paper_id, body.side))
        if destination:
            destination.parent.mkdir(parents=True, exist_ok=True)
            # Replace only after the complete PDF is written successfully.
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".pdf", delete=False) as output:
                    temporary = Path(output.name)
                    output.write(data)
                os.replace(temporary, destination)
            finally:
                if temporary:
                    temporary.unlink(missing_ok=True)
            return {"status": "exported", "destination": str(destination)}
        return Response(data, media_type="application/pdf", headers={
            "Content-Disposition": f'attachment; filename="{body.side}-annotated.pdf"'})
    except (OSError, ValueError, RuntimeError) as exc:
        raise HTTPException(400, f"書き込み付きPDFを保存できませんでした：{exc}") from exc
