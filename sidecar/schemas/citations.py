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


class Reference(BaseModel):
    id: str
    source: str
    target: str
    raw: str
    label: str
    page: int
    title: str
    doi: str
    arxiv_id: str
    year: str
    match: Literal["identifier", "title", "unresolved", "manual"]
    url: str
    research_key: str


class CitationWarning(BaseModel):
    paper_id: str
    message: str


class CitationGraph(BaseModel):
    nodes: list[CitationNode]
    edges: list[CitationEdge]
    references: list[Reference]
    warnings: list[CitationWarning]
