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
from fastapi.responses import FileResponse, StreamingResponse

from paperdesk.core.code_version import application_version, source_version
from paperdesk.core.config import Settings, data_directory
from paperdesk.core.providers import (
    Provider,
    claude_command,
    codex_command,
    gemini_command,
    query_available_efforts,
    query_available_models,
)
from paperdesk.core.service import PaperService
from paperdesk.core.storage import Library, normalize_collection_name
from paperdesk.layout.page_selection import parse_page_selection
from paperdesk.translation.translation_preview import read_preview, translated_page_numbers

from sidecar.jobs import ConcurrencyConflict, JobManager
from sidecar.schemas import (
    AskRequest,
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


def verify_token(authorization: str | None = Header(None)) -> None:
    token = get_auth_token()
    if not token:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="認証トークンが必要です。")
    provided = authorization[len("Bearer "):].strip()
    if provided != token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="認証トークンが不正です。")


def get_library() -> Library:
    return Library(get_data_dir())


def get_settings() -> Settings:
    return Settings.load(get_data_dir())


# --- Health & System ---


@app.get("/health", response_model=HealthResponse)
def health() -> dict[str, str]:
    root = Path(__file__).resolve().parents[1]
    return {
        "status": "ok",
        "version": application_version(),
        "code_version": source_version(root),
    }


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
        api_key=_runtime_api_key,
    )


