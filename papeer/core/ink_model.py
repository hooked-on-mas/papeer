"""Normalized PDF ink shared by desktop requests and Google Drive imports."""
from __future__ import annotations

from typing import Annotated, Literal
from pydantic import BaseModel, Field, model_validator

Coordinate = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class InkStroke(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    width: float = Field(gt=0, le=0.08, allow_inf_nan=False)
    points: list[tuple[Coordinate, Coordinate]] = Field(min_length=1, max_length=20000)
    kind: Literal["pen", "highlighter", "line", "arrow", "rectangle", "ellipse", "text"] = "pen"
    text: str | None = Field(default=None, max_length=2000)
    # Preferred head size in page-width units, retained when the shaft is shortened.
    arrowHeadLength: float | None = Field(default=None, gt=0, allow_inf_nan=False)

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

