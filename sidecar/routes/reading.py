"""Reading aids: tags and statuses, note templates, library search, the glossary, paragraph revisions, backup."""
from __future__ import annotations

from pathlib import Path
import sqlite3
import sys
import zipfile

from fastapi import APIRouter, Depends, Query

from papeer.core import drive_sync, glossary_domains, history_restore, reading_tools as tools
from papeer.core.errors import Invalid
from papeer.providers import Cancelled, check_cancel
from papeer.core.terminology import (
    GENERAL_DOMAIN, SPLIT_AT, add_glossary_term, domain_names, global_glossary, glossary_scope_key,
    paper_domains, paper_glossary, save_global_glossary, save_paper_domains, save_paper_glossary)
from sidecar import deps
from sidecar.job_types import JobKind, JobStarted
from sidecar.schemas.reading import (
    BackupRequest,
    GlobalGlossaryRequest,
    GlossaryDraftRequest,
    GlossaryFileRequest,
    GlossarySelectRequest,
    GlossarySplitRequest,
    GlossaryTermRequest,
    PaperDomainsRequest,
    PaperGlossaryRequest,
    RestoreRequest,
    RevisionRequest,
    TagRequest,
    TemplateRequest,
)

router = APIRouter(dependencies=[Depends(deps.verify_token)])



@router.get("/api/tags")
def tags():
    return tools.all_tags(deps.get_library())

@router.post("/api/tags")
def add_tag(body: TagRequest):
    return save_choice("paper", body.name)

def save_choice(kind, value):
    name = tools.choice_name(kind, value)
    tools.add_choice(deps.get_library(), kind, name)
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
    affected = deps.get_library().remove_tag(name)
    deps.library_changed()
    return {"affected": affected}

@router.get("/api/note-templates")
def templates():
    return tools.note_templates(deps.get_library())

@router.put("/api/note-templates")
def save_template(body: TemplateRequest):
    name = tools.template_name(body.name, body.content)
    deps.get_library().save_note_template(name, body.content)
    return {"status": "saved"}

@router.delete("/api/note-templates/{name:path}")
def delete_template(name: str):
    deps.get_library().delete_note_template(name)
    return {"status": "deleted"}

@router.get("/api/library-search")
def search(q: str = ""):
    return tools.library_search(deps.get_library(), q)

@router.get("/api/glossary")
def get_global_glossary():
    return global_glossary(deps.get_library().root)

@router.post("/api/glossary/export")
def export_glossary(body: GlossaryFileRequest):
    from papeer.core.glossary_io import export_glossary
    return {"count": export_glossary(Path(body.path), body.terms, deps.get_data_dir())}

@router.post("/api/glossary/import")
def import_glossary(body: GlossaryFileRequest):
    from papeer.core.glossary_io import import_glossary
    return import_glossary(Path(body.path), body.terms)

@router.put("/api/glossary")
def put_global_glossary(body: GlobalGlossaryRequest):
    # A dictionary changed in another window since this one read it is a GlossaryConflict (409).
    with deps.job_manager.idle("実行中の処理が終わってから共通辞書を保存してください。",
                               ignore=frozenset({JobKind.REFERENCE_RESEARCH})):
        terms = tools.validate_terms(body.terms)
        save_global_glossary(deps.get_library().root, terms, body.expected_terms)
    return {"count": len(terms)}

@router.get("/api/papers/{paper_id}/effective-glossary")
def effective_glossary(paper_id: str):
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    return tools.effective_glossary(lib, paper_id)

def _domains_state(paper_id: str) -> dict:
    terms = global_glossary(deps.get_library().root)
    available = domain_names(terms)
    record = paper_domains(deps.get_library().root, paper_id)
    scope = paper_glossary(deps.get_library().root, paper_id)["scope"]
    source = "\n\n".join(text for _, text in deps.get_library().page_texts(paper_id)) if available else ""
    key = glossary_scope_key(terms, source)
    return {"domains": record["domains"] if record else [], "new_domain": record["new_domain"] if record else None,
            "chosen_by": record["chosen_by"] if record else None,
            "known_domains": record["known_domains"] if record else [],
            "available": available, "stale": bool(record) and record["known_domains"] != available,
            "split_at": SPLIT_AT, "scope_terms": scope["terms"] if scope and scope["key"] == key else [],
            "scope_stale": scope is None or scope["key"] != key, "selection_key": key}