@app.put("/api/settings")
def update_settings(body: SettingsModel, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    global _runtime_api_key
    s = get_settings()
    
    # Validate by creating a temporary instance
    from paperdesk.core.config import Settings
    Settings(
        provider=body.provider,
        model=body.model,
        reasoning_effort=body.reasoning_effort,
        base_url=body.api_base,
        codex_path=body.codex_path,
        claude_path=body.claude_path,
        gemini_path=body.gemini_path,
    )
    
    s.provider = body.provider
    s.model = body.model
    s.reasoning_effort = body.reasoning_effort
    s.base_url = body.api_base
    s.codex_path = body.codex_path
    s.claude_path = body.claude_path
    s.gemini_path = body.gemini_path
    s.save(get_data_dir())
    if body.api_key is not None:
        _runtime_api_key = body.api_key
    return {"status": "saved"}


@app.get("/api/providers/{provider}/models")
def get_provider_models(provider: str, dependencies: None = Depends(verify_token)) -> list[dict[str, str]]:
    s = get_settings()
    cli_path = getattr(s, f"{provider}_path", "")
    models = query_available_models(provider, cli_path=cli_path)
    return [{"id": m[0], "name": m[1]} for m in models]


@app.get("/api/providers/{provider}/efforts")
def get_provider_efforts(provider: str, model: str | None = None, dependencies: None = Depends(verify_token)) -> list[dict[str, str]]:
    efforts = query_available_efforts(provider, model=model or "")
    return [{"id": e[0], "name": e[1]} for e in efforts]


@app.post("/api/providers/login")
def provider_login(dependencies: None = Depends(verify_token)) -> dict[str, str]:
    s = get_settings()
    creationflags = subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0
    if s.provider == "codex":
        cmd = codex_command(s.codex_path) + ["login"]
        subprocess.Popen(cmd, creationflags=creationflags)
        return {"message": "ブラウザでChatGPTログイン画面を開きました。ログイン完了後「接続を確認」を実行してください。"}
    elif s.provider == "claude":
        cmd = claude_command(s.claude_path) + ["auth", "login"]
        subprocess.Popen(cmd, creationflags=creationflags)
        return {"message": "ブラウザでClaudeログイン画面を開きました。ログイン完了後「接続を確認」を実行してください。"}
    elif s.provider == "gemini":
        cmd = gemini_command(s.gemini_path)
        subprocess.Popen(cmd, creationflags=creationflags)
        return {"message": "ブラウザでAntigravityログイン画面を開きました。ログイン完了後「接続を確認」を実行してください。"}
    else:
        return {"message": "API接続ではCLIログイン操作は不要です。"}


@app.post("/api/providers/check")
def provider_check(dependencies: None = Depends(verify_token)) -> dict[str, str]:
    s = replace(get_settings())
    api_key = _runtime_api_key

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> str:
        progress("接続を確認しています…")
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        if s.provider == "codex":
            res = subprocess.run(
                codex_command(s.codex_path) + ["login", "status"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                creationflags=creationflags,
            )
            if res.returncode:
                raise RuntimeError("未ログインです。「ログイン (CLI)」を実行してください。")
            return "Codexのログイン状態を確認しました。"
        elif s.provider == "claude":
            res = subprocess.run(
                claude_command(s.claude_path) + ["auth", "status"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                creationflags=creationflags,
            )
            if res.returncode:
                raise RuntimeError("未ログインです。「ログイン (CLI)」を実行してください。\n" + res.stdout.strip())
            return "Claude Codeのログイン状態を確認しました。"
        elif s.provider == "gemini":
            res = subprocess.run(
                gemini_command(s.gemini_path) + ["models"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                creationflags=creationflags,
            )
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


# --- Papers & Library ---


@app.get("/api/papers")
def list_papers(query: str = "", sort: int = 0, dependencies: None = Depends(verify_token)) -> list[dict[str, Any]]:
    lib = get_library()
    papers = lib.papers(query=query)
    if sort == 1:
        papers.reverse()
    elif sort in (2, 3):
        papers.sort(key=lambda p: (p.get("title") or "").casefold(), reverse=(sort == 3))
    return papers


@app.post("/api/papers/import")
def import_papers(body: ImportRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    paths = [Path(p) for p in body.paths]
    for p in paths:
        if not p.is_file():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"ファイルが存在しません: {p}")

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> list[str]:
        imported_ids = []
        for i, path in enumerate(paths):
            if cancel.is_set():
                break
            progress(f"PDFを追加中 ({i + 1}/{len(paths)}): {path.name}")
            paper_id, _is_new = lib.import_pdf(path, collection_name=body.collection or "")
            imported_ids.append(paper_id)
            progress(f"テキストを抽出中 ({i + 1}/{len(paths)}): {path.name}")
            lib.document(paper_id)
        job_manager.broadcast({"type": "library.changed"})
        return imported_ids

    try:
        job = job_manager.submit_job("import", action, paper_id=None)
        return {"job_id": job.job_id}
    except ConcurrencyConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))

from fastapi import UploadFile, File
import tempfile
import shutil

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
        
    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> list[str]:
        try:
            progress(f"PDFアップロード中: {file.filename}")
            paper_id, _is_new = lib.import_pdf(tmp_path, collection_name=collection or "", original_name=file.filename or "")
            progress(f"テキスト抽出中: {file.filename}")
            lib.document(paper_id)
            job_manager.broadcast({"type": "library.changed"})
            return [paper_id]
        finally:
            tmp_path.unlink(missing_ok=True)
            
    try:
        job = job_manager.submit_job("import", action, paper_id=None)
        return {"job_id": job.job_id}
    except ConcurrencyConflict as exc:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@app.get("/api/papers/{paper_id}")
def get_paper(paper_id: str, dependencies: None = Depends(verify_token)) -> dict[str, Any]:
    lib = get_library()
    try:
        return lib.paper(paper_id)
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")


@app.patch("/api/papers/{paper_id}")
def update_paper(paper_id: str, body: UpdatePaperRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    try:
        updates: dict[str, Any] = {}
        if body.title is not None:
            updates["title"] = body.title
        if body.author is not None:
            updates["first_author"] = body.author
        if body.year is not None:
            updates["publication_year"] = str(body.year)
        if body.collection is not None:
            updates["collection_name"] = body.collection
        if body.note is not None:
            updates["note"] = body.note
        if updates:
            lib.update(paper_id, **updates)
        job_manager.broadcast({"type": "library.changed"})
        return {"status": "updated"}
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@app.post("/api/papers/{paper_id}/rename")
def rename_paper(paper_id: str, body: RenamePaperRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    try:
        lib.rename_paper(paper_id, body.new_title)
        job_manager.broadcast({"type": "library.changed"})
        return {"status": "renamed"}
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@app.delete("/api/papers/{paper_id}")
def delete_paper(paper_id: str, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    if any(j.running and j.paper_id == paper_id for j in job_manager.get_jobs()):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="処理中のジョブがあるため削除できません。")
    lib = get_library()
    try:
        folder = lib.folder(paper_id)
        with lib.connection() as db:
            db.execute("DELETE FROM messages WHERE paper_id=?", (paper_id,))
            db.execute("DELETE FROM pages WHERE paper_id=?", (paper_id,))
            db.execute("DELETE FROM papers WHERE id=?", (paper_id,))
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)
        job_manager.broadcast({"type": "library.changed"})
        return {"status": "deleted"}
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")


@app.get("/api/papers/{paper_id}/reading")
def get_reading_info(paper_id: str, dependencies: None = Depends(verify_token)) -> dict[str, Any]:
    lib = get_library()
    try:
        folder = lib.folder(paper_id)
        info = lib.reading_info(paper_id)
        page_count = info["page_count"]
        preview = read_preview(folder)
        completed = translated_page_numbers(folder, page_count)

        report_path = folder / "translation-report.json"
        report = json.loads(report_path.read_text("utf-8")) if report_path.exists() else None

        ui_state = load_ui_state(get_data_dir())
        last_page = ui_state.get("reading_pages", {}).get(paper_id, 0)

        return {
            "page_count": page_count,
            "completed_pages": completed,
            "preview": preview,
            "report": report,
            "last_page": last_page,
            "has_translated": (folder / "translated.pdf").is_file(),
            "has_article": (folder / "article.md").is_file(),
        }
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")


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
    try:
        folder = lib.folder(paper_id).resolve()
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")

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
    try:
        folder = lib.folder(paper_id).resolve()
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")

    if not re.fullmatch(r"^[a-zA-Z0-9_\-\.]+\.png$", name):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不正な画像名です。")

    media_file = (folder / "media" / name).resolve()
    if not media_file.is_relative_to(folder / "media") or not media_file.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="画像が見つかりません。")

    return FileResponse(media_file, media_type="image/png")


@app.get("/api/papers/{paper_id}/article")
def get_paper_article(paper_id: str, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    try:
        folder = lib.folder(paper_id)
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")

    article_path = folder / "article.md"
    if not article_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="サマリー記事がまだ生成されていません。")

    return {"content": article_path.read_text("utf-8")}


# --- Translation, Article & Chat Jobs ---


@app.post("/api/papers/{paper_id}/translate")
def translate_paper(paper_id: str, body: TranslateRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    try:
        doc = lib.document(paper_id)
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")

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
    try:
        lib.document(paper_id)
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")

    s = replace(get_settings())
    api_key = _runtime_api_key

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> str:
        provider = Provider(replace(s, api_key=api_key or s.api_key), cancel)
        service = PaperService(lib, provider, cancel, progress=progress)
        result = service.article(paper_id)
        job_manager.broadcast({"type": "library.changed"})
        return result

    try:
        job = job_manager.submit_job("article", action, paper_id=paper_id)
        return {"job_id": job.job_id}
    except ConcurrencyConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@app.get("/api/papers/{paper_id}/messages")
def get_paper_messages(paper_id: str, dependencies: None = Depends(verify_token)) -> list[dict[str, str]]:
    lib = get_library()
    try:
        return lib.messages(paper_id)
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")


@app.post("/api/papers/{paper_id}/ask")
def ask_paper(paper_id: str, body: AskRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    try:
        lib.document(paper_id)
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")

    s = replace(get_settings())
    api_key = _runtime_api_key

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> str:
        provider = Provider(replace(s, api_key=api_key or s.api_key), cancel)
        service = PaperService(lib, provider, cancel, progress=progress)
        return service.ask(paper_id, body.question, entire_library=body.search_all)

    try:
        job = job_manager.submit_job("ask", action, paper_id=paper_id)
        return {"job_id": job.job_id}
    except ConcurrencyConflict as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


# --- Export ---


@app.post("/api/papers/{paper_id}/export")
def export_paper(paper_id: str, body: ExportRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    try:
        folder = lib.folder(paper_id)
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="論文が見つかりません。")

    dest = Path(body.destination)
    dest.parent.mkdir(parents=True, exist_ok=True)
    service = PaperService(lib, Provider(get_settings(), threading.Event()), threading.Event())

    if body.kind == "translated":
        source = folder / "translated.pdf"
        if not source.is_file():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="訳文PDFが存在しません。")
        shutil.copyfile(source, dest)
    elif body.kind == "interleaved":
        service.export_interleaved(paper_id, dest)
    elif body.kind == "bilingual":
        service.export_bilingual(paper_id, dest)
    elif body.kind == "markdown":
        article = folder / "article.md"
        if not article.is_file():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="サマリーMarkdownが存在しません。")
        shutil.copyfile(article, dest)
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="不明なエクスポート形式です。")

    return {"status": "exported", "destination": str(dest)}


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
    lib.create_collection(name)
    job_manager.broadcast({"type": "library.changed"})
    return {"status": "created", "name": name}


@app.patch("/api/collections/rename")
def rename_collection(body: RenameCollectionRequest, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    try:
        lib.rename_collection(body.old_name, body.new_name)
        job_manager.broadcast({"type": "library.changed"})
        return {"status": "renamed"}
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@app.delete("/api/collections/{name:path}")
def delete_collection(name: str, dependencies: None = Depends(verify_token)) -> dict[str, str]:
    lib = get_library()
    lib.delete_collection(name)
    job_manager.broadcast({"type": "library.changed"})
    return {"status": "deleted"}


# --- Jobs ---


@app.get("/api/jobs")
def get_jobs(dependencies: None = Depends(verify_token)) -> list[dict[str, Any]]:
    return [job.model_dump() for job in job_manager.get_jobs()]


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
            # Yield events to client, listen for client pings
            event = await queue.get()
            await websocket.send_text(json.dumps(event, ensure_ascii=False))
    except WebSocketDisconnect:
        pass
    finally:
        job_manager.remove_listener(queue)


def main() -> None:
    import uvicorn

    port = int(os.environ.get("PAPERDESK_PORT", "8000"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()

