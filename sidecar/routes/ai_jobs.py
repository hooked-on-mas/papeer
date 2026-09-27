"""Background work on one paper: translation, summary, questions, and exported PDFs."""
from __future__ import annotations

from pathlib import Path
import threading
from typing import Any

from fastapi import APIRouter, Depends

from papeer.core import exports
from papeer.core.errors import Invalid
from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService
from papeer.core.translation_plan import translation_plan as plan_translation
from papeer.layout.page_selection import parse_page_selection
from sidecar import deps
from sidecar.schemas import AskRequest, ExportRequest, TranslateRequest

router = APIRouter(dependencies=[Depends(deps.verify_token)])

ASK_SCOPES = {"paper", "selected", "collection", "all"}


@router.post("/api/papers/{paper_id}/translate")
def translate_paper(paper_id: str, body: TranslateRequest) -> dict[str, str]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    selected_pages = None
    if body.pages:
        selected_pages = parse_page_selection(body.pages, lib.document(paper_id)["page_count"])
    # The translation dialog may pick another model or effort for this run only.
    settings = deps.settings_for_run(body.model, body.effort)

    def action(cancel: threading.Event, progress: Any, page_ready: Any) -> dict:
        service = PaperService(lib, deps.provider_for(settings, cancel), cancel, progress=progress, page_ready=page_ready)
        result = service.translate(paper_id, pages=selected_pages)
        deps.library_changed()
        return result

    return deps.submit_job("translate", action, paper_id)


@router.get("/api/papers/{paper_id}/translation-plan")
def translation_plan(paper_id: str, pages: str = "", model: str | None = None) -> dict[str, Any]:
    """What POST .../translate with the same pages and model would send to the model; nothing runs."""
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    selected_pages = parse_page_selection(pages, lib.document(paper_id)["page_count"]) if pages else None
    return plan_translation(lib, paper_id, deps.settings_for_run(model, None), selected_pages)


@router.post("/api/papers/{paper_id}/article")
def generate_article(paper_id: str) -> dict[str, str]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    settings = deps.get_settings()

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict:
        service = PaperService(lib, deps.provider_for(settings, cancel), cancel, progress=progress)
        result = service.article(paper_id)
        deps.library_changed()
        return {"content": result, "usage": service.usage()}

    return deps.submit_job("article", action, paper_id)


@router.get("/api/papers/{paper_id}/messages")
def get_paper_messages(paper_id: str) -> list[dict[str, Any]]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    return lib.messages(paper_id, with_usage=True)


@router.post("/api/papers/{paper_id}/ask")
def ask_paper(paper_id: str, body: AskRequest) -> dict[str, str]:
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    settings = deps.get_settings()

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict:
        service = PaperService(lib, deps.provider_for(settings, cancel), cancel, progress=progress)
        if body.scope not in ASK_SCOPES:
            raise ValueError("チャットの参照範囲が不正です。")
        answer = service.ask(paper_id, body.question,
                             attachments=[item.model_dump() for item in body.attachments],
                             entire_library=body.scope == "all" or body.search_all,
                             paper_ids=set(body.paper_ids) if body.scope == "selected" else None,
                             collection=body.collection if body.scope == "collection" else None,
                             reference_pages=parse_page_selection(body.reference_pages, lib.paper(paper_id)["pages"])
                             if body.reference_pages.strip() else None,
                             retrieval_query=body.retrieval_query, max_pages=body.max_pages)
        return {"answer": answer, "usage": service.usage()}

    return deps.submit_job("ask", action, paper_id)


@router.post("/api/papers/{paper_id}/export")
def export_paper(paper_id: str, body: ExportRequest) -> dict[str, str]:
    lib = deps.get_library()
    files = PaperFiles(deps.paper_folder(lib, paper_id))
    dest = exports.check_export(files, body.kind, Path(body.destination), lib.root)
    dest.parent.mkdir(parents=True, exist_ok=True)

    if body.kind in exports.PAIRED_KINDS:
        def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict[str, str]:
            progress("原文・日本語訳の交互PDFを作成しています…" if body.kind == "interleaved" else "対訳PDFを作成しています…")
            exports.build_paired_pdf(files, body.kind, dest)
            return {"kind": body.kind, "destination": str(dest)}

        return {"status": "started", **deps.submit_job("export", action, paper_id), "destination": str(dest)}

    exports.copy_export(files, body.kind, dest)
    return {"status": "exported", "destination": str(dest)}


@router.post("/api/papers/{paper_id}/interleaved")
def prepare_interleaved(paper_id: str) -> dict[str, str]:
    """interleaved.pdf beside the paper for an external viewer, built only when missing or out of date."""
    lib = deps.get_library()
    files = PaperFiles(deps.paper_folder(lib, paper_id))
    if not files.translated_pdf.is_file():
        raise Invalid("先に日本語訳を作成してください。")

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict[str, str]:
        return {"kind": "interleaved", "path": str(exports.interleaved_cache(files, progress).resolve())}

    return deps.submit_job("interleaved", action, paper_id)
