"""The library: papers, folders (collections), their files, sticky notes and what the reader shows."""
from __future__ import annotations

from contextlib import nullcontext
from pathlib import Path
import logging
import re
import threading
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse

from papeer.core import library_organize, ocr, reading_state, search
from papeer.core.bibtex import bibtex, export_bibtex
from papeer.core.citations import citation_graph
from papeer.core.errors import Invalid, NotFound
from papeer.core.library_list import LibrarySort, library_rows, paper_row
from papeer.core.opened_papers import mark_opened
from papeer.core.paths import PaperFiles
from papeer.core.paper_metadata import complete_metadata
from papeer.core.storage import normalize_collection_name
from papeer.pdf.pdf_viewer import pdf_page_count
from papeer.providers import Cancelled
from sidecar import deps
from sidecar.job_types import ImportItemEvent, ImportPagesEvent, JobKind, JobStarted
from sidecar.jobs import ConcurrencyConflict, TurnQueue
from sidecar.routes.ocr import ocr_turn
from sidecar.schemas.papers import (
    ApplyMovesRequest,
    ApplyMovesResult,
    Article,
    BibtexExportRequest,
    BibtexRequest,
    BookmarkEditRequest,
    BookmarkRequest,
    CreateCollectionRequest,
    ImportRequest,
    LibraryStickyNote,
    OrganizeRequest,
    Paper,
    PaperOpened,
    PaperRow,
    ReadingState,
    RenameCollectionRequest,
    RenamePaperRequest,
    StickyNote,
    UpdatePaperRequest,
)
from sidecar.ui_state import load_ui_state
from sidecar.schemas.citations import CitationGraph

router = APIRouter(dependencies=[Depends(deps.verify_token)])
logger = logging.getLogger(__name__)


# --- Papers ---


@router.get("/api/citations", response_model=CitationGraph)
def citations() -> dict[str, Any]:
    return citation_graph(deps.get_library())


# The rows keep exactly the keys they were given (see PaperRow).
@router.get("/api/papers", response_model=list[PaperRow], response_model_exclude_unset=True)
def list_papers(query: str = "", sort: int = 0) -> list[dict[str, Any]]:
    """Every paper's row (without the memo); `sort` is a LibrarySort."""
    try:
        order = LibrarySort(sort)
    except ValueError:
        raise Invalid("並べ替えの指定が不正です。") from None
    return library_rows(deps.get_library(), query, order)


# Imports run one after another in request order, so PDFs dropped while others are still
# being added simply wait. Extraction is serialized by PDF_LOCK anyway, and the duplicate
# check in Library.import_pdf would race if two imports of the same file overlapped.
import_turns = TurnQueue()


def submit_import(action: Any, before_turn: Any = None) -> str:
    """Submit an import job that waits for the earlier ones; `before_turn` runs before waiting."""
    ticket = import_turns.ticket()

    def queued(cancel: threading.Event, progress: Any, page_ready: Any) -> Any:
        try:
            if before_turn:
                before_turn()
            if not import_turns.wait(ticket, cancel, lambda: progress("前のPDFの追加が終わるのを待っています…")):
                raise Cancelled("追加を中止しました。")
            return action(cancel, progress, page_ready)
        finally:
            import_turns.release(ticket)

    try:
        return deps.job_manager.submit_job(JobKind.IMPORT, queued, paper_id=None).job_id
    except ConcurrencyConflict:
        import_turns.release(ticket)
        raise


