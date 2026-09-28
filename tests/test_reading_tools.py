from __future__ import annotations

import json
from pathlib import Path
import threading
import time
import zipfile

from fastapi.testclient import TestClient
import pymupdf as fitz
import pytest

from papeer.core.config import Settings
from papeer.core.exports import interleaved_cache
from papeer.core.paths import PaperFiles
from papeer.core.reading_tools import create_backup, draft_revision, restore_backup, library_search, translation_paragraphs
from papeer.core.terminology import effective_glossary, validate_revision, global_glossary, save_global_glossary
from papeer.core.service import PaperService
from papeer.core.storage import Library
from _legacy_library import mark_unversioned
from papeer.layout.math_layout import MATH_TOKEN
from sidecar.jobs import JobManager, ConcurrencyConflict

FIXTURE = Path(__file__).parent / "fixtures/sample.pdf"


class FakeProvider:
    def __init__(self, settings=None, cancel=None):
        self.settings = settings or Settings(translation_concurrency=1)
        self.calls = []

    def generate(self, instruction, data, schema=None):
        self.calls.append((instruction, json.loads(data)))
        units = json.loads(data)
        if isinstance(units, dict) and "blocks" in units:  # The first request of a batch.
            units = units["blocks"]
        if schema and "current" in units:
            return json.dumps({"text": "修正した日本語。" + " ".join(MATH_TOKEN.findall(units["source"]))})
        if schema:
            if isinstance(units, dict):
                units = units["texts"]
            return json.dumps({"translations": [{"id": u["id"], "text": "日本語訳。" + " ".join(MATH_TOKEN.findall(u["text"]))} for u in units]})
        return "回答。"


@pytest.fixture
def library(tmp_path):
    lib = Library(tmp_path / "data")
    identity, _ = lib.import_pdf(FIXTURE, "制御 / 読書会")
    return lib, identity


def test_tags_read_status_and_old_database_migration(library):
    lib, identity = library
    with lib.connection() as db:
        db.execute("ALTER TABLE papers DROP COLUMN tags")
        db.execute("ALTER TABLE papers DROP COLUMN read_status")
        mark_unversioned(db)  # as saved by a version before schema versioning
    lib = Library(lib.root)
    assert lib.paper(identity)["read_status"] == "未読"
    lib.update(identity, tags=[" 実装したい ", "研究/制御", "実装したい"], read_status="読書中")
    reopened = Library(lib.root)
    assert reopened.paper(identity)["tags"] == ["実装したい", "研究/制御"]
    assert reopened.papers("研究/制御")[0]["id"] == identity
    with pytest.raises(ValueError):
        lib.update(identity, read_status="不明")


def test_legacy_glossaries_migrate_once_and_survive_folder_deletion(library):
    lib, identity = library
    with lib.connection() as db:
        db.executemany("INSERT INTO collection_glossaries VALUES(?,?)", [
            ("制御", json.dumps([{"source": "control", "target": "制御"}, {"source": "delay", "target": "遅延"}])),
            ("制御 / 読書会", json.dumps([{"source": "Control", "target": "制御方式"}]))])
    (lib.folder(identity) / "glossary.json").write_text(json.dumps([{"source": "delay", "target": "むだ時間"}]))
    assert {t["source"].lower(): t["target"] for t in effective_glossary(lib, identity)} == {"control": "制御方式", "delay": "むだ時間"}
    lib.rename_collection("制御", "工学")
    assert len(effective_glossary(lib, identity)) == 2
    lib.delete_collection("工学")
    assert len(effective_glossary(lib, identity)) == 2
    save_global_glossary(lib.root, [])
    assert effective_glossary(Library(lib.root), identity) == []
    assert (lib.folder(identity) / "glossary.json").is_file()


