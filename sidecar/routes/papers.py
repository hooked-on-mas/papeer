"""The library: papers, folders (collections), their files, sticky notes and what the reader shows."""
from __future__ import annotations

from pathlib import Path
import re
import shutil
import tempfile
import threading
import uuid
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse

from papeer.core import reading_state, search
from papeer.core.bibtex import bibtex, export_bibtex
from papeer.core.paths import PaperFiles
from papeer.core.reading_tools import validate_terms
from papeer.core.storage import normalize_collection_name
from papeer.core.terminology import global_glossary, save_global_glossary
from papeer.pdf.pdf_viewer import pdf_page_count
from papeer.providers import Cancelled
from sidecar import deps
from sidecar.jobs import ConcurrencyConflict, TurnQueue
from sidecar.schemas import (
    BibtexExportRequest,
    BibtexRequest,
    BookmarkEditRequest,
    BookmarkRequest,
    CreateCollectionRequest,
    GlossaryRequest,
    ImportRequest,
    RenameCollectionRequest,
    RenamePaperRequest,
    UpdatePaperRequest,
)
from sidecar.ui_state import load_ui_state

router = APIRouter(dependencies=[Depends(deps.verify_token)])


def _with_state(lib, paper: dict[str, Any]) -> dict[str, Any]:
    """A paper row with its folder and translation progress, as the library list shows it."""
    files = PaperFiles(lib.folder(paper["id"]))
    paper["folder_path"] = str(files.folder.resolve())
    paper["has_article"] = files.article_md.is_file()
    paper.update(reading_state.translation_state(files.folder, paper["pages"]))
    return paper


# --- Papers ---


@router.get("/api/papers")
def list_papers(query: str = "", sort: int = 0) -> list[dict[str, Any]]:
    lib = deps.get_library()
    papers = []
    for paper in lib.papers(query=query):
        try:
            papers.append(_with_state(lib, paper))
        except ValueError:
            papers.append(paper)
    if sort == 1:
        papers.reverse()
    elif sort in (2, 3):
        papers.sort(key=lambda p: (p.get("title") or "").casefold(), reverse=(sort == 3))
    return papers


# Imports run one after another in request order, so PDFs dropped while others are still
# being added simply wait. Extraction is serialized by PDF_LOCK anyway, and the duplicate
# check in Library.import_pdf would race if two imports of the same file overlapped.
import_turns = TurnQueue()


def submit_import(action: Any, before_turn: Any = None, cleanup: Any = None) -> str:
    """Submit an import job that waits for the earlier ones.

    `before_turn` runs before waiting; `cleanup` runs however the job ends, even if never submitted.
    """
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
            if cleanup:
                cleanup()

    try:
        return deps.job_manager.submit_job("import", queued, paper_id=None).job_id
    except ConcurrencyConflict as exc:
        import_turns.release(ticket)
        if cleanup:
            cleanup()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.post("/api/papers/import")
def import_papers(body: ImportRequest) -> dict[str, str]:
    lib = deps.get_library()
    paths = [Path(p) for p in body.paths]
    for p in paths:
        if not p.is_file():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"ファイルが存在しません: {p}")

    def announce_pages() -> None:
        # Page counts are cheap, so the library can show them on its placeholder rows
        # long before text extraction (or an earlier import) finishes. Keyed by the path as sent.
        deps.job_manager.broadcast({"type": "import.pages", "pages": {
            source: pdf_page_count(path) for source, path in zip(body.paths, paths)}})

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict[str, Any]:
        imported_ids: list[str] = []
        added = 0
        for i, (source, path) in enumerate(zip(body.paths, paths)):
            if cancel.is_set():
                raise Cancelled("追加を中止しました。追加済みの論文は保存されています。")
            progress(f"PDFを追加 {i + 1}/{len(paths)}: {path.name}")
            paper_id, is_new = lib.import_pdf(path, collection_name=body.collection or "")
            imported_ids.append(paper_id)
            added += is_new
            lib.document(paper_id)
            # Also a library change: the client refreshes the list, then drops the placeholder row.
            deps.job_manager.broadcast({"type": "import.item", "path": source, "paper_id": paper_id})
        return {"paper_ids": imported_ids, "added": added}

    return {"job_id": submit_import(action, announce_pages)}


@router.post("/api/papers/upload", tags=["Papers"])
def upload_paper(file: UploadFile = File(...), collection: str | None = None) -> dict[str, str]:
    lib = deps.get_library()

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict[str, Any]:
        progress(f"PDFアップロード中: {file.filename}")
        paper_id, is_new = lib.import_pdf(tmp_path, collection_name=collection or "", original_name=file.filename or "")
        progress(f"テキスト抽出中: {file.filename}")
        lib.document(paper_id)
        deps.library_changed()
        return {"paper_ids": [paper_id], "added": int(is_new)}

    return {"job_id": submit_import(action, cleanup=lambda: tmp_path.unlink(missing_ok=True))}