@router.post("/api/papers/import")
def import_papers(body: ImportRequest) -> JobStarted:
    lib = deps.get_library()
    paths = [Path(p) for p in body.paths]
    for p in paths:
        if not p.is_file():
            raise Invalid(f"ファイルが存在しません: {p}")

    def announce_pages() -> None:
        # Page counts are cheap, so the library can show them on its placeholder rows
        # long before text extraction (or an earlier import) finishes. Keyed by the path as sent.
        deps.job_manager.broadcast(ImportPagesEvent(pages={
            source: pdf_page_count(path) for source, path in zip(body.paths, paths)}))

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict[str, Any]:
        imported_ids: list[str] = []
        added_ids: list[str] = []
        needs_ocr: list[str] = []
        metadata_failures: list[str] = []
        added = 0
        # This PC's OCR setting "auto": pages needing OCR are read while the paper is added.
        reads = ocr.import_reads()
        for i, (source, path) in enumerate(zip(body.paths, paths)):
            if cancel.is_set():
                raise Cancelled("追加を中止しました。追加済みの論文は保存されています。")
            label = f"PDFを追加 {i + 1}/{len(paths)}: {path.name}"
            progress(label)
            run = None
            if reads:
                run = ocr.ocr_run(ocr.ocr_options(), cancel,
                                  progress=lambda page, _done, _total, label=label: progress(f"{label}（p.{page} を OCR で読んでいます）"))
            try:
                with ocr_turn(cancel, progress) if reads else nullcontext():
                    paper_id, is_new = lib.import_pdf(path, collection_name=body.collection or "", ocr=run)
            except Cancelled:
                raise Cancelled("追加を中止しました。追加済みの論文は保存されています。") from None
            imported_ids.append(paper_id)
            added += is_new
            if is_new:
                added_ids.append(paper_id)
            document = lib.document(paper_id)
            if is_new and any(entry.get("reason") != "partial" for entry in document["ocr_pages"]):
                needs_ocr.append(paper_id)
            # Also a library change: the client refreshes the list, then drops the placeholder row.
            deps.job_manager.broadcast(ImportItemEvent(path=source, paper_id=paper_id))
            settings = deps.get_settings()
            if is_new and settings.paper_metadata_ai_enabled:
                progress(f"{label}（不足している論文情報を調べています）")
                try:
                    changed = complete_metadata(lib, paper_id, settings,
                                                lambda settings=settings: deps.provider_for(settings.for_paper_metadata(), cancel),
                                                enabled_now=lambda: deps.get_settings().paper_metadata_ai_enabled,
                                                on_warning=lambda message, name=path.name: metadata_failures.append(f"{name}: {message}"))
                    if changed:
                        deps.paper_changed(paper_id, changed)
                except Cancelled:
                    raise Cancelled("追加を中止しました。追加済みの論文は保存されています。") from None
                except Exception as error:  # noqa: BLE001 - optional metadata failure must not lose an imported PDF
                    logger.warning("Paper metadata completion failed for %s", paper_id, exc_info=True)
                    metadata_failures.append(f"{path.name}: {error}")
        return {"paper_ids": imported_ids, "added": added, "added_ids": added_ids, "needs_ocr": needs_ocr,
                "metadata_failures": metadata_failures}

    return JobStarted(job_id=submit_import(action, announce_pages))


@router.get("/api/papers/{paper_id}", response_model=Paper, response_model_exclude_unset=True)
def get_paper(paper_id: str) -> dict[str, Any]:
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    paper = lib.paper(paper_id)
    return {**paper_row(lib, paper), "note": paper["note"]}


@router.patch("/api/papers/{paper_id}")
def update_paper(paper_id: str, body: UpdatePaperRequest) -> dict[str, str]:
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    if body.title is not None and not body.title.strip():
        raise Invalid("タイトルを入力してください。")
    fields = {"title": body.title.strip() if body.title is not None else None, "first_author": body.author,
              "publication_year": str(body.year) if body.year is not None else None,
              "collection_name": body.collection, "note": body.note, "tags": body.tags, "read_status": body.read_status,
              "doi": body.doi, "arxiv_id": body.arxiv_id, "venue": body.venue}
    updates = {key: value for key, value in fields.items() if value is not None}
    if updates:
        lib.update(paper_id, **updates)
        # A memo saved as it is typed then reloads no list at all.
        deps.paper_changed(paper_id, updates)
    return {"status": "updated"}


@router.post("/api/papers/{paper_id}/opened", response_model=PaperOpened)
def paper_opened(paper_id: str) -> dict[str, Any]:
    """The reader opened the paper: remembered on this PC for 最近開いた順, and 未読 becomes 読書中 (mark_opened)."""
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    result = mark_opened(lib, paper_id)
    deps.paper_changed(paper_id, result["fields"])
    return result


@router.post("/api/papers/{paper_id}/rename")
def rename_paper(paper_id: str, body: RenamePaperRequest) -> dict[str, str]:
    lib = deps.get_library()
    name = lib.rename_paper(paper_id, body.new_title)
    deps.paper_changed(paper_id, ["original_name", "title"])
    return {"status": "renamed", "name": name}


@router.delete("/api/papers/{paper_id}")
def delete_paper(paper_id: str) -> dict[str, str]:
    with deps.job_manager.idle("処理中のジョブがあるため削除できません。", paper_id):
        lib = deps.get_library()
        lib.paper_folder(paper_id)
        lib.delete_paper(paper_id)
    deps.library_changed()
    return {"status": "deleted"}


@router.post("/api/papers/bibtex")
def papers_bibtex(body: BibtexRequest) -> dict[str, Any]:
    """BibTeX entries of the papers, to copy; made from the library's own data (nothing is looked up online)."""
    papers = deps.get_library().papers_by_id(body.paper_ids)
    return {"text": bibtex(papers), "count": len(papers)}


