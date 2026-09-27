"""Reading aids: tags and statuses, note templates, library search, the glossary, paragraph revisions, backup."""
from __future__ import annotations

from pathlib import Path
import sqlite3
import sys
import zipfile

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from papeer.core import drive_sync, reading_tools as tools
from papeer.providers import Cancelled, check_cancel
from papeer.core.service import PaperService
from papeer.core.terminology import global_glossary, save_global_glossary, GlossaryConflict
from sidecar import deps


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

router = APIRouter(dependencies=[Depends(deps.verify_token)])



@router.get("/api/tags")
def tags():
    lib = deps.get_library()
    names = set(lib.tag_choices("paper"))
    return sorted(names | {tag for paper in lib.papers() for tag in paper["tags"]}, key=str.casefold)

@router.post("/api/tags")
def add_tag(body: TagRequest):
    return save_choice("paper", body.name)

def save_choice(kind, value):
    name = value.strip()
    if not name or (kind == "sticky" and len(name) > 40):
        raise HTTPException(status_code=400, detail="名前を入力してください（付箋の分類は40文字まで）。")
    lib = deps.get_library()
    if kind == "status":
        lib.add_reading_status(name)
    else:
        lib.add_tag_choice(kind, name)
    return {"name": name}

@router.get("/api/reading-statuses")
def reading_statuses():
    return deps.get_library().reading_statuses()

@router.post("/api/reading-statuses")
def add_reading_status(body: TagRequest):
    return save_choice("status", body.name)

@router.delete("/api/reading-statuses")
def delete_reading_status(name: str = Query(min_length=1, max_length=80)):
    deps.get_library().delete_reading_status(name)
    return {"status": "deleted"}

@router.get("/api/sticky-labels")
def sticky_labels():
    return deps.get_library().tag_choices("sticky")

@router.post("/api/sticky-labels")
def add_sticky_label(body: TagRequest):
    return save_choice("sticky", body.name)

@router.delete("/api/sticky-labels")
def delete_sticky_label(name: str = Query(min_length=1, max_length=40)):
    deps.get_library().delete_tag_choice("sticky", name)
    return {"status": "deleted"}

@router.delete("/api/tags")
def delete_tag(name: str = Query(min_length=1, max_length=80)):
    try:
        affected = deps.get_library().remove_tag(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    deps.library_changed()
    return {"affected": affected}

@router.get("/api/note-templates")
def templates():
    return [{"name": "読書メモ", "content": tools.DEFAULT_TEMPLATE, "builtin": True},
            *[dict(row, builtin=False) for row in deps.get_library().note_templates()]]

@router.put("/api/note-templates")
def save_template(body: TemplateRequest):
    name = body.name.strip()
    if not name or name == "読書メモ" or not body.content.strip():
        raise HTTPException(status_code=400, detail="テンプレート名と本文を入力してください。標準名は変更できません。")
    deps.get_library().save_note_template(name, body.content)
    return {"status": "saved"}

@router.delete("/api/note-templates/{name:path}")
def delete_template(name: str):
    deps.get_library().delete_note_template(name)
    return {"status": "deleted"}

@router.get("/api/library-search")
def search(q: str = ""):
    try:
        return tools.library_search(deps.get_library(), q)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

@router.get("/api/glossary")
def get_global_glossary():
    return global_glossary(deps.get_library().root)

@router.post("/api/glossary/export")
def export_glossary(body: GlossaryFileRequest):
    from papeer.core.glossary_io import export_glossary
    try:
        count = export_glossary(Path(body.path), body.terms)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"count": count}

@router.post("/api/glossary/import")
def import_glossary(body: GlossaryFileRequest):
    from papeer.core.glossary_io import import_glossary
    try:
        return import_glossary(Path(body.path), body.terms)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))

@router.put("/api/glossary")
def put_global_glossary(body: GlobalGlossaryRequest):
    if any(j.running for j in deps.job_manager.get_jobs()):
        raise HTTPException(status_code=409, detail="実行中の処理が終わってから共通辞書を保存してください。")
    try:
        terms = tools.validate_terms(body.terms)
        save_global_glossary(deps.get_library().root, terms, body.expected_terms)
    except GlossaryConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"count": len(terms)}

@router.get("/api/papers/{paper_id}/effective-glossary")
def effective_glossary(paper_id: str):
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    return tools.effective_glossary(lib, paper_id)

@router.post("/api/papers/{paper_id}/glossary-draft")
def glossary_draft(paper_id: str, body: GlossaryDraftRequest):
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    try:
        existing = tools.validate_terms(body.terms)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        settings = deps.settings_for_run(body.model, body.effort)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    def action(cancel, progress, _page_ready):
        return tools.draft_glossary(lib, paper_id, deps.provider_for(settings, cancel), cancel, progress, existing)
    return deps.submit_job("glossary-draft", action, paper_id)