def test_delete_tag_preserves_papers_notes_and_other_tags(library, tmp_path, monkeypatch):
    from sidecar import app as runtime
    lib, identity = library
    other_pdf = tmp_path / "other.pdf"
    other_pdf.write_bytes(FIXTURE.read_bytes() + b"\n% second paper\n")
    other_id, _ = lib.import_pdf(other_pdf)
    tag = "研究/制御 #1 & '引用'"
    lib.update(identity, tags=[tag, tag + "a", "残す"], note="大切な読書メモ", read_status="読了")
    lib.update(other_id, tags=[tag, "別のタグ"])
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    with TestClient(runtime.app) as client:
        response = client.delete("/api/tags", params={"name": tag})
        assert response.status_code == 200
        assert response.json() == {"affected": 2}
        assert tag not in client.get("/api/tags").json()
        assert client.delete("/api/tags", params={"name": tag}).json() == {"affected": 0}
        assert client.delete("/api/tags", params={"name": " "}).status_code == 400
        assert client.delete("/api/tags", params={"name": "x" * 81}).status_code == 422
        assert client.delete("/api/tags").status_code == 422
    assert lib.paper(identity)["tags"] == [tag + "a", "残す"]
    assert lib.paper(other_id)["tags"] == ["別のタグ"]
    assert lib.paper(identity)["note"] == "大切な読書メモ"
    assert lib.paper(identity)["read_status"] == "読了"
    assert (lib.folder(identity) / "note.md").read_text("utf-8") == "大切な読書メモ"
    assert (lib.folder(other_id) / "original.pdf").is_file()


def test_tag_choices_persist_without_papers_and_deleted_labels_stay_deleted(library, monkeypatch):
    from sidecar import app as runtime
    lib, identity = library
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    bookmark = lib.add_bookmark(identity, 1, "original", "引用", label="重要", note="残すメモ")
    with TestClient(runtime.app) as client:
        assert client.post("/api/tags", json={"name": " 未使用のタグ "}).status_code == 200
        assert client.post("/api/tags", json={"name": "未使用のタグ"}).status_code == 200
        assert client.get("/api/tags").json().count("未使用のタグ") == 1
        assert Library(lib.root).paper(identity)["tags"] == []
        lib.update(identity, tags=["取り外したタグ"])
        lib.update(identity, tags=[])
        assert "取り外したタグ" in client.get("/api/tags").json()
        assert client.delete("/api/tags", params={"name": "未使用のタグ"}).json() == {"affected": 0}
        assert "未使用のタグ" not in client.get("/api/tags").json()
        assert client.post("/api/sticky-labels", json={"name": "実験する"}).status_code == 200
        assert "実験する" in client.get("/api/sticky-labels").json()
        assert client.delete("/api/sticky-labels", params={"name": "重要"}).status_code == 200
        Library(lib.root)
        assert "重要" not in client.get("/api/sticky-labels").json()
        with lib.connection() as db:
            row = db.execute("SELECT label,note FROM bookmarks WHERE id=?", (bookmark["id"],)).fetchone()
            assert tuple(row) == ("重要", "残すメモ")
        for path in ("/api/tags", "/api/sticky-labels", "/api/reading-statuses"):
            assert client.post(path, json={"name": " "}).status_code == 400
        assert client.post("/api/sticky-labels", json={"name": "a" * 41}).status_code == 400


def test_reading_status_choices_can_be_deleted_and_restored(library, monkeypatch, tmp_path):
    from sidecar import app as runtime
    lib, identity = library
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    with TestClient(runtime.app) as client:
        defaults = ["未読", "読書中", "読了", "再読したい"]
        assert client.get("/api/reading-statuses").json() == defaults
        for name in defaults:
            assert client.delete("/api/reading-statuses", params={"name": name}).status_code == 200
        lib = Library(lib.root)
        assert client.get("/api/reading-statuses").json() == []
        assert lib.paper(identity)["read_status"] == "未読"
        other_pdf = tmp_path / "new-status.pdf"
        other_pdf.write_bytes(FIXTURE.read_bytes() + b"\n% new status\n")
        new_id, _ = lib.import_pdf(other_pdf)
        assert lib.paper(new_id)["read_status"] == ""
        with pytest.raises(ValueError):
            lib.update(new_id, read_status="読了")
        assert client.post("/api/reading-statuses", json={"name": "読了"}).status_code == 200
        lib.update(new_id, read_status="読了")
        assert lib.paper(new_id)["read_status"] == "読了"
        lib.update(new_id, read_status="")
        assert lib.paper(new_id)["read_status"] == ""