# --- What the reader shows ---


@router.get("/api/papers/{paper_id}/reading", response_model=ReadingState)
def get_reading_info(paper_id: str) -> dict[str, Any]:
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    last_page = load_ui_state(deps.get_data_dir()).get("reading_pages", {}).get(paper_id, 0)
    return reading_state.reading_state(lib, paper_id, last_page)


@router.get("/api/papers/{paper_id}/translation-text/{page}")
def get_translation_text(paper_id: str, page: int) -> dict[str, list[str]]:
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    return {"blocks": reading_state.translation_text(lib, paper_id, page)}


@router.get("/api/papers/{paper_id}/search")
def search_paper(paper_id: str, q: str = "", side: str = "original") -> dict[str, Any]:
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    return search.search_paper(lib, paper_id, q, side)


@router.get("/api/papers/{paper_id}/article", response_model=Article)
def get_paper_article(paper_id: str) -> dict[str, Any]:
    lib = deps.get_library()
    files = PaperFiles(lib.paper_folder(paper_id))
    if not files.article_md.is_file():
        raise NotFound("サマリー記事がまだ生成されていません。")
    return {"content": files.article_md.read_text("utf-8"), "usage": files.read_json(files.article_usage)}


# --- Files, served to pdf.js and <img> ---


SAFE_FILE_NAME = re.compile(r"^(original|translated|interleaved|bilingual)\.pdf$")
SAFE_PAGE_NAME = re.compile(r"^translation-pages/([0-9a-f]{32})/page-(\d+)\.pdf$")


@router.get("/api/papers/{paper_id}/files/{file_path:path}")
def stream_paper_file(paper_id: str, file_path: str, request: Request) -> Response:
    """A paper's PDF, with HTTP Range support so pdf.js can fetch only the parts it needs."""
    lib = deps.get_library()
    folder = lib.paper_folder(paper_id).resolve()

    normalized = file_path.replace("\\", "/")
    if not (SAFE_FILE_NAME.match(normalized) or SAFE_PAGE_NAME.match(normalized)):
        raise Invalid("許可されていないファイル形式です。")

    target = (folder / normalized).resolve()
    if not target.is_relative_to(folder) or not target.is_file():
        raise NotFound("ファイルが見つかりません。")

    stat = target.stat()
    file_size = stat.st_size
    etag = f'"{int(stat.st_mtime)}-{file_size}"'

    if_none_match = request.headers.get("if-none-match")
    if if_none_match and if_none_match == etag:
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers={"ETag": etag})

    range_header = request.headers.get("range")
    if not range_header or not range_header.startswith("bytes="):
        return FileResponse(target, media_type="application/pdf", headers={"Accept-Ranges": "bytes", "ETag": etag})

    parts = range_header[len("bytes="):].strip().split("-")
    try:
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if len(parts) > 1 and parts[1] else file_size - 1
    except ValueError:
        return Response(status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE)

    if start >= file_size or end >= file_size or start > end:
        return Response(status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                        headers={"Content-Range": f"bytes */{file_size}"})

    content_length = end - start + 1

    def iterfile():
        with open(target, "rb") as f:
            f.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(
        iterfile(),
        status_code=status.HTTP_206_PARTIAL_CONTENT,
        media_type="application/pdf",
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(content_length),
            "ETag": etag,
        },
    )


@router.get("/api/papers/{paper_id}/media/{name}")
def get_paper_media(paper_id: str, name: str) -> FileResponse:
    lib = deps.get_library()
    media = PaperFiles(lib.paper_folder(paper_id).resolve()).media
    if not re.fullmatch(r"^[a-zA-Z0-9_\-\.]+\.png$", name):
        raise Invalid("不正な画像名です。")
    media_file = (media / name).resolve()
    if not media_file.is_relative_to(media) or not media_file.is_file():
        raise NotFound("画像が見つかりません。")
    return FileResponse(media_file, media_type="image/png")


# --- Sticky notes and highlights (stored in the bookmarks table) ---


def _paper_library(paper_id: str):
    """The library, once the paper is known to exist (404 otherwise, as for its other routes)."""
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    return lib


@router.get("/api/sticky-notes", response_model=list[LibraryStickyNote])
def get_sticky_notes() -> list[dict]:
    return deps.get_library().sticky_notes()


@router.get("/api/papers/{paper_id}/sticky-notes", response_model=list[StickyNote])
def get_bookmarks(paper_id: str) -> list[dict]:
    return _paper_library(paper_id).bookmarks(paper_id)


