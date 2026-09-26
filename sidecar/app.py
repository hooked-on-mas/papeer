from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
from typing import Any, AsyncGenerator

from fastapi import Depends, FastAPI, HTTPException, Header, Query, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse

from paperdesk.core.code_version import application_version
from paperdesk.core.config import Settings, data_directory
from paperdesk.core.providers import (
    Cancelled,
    Provider,
    claude_command,
    codex_command,
    current_limits,
    gemini_command,
    query_available_efforts,
    query_available_models,
)
from paperdesk.core.service import PaperService, page_translation_text
from paperdesk.core.storage import Library, normalize_collection_name
from paperdesk.layout.page_selection import parse_page_selection
from paperdesk.pdf.pdf_viewer import pdf_page_count
from paperdesk.translation.translation_preview import read_preview, translated_page, translated_page_numbers

from sidecar.jobs import ConcurrencyConflict, JobManager, TurnQueue
from sidecar.schemas import (
    AskRequest,
    BookmarkRequest,
    BookmarkEditRequest,
    GlossaryRequest,
    CreateCollectionRequest,
    ExportRequest,
    HealthResponse,
    ImportRequest,
    RenameCollectionRequest,
    RenamePaperRequest,
    SettingsModel,
    TranslateRequest,
    UIStateModel,
    UpdatePaperRequest,
    ProviderActionRequest,
)
from sidecar.ui_state import load_ui_state, save_ui_state


def get_data_dir() -> Path:
    env_dir = os.environ.get("PAPERDESK_DATA_DIR")
    if env_dir:
        return Path(env_dir).resolve()
    return data_directory()


def get_auth_token() -> str | None:
    return os.environ.get("PAPERDESK_TOKEN")


job_manager = JobManager()
_runtime_api_key: str | None = os.environ.get("PAPERDESK_API_KEY") or os.environ.get("OPENAI_API_KEY")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    loop = asyncio.get_running_loop()
    job_manager.set_loop(loop)
    yield


app = FastAPI(
    title="PaperDesk Sidecar",
    version=application_version(),
    lifespan=lifespan,
)

# CORS setup

@app.middleware("http")
async def protect_library_snapshot(request: Request, call_next):
    if (request.method != "OPTIONS" and request.url.path not in {"/health", "/api/jobs"}
            and any(job.running and job.kind in {"backup", "restore"} for job in job_manager.get_jobs())):
        return JSONResponse(status_code=409, content={"detail": "バックアップ・復元が終わるまでお待ちください。"})
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
        "http://localhost:5173",
        "http://127.0.0.1:1420",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def verify_token(authorization: str | None = Header(None), token: str | None = Query(None)) -> None:
    expected = get_auth_token()
    if not expected:
        return
    # <img> tags cannot send headers, so media URLs carry the token as a query parameter.
    if authorization and authorization.startswith("Bearer "):
        provided = authorization[len("Bearer "):].strip()
    elif token:
        provided = token
    else:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="認証トークンが必要です。")
    if provided != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="認証トークンが不正です。")


def get_library() -> Library:
    if any(job.running and job.kind in {"backup", "restore"} for job in job_manager.get_jobs()):
        raise HTTPException(status_code=409, detail="バックアップ・復元が終わるまでお待ちください。")
    return Library(get_data_dir())


def get_settings() -> Settings:
    return Settings.load(get_data_dir())


def paper_folder(lib: Library, paper_id: str) -> Path:
    try:
        lib.paper(paper_id)
        return lib.folder(paper_id)
    except (KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")


def translation_state(folder: Path, page_count: int) -> dict[str, Any]:
    """Summarize how much of a paper has a Japanese translation, as the library shows it."""
    try:
        completed = translated_page_numbers(folder, page_count)
        preview = read_preview(folder)
    except (OSError, ValueError, json.JSONDecodeError):
        completed, preview = [], None
    in_progress = bool(preview and not preview["complete"])
    from paperdesk.core.translation_review import cached_required_translation_pages
    required = set(cached_required_translation_pages(folder, page_count))
    try:
        report = json.loads((folder / "translation-report.json").read_text("utf-8"))
        has_issues = bool(report.get("skipped_blocks") or report.get("skipped_pages"))
    except (OSError, ValueError):
        has_issues = None
    return {
        "translated_count": len(completed),
        "translation_required_count": len(required),
        "translation_completed_required_count": len(required.intersection(completed)),
        "translation_has_issues": has_issues,
        "has_translated": (folder / "translated.pdf").is_file(),
        "translation_in_progress": in_progress,
    }


def cli_path_for(settings: Settings, provider: str) -> str:
    return {"codex": settings.codex_path, "claude": settings.claude_path,
            "gemini": settings.gemini_path}.get(provider, "")


def settings_with_override(body: ProviderActionRequest | None) -> Settings:
    """Apply unsaved dialog values, so login/check test what the user is editing."""
    s = replace(get_settings())
    if body is None:
        return s
    if body.provider:
        s.provider = body.provider
    for field, value in (("model", body.model), ("base_url", body.api_base), ("codex_path", body.codex_path),
                         ("claude_path", body.claude_path), ("gemini_path", body.gemini_path)):
        if value is not None:
            setattr(s, field, value)
    if body.reasoning_effort is not None:
        s.reasoning_effort = body.reasoning_effort
    return s


def cli_login_status(s: Settings, timeout: int) -> subprocess.CompletedProcess | None:
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    if s.provider == "codex":
        command = codex_command(s.codex_path) + ["login", "status"]
    elif s.provider == "claude":
        command = claude_command(s.claude_path) + ["auth", "status"]
    elif s.provider == "gemini":
        command = gemini_command(s.gemini_path) + ["models"]
    else:
        return None
    return subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, creationflags=creationflags)