@router.get("/api/papers/{paper_id}")
def get_paper(paper_id: str) -> dict[str, Any]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    return _with_state(lib, lib.paper(paper_id))


@router.patch("/api/papers/{paper_id}")
def update_paper(paper_id: str, body: UpdatePaperRequest) -> dict[str, str]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    if body.title is not None and not body.title.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="タイトルを入力してください。")
    fields = {"title": body.title.strip() if body.title is not None else None, "first_author": body.author,
              "publication_year": str(body.year) if body.year is not None else None,
              "collection_name": body.collection, "note": body.note, "tags": body.tags, "read_status": body.read_status,
              "doi": body.doi, "arxiv_id": body.arxiv_id, "venue": body.venue}
    updates = {key: value for key, value in fields.items() if value is not None}
    try:
        if updates:
            lib.update(paper_id, **updates)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    deps.library_changed()
    return {"status": "updated"}


@router.post("/api/papers/{paper_id}/rename")
def rename_paper(paper_id: str, body: RenamePaperRequest) -> dict[str, str]:
    lib = deps.get_library()
    try:
        name = lib.rename_paper(paper_id, body.new_title)
        deps.library_changed()
        return {"status": "renamed", "name": name}
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.delete("/api/papers/{paper_id}")
def delete_paper(paper_id: str) -> dict[str, str]:
    if any(j.running and j.paper_id == paper_id for j in deps.job_manager.get_jobs()):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="処理中のジョブがあるため削除できません。")
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    lib.delete_paper(paper_id)
    deps.library_changed()
    return {"status": "deleted"}


@router.post("/api/papers/bibtex")
def papers_bibtex(body: BibtexRequest) -> dict[str, Any]:
    """BibTeX entries of the papers, to copy; made from the library's own data (nothing is looked up online)."""
    lib = deps.get_library()
    try:
        papers = lib.papers_by_id(body.paper_ids)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc.args[0]))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return {"text": bibtex(papers), "count": len(papers)}


# --- What the reader shows ---


@router.get("/api/papers/{paper_id}/reading")
def get_reading_info(paper_id: str) -> dict[str, Any]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    last_page = load_ui_state(deps.get_data_dir()).get("reading_pages", {}).get(paper_id, 0)
    return reading_state.reading_state(lib, paper_id, last_page)


@router.get("/api/papers/{paper_id}/translation-text/{page}")
def get_translation_text(paper_id: str, page: int) -> dict[str, list[str]]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    return {"blocks": reading_state.translation_text(lib, paper_id, page)}


@router.get("/api/papers/{paper_id}/reading-blocks/{page}")
def get_reading_blocks(paper_id: str, page: int) -> dict[str, Any]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    try:
        return reading_state.reading_blocks(lib, paper_id, page)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/api/papers/{paper_id}/search")
def search_paper(paper_id: str, q: str = "", side: str = "original") -> dict[str, Any]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    try:
        return search.search_paper(lib, paper_id, q, side)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/api/papers/{paper_id}/article")
def get_paper_article(paper_id: str) -> dict[str, Any]:
    lib = deps.get_library()
    files = PaperFiles(deps.paper_folder(lib, paper_id))
    if not files.article_md.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="サマリー記事がまだ生成されていません。")
    return {"content": files.article_md.read_text("utf-8"), "usage": files.read_json(files.article_usage)}


# --- Files, served to pdf.js and <img> ---


SAFE_FILE_NAME = re.compile(r"^(original|translated|interleaved|bilingual)\.pdf$")
SAFE_PAGE_NAME = re.compile(r"^translation-pages/([0-9a-f]{32})/page-(\d+)\.pdf$")


@router.get("/api/papers/{paper_id}/files/{file_path:path}")
def stream_paper_file(paper_id: str, file_path: str, request: Request) -> Response:
    """A paper's PDF, with HTTP Range support so pdf.js can fetch only the parts it needs."""
    lib = deps.get_library()
    folder = deps.paper_folder(lib, paper_id).resolve()

    normalized = file_path.replace("\\", "/")
    if not (SAFE_FILE_NAME.match(normalized) or SAFE_PAGE_NAME.match(normalized)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="許可されていないファイル形式です。")

    target = (folder / normalized).resolve()
    if not target.is_relative_to(folder) or not target.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="ファイルが見つかりません。")

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
    media = PaperFiles(deps.paper_folder(lib, paper_id).resolve()).media
    if not re.fullmatch(r"^[a-zA-Z0-9_\-\.]+\.png$", name):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不正な画像名です。")
    media_file = (media / name).resolve()
    if not media_file.is_relative_to(media) or not media_file.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="画像が見つかりません。")
    return FileResponse(media_file, media_type="image/png")


