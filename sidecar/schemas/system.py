"""Models of the health check and the remembered UI state (sidecar/routes/system.py)."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)  # status is always sent.
    status: str = "ok"
    version: str  # App release, MAJOR.MINOR.PATCH (papeer.__version__).
    code_version: str  # Extraction and PDF drawing code identity, "code-sha256-<hex>" (papeer.core.code_version).


class InstanceResponse(BaseModel):
    """Who this sidecar is (GET /api/instance): what the CLI and a second window check a discovery file against."""
    pid: int
    launcher: str  # "app" (the installed app), "dev" (just dev-sidecar) or "cli" (started headless by the CLI).
    data_dir: str  # The library's folder, as the discovery file names it.
    port: int | None  # Where it listens; None when it did not bind its own socket (a test client).
    version: str  # App release, MAJOR.MINOR.PATCH (papeer.__version__).
    idle_exit: float | None  # Seconds of idleness after which it ends by itself; None: it does not.


class UIStateModel(BaseModel):
    reading_pages: dict[str, int] = Field(default_factory=dict)
    # Where the view was within each paper's page in reading_pages, as a fraction of the page's height.
    reading_anchors: dict[str, float] = Field(default_factory=dict)
    last_paper: str = ""
    sort: int = 0
    expanded_collections: list[str] = Field(default_factory=list)
    chat_web_search: dict[str, bool] = Field(default_factory=dict)