def test_delete_tag_requires_authentication(library, monkeypatch):
    from sidecar import app as runtime
    lib, identity = library
    lib.update(identity, tags=["残す"])
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_TOKEN", "test-secret")
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    with TestClient(runtime.app) as client:
        assert client.delete("/api/tags", params={"name": "残す"}).status_code == 401
        for path in ("/api/tags", "/api/sticky-labels", "/api/reading-statuses"):
            assert client.post(path, json={"name": "新しいタグ"}).status_code == 401
        assert client.delete("/api/sticky-labels", params={"name": "重要"}).status_code == 401
        assert client.delete("/api/reading-statuses", params={"name": "未読"}).status_code == 401
    assert lib.paper(identity)["tags"] == ["残す"]


def test_search_translation_note_and_literal_query(library):
    lib, identity = library
    lib.update(identity, note="次の実験で検証したい。", tags=["検証"])
    (lib.folder(identity) / "translation.md").write_text("# 翻訳\n\n## p.1 / b1\n\nむだ時間を考慮します。", encoding="utf-8")
    assert library_search(lib, "むだ時間")["results"][0]["side"] == "translated"
    assert library_search(lib, "検証")["results"][1]["side"] == "note"
    assert library_search(lib, "%' OR 1=1 --")["results"] == []


def test_revision_reuses_other_translations_and_updates_exports(library):
    lib, identity = library
    provider = FakeProvider()
    service = PaperService(lib, provider, threading.Event())
    service.translate(identity)
    paragraphs = translation_paragraphs(lib, identity)
    paragraph = paragraphs[0]
    calls = len(provider.calls)
    edited = "変更した日本語の段落。" + " ".join(MATH_TOKEN.findall(paragraph["source"]))
    service.translate(identity, set(paragraph["pages"]), replacements={paragraph["id"]: edited})
    assert len(provider.calls) == calls
    assert next(p for p in translation_paragraphs(lib, identity) if p["id"] == paragraph["id"])["text"] == edited
    assert "変更した日本語の段落" in (lib.folder(identity) / "translation.md").read_text("utf-8")
    with fitz.open(lib.folder(identity) / "translated.pdf") as pdf:
        assert "変更した日本語" in "".join(p.get_text() for p in pdf)
    # The paired PDF is built from the revised translation, not from a copy made before it.
    with fitz.open(interleaved_cache(PaperFiles(lib.folder(identity)))) as pdf:
        assert "変更した日本語" in "".join(p.get_text() for p in pdf)
    # Undoing reads the page records of the cache, not the page previews removed after each run.
    assert list((lib.folder(identity) / "translation-pages").rglob("*.pdf")) == []
    service.translate(identity, set(paragraph["pages"]), replacements={paragraph["id"]: paragraph["text"]})
    assert len(provider.calls) == calls
    assert next(p for p in translation_paragraphs(lib, identity) if p["id"] == paragraph["id"])["text"] == paragraph["text"]
    assert not (lib.folder(identity) / "interleaved.pdf").exists()


def test_glossary_changes_only_retranslate_affected_pages(tmp_path):
    source = tmp_path / "two.pdf"
    with fitz.open() as pdf:
        for text in ["Unique terminology alpha paragraph.", "Another independent beta paragraph."]:
            page = pdf.new_page()
            page.insert_text((72, 72), text)
        pdf.save(source)
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(source)
    provider = FakeProvider()
    service = PaperService(lib, provider, threading.Event())
    service.translate(identity)
    provider.calls.clear()
    save_global_glossary(lib.root, [{"source": "alpha", "target": "アルファ"}])
    report = service.translate(identity)
    assert report["already_translated_pages"] == [2]
    sent = [unit["text"] for _, values in provider.calls for unit in values.get("texts", values.get("blocks", []))]
    assert all("beta" not in text for text in sent)


def test_revision_preserves_math_token_multiplicity():
    token = "[[PD_MATH_b1_0]]"
    assert MATH_TOKEN.findall(token)
    with pytest.raises(ValueError):
        validate_revision("Source " + token, "訳文")
    with pytest.raises(ValueError):
        validate_revision(token, token + token)
    assert validate_revision(token, "訳文 " + token)


