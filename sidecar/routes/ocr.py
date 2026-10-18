"""OCR: this PC's settings and language data, and reading a paper's pages that need it (papeer.core.ocr)."""
from __future__ import annotations

from contextlib import contextmanager
import threading
from typing import Any, Iterator

from fastapi import APIRouter, Depends

from papeer.core import ocr
from papeer.core.ai_ocr import AiOcrEngine
from papeer.core.errors import Invalid
from papeer.core.search_index import SearchIndex
from papeer.layout.ocr_engines import TESSDATA, download_tessdata, tessdata_directory
from papeer.providers import Cancelled, check_cancel, spec_for
from sidecar import deps
from sidecar.job_types import JobKind, JobStarted
from sidecar.jobs import ConcurrencyConflict, TurnQueue
from sidecar.schemas.ocr import LanguageDataRequest, OcrReadRequest, OcrSettings, OcrStatus

router = APIRouter(dependencies=[Depends(deps.verify_token)])

# Papers are read by OCR one at a time, in the order asked (a page image and the engines take hundreds
# of megabytes): the jobs of other papers, and the papers being added with the "auto" setting, wait their turn.
ocr_turns = TurnQueue()


@contextmanager
def ocr_turn(cancel: threading.Event, progress: Any) -> Iterator[None]:
    """Wait for this job's turn to read by OCR (Cancelled when cancelled first), and hold it meanwhile."""
    ticket = ocr_turns.ticket()
    try:
        if not ocr_turns.wait(ticket, cancel, lambda: progress("ほかの論文の OCR が終わるのを待っています…")):
            raise Cancelled("OCR を中止しました。")
        yield
    finally:
        ocr_turns.release(ticket)


def ai_reading() -> dict[str, Any]:
    """Whether the AI connection now chosen can read a page image (ProviderBackend.image_support)."""
    settings = deps.get_settings()
    spec = spec_for(settings.provider)
    reason = deps.provider_for(settings).image_support()
    return {"available": reason is None, "reason": reason, "provider": spec.id, "label": spec.label}


@router.get("/api/ocr", response_model=OcrStatus)
def ocr_status() -> dict[str, Any]:
    return {**ocr.status(), "ai": ai_reading()}


@router.put("/api/ocr/settings", response_model=OcrSettings)
def save_ocr_settings(body: OcrSettings) -> dict[str, str]:
    """This PC's settings (not synced); they apply to the next paper added or read."""
    return ocr.save_ocr_settings(body.mode, body.engine, body.lang)


@router.post("/api/ocr/language-data")
def download_language_data(body: LanguageDataRequest) -> JobStarted:
    """Download Tesseract's language data (the user has agreed on the screen, which named the source and size)."""
    langs = list(dict.fromkeys(body.langs))
    directory = tessdata_directory(ocr.ocr_options())
    labels = {entry["lang"]: entry["label"] for entry in ocr.language_data()}

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict[str, Any]:
        for index, lang in enumerate(langs):
            shown = [-1]

            def report(received: int, size: int, lang: str = lang, index: int = index, shown: list[int] = shown) -> None:
                check_cancel(cancel)
                percent = received * 100 // max(size, 1)
                if percent != shown[0]:
                    shown[0] = percent
                    which = f"（{index + 1}/{len(langs)} 件目）" if len(langs) > 1 else ""
                    progress(f"{labels[lang]}の言語データをダウンロードしています {received // 1024}/{size // 1024} KB{which}")

            check_cancel(cancel)
            try:
                download_tessdata(lang, lambda _url, _size: True, directory, progress=report)
            except Cancelled:
                raise Cancelled("言語データのダウンロードを中止しました。") from None
        return {"installed": [lang for lang in TESSDATA if lang in langs]}

    return deps.submit_job(JobKind.OCR_DATA, action)


@router.post("/api/papers/{paper_id}/ocr")
def read_paper(paper_id: str, body: OcrReadRequest) -> JobStarted:
    """Read a paper's pages by OCR and write its extraction again (papeer.core.ocr.read_again).

    engine "ai" reads one page with the AI connection: its images go to that service and use its plan.
    """
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    page_count = lib.paper(paper_id)["pages"]
    pages = set(body.pages) if body.pages is not None else None
    if pages is not None and (not pages or not all(1 <= page <= page_count for page in pages)):
        raise Invalid("読むページを正しく指定してください。")
    settings = deps.get_settings()
    if body.engine == "ai":
        if pages is None or len(pages) != 1:
            raise Invalid("AI で読み直すページを 1 ページ指定してください。")
        reason = deps.provider_for(settings).image_support()
        if reason:
            raise Invalid(reason)
    ticket = ocr_turns.ticket()

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict[str, Any]:
        try:
            if not ocr_turns.wait(ticket, cancel, lambda: progress("ほかの論文の OCR が終わるのを待っています…")):
                raise Cancelled("OCR を中止しました。")
            return run(cancel, progress)
        finally:
            ocr_turns.release(ticket)

    def run(cancel: threading.Event, progress: Any) -> dict[str, Any]:
        provider = None
        engines = {}
        if body.engine == "ai":
            provider = deps.provider_for(settings, cancel)
            engines = {"ai": AiOcrEngine(provider)}
        options = ocr.ocr_options(engine="ai" if provider is not None else None)
        how = "AI で読んでいます（画像を送信中）" if provider is not None else "OCR で読んでいます"

        def report(page: int, done: int, total: int) -> None:
            progress(f"p.{page} を{how} {done}/{total}")

        progress("ページを調べています…")
        # With the AI, a failure of the connection ends the job as it is (errorReports tells its cause).
        result = ocr.read_again(lib, paper_id, ocr.ocr_run(options, cancel, pages, report, engines, strict=provider is not None))
        SearchIndex(lib.root).forget_pages(paper_id)
        deps.paper_changed(paper_id)
        if provider is not None:
            (page,) = pages or {0}
            if str(page) in result["failed_pages"]:
                raise ValueError(f"p.{page} を AI で読めませんでした。{result['failed_pages'][str(page)]}")
            result["usage"] = provider.usage_report()
        return result

    try:
        return deps.submit_job(JobKind.OCR, action, paper_id)
    except ConcurrencyConflict:
        ocr_turns.release(ticket)
        raise
