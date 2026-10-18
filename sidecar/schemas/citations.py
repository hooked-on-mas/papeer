"""The local reference list and its directed citation network."""
from typing import Literal

from pydantic import BaseModel


class CitationNode(BaseModel):
    id: str
    paper_id: str | None
    title: str
    year: str
    url: str


class CitationEdge(BaseModel):
    source: str
    target: str


class ReferenceProvenance(BaseModel):
    provider: Literal["PDF", "Semantic Scholar", "Crossref"]
    page: int | None = None
    label: str = ""
    checked_at: str = ""


class Reference(BaseModel):
    id: str
    source: str
    target: str
    raw: str
    label: str
    page: int | None
    title: str
    doi: str
    arxiv_id: str
    year: str
    match: Literal["identifier", "title", "unresolved", "manual"]
    url: str
    research_key: str
    first_author: str = ""
    abstract: str = ""
    provenance: list[ReferenceProvenance] = []
    citation_status: Literal["confirmed", "unverified"] = "confirmed"


class CitationWarning(BaseModel):
    paper_id: str
    message: str


class CitationGraph(BaseModel):
    nodes: list[CitationNode]
    edges: list[CitationEdge]
    references: list[Reference]
    warnings: list[CitationWarning]
