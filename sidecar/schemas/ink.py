"""Request models of freehand ink (sidecar/routes/ink.py): strokes per page, region capture, exported PDFs."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator
from papeer.core.ink_model import InkStroke as InkStroke

Side = Literal["original", "translated"]
Coordinate = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


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
    page_id: str | None = None
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