# --- Health & System ---


@app.get("/health", response_model=HealthResponse)
def health() -> dict[str, str]:
    version = application_version()
    return {"status": "ok", "version": version, "code_version": version}


@app.post("/shutdown")
def shutdown(dependencies: None = Depends(verify_token)) -> dict[str, str]:
    def stop():
        asyncio.run(asyncio.sleep(0.5))
        os._exit(0)

    threading.Thread(target=stop, daemon=True).start()
    return {"status": "shutting down"}


# --- UI State ---


@app.get("/api/ui-state", response_model=UIStateModel)
def get_ui_state(dependencies: None = Depends(verify_token)) -> dict[str, Any]:
    return load_ui_state(get_data_dir())


@app.put("/api/ui-state")
def put_ui_state(body: UIStateModel, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    save_ui_state(get_data_dir(), body.model_dump())
    return {"status": "saved"}


# --- Settings & Providers ---


@app.get("/api/settings", response_model=SettingsModel)
def get_settings_endpoint(dependencies: None = Depends(verify_token)) -> SettingsModel:
    s = get_settings()
    return SettingsModel(
        provider=s.provider,
        model=s.model,
        reasoning_effort=s.reasoning_effort,
        api_base=s.base_url,
        codex_path=s.codex_path,
        claude_path=s.claude_path,
        gemini_path=s.gemini_path,
        translation_concurrency=s.translation_concurrency,
        api_key=_runtime_api_key,
    )


@app.put("/api/settings")
def update_settings(body: SettingsModel, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    global _runtime_api_key
    s = get_settings()

    # Validate by creating a temporary instance
    from paperdesk.core.config import Settings
    try:
        Settings(
            provider=body.provider,
            model=body.model,
            reasoning_effort=body.reasoning_effort,
            base_url=body.api_base,
            codex_path=body.codex_path,
            claude_path=body.claude_path,
            gemini_path=body.gemini_path,
            translation_concurrency=body.translation_concurrency,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    s.provider = body.provider
    s.model = body.model
    s.reasoning_effort = body.reasoning_effort
    s.base_url = body.api_base
    s.codex_path = body.codex_path
    s.claude_path = body.claude_path
    s.gemini_path = body.gemini_path
    s.translation_concurrency = body.translation_concurrency
    s.save(get_data_dir())
    if body.api_key is not None:
        _runtime_api_key = body.api_key
    return {"status": "saved"}

@app.get("/api/prompts")
def get_prompts(dependencies: None = Depends(verify_token)) -> dict[str, str]:
    from paperdesk.core.prompts import _BUILTIN_DIR, _get_custom_dir
    prompts = {}
    for p in _BUILTIN_DIR.glob("*.txt"):
        name = p.stem
        custom_path = _get_custom_dir() / f"{name}.txt"
        if custom_path.exists():
            prompts[name] = custom_path.read_text("utf-8").strip()
        else:
            prompts[name] = p.read_text("utf-8").strip()
    return prompts

@app.get("/api/prompts/defaults")
def get_default_prompts(dependencies: None = Depends(verify_token)) -> dict[str, str]:
    """Built-in texts, so the settings dialog can show and restore them."""
    from paperdesk.core.prompts import _BUILTIN_DIR
    return {p.stem: p.read_text("utf-8").strip() for p in _BUILTIN_DIR.glob("*.txt")}

@app.put("/api/prompts")
def update_prompts(body: dict[str, str], dependencies: None = Depends(verify_token)) -> dict[str, str]:
    from paperdesk.core.prompts import _get_custom_dir
    d = _get_custom_dir()
    d.mkdir(parents=True, exist_ok=True)
    for name, content in body.items():
        if content.strip():
            (d / f"{name}.txt").write_text(content.strip(), "utf-8")
        else:
            p = d / f"{name}.txt"
            if p.exists():
                p.unlink()
    return {"status": "updated"}

@app.get("/api/providers/{provider}/models")
def get_provider_models(provider: str, cli_path: str | None = None, dependencies: None = Depends(verify_token)) -> list[dict[str, str]]:
    s = get_settings()
    path = cli_path if cli_path is not None else cli_path_for(s, provider)
    models = query_available_models(provider, cli_path=path)
    return [{"id": m[0], "name": m[1]} for m in models]


@app.get("/api/providers/{provider}/efforts")
def get_provider_efforts(provider: str, model: str | None = None, cli_path: str | None = None,
                         dependencies: None = Depends(verify_token)) -> list[dict[str, str]]:
    s = get_settings()
    path = cli_path if cli_path is not None else cli_path_for(s, provider)
    efforts = query_available_efforts(provider, path, model or "")
    return [{"id": e[0], "name": e[1]} for e in efforts]


@app.post("/api/providers/login")
def provider_login(body: ProviderActionRequest | None = None, dependencies: None = Depends(verify_token)) -> dict[str, Any]:
    s = settings_with_override(body)
    if s.provider not in ("codex", "claude", "gemini"):
        return {"message": "API接続ではログイン操作は不要です。", "already": False}
    # Launching a second login console is confusing when the CLI is already signed in.
    try:
        result = cli_login_status(s, timeout=5)
        if result is not None and result.returncode == 0:
            return {"message": "すでにログインされています。", "already": True}
    except (OSError, subprocess.SubprocessError):
        pass
    creationflags = subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0
    try:
        if s.provider == "codex":
            subprocess.Popen(codex_command(s.codex_path) + ["login"], creationflags=creationflags)
            service = "ChatGPT"
        elif s.provider == "claude":
            subprocess.Popen(claude_command(s.claude_path) + ["auth", "login"], creationflags=creationflags)
            service = "Claude"
        else:
            subprocess.Popen(gemini_command(s.gemini_path), creationflags=creationflags)
            service = "Antigravity"
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"CLIの準備エラー: {error}")
    return {"message": f"開いたブラウザーで{service}にログイン後、「接続を確認」を押してください。", "already": False}


@app.post("/api/providers/check")
def provider_check(body: ProviderActionRequest | None = None, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    s = settings_with_override(body)
    api_key = (body.api_key if body and body.api_key else None) or _runtime_api_key

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> str:
        progress("接続を確認しています…")
        if s.provider in ("codex", "claude", "gemini"):
            res = cli_login_status(s, timeout=30)
            assert res is not None
            if s.provider == "codex":
                if res.returncode:
                    raise RuntimeError("未ログインです。「ログイン (CLI)」を実行してください。")
                return "Codexのログイン状態を確認しました。AI処理の実行可否は利用枠・モデル設定にも依存します。"
            if s.provider == "claude":
                if res.returncode:
                    raise RuntimeError("未ログインです。「ログイン (CLI)」を実行してください。\n" + res.stdout.strip())
                return "Claude Codeのログイン状態を確認しました。"
            if res.returncode:
                detail = res.stderr.strip() or res.stdout.strip()
                raise RuntimeError("Gemini (agy) の接続確認に失敗しました。\n" + detail)
            return f"Gemini (agy) の疎通を確認しました（応答: {res.stdout.strip()[:60]}）。"

        provider = Provider(replace(s, api_key=api_key or s.api_key), cancel)
        ans = provider.generate("Reply with OK only.", "Connection test, no document data.")
        return "APIから応答を受信しました: " + ans[:120]

    try:
        job = job_manager.submit_job("check", action, paper_id=None)
        return {"job_id": job.job_id}
    except ConcurrencyConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@app.get("/api/usage/limits")
def usage_limits(dependencies: None = Depends(verify_token)) -> dict[str, Any] | None:
    """Plan usage of the connected AI. Claude Code reports it with each answer; Codex is asked here."""
    try:
        return current_limits(get_settings())
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))


# --- Papers & Library ---


@app.get("/api/papers")
def list_papers(query: str = "", sort: int = 0, dependencies: None = Depends(verify_token)) -> list[dict[str, Any]]:
    lib = get_library()
    papers = lib.papers(query=query)
    for p in papers:
        try:
            folder = lib.folder(p["id"])
        except ValueError:
            continue
        p["folder_path"] = str(folder.resolve())
        p["has_article"] = (folder / "article.md").is_file()
        p.update(translation_state(folder, p["pages"]))

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
        return job_manager.submit_job("import", queued, paper_id=None).job_id
    except ConcurrencyConflict as exc:
        import_turns.release(ticket)
        if cleanup:
            cleanup()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@app.post("/api/papers/import")
def import_papers(body: ImportRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    paths = [Path(p) for p in body.paths]
    for p in paths:
        if not p.is_file():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"ファイルが存在しません: {p}")

    def announce_pages() -> None:
        # Page counts are cheap, so the library can show them on its placeholder rows
        # long before text extraction (or an earlier import) finishes. Keyed by the path as sent.
        job_manager.broadcast({"type": "import.pages", "pages": {
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
            job_manager.broadcast({"type": "import.item", "path": source, "paper_id": paper_id})
        return {"paper_ids": imported_ids, "added": added}

    return {"job_id": submit_import(action, announce_pages)}

from fastapi import UploadFile, File
import tempfile

@app.post("/api/papers/upload", tags=["Papers"])
def upload_paper(
    file: UploadFile = File(...),
    collection: str | None = None,
    dependencies: None = Depends(verify_token)
) -> dict[str, str]:
    lib = get_library()

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict[str, Any]:
        progress(f"PDFアップロード中: {file.filename}")
        paper_id, is_new = lib.import_pdf(tmp_path, collection_name=collection or "", original_name=file.filename or "")
        progress(f"テキスト抽出中: {file.filename}")
        lib.document(paper_id)
        job_manager.broadcast({"type": "library.changed"})
        return {"paper_ids": [paper_id], "added": int(is_new)}

    return {"job_id": submit_import(action, cleanup=lambda: tmp_path.unlink(missing_ok=True))}


@app.get("/api/papers/{paper_id}")
def get_paper(paper_id: str, dependencies: None = Depends(verify_token)) -> dict[str, Any]:
    lib = get_library()
    folder = paper_folder(lib, paper_id)
    paper = lib.paper(paper_id)
    paper["folder_path"] = str(folder.resolve())
    paper["has_article"] = (folder / "article.md").is_file()
    paper.update(translation_state(folder, paper["pages"]))
    return paper


@app.patch("/api/papers/{paper_id}")
def update_paper(paper_id: str, body: UpdatePaperRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    paper_folder(lib, paper_id)
    updates: dict[str, Any] = {}
    if body.title is not None:
        if not body.title.strip():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="タイトルを入力してください。")
        updates["title"] = body.title.strip()
    if body.author is not None:
        updates["first_author"] = body.author
    if body.year is not None:
        updates["publication_year"] = str(body.year)
    if body.collection is not None:
        updates["collection_name"] = body.collection
    if body.note is not None:
        updates["note"] = body.note
    if body.tags is not None:
        updates["tags"] = body.tags
    if body.read_status is not None:
        updates["read_status"] = body.read_status
    try:
        if updates:
            lib.update(paper_id, **updates)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    job_manager.broadcast({"type": "library.changed"})
    return {"status": "updated"}


@app.post("/api/papers/{paper_id}/rename")
def rename_paper(paper_id: str, body: RenamePaperRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    try:
        name = lib.rename_paper(paper_id, body.new_title)
        job_manager.broadcast({"type": "library.changed"})
        return {"status": "renamed", "name": name}
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@app.delete("/api/papers/{paper_id}")
def delete_paper(paper_id: str, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    if any(j.running and j.paper_id == paper_id for j in job_manager.get_jobs()):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="処理中のジョブがあるため削除できません。")
    lib = get_library()
    folder = paper_folder(lib, paper_id)
    with lib.connection() as db:
        db.execute("DELETE FROM messages WHERE paper_id=?", (paper_id,))
        db.execute("DELETE FROM pages WHERE paper_id=?", (paper_id,))
        db.execute("DELETE FROM papers WHERE id=?", (paper_id,))
    if folder.exists():
        shutil.rmtree(folder, ignore_errors=True)
    job_manager.broadcast({"type": "library.changed"})
    return {"status": "deleted"}


@app.get("/api/papers/{paper_id}/reading")
def get_reading_info(paper_id: str, dependencies: None = Depends(verify_token)) -> dict[str, Any]:
    lib = get_library()
    folder = paper_folder(lib, paper_id)
    info = lib.reading_info(paper_id)
    page_count = info["page_count"]
    preview = read_preview(folder)
    completed = translated_page_numbers(folder, page_count)

    report_path = folder / "translation-report.json"
    report = json.loads(report_path.read_text("utf-8")) if report_path.exists() else None
    in_progress = bool(preview and not preview["complete"])
    if report and not in_progress:
        # Papers translated before page alignment may have more translated pages.
        page_count = max(page_count, int(report.get("pages") or 0))

    # Where the right pane finds each page: a per-page preview while translating,
    # the original for pages outside the request, or nothing while it waits.
    translated_pages: dict[str, dict[str, Any] | None] = {}
    for index in range(page_count):
        path, page_index = translated_page(folder, index)
        if path is None or not path.is_file():
            translated_pages[str(index + 1)] = None
        else:
            translated_pages[str(index + 1)] = {
                "file": path.resolve().relative_to(folder.resolve()).as_posix(),
                "index": page_index,
                "mtime": int(path.stat().st_mtime),
            }

    # The code revision and model that produced each page, as the old reader showed.
    page_versions: dict[str, dict[str, str]] = {}
    cache_path = folder / "translation-cache.json"
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text("utf-8"))
            for number, entry in (cache.get("completed_pages") or {}).items():
                version = entry.get("version", "")
                sha = version.split("code-sha256-")[1][:7] if "code-sha256-" in version else "不明"
                page_versions[number] = {"sha": sha, "model": entry.get("model") or "不明"}
        except (OSError, ValueError, AttributeError):
            pass

    ui_state = load_ui_state(get_data_dir())
    last_page = ui_state.get("reading_pages", {}).get(paper_id, 0)

    return {
        "page_count": page_count,
        "source_page_count": info["page_count"],
        "empty_pages": info["empty_pages"],
        "translation_required_pages": info["translation_required_pages"],
        "completed_pages": completed,
        "preview": preview,
        "in_progress": in_progress,
        "report": report,
        "translated_pages": translated_pages,
        "page_versions": page_versions,
        "last_page": last_page,
        "has_translated": (folder / "translated.pdf").is_file(),
        "has_article": (folder / "article.md").is_file(),
        "has_interleaved": (folder / "interleaved.pdf").is_file(),
        "original_mtime": int((folder / "original.pdf").stat().st_mtime) if (folder / "original.pdf").is_file() else 0,
    }


# --- File Streaming with Range Support ---


SAFE_FILE_NAME = re.compile(r"^(original|translated|interleaved|bilingual)\.pdf$")
SAFE_PAGE_NAME = re.compile(r"^translation-pages/([0-9a-f]{32})/page-(\d+)\.pdf$")


@app.get("/api/papers/{paper_id}/files/{file_path:path}")
def stream_paper_file(
    paper_id: str,
    file_path: str,
    request: Request,
    dependencies: None = Depends(verify_token),
) -> Response:
    lib = get_library()
    folder = paper_folder(lib, paper_id).resolve()

    # Validate file path
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
        return FileResponse(
            target,
            media_type="application/pdf",
            headers={"Accept-Ranges": "bytes", "ETag": etag},
        )

    # Partial Content (Range)
    range_val = range_header[len("bytes="):].strip()
    parts = range_val.split("-")
    try:
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if len(parts) > 1 and parts[1] else file_size - 1
    except ValueError:
        return Response(status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE)

    if start >= file_size or end >= file_size or start > end:
        return Response(
            status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    content_length = end - start + 1

    def iterfile():
        with open(target, "rb") as f:
            f.seek(start)
            remaining = content_length
            chunk_size = 64 * 1024
            while remaining > 0:
                chunk = f.read(min(chunk_size, remaining))
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


# --- Media & Article ---


@app.get("/api/papers/{paper_id}/media/{name}")
def get_paper_media(paper_id: str, name: str, dependencies: None = Depends(verify_token)) -> FileResponse:
    lib = get_library()
    folder = paper_folder(lib, paper_id).resolve()

    if not re.fullmatch(r"^[a-zA-Z0-9_\-\.]+\.png$", name):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不正な画像名です。")

    media_file = (folder / "media" / name).resolve()
    if not media_file.is_relative_to(folder / "media") or not media_file.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="画像が見つかりません。")

    return FileResponse(media_file, media_type="image/png")


@app.get("/api/papers/{paper_id}/article")
def get_paper_article(paper_id: str, dependencies: None = Depends(verify_token)) -> dict[str, Any]:
    lib = get_library()
    folder = paper_folder(lib, paper_id)

    article_path = folder / "article.md"
    if not article_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="サマリー記事がまだ生成されていません。")

    usage_path = folder / "article-usage.json"
    usage = json.loads(usage_path.read_text("utf-8")) if usage_path.is_file() else None
    return {"content": article_path.read_text("utf-8"), "usage": usage}


@app.get("/api/papers/{paper_id}/translation-text/{page}")
def get_translation_text(paper_id: str, page: int, dependencies: None = Depends(verify_token)) -> dict[str, list[str]]:
    lib = get_library()
    folder = paper_folder(lib, paper_id)
    if not (folder / "translation-cache.json").is_file() and not (folder / "translation.md").is_file():
        return {"blocks": []}
    return {"blocks": page_translation_text(folder, lib.document(paper_id), page)}


@app.get("/api/papers/{paper_id}/reading-blocks/{page}")
def get_reading_blocks(paper_id: str, page: int, dependencies: None = Depends(verify_token)) -> dict[str, Any]:
    lib = get_library()
    document = lib.document(paper_id)
    if not 1 <= page <= document["page_count"]:
        raise HTTPException(status_code=400, detail="ページが範囲外です。")
    source = [{"id": b["id"], "text": b["text"], "bbox": b["bbox"]}
              for b in document["blocks"] if b["page"] == page]
    folder = lib.folder(paper_id)
    translations: list[dict[str, str]] = []
    markdown = folder / "translation.md"
    if markdown.exists():
        parts = re.split(r"^## p\.(\d+) / (\S+)[ \t]*$", markdown.read_text("utf-8"), flags=re.M)
        translations = [{"id": block_id, "text": body.strip()} for number, block_id, body in
                        zip(parts[1::3], parts[2::3], parts[3::3]) if int(number) == page and body.strip()]
    elif (folder / "translation-cache.json").exists():
        translations = [{"id": f"preview-{i}", "text": value} for i, value in
                        enumerate(page_translation_text(folder, document, page))]
    return {"source": source, "translations": translations,
            "width": document["pages"][page - 1]["width"], "height": document["pages"][page - 1]["height"]}


@app.get("/api/papers/{paper_id}/search")
def search_paper(paper_id: str, q: str = "", side: str = "original",
                 dependencies: None = Depends(verify_token)) -> dict[str, Any]:
    lib = get_library()
    folder = paper_folder(lib, paper_id)
    if side not in {"original", "translated"}:
        raise HTTPException(status_code=400, detail="検索対象が不正です。")
    term = q.strip().casefold()
    if not term:
        return {"results": [], "total": 0}
    if len(term) > 200:
        raise HTTPException(status_code=400, detail="検索語が長すぎます。")
    document = lib.document(paper_id)
    results = []
    translated_pages: dict[int, list[tuple[str, str]]] = {}
    markdown = folder / "translation.md"
    if side == "translated" and markdown.exists():
        parts = re.split(r"^## p\.(\d+) / (\S+)[ \t]*$", markdown.read_text("utf-8"), flags=re.M)
        for number, block_id, body in zip(parts[1::3], parts[2::3], parts[3::3]):
            translated_pages.setdefault(int(number), []).append((block_id, body.strip()))
    source_by_id = {block["id"]: block for block in document["blocks"]}
    for info in document["pages"]:
        if len(results) >= 200:
            break
        number = info["number"]
        sections = ([block for block in document["blocks"] if block["page"] == number]
                    if side == "original" else
                    [{"text": body, "bbox": source_by_id.get(block_id, {}).get("bbox", [0, 0, 0, 0])}
                     for block_id, body in translated_pages.get(number, [])])
        content = (info["text"] if side == "original" else "\n".join(
            body for _, body in translated_pages.get(number, [])) or "\n".join(
            page_translation_text(folder, document, number)))
        anchors = [max(0.0, min(1.0, block["bbox"][1] / info["height"]))
                   for block in sections for _ in range(block["text"].casefold().count(term))]
        folded = content.casefold()
        offset = 0
        occurrence = 0
        while len(results) < 200:
            found = folded.find(term, offset)
            if found < 0:
                break
            results.append({"page": number, "snippet": content[max(0, found - 45):found + len(term) + 65].replace("\n", " "),
                            "anchor_y": anchors[occurrence] if occurrence < len(anchors) else 0})
            occurrence += 1
            offset = found + max(1, len(term))
    return {"results": results, "total": len(results), "limited": len(results) == 200}


@app.get("/api/sticky-notes")
def get_sticky_notes(dependencies: None = Depends(verify_token)) -> list[dict]:
    return get_library().sticky_notes()


@app.get("/api/papers/{paper_id}/sticky-notes")
@app.get("/api/papers/{paper_id}/bookmarks")
def get_bookmarks(paper_id: str, dependencies: None = Depends(verify_token)) -> list[dict]:
    return get_library().bookmarks(paper_id)


@app.post("/api/papers/{paper_id}/sticky-notes")
@app.post("/api/papers/{paper_id}/bookmarks")
def add_bookmark(paper_id: str, body: BookmarkRequest,
                 dependencies: None = Depends(verify_token)) -> dict:
    try:
        return get_library().add_bookmark(paper_id, body.page, body.side, body.quote, body.label, body.note, body.anchor_y, body.anchor_x)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.delete("/api/papers/{paper_id}/sticky-notes/{bookmark_id}")
@app.delete("/api/papers/{paper_id}/bookmarks/{bookmark_id}")
def delete_bookmark(paper_id: str, bookmark_id: int,
                    dependencies: None = Depends(verify_token)) -> dict[str, bool]:
    return {"deleted": get_library().delete_bookmark(paper_id, bookmark_id)}


@app.patch("/api/papers/{paper_id}/sticky-notes/{bookmark_id}")
@app.patch("/api/papers/{paper_id}/bookmarks/{bookmark_id}")
def update_bookmark(paper_id: str, bookmark_id: int, body: BookmarkEditRequest,
                    dependencies: None = Depends(verify_token)) -> dict:
    try:
        return get_library().update_bookmark(paper_id, bookmark_id, body.label, body.note,
                                             anchor_x=body.anchor_x, anchor_y=body.anchor_y)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/papers/{paper_id}/glossary")
def get_glossary(paper_id: str, dependencies: None = Depends(verify_token)) -> list[dict[str, str]]:
    from paperdesk.core.terminology import global_glossary
    lib = get_library()
    paper_folder(lib, paper_id)
    return global_glossary(lib.root)


@app.put("/api/papers/{paper_id}/glossary", deprecated=True)
def put_glossary(paper_id: str, body: GlossaryRequest,
                 dependencies: None = Depends(verify_token)) -> dict[str, int]:
    from paperdesk.core.reading_tools import validate_terms
    from paperdesk.core.terminology import save_global_glossary
    if any(job.running for job in job_manager.get_jobs()):
        raise HTTPException(status_code=409, detail="実行中の処理が終わってから共通辞書を保存してください。")
    lib = get_library()
    paper_folder(lib, paper_id)
    try:
        terms = validate_terms(body.terms)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    save_global_glossary(lib.root, terms)
    return {"count": len(terms)}


# --- Translation, Article & Chat Jobs ---


@app.post("/api/papers/{paper_id}/translate")
def translate_paper(paper_id: str, body: TranslateRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    paper_folder(lib, paper_id)
    doc = lib.document(paper_id)

    selected_pages = None
    if body.pages:
        try:
            selected_pages = parse_page_selection(body.pages, doc["page_count"])
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    s = replace(get_settings())
    if body.model:
        s.model = body.model
    if body.effort:
        s.reasoning_effort = body.effort
    api_key = _runtime_api_key

    def action(cancel: threading.Event, progress: Any, page_ready: Any) -> dict:
        provider = Provider(replace(s, api_key=api_key or s.api_key), cancel)
        service = PaperService(lib, provider, cancel, progress=progress, page_ready=page_ready)
        result = service.translate(paper_id, pages=selected_pages)
        job_manager.broadcast({"type": "library.changed"})
        return result

    try:
        job = job_manager.submit_job("translate", action, paper_id=paper_id)
        return {"job_id": job.job_id}
    except ConcurrencyConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@app.post("/api/papers/{paper_id}/article")
def generate_article(paper_id: str, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    paper_folder(lib, paper_id)

    s = replace(get_settings())
    api_key = _runtime_api_key

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict:
        provider = Provider(replace(s, api_key=api_key or s.api_key), cancel)
        service = PaperService(lib, provider, cancel, progress=progress)
        result = service.article(paper_id)
        job_manager.broadcast({"type": "library.changed"})
        return {"content": result, "usage": service.usage()}

    try:
        job = job_manager.submit_job("article", action, paper_id=paper_id)
        return {"job_id": job.job_id}
    except ConcurrencyConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@app.get("/api/papers/{paper_id}/messages")
def get_paper_messages(paper_id: str, dependencies: None = Depends(verify_token)) -> list[dict[str, Any]]:
    lib = get_library()
    paper_folder(lib, paper_id)
    return lib.messages(paper_id, with_usage=True)


@app.post("/api/papers/{paper_id}/ask")
def ask_paper(paper_id: str, body: AskRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    paper_folder(lib, paper_id)

    s = replace(get_settings())
    api_key = _runtime_api_key

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict:
        provider = Provider(replace(s, api_key=api_key or s.api_key), cancel)
        service = PaperService(lib, provider, cancel, progress=progress)
        if body.scope not in {"paper", "selected", "collection", "all"}:
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

    try:
        job = job_manager.submit_job("ask", action, paper_id=paper_id)
        return {"job_id": job.job_id}
    except ConcurrencyConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


# --- Export ---


@app.post("/api/papers/{paper_id}/export")
def export_paper(paper_id: str, body: ExportRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    folder = paper_folder(lib, paper_id)
    if body.kind not in ("translated", "original", "interleaved", "bilingual", "markdown"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不明なエクスポート形式です。")

    dest = Path(body.destination).resolve()
    library_files = {(folder / name).resolve() for name in
                     ("original.pdf", "translated.pdf", "interleaved.pdf", "article.md")}
    if dest in library_files:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="別の保存先を選んでください。")

    if body.kind in ("translated", "interleaved", "bilingual"):
        preview = read_preview(folder)
        if preview and not preview["complete"]:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="指定したページの翻訳が終わると書き出せます。完了したページはアプリ内で確認できます。")
        if not (folder / "translated.pdf").is_file():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="先に日本語訳を作成してください。")

    dest.parent.mkdir(parents=True, exist_ok=True)
    if body.kind in ("interleaved", "bilingual"):
        # Building paired PDFs can take a while on long papers; run it like other paper jobs.
        def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict[str, str]:
            service = PaperService(lib, Provider(get_settings(), cancel), cancel)
            if body.kind == "interleaved":
                progress("原文・日本語訳の交互PDFを作成しています…")
                service.export_interleaved(paper_id, dest)
            else:
                progress("対訳PDFを作成しています…")
                service.export_bilingual(paper_id, dest)
            return {"kind": body.kind, "destination": str(dest)}

        try:
            job = job_manager.submit_job("export", action, paper_id=paper_id)
        except ConcurrencyConflict as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
        return {"status": "started", "job_id": job.job_id, "destination": str(dest)}

    names = {"translated": "translated.pdf", "original": "original.pdf", "markdown": "article.md"}
    source = folder / names[body.kind]
    if not source.is_file():
        detail = "先に解説を作成してください。" if body.kind == "markdown" else "ファイルが存在しません。"
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)
    try:
        shutil.copyfile(source, dest)
    except OSError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"保存できませんでした: {error}")
    return {"status": "exported", "destination": str(dest)}


@app.post("/api/papers/{paper_id}/interleaved")
def prepare_interleaved(paper_id: str, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    """Regenerate interleaved.pdf beside the paper so it can be opened in an external viewer."""
    lib = get_library()
    folder = paper_folder(lib, paper_id)
    if not (folder / "translated.pdf").is_file():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="先に日本語訳を作成してください。")
    target = folder / "interleaved.pdf"

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> dict[str, str]:
        progress("原文・日本語訳の交互PDFを作成しています…")
        PaperService(lib, Provider(get_settings(), cancel), cancel).export_interleaved(paper_id, target)
        return {"kind": "interleaved", "path": str(target.resolve())}

    try:
        job = job_manager.submit_job("interleaved", action, paper_id=paper_id)
    except ConcurrencyConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    return {"job_id": job.job_id}


# --- Collections ---


@app.get("/api/collections")
def list_collections(dependencies: None = Depends(verify_token)) -> list[str]:
    lib = get_library()
    return [c for c in lib.collections() if c]


@app.post("/api/collections")
def create_collection(body: CreateCollectionRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    name = normalize_collection_name(body.name)
    if not name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="有効なフォルダー名を入力してください。")
    lib = get_library()
    if name in lib.collections():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="同じ名前のフォルダーが既にあります。")
    lib.create_collection(name)
    job_manager.broadcast({"type": "library.changed"})
    return {"status": "created", "name": name}


@app.patch("/api/collections/rename")
def rename_collection(body: RenameCollectionRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    # new_name is the new last segment; accept a full path too for older clients.
    leaf = normalize_collection_name(body.new_name).split(" / ")[-1]
    try:
        destination = lib.rename_collection(body.old_name, leaf)
        job_manager.broadcast({"type": "library.changed"})
        return {"status": "renamed", "name": destination}
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@app.delete("/api/collections/{name:path}")
def delete_collection(name: str, dependencies: None = Depends(verify_token)) -> dict[str, Any]:
    lib = get_library()
    try:
        moved = lib.delete_collection(name)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    job_manager.broadcast({"type": "library.changed"})
    return {"status": "deleted", "moved": moved}


# --- Jobs ---


@app.get("/api/jobs")
def get_jobs(dependencies: None = Depends(verify_token)) -> list[dict[str, Any]]:
    return [job.model_dump() for job in job_manager.get_jobs()]


@app.post("/api/jobs/cancel-all")
def cancel_all_jobs(dependencies: None = Depends(verify_token)) -> dict[str, int]:
    cancelled = sum(job_manager.cancel_job(job.job_id) for job in job_manager.get_jobs() if job.running)
    return {"cancelled": cancelled}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    success = job_manager.cancel_job(job_id)
    if not success:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="実行中のジョブが見つかりません。")
    return {"status": "cancelling"}


# --- WebSocket Events ---


@app.websocket("/ws/events")
async def ws_events(websocket: WebSocket, token: str | None = Query(None)) -> None:
    expected_token = get_auth_token()
    if expected_token and token != expected_token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    queue: asyncio.Queue = asyncio.Queue()
    job_manager.add_listener(queue)
    try:
        while True:
            send_task = asyncio.create_task(queue.get())
            recv_task = asyncio.create_task(websocket.receive_text())
            done, pending = await asyncio.wait(
                [send_task, recv_task], return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()

            if recv_task in done:
                try:
                    await recv_task
                except WebSocketDisconnect:
                    break

            if send_task in done:
                event = await send_task
                await websocket.send_text(json.dumps(event, ensure_ascii=False))
    except Exception:
        pass
    finally:
        job_manager.remove_listener(queue)


from sidecar.reading_api import register_reading_api

register_reading_api(app, verify_token)

from sidecar.ink_api import register_ink_api

register_ink_api(app, verify_token)


def main() -> None:
    import uvicorn

    port = int(os.environ.get("PAPERDESK_PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
