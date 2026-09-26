from __future__ import annotations

import json
from pathlib import Path
import threading
import time
import zipfile

from fastapi.testclient import TestClient
import pymupdf as fitz
import pytest

from paperdesk.core.config import Settings
from paperdesk.core.reading_tools import library_search
from paperdesk.core.service import PaperService
from paperdesk.core.storage import Library
from paperdesk.layout.math_layout import MATH_TOKEN
from sidecar.jobs import JobManager, ConcurrencyConflict

FIXTURE = Path(__file__).parent / "fixtures/sample.pdf"


class FakeProvider:
    def __init__(self, settings=None, cancel=None):
        self.settings = settings or Settings(translation_concurrency=1)
        self.calls = []

    def generate(self, instruction, data, schema=None):
        self.calls.append((instruction, json.loads(data)))
        units = json.loads(data)
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
    lib = Library(lib.root)
    assert lib.paper(identity)["read_status"] == "未読"
    lib.update(identity, tags=[" 実装したい ", "研究/制御", "実装したい"], read_status="読書中")
    reopened = Library(lib.root)
    assert reopened.paper(identity)["tags"] == ["実装したい", "研究/制御"]
    assert reopened.papers("研究/制御")[0]["id"] == identity
    with pytest.raises(ValueError):
        lib.update(identity, read_status="不明")


def test_delete_tag_preserves_papers_notes_and_other_tags(library, tmp_path, monkeypatch):
    from sidecar import app as runtime
    lib, identity = library
    other_pdf = tmp_path / "other.pdf"
    other_pdf.write_bytes(FIXTURE.read_bytes() + b"\n% second paper\n")
    other_id, _ = lib.import_pdf(other_pdf)
    tag = "研究/制御 #1 & '引用'"
    lib.update(identity, tags=[tag, tag + "a", "残す"], note="大切な読書メモ", read_status="読了")
    lib.update(other_id, tags=[tag, "別のタグ"])
    monkeypatch.setenv("PAPERDESK_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPERDESK_TOKEN", "")
    monkeypatch.setattr(runtime, "job_manager", JobManager())
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
    monkeypatch.setenv("PAPERDESK_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPERDESK_TOKEN", "")
    monkeypatch.setattr(runtime, "job_manager", JobManager())
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
    monkeypatch.setenv("PAPERDESK_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPERDESK_TOKEN", "")
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
    monkeypatch.setenv("PAPERDESK_DATA_DIR", str(lib.root))
    monkeypatch.setenv("PAPERDESK_TOKEN", "test-secret")
    monkeypatch.setattr(runtime, "job_manager", JobManager())
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


def test_chat_explicit_reference_pages(library):
    lib, identity = library
    provider = FakeProvider()
    result = PaperService(lib, provider, threading.Event()).ask(identity, "実験の条件は？", reference_pages={1})
    request = provider.calls[-1][1]
    assert f"[{identity}:p1]" in request["evidence"]
    assert f"paperdesk://{identity}/1" in result
    with pytest.raises(ValueError):
        PaperService(lib, provider, threading.Event()).ask(identity, "条件は？", reference_pages={999})
