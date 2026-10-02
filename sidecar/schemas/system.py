"""Models of the health check and the remembered UI state (sidecar/routes/system.py)."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)  # status is always sent.
    status: str = "ok"
    version: str  # App release, MAJOR.MINOR.PATCH (papeer.__version__).
    code_version: str  # Extraction and PDF drawing code identity, "code-sha256-<hex>" (papeer.core.code_version).


class UIStateModel(BaseModel):
    reading_pages: dict[str, int] = Field(default_factory=dict)
    # Where the view was within each paper's page in reading_pages, as a fraction of the page's height.
    reading_anchors: dict[str, float] = Field(default_factory=dict)
    last_paper: str = ""
    sort: int = 0
    expanded_collections: list[str] = Field(default_factory=list)
    chat_web_search: dict[str, bool] = Field(default_factory=dict)
