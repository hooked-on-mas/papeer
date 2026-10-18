"""Research and import a cited paper without switching the reader to it."""
from contextlib import nullcontext
from pathlib import Path
import tempfile
import threading

from fastapi import APIRouter, Depends

from papeer.core import ocr, web_research
from papeer.core.collection_paths import normalize_collection_name
from papeer.core.paths import PaperFiles
from papeer.core.reference_pdf import download_pdf, validate_pdf, validate_reference_identity
from papeer.core.service import PaperService
from papeer.core.summary_scope import SUMMARY_SELECTION_THRESHOLD
from papeer.providers import Cancelled, check_cancel, spec_for
from sidecar import deps
from sidecar.job_types import JobKind, JobStarted
from sidecar.routes.ocr import ocr_turn
from sidecar.routes.papers import import_turns
from sidecar.schemas.research import ResearchRecord, ResearchRequest, ResearchImportRequest

router = APIRouter(dependencies=[Depends(deps.verify_token)])


@router.get("/api/research-capabilities")
def capabilities() -> dict[str, bool]:
    settings = deps.get_settings()
    return {"web_search": spec_for(settings.provider).web_search,
            "paper_discovery_enabled": settings.paper_discovery_enabled,
            "reference_research_enabled": settings.paper_metadata_ai_enabled,
            "reference_lookup": True,
            "reference_web_search": spec_for(settings.for_paper_metadata().provider).web_search}


@router.get("/api/papers/{paper_id}/reference-research", response_model=list[ResearchRecord])
def get_research(paper_id: str) -> list[dict]:
    return web_research.records(deps.get_library(), paper_id)


@router.post("/api/papers/{paper_id}/reference-research")
def start_research(paper_id: str, body: ResearchRequest) -> JobStarted:
    lib = deps.get_library()
    if bool(body.reference_id) == bool(body.research_key):
        raise ValueError("調べる参考文献を一つ指定してください。")
    if body.reference_id:
        web_research.reference_entry(lib, paper_id, body.reference_id)
    else:
        web_research.get_record(lib, paper_id, body.research_key)
    settings = deps.get_settings().for_paper_metadata()
    if not settings.paper_metadata_ai_enabled:
        raise ValueError("設定の「論文情報の取得にAIを使う」をONにすると、参考文献の情報を取得できます。")

    def action(cancel, progress, _page_ready):
        if not deps.get_settings().paper_metadata_ai_enabled:
            raise Cancelled("論文情報のAI取得がOFFになったため、収集を中止しました。")
        check_cancel(cancel)
        progress("Semantic Scholarを優先して参考文献を取得し、Crossref・AIで不足情報を補完しています…")
        provider = deps.provider_for(settings, cancel)
        try:
            record = (web_research.research_reference(lib, paper_id, body.reference_id, provider) if body.reference_id
                      else web_research.research_saved(lib, paper_id, body.research_key, provider))
        finally:
            # Failures can save diagnostic evidence while preserving the previous good record.
            deps.paper_changed(paper_id)
        return record

    return deps.submit_job(JobKind.REFERENCE_RESEARCH, action, paper_id)


def _record_for_import(lib, paper_id: str, key: str) -> dict:
    from papeer.core.citations import citation_graph

    existing = next((r for r in web_research.records(lib, paper_id) if r["key"] == key), None)
    # A user may already have a PDF, and should not have to search the web first.
    if existing:
        record = existing
    else:
        entry = next((r for r in citation_graph(lib)["references"] if r["source"] == paper_id and r["research_key"] == key), None)
        if entry is None:
            raise ValueError("参考文献が見つかりません。")
        record = web_research.normalized_record({**entry, "basis": "metadata"}, entry["raw"], key)
    if record.get("paper_id"):
        return record
    matched = next((r for r in citation_graph(lib)["references"] if r["source"] == paper_id and r["research_key"] == key), None)
    if matched and len(matched["target"]) == 32 and matched["target"] != paper_id:
        record["paper_id"] = matched["target"]
    elif existing:
        # Papers found in chat have no bibliography row. Reuse an exact identifier match only.
        targets = []
        for paper in lib.papers():
            if paper["id"] == paper_id:
                continue
            matches = [paper.get(field, "").casefold() == record[field].casefold()
                       for field in ("doi", "arxiv_id") if record[field] and paper.get(field)]
            if matches and all(matches):
                targets.append(paper)
        if len(targets) == 1:
            record["paper_id"] = targets[0]["id"]
    if record.get("paper_id") and not record["version"]:
        record["version"] = "登録済みPDF（版は原文で確認）"
    return record