@router.get("/api/papers/{paper_id}/glossary")
def get_local_glossary(paper_id: str):
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    state = paper_glossary(lib.root, paper_id)
    return {"terms": state["terms"], "dismissed": state["dismissed"]}


@router.put("/api/papers/{paper_id}/glossary")
def put_local_glossary(paper_id: str, body: PaperGlossaryRequest):
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    terms = tools.validate_terms(body.terms)
    if any(t.get("domain") for t in terms):
        raise Invalid("この論文だけの訳語指定には分野を付けられません。")
    if any(not s.strip() or len(s) > 100 for s in body.dismissed):
        raise Invalid("確認しない語は1〜100文字で指定してください。")
    dismissed = list(dict.fromkeys(s.strip().casefold() for s in body.dismissed))
    with deps.job_manager.idle("実行中の処理が終わってから訳語指定を保存してください。",
                               ignore=frozenset({JobKind.REFERENCE_RESEARCH})):
        save_paper_glossary(lib.root, paper_id, terms, dismissed, body.expected)
    return {"terms": terms, "dismissed": dismissed}

@router.get("/api/papers/{paper_id}/glossary-domains")
def get_paper_domains(paper_id: str):
    deps.get_library().paper_folder(paper_id)
    return _domains_state(paper_id)

@router.put("/api/papers/{paper_id}/glossary-domains")
def put_paper_domains(paper_id: str, body: PaperDomainsRequest):
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    available = domain_names(global_glossary(lib.root))
    by_folded = {name.casefold(): name for name in available}
    domains = []
    for name in body.domains:
        name = by_folded.get(name.strip().casefold())
        if name and name not in domains:
            domains.append(name)
    new_domain = (body.new_domain or "").strip()
    new_domain = None if new_domain in {"", GENERAL_DOMAIN} else new_domain
    if new_domain and new_domain.casefold() in by_folded:
        new_domain = by_folded[new_domain.casefold()]
        if new_domain not in domains:
            domains.append(new_domain)
        new_domain = None
    save_paper_domains(lib.root, paper_id, domains, new_domain, "user", available)
    return _domains_state(paper_id)

@router.post("/api/papers/{paper_id}/glossary/terms")
def add_paper_term(paper_id: str, body: GlossaryTermRequest):
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    with deps.job_manager.idle("実行中の処理が終わってから辞書に登録してください。",
                               ignore=frozenset({JobKind.REFERENCE_RESEARCH})):
        term = tools.validate_terms([{"source": body.source, "target": body.target}])[0]
        return {"domain": add_glossary_term(lib.root, paper_id, term["source"], term["target"])}

@router.post("/api/papers/{paper_id}/glossary-domains/select")
def select_paper_domains(paper_id: str, body: GlossarySelectRequest) -> JobStarted:
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    settings = deps.settings_for_run(body.model, body.effort)
    def action(cancel, progress, _page_ready):
        progress("この論文に使う分野辞書を選んでいます…")
        return glossary_domains.select_domains(lib, paper_id, deps.provider_for(settings, cancel), cancel)
    return deps.submit_job(JobKind.GLOSSARY_SELECT, action, paper_id)

@router.post("/api/papers/{paper_id}/glossary/split")
def split_glossary(paper_id: str, body: GlossarySplitRequest) -> JobStarted:
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    glossary_domains.split_target(global_glossary(lib.root), body.domain)  # Invalid (400) before the job starts.
    settings = deps.settings_for_run(body.model, body.effort)
    def action(cancel, progress, _page_ready):
        return glossary_domains.split_domain(lib.root, deps.provider_for(settings, cancel), cancel, progress, body.domain,
                                             preview=body.preview)
    return deps.submit_job(JobKind.GLOSSARY_SPLIT, action, paper_id)

@router.post("/api/papers/{paper_id}/glossary-draft")
def glossary_draft(paper_id: str, body: GlossaryDraftRequest) -> JobStarted:
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    existing = tools.validate_terms(body.terms)
    settings = deps.settings_for_run(body.model, body.effort)
    def action(cancel, progress, _page_ready):
        return tools.draft_glossary(lib, paper_id, deps.provider_for(settings, cancel), cancel, progress, existing)
    return deps.submit_job(JobKind.GLOSSARY_DRAFT, action, paper_id)