def test_backup_restore_keeps_current_data_and_rejects_bad_archive(library, tmp_path):
    lib, identity = library
    lib.update(identity, tags=["日本語"], read_status="読了", note="バックアップ時のメモ")
    with lib.connection() as db:
        db.execute("INSERT INTO note_templates VALUES('自分用', '## 結果')")
    backup = tmp_path / "snapshot.zip"
    create_backup(lib, backup)
    lib.update(identity, note="新しいメモ")
    previous = restore_backup(lib, backup)
    assert Library(lib.root).paper(identity)["note"] == "バックアップ時のメモ"
    assert Library(previous).paper(identity)["note"] == "新しいメモ"
    assert Library(lib.root).paper(identity)["tags"] == ["日本語"]
    invalid = tmp_path / "bad.zip"
    with zipfile.ZipFile(invalid, "w") as archive:
        archive.writestr("../outside.txt", "invalid")
    with pytest.raises(ValueError):
        restore_backup(Library(lib.root), invalid)
    assert not (tmp_path / "outside.txt").exists()
    assert Library(lib.root).paper(identity)["note"] == "バックアップ時のメモ"
    assert not list(tmp_path.glob("data-restore-*"))


def test_maintenance_jobs_exclude_other_jobs():
    manager = JobManager()
    gate = threading.Event()
    job = manager.submit_job("backup", lambda *_: gate.wait(2))
    try:
        with pytest.raises(ConcurrencyConflict):
            manager.submit_job("translate", lambda *_: None, paper_id="a" * 32)
    finally:
        gate.set()
    deadline = time.monotonic() + 3
    while job.running and time.monotonic() < deadline:
        time.sleep(.01)
    assert not job.running


def test_reading_api_templates_tags_search_and_revision(library, monkeypatch):
    from sidecar import app as runtime
    from sidecar import deps
    lib, identity = library
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    monkeypatch.setattr("sidecar.deps.create_provider", FakeProvider)
    PaperService(lib, FakeProvider(), threading.Event()).translate(identity)
    with TestClient(runtime.app) as client:
        assert client.patch(f"/api/papers/{identity}", json={"tags": ["自由なタグ"], "read_status": "読了"}).status_code == 200
        assert client.get("/api/tags").json() == ["自由なタグ"]
        assert client.put("/api/note-templates", json={"name": "実験", "content": "## 条件"}).status_code == 200
        assert len(client.get("/api/note-templates").json()) == 2
        assert client.get("/api/library-search", params={"q": "日本語訳"}).json()["results"]
        paragraph = client.get(f"/api/papers/{identity}/paragraphs").json()[0]
        assert client.post(f"/api/papers/{identity}/revision", json={"unit_id": paragraph["id"], "text": "修正", "expected_text": "stale"}).status_code == 409
        assert client.post(f"/api/papers/{identity}/revision-draft",
                           json={"unit_id": paragraph["id"], "char_budget": 0}).status_code == 422
        response = client.post(f"/api/papers/{identity}/revision-draft", json={"unit_id": paragraph["id"]})
        assert response.status_code == 200
        job = deps.job_manager.get_job(response.json()["job_id"])
        deadline = time.monotonic() + 10
        while job.running and time.monotonic() < deadline:
            time.sleep(.02)
        assert job.status == "succeeded", job.error
        assert "修正した" in job.result.text
        response = client.post(f"/api/papers/{identity}/revision", json={"unit_id": paragraph["id"], "text": job.result.text, "expected_text": paragraph["text"]})
        assert response.status_code == 200
        job = deps.job_manager.get_job(response.json()["job_id"])
        deadline = time.monotonic() + 10
        while job.running and time.monotonic() < deadline:
            time.sleep(.02)
        assert job.status == "succeeded", job.error
        assert client.get(f"/api/papers/{identity}/revisions").json()[0]["before"] == paragraph["text"]
        assert client.get(f"/api/papers/{identity}/citation-excerpts", params={"page": 1}).json()["text"]
        assert client.delete("/api/note-templates/実験").status_code == 200