@router.post("/api/papers/{paper_id}/reference-import/{key}")
def start_import(paper_id: str, key: str, body: ResearchImportRequest) -> JobStarted:
    lib = deps.get_library()
    initial_record = _record_for_import(lib, paper_id, key)
    collection = normalize_collection_name(body.collection)
    local = Path(body.local_path) if body.local_path else None
    if local:
        validate_pdf(local)
    elif not initial_record.get("paper_id"):
        if body.pdf_index is None or body.pdf_index >= len(initial_record["pdfs"]):
            raise ValueError("取り込むPDFを選択してください。")
    settings = deps.get_settings()
    ticket = import_turns.ticket()

    def action(cancel: threading.Event, progress, _page_ready):
        record = dict(initial_record)
        added = False
        try:
            if not import_turns.wait(ticket, cancel, lambda: progress("前のPDFの追加が終わるのを待っています…")):
                check_cancel(cancel)
            target = record.get("paper_id")
            if not target:
                with tempfile.TemporaryDirectory(prefix="papeer-reference-") as directory:
                    path = local or Path(directory) / "reference.pdf"
                    if not local:
                        candidate = record["pdfs"][body.pdf_index]
                        progress("PDFを取得しています…")
                        download_pdf(candidate["url"], path, cancel, progress)
                        validate_reference_identity(path, record["title"], record["doi"])
                        record["version"] = candidate["version"]
                    else:
                        record["version"] = "手元のPDF（版は原文で確認）"
                    check_cancel(cancel)
                    progress("PDFの本文を読み取っています…")
                    reads = ocr.import_reads()
                    run = ocr.ocr_run(ocr.ocr_options(), cancel,
                                      progress=lambda page, _done, _total: progress(f"本文をOCRで読み取り中… p.{page}")) if reads else None
                    with ocr_turn(cancel, progress) if reads else nullcontext():
                        target, added = lib.import_pdf(path, collection_name=collection, ocr=run)
                    record["paper_id"] = target
                    record["summary_error"] = ""
                    # Link first: a cancel or a failed summary must never lose the imported paper.
                    web_research.save_record(lib, paper_id, record)
                    deps.library_changed()
            else:
                web_research.save_record(lib, paper_id, record)
        finally:
            import_turns.release(ticket)
        check_cancel(cancel)
        record = web_research.get_record(lib, paper_id, key)
        files = PaperFiles(lib.paper_folder(target))
        if body.create_summary and not files.article_md.is_file():
            if record["needs_ocr"]:
                record["summary_error"] = "文字の読み取りが必要です。PDFを開き、OCR後にサマリーを作成してください。"
            elif lib.document(target)["page_count"] >= SUMMARY_SELECTION_THRESHOLD:
                record["summary_error"] = "PDFは取り込み済みです。30ページ以上の資料は、サマリー画面で章・ページ範囲を選んで作成してください。"
            else:
                try:
                    # The target may already be registered and busy with another operation.
                    guard = deps.job_manager.idle("この参考文献を処理中です。完了後にサマリーを作成してください。", target) if target != paper_id else nullcontext()
                    with guard:
                        if not files.article_md.is_file():
                            progress("PDF取り込み済み。サマリーを作成しています…")
                            service = PaperService(lib, deps.provider_for(settings, cancel), cancel, progress=progress)
                            service.article(target)
                    record["summary_error"] = ""
                except Cancelled:
                    raise Cancelled("サマリー作成を中止しました。取り込んだPDFは保存されています。") from None
                except Exception as exc:  # noqa: BLE001 - PDF succeeded; expose the separate summary failure for retry.
                    record["summary_error"] = f"PDFは取り込み済みです。サマリーを作成できませんでした：{exc}"
            web_research.save_record(lib, paper_id, record)
        deps.paper_changed(target)
        deps.paper_changed(paper_id)
        return {"record": web_research.get_record(lib, paper_id, key), "added": added}

    try:
        return deps.submit_job(JobKind.REFERENCE_IMPORT, action, paper_id)
    except Exception:  # noqa: BLE001 - a ticket taken before submission must also be released on refusal.
        import_turns.release(ticket)
        raise