@router.get("/api/papers/{paper_id}/paragraphs")
def paragraphs(paper_id: str):
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    return tools.translation_paragraphs(lib, paper_id)

@router.get("/api/papers/{paper_id}/revisions")
def revisions(paper_id: str):
    return tools.revision_history(deps.get_library().paper_folder(paper_id))

@router.post("/api/papers/{paper_id}/revision-draft")
def draft_revision(paper_id: str, body: RevisionRequest) -> JobStarted:
    lib = deps.get_library()
    paragraph = tools.find_paragraph(lib, paper_id, body.unit_id, body.expected_text)
    settings = deps.get_settings()
    def action(cancel, progress, _page_ready):
        progress("この段落の修正案を作っています…")
        text = tools.draft_revision(lib, paper_id, paragraph, body.instruction,
                                   deps.provider_for(settings, cancel), cancel, body.char_budget)
        return {"text": text, "unit_id": paragraph["id"]}
    return deps.submit_job(JobKind.REVISION_DRAFT, action, paper_id)

@router.post("/api/papers/{paper_id}/revision")
def adopt_revision(paper_id: str, body: RevisionRequest) -> JobStarted:
    lib = deps.get_library()
    paragraph = tools.find_paragraph(lib, paper_id, body.unit_id, body.expected_text)
    text = tools.validate_revision(paragraph["source"], body.text)
    settings = deps.get_settings()
    def action(cancel, progress, page_ready):
        result = tools.adopt_revision(lib, paper_id, body.unit_id, text, deps.provider_for(settings, cancel),
                                      cancel, progress, page_ready, body.expected_text)
        deps.paper_changed(paper_id)
        return result
    return deps.submit_job(JobKind.REVISION, action, paper_id)

@router.get("/api/papers/{paper_id}/citation-excerpts")
def citation_excerpts(paper_id: str, page: int):
    lib = deps.get_library()
    lib.paper_folder(paper_id)
    if not 1 <= page <= lib.paper(paper_id)["pages"]:
        raise Invalid("ページが範囲外です。")
    return {"text": lib.page_text(paper_id, page)[:6000]}

@router.post("/api/backup")
def backup(body: BackupRequest) -> JobStarted:
    lib = deps.get_library()
    def action(cancel, progress, _page_ready):
        try:
            deps.wait_for_library_requests(cancel=cancel)
            check_cancel(cancel)
            progress("ライブラリ全体をバックアップしています…")
            tools.create_backup(lib, Path(body.path), cancel)
        except Cancelled:
            raise Cancelled("バックアップを中止しました。") from None
        return {"path": body.path}
    return deps.submit_job(JobKind.BACKUP, action)

@router.post("/api/restore")
def restore(body: RestoreRequest) -> JobStarted:
    """Replace the library with a backup ZIP; the library as it was goes to this PC's history (history_restore)."""
    lib = deps.get_library()
    return start_restore(lib, "バックアップを復元できませんでした",
                         lambda cancel, progress: history_restore.restore_zip(
                             lib, Path(body.path), cancel, progress, import_settings=body.import_settings))


def start_restore(lib, failure: str, run) -> JobStarted:
    """A restore job (from a backup, or from this PC's history): run(cancel, progress) replaces the library."""
    def action(cancel, progress, _page_ready):
        try:
            deps.wait_for_library_requests(cancel=cancel)
            check_cancel(cancel)
            result = run(cancel, progress)
        except Cancelled:
            raise Cancelled("復元を中止しました。ライブラリは変更していません。") from None
        except (OSError, ValueError, sqlite3.DatabaseError, zipfile.BadZipFile) as exc:
            raise ValueError(f"{failure}：{exc}") from exc
        # The state restored may be older than what the sync folder holds: the next sync asks before publishing it.
        try:
            drive_sync.mark_restored(lib.root)
        except Exception as exc:  # noqa: BLE001 - the restore itself has succeeded; a missing mark must not report it as failed.
            print(f"警告: 復元後の同期確認の印を保存できませんでした: {exc!r}", file=sys.stderr)
        deps.library_changed()
        return {"previous_path": result["previous_path"]}
    return deps.submit_job(JobKind.RESTORE, action)