def test_shorter_revision_draft_asks_for_the_estimated_length(library):
    lib, identity = library
    provider = FakeProvider()
    paragraph = {"source": "A long source paragraph.", "text": "長い訳文です。"}
    assert draft_revision(lib, identity, paragraph, "簡潔にしてください。", provider, threading.Event(), 120) == "修正した日本語。"
    instruction, payload = provider.calls[-1]
    assert payload["max_characters"] == 120
    assert "簡潔にしてください。" in instruction and "about 120 characters" in instruction
    draft_revision(lib, identity, paragraph, "自然な日本語にしてください。", provider, threading.Event())
    instruction, payload = provider.calls[-1]
    assert "max_characters" not in payload and "characters" not in instruction


@pytest.mark.parametrize("name", ["/outside.txt", "papers/../outside.txt", "C:/outside.txt", "papers\\outside.txt", "CON.txt", "papers/test. /file"])
def test_restore_rejects_windows_unsafe_paths(library, tmp_path, name):
    lib, identity = library
    invalid = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(invalid, "w") as archive:
        archive.writestr(name.replace("\\", "/"), "invalid")
    if "\\" in name:
        invalid.write_bytes(invalid.read_bytes().replace(name.replace("\\", "/").encode(), name.encode()))
    with pytest.raises(ValueError):
        restore_backup(lib, invalid)
    assert lib.paper(identity)["id"] == identity


def test_snapshot_api_and_write_guard(library, tmp_path, monkeypatch):
    from sidecar import app as runtime
    from sidecar import deps
    lib, identity = library
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    def wait(job_id):
        job = deps.job_manager.get_job(job_id)
        deadline = time.monotonic() + 10
        while job.running and time.monotonic() < deadline:
            time.sleep(.02)
        assert job.status == "succeeded", job.error
        return job
    with TestClient(runtime.app) as client:
        gate = threading.Event()
        active = deps.job_manager.submit_job("backup", lambda *_: {"path": str(tmp_path / "held.zip")} if gate.wait(3) else None)
        try:
            assert client.put("/api/prompts", json={"chat_answer": "changed"}).status_code == 409
            assert client.patch(f"/api/papers/{identity}", json={"note": "changed"}).status_code == 409
            assert client.get("/api/jobs").status_code == 200
        finally:
            gate.set()
        wait(active.job_id)
        backup = tmp_path / "api.zip"
        response = client.post("/api/backup", json={"path": str(backup)})
        assert response.status_code == 200
        wait(response.json()["job_id"])
        assert backup.is_file()
        lib.update(identity, note="復元前のメモ")
        response = client.post("/api/restore", json={"path": str(backup)})
        assert response.status_code == 200
        job = wait(response.json()["job_id"])
        assert Library(Path(job.result.previous_path)).paper(identity)["note"] == "復元前のメモ"
        assert client.get(f"/api/papers/{identity}").json()["note"] == ""


def test_chat_explicit_reference_pages(library):
    lib, identity = library
    provider = FakeProvider()
    result = PaperService(lib, provider, threading.Event()).ask(identity, "実験の条件は？", reference_pages={1})
    request = provider.calls[-1][1]
    assert f"[{identity}:p1]" in request["evidence"]
    assert f"papeer://{identity}/1" in result
    with pytest.raises(ValueError):
        PaperService(lib, provider, threading.Event()).ask(identity, "条件は？", reference_pages={999})