@router.post("/api/papers/{paper_id}/sticky-notes", response_model=StickyNote)
def add_bookmark(paper_id: str, body: BookmarkRequest) -> dict:
    return _paper_library(paper_id).add_bookmark(paper_id, body.page, body.side, body.quote, body.label, body.note,
                                                 body.anchor_y, body.anchor_x, kind=body.kind, color=body.color,
                                                 rects=[list(rect) for rect in body.rects])


@router.delete("/api/papers/{paper_id}/sticky-notes/{bookmark_id}")
def delete_bookmark(paper_id: str, bookmark_id: int) -> dict[str, bool]:
    return {"deleted": _paper_library(paper_id).delete_bookmark(paper_id, bookmark_id)}


@router.patch("/api/papers/{paper_id}/sticky-notes/{bookmark_id}", response_model=StickyNote)
def update_bookmark(paper_id: str, bookmark_id: int, body: BookmarkEditRequest) -> dict:
    # A missing note is NotFound (404); a wrong color, like any other invalid value, 400.
    return _paper_library(paper_id).update_bookmark(paper_id, bookmark_id, body.label, body.note,
                                                    anchor_x=body.anchor_x, anchor_y=body.anchor_y, color=body.color)


# --- Folders (collections) ---


@router.get("/api/collections")
def list_collections() -> list[str]:
    return [c for c in deps.get_library().collections() if c]


@router.post("/api/collections")
def create_collection(body: CreateCollectionRequest) -> dict[str, str]:
    name = normalize_collection_name(body.name)
    if not name:
        raise Invalid("有効なフォルダー名を入力してください。")
    lib = deps.get_library()
    if name in lib.collections():
        raise Invalid("同じ名前のフォルダーが既にあります。")
    lib.create_collection(name)
    deps.library_changed()
    return {"status": "created", "name": name}


@router.patch("/api/collections/rename")
def rename_collection(body: RenameCollectionRequest) -> dict[str, str]:
    lib = deps.get_library()
    # new_name is the new last segment; accept a full path too for older clients.
    leaf = normalize_collection_name(body.new_name).split(" / ")[-1]
    destination = lib.rename_collection(body.old_name, leaf)
    deps.library_changed()
    return {"status": "renamed", "name": destination}


@router.post("/api/collections/organize")
def organize_collection(body: OrganizeRequest) -> JobStarted:
    """Have the AI propose folders for the papers of a folder (or of paper_ids); the result is a preview."""
    lib = deps.get_library()
    library_organize.organize_candidates(lib, body.source, body.paper_ids)  # Invalid (400) before the job starts.
    settings = deps.settings_for_run(body.model, body.effort)
    previous = body.previous.model_dump() if body.previous else None

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict:
        provider = deps.provider_for(settings, cancel)
        result = library_organize.propose_organization(
            lib, provider, cancel, progress, source=body.source, instruction=body.instruction,
            paper_ids=body.paper_ids, feedback=body.feedback, previous=previous)
        report = getattr(provider, "usage_report", None)
        return {**result, "usage": report() if report else None}

    return deps.submit_job(JobKind.LIBRARY_ORGANIZE, action)


@router.post("/api/collections/apply-moves", response_model=ApplyMovesResult)
def apply_collection_moves(body: ApplyMovesRequest) -> dict[str, Any]:
    """Apply a proposal all or nothing: 409 (code collection_changed) when a paper is gone or has moved since."""
    result = deps.get_library().apply_moves([move.model_dump() for move in body.moves], body.expected)
    if result["moved"] or result["created"]:
        deps.library_changed()
    return result


@router.post("/api/collections/bibtex")
def export_collection_bibtex(body: BibtexExportRequest) -> dict[str, Any]:
    """Save the BibTeX entries of a folder's papers (with its subfolders') to a .bib file outside the library."""
    lib = deps.get_library()
    papers = lib.collection_papers(body.collection)
    count = export_bibtex(Path(body.destination), papers, lib.root)
    return {"count": count, "destination": str(Path(body.destination).resolve())}


@router.delete("/api/collections/{name:path}")
def delete_collection(name: str) -> dict[str, Any]:
    lib = deps.get_library()
    token = uuid.uuid4().hex
    moved = lib.delete_collection(name, undo_token=token)
    deps.library_changed()
    return {"status": "deleted", "moved": moved, "undo_token": token}


@router.post("/api/collections/restore/{undo_token}")
def restore_collection(undo_token: str) -> dict[str, str]:
    name = deps.get_library().restore_collection(undo_token)
    deps.library_changed()
    return {"status": "restored", "name": name}