@router.get("/api/papers/{paper_id}/paragraphs")
def paragraphs(paper_id: str):
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    return tools.translation_paragraphs(lib, paper_id)

@router.get("/api/papers/{paper_id}/revisions")
def revisions(paper_id: str):
    return tools.revision_history(deps.paper_folder(deps.get_library(), paper_id))

def find_paragraph(lib, paper_id, body):
    deps.paper_folder(lib, paper_id)
    paragraph = next((item for item in tools.translation_paragraphs(lib, paper_id) if item["id"] == body.unit_id), None)
    if not paragraph:
        raise HTTPException(status_code=400, detail="段落が見つかりません。辞書変更後は再翻訳してください。")
    if body.expected_text is not None and paragraph["text"] != body.expected_text:
        raise HTTPException(status_code=409, detail="訳文が変更されました。読み込み直してください。")
    return paragraph

@router.post("/api/papers/{paper_id}/revision-draft")
def draft_revision(paper_id: str, body: RevisionRequest):
    lib = deps.get_library()
    paragraph = find_paragraph(lib, paper_id, body)
    settings = deps.get_settings()
    def action(cancel, progress, _page_ready):
        progress("この段落の修正案を作っています…")
        text = tools.draft_revision(lib, paper_id, paragraph, body.instruction,
                                   deps.provider_for(settings, cancel), cancel)
        return {"text": text, "unit_id": paragraph["id"]}
    return deps.submit_job("revision-draft", action, paper_id)

@router.post("/api/papers/{paper_id}/revision")
def adopt_revision(paper_id: str, body: RevisionRequest):
    lib = deps.get_library()
    paragraph = find_paragraph(lib, paper_id, body)
    try:
        text = tools.validate_revision(paragraph["source"], body.text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    settings = deps.get_settings()
    def action(cancel, progress, page_ready):
        current = find_paragraph(lib, paper_id, body)
        provider = deps.provider_for(settings, cancel)
        result = PaperService(lib, provider, cancel, progress, page_ready).translate(
            paper_id, pages=set(current["pages"]), replacements={body.unit_id: text})
        if result.get("skipped_pages"):
            raise ValueError("修正したページのPDF生成に失敗しました。翻訳の要確認一覧から確認してください。")
        tools.save_revision_history(lib.folder(paper_id), body.unit_id, current["text"], text)
        deps.library_changed()
        return result
    return deps.submit_job("revision", action, paper_id)

@router.get("/api/papers/{paper_id}/citation-excerpts")
def citation_excerpts(paper_id: str, page: int):
    lib = deps.get_library()
    deps.paper_folder(lib, paper_id)
    if not 1 <= page <= lib.paper(paper_id)["pages"]:
        raise HTTPException(status_code=400, detail="ページが範囲外です。")
    return {"text": lib.page_text(paper_id, page)[:6000]}

@router.post("/api/backup")
def backup(body: BackupRequest):
    lib = deps.get_library()
    def action(cancel, progress, _page_ready):
        deps.wait_for_library_requests()
        check_cancel(cancel)
        progress("ライブラリ全体をバックアップしています…")
        try:
            tools.create_backup(lib, Path(body.path), cancel)
        except Cancelled:
            raise Cancelled("バックアップを中止しました。") from None
        return {"path": body.path}
    return deps.submit_job("backup", action)

@router.post("/api/restore")
def restore(body: RestoreRequest):
    lib = deps.get_library()
    def action(cancel, progress, _page_ready):
        deps.wait_for_library_requests()
        check_cancel(cancel)
        progress("バックアップを検証して復元しています…")
        try:
            previous = tools.restore_backup(lib, Path(body.path), cancel, import_settings=body.import_settings)
        except Cancelled:
            raise Cancelled("復元を中止しました。ライブラリは変更していません。") from None
        except (OSError, ValueError, sqlite3.DatabaseError, zipfile.BadZipFile) as exc:
            raise ValueError(f"バックアップを復元できませんでした：{exc}") from exc
        # The backup may be older than what the sync folder holds: the next sync asks before publishing it.
        try:
            drive_sync.mark_restored(lib.root)
        except Exception as exc:  # The restore itself has succeeded; a missing mark must not report it as failed.
            print(f"警告: 復元後の同期確認の印を保存できませんでした: {exc!r}", file=sys.stderr)
        deps.library_changed()
        return {"previous_path": str(previous)}
    return deps.submit_job("restore", action)