def test_ai_glossary_draft_is_reviewed_before_saving(library, monkeypatch):
    from sidecar import app as runtime
    from sidecar import deps
    lib, identity = library
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    with lib.connection() as db:
        db.execute("UPDATE pages SET text=? WHERE paper_id=?",
                   ("Adaptive control improves tracking error.", identity))
    existing = [{"source": "Adaptive control", "target": "修正済みの訳"}]
    calls = []

    class GlossaryProvider:
        def __init__(self, settings, cancel):
            assert settings.model == "draft-model"
            assert settings.reasoning_effort == "low"

        def generate(self, instruction, data, schema):
            calls.append(json.loads(data))
            return json.dumps({"terms": [
                {"source": "adaptive control", "target": "上書きしない"},
                {"source": "tracking error", "target": "追従誤差"},
                {"source": "invented term", "target": "原文にない用語"}]})

    monkeypatch.setattr("sidecar.deps.create_provider", GlossaryProvider)
    with TestClient(runtime.app) as client:
        base = f"/api/papers/{identity}"
        assert client.put("/api/glossary", json={"terms": existing, "expected_terms": []}).status_code == 200
        response = client.post(base + "/glossary-draft", json={
            "terms": existing, "model": "draft-model", "effort": "low"})
        assert response.status_code == 200
        job = deps.job_manager.get_job(response.json()["job_id"])
        deadline = time.monotonic() + 10
        while job.running and time.monotonic() < deadline:
            time.sleep(0.01)
        assert job.status == "succeeded"
        terms = job.result.model_dump()["terms"]
        assert terms == [{"source": "tracking error", "target": "追従誤差"}]
        assert calls[0]["existing_terms"] == existing
        assert client.get("/api/glossary").json() == existing
        assert client.put("/api/glossary", json={"terms": existing + terms,
                                                 "expected_terms": existing}).status_code == 200
        assert len(client.get("/api/glossary").json()) == 2
        assert client.post(base + "/glossary-draft", json={"terms": existing * 2}).status_code == 400


def test_ai_glossary_failure_and_cancel_leave_dictionary_untouched(library):
    from papeer.core.reading_tools import draft_glossary
    from papeer.providers import Cancelled
    lib, identity = library
    path = lib.folder(identity) / "glossary.json"
    path.write_text("[]", encoding="utf-8")

    class InvalidProvider:
        def generate(self, *args):
            return '{"terms": [{"source": 123, "target": "invalid"}]}'

    with pytest.raises(ValueError, match="有効な翻訳対応表"):
        draft_glossary(lib, identity, InvalidProvider(), threading.Event(), lambda _: None, [])
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        draft_glossary(lib, identity, InvalidProvider(), cancel, lambda _: None, [])
    assert path.read_text("utf-8") == "[]"


