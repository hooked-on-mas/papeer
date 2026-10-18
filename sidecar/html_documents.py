"""HTML documents (attachments of format html): their metadata, and the isolated route that shows them.

A document is arbitrary HTML the user added, so it is never served from the API's own routes: the
authenticated side (`router`) only describes it and hands out a ticket, and `public` serves the bytes
under a Content-Security-Policy sandbox, to a ticket instead of the launch token. The token never
reaches the document: a page that could carry it would call the API as the user.

A ticket is 256 random bits, read-only, kept in memory for TICKET_TTL seconds, and scoped to one
document of one library at one content (its SHA-256) and one script mode, so a document that was
changed, deleted or replaced by another library is refused instead of shown stale.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
from pathlib import Path
import secrets
import threading
import time
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, ConfigDict, Field

from papeer.core.errors import Conflict, Invalid, NotFound
from sidecar import deps
from sidecar.routes.attachments import Attachment, library

router = APIRouter(dependencies=[Depends(deps.verify_token)])
# Without the token (dependencies): the viewer's ticket is its only credential.
public = APIRouter()

TICKET_TTL = 600.0
MAX_TICKETS = 256
VIEW_PATH = "/html-view/"
DOCUMENT_CHANGED = "document_changed"

# What a page of the document may not do, whatever the CSP says (the CSP has no switch for these).
PERMISSIONS_POLICY = ", ".join(f"{feature}=()" for feature in (
    "accelerometer", "autoplay", "camera", "clipboard-read", "clipboard-write", "display-capture", "fullscreen",
    "geolocation", "gyroscope", "hid", "magnetometer", "microphone", "midi", "payment", "publickey-credentials-get",
    "screen-wake-lock", "serial", "usb", "xr-spatial-tracking"))


class NewDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=200)
    content: str
    source: Literal["imported", "user"] = "user"


class HtmlDocument(Attachment):
    content_hash: str


class ViewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    allow_scripts: bool = False
    content_hash: str = Field(min_length=1, max_length=128)


class ViewTicket(BaseModel):
    path: str


@dataclass(frozen=True)
class Grant:
    owner_id: str
    attachment_id: str
    root: Path
    content_hash: str
    allow_scripts: bool
    expires: float


_tickets: OrderedDict[str, Grant] = OrderedDict()
_lock = threading.Lock()


def clock() -> float:
    """Looked up at call time, so a test can move it."""
    return time.monotonic()


def mint(grant_for: Grant) -> str:
    """Remember a grant under a new random ticket; the oldest go when there are too many."""
    ticket = secrets.token_urlsafe(32)
    with _lock:
        now = clock()
        for stale in [key for key, grant in _tickets.items() if grant.expires <= now]:
            del _tickets[stale]
        while len(_tickets) >= MAX_TICKETS:
            _tickets.popitem(last=False)
        _tickets[ticket] = grant_for
    return ticket


def find(ticket: str) -> Grant | None:
    with _lock:
        grant = _tickets.get(ticket)
        if grant is not None and grant.expires <= clock():
            del _tickets[ticket]
            return None
        return grant


def revoke(ticket: str) -> None:
    with _lock:
        _tickets.pop(ticket, None)


def content_hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def same_root(first: Path, second: Path) -> bool:
    return first.resolve() == second.resolve()


def document(lib, owner: str, identity: str) -> dict:
    row = next((item for item in lib.attachments(owner) if item["id"] == identity and item["format"] == "html"), None)
    if row is None:
        raise NotFound("資料が見つかりません。")
    return row


# --- Authenticated side ---

@router.post("/api/papers/{paper_id}/documents", response_model=Attachment)
def create_document(paper_id: str, body: NewDocument):
    lib = library(paper_id)
    if not body.title.strip():
        raise Invalid("資料の名前を入力してください。")
    try:
        body.content.encode("utf-8")
    except UnicodeEncodeError:
        raise Invalid("資料の本文を UTF-8 で保存できません。") from None
    row = lib.add_attachment(paper_id, "html", body.title, body.content, body.source)
    deps.paper_changed(paper_id, ["attachment_count"])
    return row


@router.get("/api/papers/{paper_id}/documents/{attachment_id}", response_model=HtmlDocument)
def get_document(paper_id: str, attachment_id: str):
    lib = library(paper_id)
    row = document(lib, paper_id, attachment_id)
    return {**row, "content_hash": content_hash(lib.attachment_bytes(attachment_id))}


@router.post("/api/papers/{paper_id}/documents/{attachment_id}/view", response_model=ViewTicket)
def open_document(paper_id: str, attachment_id: str, body: ViewRequest):
    lib = library(paper_id)
    document(lib, paper_id, attachment_id)
    if content_hash(lib.attachment_bytes(attachment_id)) != body.content_hash:
        raise Conflict("資料が変更されました。開き直してください。", code=DOCUMENT_CHANGED)
    ticket = mint(Grant(paper_id, attachment_id, lib.root, body.content_hash, body.allow_scripts,
                        clock() + TICKET_TTL))
    return {"path": VIEW_PATH + ticket}


# --- The viewer ---

def policy(allow_scripts: bool, ancestors: list[str]) -> str:
    return "; ".join([
        "sandbox allow-scripts" if allow_scripts else "sandbox",
        "default-src 'none'",
        "script-src 'unsafe-inline'" if allow_scripts else "script-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src data:",
        "font-src data:",
        "connect-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors " + " ".join(ancestors),
    ])


def app_origins() -> list[str]:
    # Looked up now: sidecar.app imports this module.
    import sys

    from sidecar.app import allowed_origins
    return allowed_origins(getattr(sys, "frozen", False))


@public.get("/html-view/{ticket}", include_in_schema=False)
def view_document(ticket: str):
    """The document's bytes as they were saved, under a sandboxing CSP; 404 for any ticket that is not live.

    The token is neither needed nor looked at, so the middleware that counts library requests does not
    admit this route: it asks for admission itself, after the ticket is known, and answers library_busy
    while a sync, backup or restore holds the library.
    """
    grant = find(ticket)
    if grant is None:
        raise NotFound("資料を開けません。もう一度開いてください。")
    admitted = deps.begin_library_request(read_only=True)
    if not admitted:
        raise deps.LibraryBusy()
    try:
        lib = deps.get_library()
        if not same_root(lib.root, grant.root):
            raise NotFound("資料を開けません。もう一度開いてください。")
        try:
            document(lib, grant.owner_id, grant.attachment_id)
            raw = lib.attachment_bytes(grant.attachment_id)
        except NotFound:
            revoke(ticket)
            raise NotFound("資料が見つかりません。") from None
        if content_hash(raw) != grant.content_hash:
            revoke(ticket)
            raise Conflict("資料が変更されました。開き直してください。", code=DOCUMENT_CHANGED)
    finally:
        deps.end_library_request(admitted)
    return HTMLResponse(raw, headers={
        "Content-Security-Policy": policy(grant.allow_scripts, app_origins()),
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Permissions-Policy": PERMISSIONS_POLICY,
    })
