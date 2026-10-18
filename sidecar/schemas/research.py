"""Saved public sources and the reference-to-reading workflow."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool


class WebSource(BaseModel):
    title: str
    url: str


class PdfCandidate(WebSource):
    version: str


class ResearchFailure(BaseModel):
    kind: Literal["identity_mismatch"]
    title: str
    returned_title: str
    expected_doi: str
    returned_doi: str
    expected_arxiv_id: str
    returned_arxiv_id: str
    sources: list[WebSource]
    checked_at: str
    message: str


class ResearchRecord(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)
    key: str
    title: str
    raw: str
    doi: str = ""
    arxiv_id: str = ""
    first_author: str = ""
    publication_year: str = ""
    venue: str = ""
    abstract: str = ""
    diagnostics: list[str] = Field(default_factory=list)
    lookup_version: int = 0
    summary: str = ""
    basis: Literal["abstract", "full_text", "metadata", "unresolved"] = "metadata"
    sources: list[WebSource] = Field(default_factory=list)
    pdfs: list[PdfCandidate] = Field(default_factory=list)
    checked_at: str = ""
    paper_id: str | None = None
    has_summary: bool = False
    needs_ocr: bool = False
    version: str = ""
    summary_error: str = ""
    last_failure: ResearchFailure | None = None


class ChatResearch(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)
    web_search: bool = False
    sources: list[WebSource] = Field(default_factory=list)
    records: list[ResearchRecord] = Field(default_factory=list)
    attached_keys: list[str] = Field(default_factory=list)


class ResearchRequest(BaseModel):
    reference_id: str = Field(default="", max_length=100)
    research_key: str = Field(default="", max_length=100)


class ResearchImportRequest(BaseModel):
    pdf_index: int | None = Field(default=None, ge=0, le=19)
    local_path: str = Field(default="", max_length=4000)
    collection: str = Field(default="", max_length=1000)
    create_summary: StrictBool = False


class ReferenceImportResult(BaseModel):
    record: ResearchRecord
    added: bool = False
