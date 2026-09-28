"""Request models of freehand ink (sidecar/routes/ink.py): strokes per page, region capture, exported PDFs."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

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
