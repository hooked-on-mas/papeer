from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import sqlite3
import zipfile

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, Field

from paperdesk.core import reading_tools as tools
from paperdesk.core.providers import Provider, check_cancel, parse_json_answer
from paperdesk.core.service import PaperService
from paperdesk.core.terminology import global_glossary, save_global_glossary, GlossaryConflict
from sidecar.jobs import ConcurrencyConflict


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


class BackupRequest(BaseModel):
    path: str


class TagRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class RevisionRequest(BaseModel):
    unit_id: str
    text: str = ""
    instruction: str = Field(default="自然な日本語にしてください。", max_length=2000)
    expected_text: str | None = None


def register_reading_api(app, verify_token):
    # Resolve the runtime on each call so app settings, tests and API keys share one source.
    from sidecar import app as runtime

    def submit(kind, action, paper_id=None):
        try:
            job = runtime.job_manager.submit_job(kind, action, paper_id=paper_id)
            return {"job_id": job.job_id}
        except ConcurrencyConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc))

    @app.get("/api/tags", dependencies=[Depends(verify_token)])
    def tags():
        lib = runtime.get_library()
        with lib.connection() as db:
            names = {row[0] for row in db.execute("SELECT name FROM tag_choices WHERE kind='paper'")}
        return sorted(names | {tag for paper in lib.papers() for tag in paper["tags"]}, key=str.casefold)

    @app.post("/api/tags", dependencies=[Depends(verify_token)])
    def add_tag(body: TagRequest):
        return save_choice("paper", body.name)

    def save_choice(kind, value):
        name = value.strip()
        if not name or (kind == "sticky" and len(name) > 40):
            raise HTTPException(status_code=400, detail="名前を入力してください（付箋の分類は40文字まで）。")
        with runtime.get_library().connection() as db:
            if kind == "status":
                db.execute("INSERT OR IGNORE INTO reading_status_choices VALUES(?)", (name,))
            else:
                db.execute("INSERT OR IGNORE INTO tag_choices VALUES(?,?)", (kind, name))
        return {"name": name}

    @app.get("/api/reading-statuses", dependencies=[Depends(verify_token)])
    def reading_statuses():
        with runtime.get_library().connection() as db:
            return [row[0] for row in db.execute("SELECT name FROM reading_status_choices ORDER BY rowid")]

    @app.post("/api/reading-statuses", dependencies=[Depends(verify_token)])
    def add_reading_status(body: TagRequest):
        return save_choice("status", body.name)

    @app.delete("/api/reading-statuses", dependencies=[Depends(verify_token)])
    def delete_reading_status(name: str = Query(min_length=1, max_length=80)):
        with runtime.get_library().connection() as db:
            db.execute("DELETE FROM reading_status_choices WHERE name=?", (name,))
        return {"status": "deleted"}

    @app.get("/api/sticky-labels", dependencies=[Depends(verify_token)])
    def sticky_labels():
        with runtime.get_library().connection() as db:
            return [row[0] for row in db.execute("SELECT name FROM tag_choices WHERE kind='sticky' ORDER BY rowid")]

    @app.post("/api/sticky-labels", dependencies=[Depends(verify_token)])
    def add_sticky_label(body: TagRequest):
        return save_choice("sticky", body.name)

    @app.delete("/api/sticky-labels", dependencies=[Depends(verify_token)])
    def delete_sticky_label(name: str = Query(min_length=1, max_length=40)):
        with runtime.get_library().connection() as db:
            db.execute("DELETE FROM tag_choices WHERE kind='sticky' AND name=?", (name,))
        return {"status": "deleted"}

    @app.delete("/api/tags", dependencies=[Depends(verify_token)])
    def delete_tag(name: str = Query(min_length=1, max_length=80)):
        try:
            affected = runtime.get_library().remove_tag(name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        runtime.job_manager.broadcast({"type": "library.changed"})
        return {"affected": affected}

    @app.get("/api/note-templates", dependencies=[Depends(verify_token)])
    def templates():
        with runtime.get_library().connection() as db:
            return [{"name": "読書メモ", "content": tools.DEFAULT_TEMPLATE, "builtin": True},
                    *[dict(row, builtin=False) for row in db.execute("SELECT * FROM note_templates ORDER BY name")]]

    @app.put("/api/note-templates", dependencies=[Depends(verify_token)])
    def save_template(body: TemplateRequest):
        name = body.name.strip()
        if not name or name == "読書メモ" or not body.content.strip():
            raise HTTPException(status_code=400, detail="テンプレート名と本文を入力してください。標準名は変更できません。")
        with runtime.get_library().connection() as db:
            db.execute("INSERT OR REPLACE INTO note_templates(name,content) VALUES(?,?)", (name, body.content))
        return {"status": "saved"}

    @app.delete("/api/note-templates/{name:path}", dependencies=[Depends(verify_token)])
    def delete_template(name: str):
        with runtime.get_library().connection() as db:
            db.execute("DELETE FROM note_templates WHERE name=?", (name,))
        return {"status": "deleted"}

    @app.get("/api/library-search", dependencies=[Depends(verify_token)])
    def search(q: str = ""):
        try:
            return tools.library_search(runtime.get_library(), q)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.get("/api/glossary", dependencies=[Depends(verify_token)])
    def get_global_glossary():
        return global_glossary(runtime.get_library().root)

    @app.post("/api/glossary/export", dependencies=[Depends(verify_token)])
    def export_glossary(body: GlossaryFileRequest):
        from paperdesk.core.glossary_io import export_glossary
        try:
            count = export_glossary(Path(body.path), body.terms)
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"count": count}

    @app.post("/api/glossary/import", dependencies=[Depends(verify_token)])
    def import_glossary(body: GlossaryFileRequest):
        from paperdesk.core.glossary_io import import_glossary
        try:
            return import_glossary(Path(body.path), body.terms)
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    @app.put("/api/glossary", dependencies=[Depends(verify_token)])
    def put_global_glossary(body: GlobalGlossaryRequest):
        if any(j.running for j in runtime.job_manager.get_jobs()):
            raise HTTPException(status_code=409, detail="実行中の処理が終わってから共通辞書を保存してください。")
        try:
            terms = tools.validate_terms(body.terms)
            save_global_glossary(runtime.get_library().root, terms, body.expected_terms)
        except GlossaryConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        return {"count": len(terms)}

    @app.get("/api/papers/{paper_id}/effective-glossary", dependencies=[Depends(verify_token)])
    def effective_glossary(paper_id: str):
        lib = runtime.get_library()
        runtime.paper_folder(lib, paper_id)
        return tools.effective_glossary(lib, paper_id)

    @app.post("/api/papers/{paper_id}/glossary-draft", dependencies=[Depends(verify_token)])
    def glossary_draft(paper_id: str, body: GlossaryDraftRequest):
        lib = runtime.get_library()
        runtime.paper_folder(lib, paper_id)
        try:
            existing = tools.validate_terms(body.terms)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        settings = runtime.get_settings()
        settings = replace(settings, api_key=runtime._runtime_api_key or settings.api_key,
                           model=body.model or settings.model,
                           reasoning_effort=body.effort or settings.reasoning_effort)
        def action(cancel, progress, _page_ready):
            return tools.draft_glossary(lib, paper_id, Provider(settings, cancel), cancel, progress, existing)
        return submit("glossary-draft", action, paper_id)

    @app.get("/api/papers/{paper_id}/paragraphs", dependencies=[Depends(verify_token)])
    def paragraphs(paper_id: str):
        lib = runtime.get_library()
        runtime.paper_folder(lib, paper_id)
        return tools.translation_paragraphs(lib, paper_id)

    @app.get("/api/papers/{paper_id}/revisions", dependencies=[Depends(verify_token)])
    def revisions(paper_id: str):
        path = runtime.paper_folder(runtime.get_library(), paper_id) / "translation-revisions.json"
        return json.loads(path.read_text("utf-8")) if path.exists() else []

    def find_paragraph(lib, paper_id, body):
        runtime.paper_folder(lib, paper_id)
        paragraph = next((item for item in tools.translation_paragraphs(lib, paper_id) if item["id"] == body.unit_id), None)
        if not paragraph:
            raise HTTPException(status_code=400, detail="段落が見つかりません。辞書変更後は再翻訳してください。")
        if body.expected_text is not None and paragraph["text"] != body.expected_text:
            raise HTTPException(status_code=409, detail="訳文が変更されました。読み込み直してください。")
        return paragraph

    @app.post("/api/papers/{paper_id}/revision-draft", dependencies=[Depends(verify_token)])
    def draft_revision(paper_id: str, body: RevisionRequest):
        lib = runtime.get_library()
        paragraph = find_paragraph(lib, paper_id, body)
        settings = runtime.get_settings()
        settings = replace(settings, api_key=runtime._runtime_api_key or settings.api_key)
        def action(cancel, progress, _page_ready):
            progress("この段落の修正案を作っています…")
            provider = Provider(settings, cancel)
            answer = provider.generate(
                "Translate this academic paragraph into Japanese. Return JSON with a single text field. "
                "Preserve every math placeholder verbatim, exactly once. Follow the glossary. " + body.instruction,
                json.dumps({"source": paragraph["source"], "current": paragraph["text"],
                            "glossary": tools.effective_glossary(lib, paper_id)}, ensure_ascii=False),
                {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False})
            value = parse_json_answer(answer)
            if not isinstance(value.get("text"), str):
                raise ValueError("AIから修正案を取得できませんでした。再試行してください。")
            text = tools.validate_revision(paragraph["source"], value["text"])
            check_cancel(cancel)
            return {"text": text, "unit_id": paragraph["id"]}
        return submit("revision-draft", action, paper_id)

    @app.post("/api/papers/{paper_id}/revision", dependencies=[Depends(verify_token)])
    def adopt_revision(paper_id: str, body: RevisionRequest):
        lib = runtime.get_library()
        paragraph = find_paragraph(lib, paper_id, body)
        try:
            text = tools.validate_revision(paragraph["source"], body.text)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        settings = runtime.get_settings()
        settings = replace(settings, api_key=runtime._runtime_api_key or settings.api_key)
        def action(cancel, progress, page_ready):
            current = find_paragraph(lib, paper_id, body)
            provider = Provider(settings, cancel)
            result = PaperService(lib, provider, cancel, progress, page_ready).translate(
                paper_id, pages=set(current["pages"]), replacements={body.unit_id: text})
            if result.get("skipped_pages"):
                raise ValueError("修正したページのPDF生成に失敗しました。翻訳の要確認一覧から確認してください。")
            tools.save_revision_history(lib.folder(paper_id), body.unit_id, current["text"], text)
            runtime.job_manager.broadcast({"type": "library.changed"})
            return result
        return submit("revision", action, paper_id)

    @app.get("/api/papers/{paper_id}/citation-excerpts", dependencies=[Depends(verify_token)])
    def citation_excerpts(paper_id: str, page: int):
        lib = runtime.get_library()
        runtime.paper_folder(lib, paper_id)
        if not 1 <= page <= lib.paper(paper_id)["pages"]:
            raise HTTPException(status_code=400, detail="ページが範囲外です。")
        with lib.connection() as db:
            row = db.execute("SELECT text FROM pages WHERE paper_id=? AND number=?", (paper_id, page)).fetchone()
        return {"text": row[0][:6000] if row else ""}

    @app.post("/api/backup", dependencies=[Depends(verify_token)])
    def backup(body: BackupRequest):
        lib = runtime.get_library()
        def action(cancel, progress, _page_ready):
            check_cancel(cancel)
            progress("ライブラリ全体をバックアップしています…")
            tools.create_backup(lib, Path(body.path))
            return {"path": body.path}
        return submit("backup", action)

    @app.post("/api/restore", dependencies=[Depends(verify_token)])
    def restore(body: BackupRequest):
        lib = runtime.get_library()
        def action(cancel, progress, _page_ready):
            check_cancel(cancel)
            progress("バックアップを検証して復元しています…")
            try:
                previous = tools.restore_backup(lib, Path(body.path))
            except (OSError, ValueError, sqlite3.DatabaseError, zipfile.BadZipFile) as exc:
                raise ValueError(f"バックアップを復元できませんでした：{exc}") from exc
            runtime.job_manager.broadcast({"type": "library.changed"})
            return {"previous_path": str(previous)}
        return submit("restore", action)
