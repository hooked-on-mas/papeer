"""Request models of the reading aids (sidecar/routes/reading.py): choices, templates, glossary, revisions, backup."""
from __future__ import annotations

from pydantic import BaseModel, Field


class TemplateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    content: str = Field(min_length=1, max_length=50000)


class GlobalGlossaryRequest(BaseModel):
    terms: list[dict[str, str]]
    expected_terms: list[dict[str, str]]


class GlossaryFileRequest(BaseModel):
    path: str = Field(min_length=1)
    terms: list[dict[str, str]]


class GlossaryDraftRequest(BaseModel):
    terms: list[dict[str, str]] = Field(default_factory=list)
    model: str | None = None
    effort: str | None = None


class PaperDomainsRequest(BaseModel):
    domains: list[str] = Field(default_factory=list, max_length=200)
    new_domain: str | None = Field(default=None, max_length=40)


class PaperGlossaryRequest(BaseModel):
    terms: list[dict[str, str]] = Field(max_length=2000)
    dismissed: list[str] = Field(max_length=2000)
    expected: dict


class GlossarySelectRequest(BaseModel):
    model: str | None = None
    effort: str | None = None


class GlossarySplitRequest(BaseModel):
    domain: str = Field(min_length=1, max_length=40)  # The dictionary to split: a domain's name, or 共通.
    model: str | None = None
    effort: str | None = None
    preview: bool = False


class GlossaryTermRequest(BaseModel):
    source: str = Field(min_length=1, max_length=100)
    target: str = Field(min_length=1, max_length=100)


class BackupRequest(BaseModel):
    path: str


class RestoreRequest(BackupRequest):
    # Take the backup's settings.json and prompts too; otherwise the current ones are kept.
    import_settings: bool = False


class TagRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class RevisionRequest(BaseModel):
    unit_id: str
    text: str = ""
    instruction: str = Field(default="自然な日本語にしてください。", max_length=2000)
    expected_text: str | None = None
    # A shorter translation to fit the typeset space: about this many characters (revision-draft only).
    char_budget: int | None = Field(default=None, ge=1, le=50000)
