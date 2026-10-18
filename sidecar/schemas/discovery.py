"""The map's typed provenance is separate from the PDF-extracted bibliography."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from sidecar.schemas.citations import Reference

Role = Literal["references", "incoming", "related", "prior", "following"]


class DiscoveryNode(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)
    id: str
    paper_id: str | None = None
    title: str
    year: str = ""
    url: str = ""
    doi: str = ""
    arxiv_id: str = ""
    first_author: str = ""
    abstract: str = ""
    external_id: str = ""
    external_citations: int | None = None
    local_citations: int = 0
    roles: list[Role] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    score: float = 0
    prior_count: int = 0
    following_count: int = 0
    reference_id: str | None = None
    research_key: str
    provenance: list[str] = Field(default_factory=list)
    acquired_at: str = ""


class DiscoveryEdge(BaseModel):
    source: str
    target: str
    kind: Literal["citation", "similarity", "recommendation", "candidate"]
    provenance: str


class MapTimingStep(BaseModel):
    key: str
    parent: str
    label: str
    elapsed_ms: float = Field(ge=0)
    total_ms: float = Field(ge=0)
    count: int = Field(ge=0)
    errors: int = Field(ge=0)
    canceled: int = Field(ge=0)


class MapTiming(BaseModel):
    id: str
    started_at: str
    finished_at: str
    status: Literal["running", "completed", "partial", "canceled", "failed"]
    total_ms: float = Field(ge=0)
    other_ms: float = Field(ge=0)
    steps: list[MapTimingStep]


class DiscoveryResult(BaseModel):
    origin: str
    nodes: list[DiscoveryNode]
    edges: list[DiscoveryEdge]
    checked_at: str
    stale: bool
    warnings: list[str]
    coverage: str
    references: list[Reference]
    timing: MapTiming | None = None


class DiscoveryRequest(BaseModel):
    origin: str = Field(default="", max_length=200)
    force: bool = False


class DiscoverySelection(DiscoveryRequest):
    node_id: str = Field(max_length=200)


class MapGroupRequest(DiscoveryRequest):
    groups: list[list[str]] = Field(min_length=1, max_length=30)


class MapGroupDescription(BaseModel):
    key: str
    members: list[str]
    name: str
    description: str
    evidence: list[str]
    provider: str
    model: str
    created_at: str
    elapsed_ms: float
    stale: bool


class MapGroupResult(BaseModel):
    origin: str
    groups: list[MapGroupDescription]
    connection: str