# --- Sticky notes (formerly bookmarks; both paths stay for older clients) ---


@router.get("/api/sticky-notes")
def get_sticky_notes() -> list[dict]:
    return deps.get_library().sticky_notes()


@router.get("/api/papers/{paper_id}/sticky-notes")
@router.get("/api/papers/{paper_id}/bookmarks")
def get_bookmarks(paper_id: str) -> list[dict]:
    return deps.get_library().bookmarks(paper_id)


@router.post("/api/papers/{paper_id}/sticky-notes")
@router.post("/api/papers/{paper_id}/bookmarks")
def add_bookmark(paper_id: str, body: BookmarkRequest) -> dict:
    try:
        return deps.get_library().add_bookmark(paper_id, body.page, body.side, body.quote, body.label, body.note,
                                               body.anchor_y, body.anchor_x)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/api/papers/{paper_id}/sticky-notes/{bookmark_id}")
@router.delete("/api/papers/{paper_id}/bookmarks/{bookmark_id}")
def delete_bookmark(paper_id: str, bookmark_id: int) -> dict[str, bool]:
    return {"deleted": deps.get_library().delete_bookmark(paper_id, bookmark_id)}


@router.patch("/api/papers/{paper_id}/sticky-notes/{bookmark_id}")
@router.patch("/api/papers/{paper_id}/bookmarks/{bookmark_id}")
def update_bookmark(paper_id: str, bookmark_id: int, body: BookmarkEditRequest) -> dict:
    try:
        return deps.get_library().update_bookmark(paper_id, bookmark_id, body.label, body.note,
                                                  anchor_x=body.anchor_x, anchor_y=body.anchor_y)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# --- Glossary seen from one paper (the dictionary itself is library-wide; see routes.reading) ---


@router.get("/api/papers/{paper_id}/glossary")
def get_glossary(paper_id: str) -> list[dict[str, str]]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    return global_glossary(lib.root)


@router.put("/api/papers/{paper_id}/glossary", deprecated=True)
def put_glossary(paper_id: str, body: GlossaryRequest) -> dict[str, int]:
    if any(job.running for job in deps.job_manager.get_jobs()):
        raise HTTPException(status_code=409, detail="実行中の処理が終わってから共通辞書を保存してください。")
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    try:
        terms = validate_terms(body.terms)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    save_global_glossary(lib.root, terms)
    return {"count": len(terms)}


# --- Folders (collections) ---


@router.get("/api/collections")
def list_collections() -> list[str]:
    return [c for c in deps.get_library().collections() if c]


@router.post("/api/collections")
def create_collection(body: CreateCollectionRequest) -> dict[str, str]:
    name = normalize_collection_name(body.name)
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="有効なフォルダー名を入力してください。")
    lib = deps.get_library()
    if name in lib.collections():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="同じ名前のフォルダーが既にあります。")
    lib.create_collection(name)
    deps.library_changed()
    return {"status": "created", "name": name}


@router.patch("/api/collections/rename")
def rename_collection(body: RenameCollectionRequest) -> dict[str, str]:
    lib = deps.get_library()
    # new_name is the new last segment; accept a full path too for older clients.
    leaf = normalize_collection_name(body.new_name).split(" / ")[-1]
    try:
        destination = lib.rename_collection(body.old_name, leaf)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    deps.library_changed()
    return {"status": "renamed", "name": destination}


@router.post("/api/collections/bibtex")
def export_collection_bibtex(body: BibtexExportRequest) -> dict[str, Any]:
    """Save the BibTeX entries of a folder's papers (with its subfolders') to a .bib file outside the library."""
    lib = deps.get_library()
    try:
        papers = lib.collection_papers(body.collection)
        count = export_bibtex(Path(body.destination), papers, lib.root)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return {"count": count, "destination": str(Path(body.destination).resolve())}


@router.delete("/api/collections/{name:path}")
def delete_collection(name: str) -> dict[str, Any]:
    lib = deps.get_library()
    token = uuid.uuid4().hex
    try:
        moved = lib.delete_collection(name, undo_token=token)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    deps.library_changed()
    return {"status": "deleted", "moved": moved, "undo_token": token}


@router.post("/api/collections/restore/{undo_token}")
def restore_collection(undo_token: str) -> dict[str, str]:
    try:
        name = deps.get_library().restore_collection(undo_token)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    deps.library_changed()
    return {"status": "restored", "name": name}