def test_global_glossary_applies_to_unrelated_papers_and_checks_stale_edits(library, tmp_path, monkeypatch):
    from sidecar import app as runtime
    lib, identity = library
    other = tmp_path / "other.pdf"
    other.write_bytes(FIXTURE.read_bytes() + b"\n% other paper\n")
    other_id, _ = lib.import_pdf(other, "unrelated")
    monkeypatch.setenv("PAPEER_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    terms = [{"source": f"term {i}", "target": f"訳語 {i}"} for i in range(250)]
    with TestClient(runtime.app) as client:
        assert client.get("/api/glossary").json() == []
        assert client.put("/api/glossary", json={"terms": terms, "expected_terms": []}).status_code == 200
        assert effective_glossary(lib, identity) == terms
        assert effective_glossary(lib, other_id) == terms
        assert client.put("/api/glossary", json={"terms": [], "expected_terms": []}).status_code == 409
        assert client.get("/api/glossary").json() == terms
        assert client.put("/api/glossary", json={"terms": terms * 2, "expected_terms": terms}).status_code == 400
        assert client.put("/api/glossary", json={"terms": [], "expected_terms": terms}).status_code == 200
        assert effective_glossary(lib, other_id) == []
    monkeypatch.setenv("PAPEER_TOKEN", "secret")
    with TestClient(runtime.app) as client:
        assert client.get("/api/glossary").status_code == 401
        assert client.put("/api/glossary", json={"terms": [], "expected_terms": []}).status_code == 401


def test_global_glossary_survives_backup_restore(library, tmp_path):
    lib, _ = library
    terms = [{"source": "control", "target": "制御"}]
    save_global_glossary(lib.root, terms)
    backup = tmp_path / "global.zip"
    create_backup(lib, backup)
    save_global_glossary(lib.root, [])
    restore_backup(lib, backup)
    assert global_glossary(lib.root) == terms


def test_glossary_draft_can_extend_large_global_dictionary(library):
    from papeer.core.reading_tools import draft_glossary
    lib, identity = library
    terms = [{"source": f"unrelated {i}", "target": f"訳語 {i}"} for i in range(250)]
    terms.append({"source": "control", "target": "制御"})
    save_global_glossary(lib.root, terms)
    with lib.connection() as db:
        db.execute("UPDATE pages SET text=? WHERE paper_id=?", ("control and tracking error", identity))

    class DraftProvider:
        def generate(self, instruction, data, schema):
            assert json.loads(data)["existing_terms"] == [{"source": "control", "target": "制御"}]
            return json.dumps({"terms": [{"source": "CONTROL", "target": "変更しない"},
                                        {"source": "tracking error", "target": "追従誤差"}]})

    result = draft_glossary(lib, identity, DraftProvider(), threading.Event(), lambda _: None, terms)
    assert result == {"terms": [{"source": "tracking error", "target": "追従誤差"}]}
    assert global_glossary(lib.root) == terms


def test_backup_is_never_written_inside_the_library(library):
    lib, _ = library
    long_form = Path("\\\\?\\" + str(lib.root.resolve()))
    for inside in (lib.root / "backup.zip", lib.root / "papers" / "backup.zip", long_form / "backup.zip"):
        with pytest.raises(ValueError, match="データ保存フォルダーの外"):
            create_backup(lib, inside)
    assert not list(lib.root.rglob("backup.zip"))


def test_choices_templates_and_revisions_without_the_routes(library):
    from papeer.core import reading_tools as tools
    from papeer.core.errors import Conflict, Invalid, NotFound

    lib, identity = library
    lib.update(identity, tags=["制御", "Beta"])
    lib.add_tag_choice("paper", "alpha")
    assert tools.all_tags(lib) == ["alpha", "Beta", "制御"]
    assert tools.choice_name("paper", "  読了 ") == "読了"
    assert tools.choice_name("paper", "x" * 41) == "x" * 41
    for kind, value in (("status", "  "), ("sticky", "x" * 41)):
        with pytest.raises(Invalid):
            tools.choice_name(kind, value)
    tools.add_choice(lib, "status", "精読中")
    tools.add_choice(lib, "sticky", "要再読")
    assert lib.reading_statuses()[-1] == "精読中" and lib.tag_choices("sticky")[-1] == "要再読"

    assert tools.note_templates(lib) == [{"name": "読書メモ", "content": tools.DEFAULT_TEMPLATE, "builtin": True}]
    assert tools.template_name(" 実験メモ ", "## 条件") == "実験メモ"
    for name, content in (("読書メモ", "本文"), (" ", "本文"), ("実験メモ", "  ")):
        with pytest.raises(Invalid):
            tools.template_name(name, content)
    lib.save_note_template("実験メモ", "## 条件")
    assert tools.note_templates(lib)[1:] == [{"name": "実験メモ", "content": "## 条件", "builtin": False}]

    provider = FakeProvider()
    PaperService(lib, provider, threading.Event()).translate(identity)
    paragraph = translation_paragraphs(lib, identity)[0]
    with pytest.raises(NotFound):
        tools.find_paragraph(lib, "0" * 32, paragraph["id"])
    with pytest.raises(Invalid):
        tools.find_paragraph(lib, identity, "missing")
    with pytest.raises(Conflict):
        tools.find_paragraph(lib, identity, paragraph["id"], "別の画面で変えた訳文")
    assert tools.find_paragraph(lib, identity, paragraph["id"], paragraph["text"]) == paragraph

    edited = validate_revision(paragraph["source"], "採用した日本語の段落。" + " ".join(MATH_TOKEN.findall(paragraph["source"])))
    calls = len(provider.calls)
    result = tools.adopt_revision(lib, identity, paragraph["id"], edited, provider, threading.Event(),
                                  lambda _: None, lambda *_: None, paragraph["text"])
    assert not result.get("skipped_pages") and len(provider.calls) == calls
    assert tools.find_paragraph(lib, identity, paragraph["id"])["text"] == edited
    history = tools.revision_history(lib.folder(identity))
    assert [(item["unit_id"], item["before"], item["after"]) for item in history] == [(paragraph["id"], paragraph["text"], edited)]
    # Adopting over the text the user no longer sees is refused, and nothing is recorded.
    with pytest.raises(Conflict):
        tools.adopt_revision(lib, identity, paragraph["id"], edited, provider, threading.Event(),
                             lambda _: None, lambda *_: None, paragraph["text"])
    assert len(tools.revision_history(lib.folder(identity))) == 1
