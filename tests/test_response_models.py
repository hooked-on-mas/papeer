"""The response models (sidecar/schemas) describe the answers without changing them.

A response model drops the keys it does not name and answers 500 when a value has another type, so each
typed route is compared here with what its code produces: the same keys, values and nulls. What comes from
files an earlier Papeer wrote (a translation report, a preview) or from an AI service is passed on as it is
(Stored), even when it does not look as the schema says.
"""
from __future__ import annotations

from dataclasses import asdict
import json
from pathlib import Path
import shutil
import sqlite3
import time
from unittest.mock import patch

from fastapi.testclient import TestClient
import pytest

from papeer.core import reading_state
from papeer.core.library_list import library_rows, paper_row
from papeer.core.opened_papers import mark_opened
from papeer.core.paths import PaperFiles
from papeer.providers import specs
from sidecar import deps
from sidecar.app import app
from sidecar.schemas.papers import Paper, PaperRow

FIXTURE_PDF = Path(__file__).parent / "fixtures/sample.pdf"


def _as_json(value):
    """What an answer of `value` reads as, before any response model."""
    return json.loads(json.dumps(value, ensure_ascii=False))


def _wait(job_id: str):
    deadline = time.time() + 30
    while time.time() < deadline:
        job = deps.job_manager.get_job(job_id)
        if job and not job.running:
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


@pytest.fixture
def library(tmp_path, monkeypatch):
    """A client and a library with one imported paper."""
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("PAPEER_TOKEN", "")
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    client = TestClient(app)
    job = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"])
    assert job.status == "succeeded", job.error
    return client, deps.get_library(), job.result.paper_ids[0]


def test_paper_rows_keep_every_key(library):
    client, lib, paper_id = library
    # A row the list cannot work out a state for: its ID is not a folder's name (a hand-edited database).
    with sqlite3.connect(lib.root / "library.sqlite3") as db:
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status) VALUES('hand-edited','x','Hand','h.pdf',2,'翻訳済み')")
    rows = client.get("/api/papers").json()
    assert rows == _as_json(library_rows(lib))
    edited = next(row for row in rows if row["id"] == "hand-edited")
    assert "folder_path" not in edited and "translated_count" not in edited and edited["status"] == "translated"
    # The whole row is named by the model: a column added to the papers table fails here until it is.
    full = next(row for row in rows if row["id"] == paper_id)
    assert set(full) <= set(PaperRow.model_fields)
    assert {name for name, field in PaperRow.model_fields.items() if field.is_required()} <= set(edited)

    paper = client.get(f"/api/papers/{paper_id}").json()
    stored = lib.paper(paper_id)
    assert paper == _as_json(paper_row(lib, stored))
    assert set(paper) <= set(Paper.model_fields) and "note" not in full
    assert client.get("/api/papers", params={"query": "no such paper"}).json() == []



def test_opening_a_paper_answers_what_mark_opened_returns(library):
    client, lib, paper_id = library
    returned = []

    def recording(*args):
        returned.append(mark_opened(*args))
        return returned[-1]

    with patch("sidecar.routes.papers.mark_opened", side_effect=recording):
        first = client.post(f"/api/papers/{paper_id}/opened").json()
        second = client.post(f"/api/papers/{paper_id}/opened").json()
    # Unread at first: it starts reading, and read_status is among the fields; the second time only the time.
    assert [first, second] == _as_json(returned)
    assert first["started_reading"] is True and second["fields"] == ["last_opened_at"]

def test_the_reader_state_passes_stored_files_on(library, monkeypatch):
    client, lib, paper_id = library
    files = PaperFiles(lib.folder(paper_id))
    shutil.copyfile(files.original_pdf, files.translated_pdf)
    # A report of another version: keys the model does not name, and values of another shape.
    files.translation_report.write_text(json.dumps({
        "pages": 1, "translated_pages": [1], "skipped_pages": "not a list", "future": {"nested": [1, {"a": None}]},
        "readability_warnings": [{"page": 1, "unknown": True}], "usage": {"provider": "x"}}), "utf-8")
    files.translation_cache.write_text(json.dumps({"completed_pages": {"1": {"version": "k-sha256-0123456789", "model": "m"}}}),
                                       "utf-8")
    # Pages needing OCR as a newer extraction might describe them.
    monkeypatch.setattr("papeer.core.library_papers.cached_review_pages", lambda folder, count: {
        "required": [1], "ocr": [{"page": 1, "reason": "from-a-newer-version", "extra": 1}]})
    assert client.put("/api/ui-state", json={"reading_pages": {paper_id: 1}}).status_code == 200

    answer = client.get(f"/api/papers/{paper_id}/reading").json()
    assert answer == _as_json(reading_state.reading_state(lib, paper_id, 1))
    assert answer["report"]["future"] == {"nested": [1, {"a": None}]} and answer["report"]["skipped_pages"] == "not a list"
    assert answer["translated_pages"]["1"] == {"file": "translated.pdf", "index": 0,
                                               "mtime": int(files.translated_pdf.stat().st_mtime)}
    assert answer["page_versions"]["1"] == {"sha": "0123456", "model": "m"}
    assert answer["ocr_pages"] == [{"page": 1, "reason": "from-a-newer-version", "extra": 1}]

    # While translating: the preview (with keys the model does not name) and its page files.
    run = "a" * 32
    page = files.translation_pages / run / "page-1.pdf"
    page.parent.mkdir(parents=True)
    shutil.copyfile(files.original_pdf, page)
    files.translation_preview.write_text(json.dumps({
        "run_id": run, "complete": False, "pages": [1], "target_pages": [1], "total_pages": 1, "fingerprint": "f",
        "requested_pages": [1]}), "utf-8")
    answer = client.get(f"/api/papers/{paper_id}/reading").json()
    assert answer == _as_json(reading_state.reading_state(lib, paper_id, 1))
    assert answer["in_progress"] is True and answer["preview"]["fingerprint"] == "f"
    assert answer["translated_pages"]["1"]["file"] == f"translation-pages/{run}/page-1.pdf"

    # Nothing translated: no report, no preview.
    for path in (files.translation_report, files.translation_preview, files.translated_pdf):
        path.unlink()
    answer = client.get(f"/api/papers/{paper_id}/reading").json()
    assert answer == _as_json(reading_state.reading_state(lib, paper_id, 1))
    assert answer["report"] is None and answer["preview"] is None


def test_the_article_passes_its_usage_on(library):
    client, lib, paper_id = library
    files = PaperFiles(lib.folder(paper_id))
    files.article_md.write_text("# サマリー", "utf-8")
    assert client.get(f"/api/papers/{paper_id}/article").json() == {"content": "# サマリー", "usage": None}
    files.article_usage.write_text(json.dumps({"provider": "p", "calls": 1, "later": [1]}), "utf-8")
    assert client.get(f"/api/papers/{paper_id}/article").json() == {
        "content": "# サマリー", "usage": {"provider": "p", "calls": 1, "later": [1]}}


def test_sticky_notes_keep_every_key(library):
    client, lib, paper_id = library
    base = f"/api/papers/{paper_id}/sticky-notes"
    note = client.post(base, json={"page": 1, "side": "original", "quote": "引用", "note": "メモ", "anchor_y": 0.25})
    highlight = client.post(base, json={"page": 1, "side": "translated", "quote": "訳文", "kind": "highlight",
                                        "color": "green", "rects": [[0.1, 0.2, 0.3, 0.05]]})
    assert note.status_code == highlight.status_code == 200
    assert note.json() == _as_json(lib.bookmarks(paper_id)[0])
    assert highlight.json()["rects"] == [[0.1, 0.2, 0.3, 0.05]] and highlight.json()["anchor_x"] == 0
    edited = client.patch(f"{base}/{highlight.json()['id']}", json={"color": "pink"})
    assert edited.json() == _as_json(next(item for item in lib.bookmarks(paper_id) if item["id"] == highlight.json()["id"]))
    assert client.get(base).json() == _as_json(lib.bookmarks(paper_id))
    everything = client.get("/api/sticky-notes").json()
    assert everything == _as_json(lib.sticky_notes())
    assert {item["paper_title"] for item in everything} == {lib.paper(paper_id)["title"]}


def test_chat_messages_keep_their_keys(library):
    client, lib, paper_id = library
    usage = {"provider": "p", "model": "m", "calls": 1, "measured_calls": 1, "input_tokens": 3, "cached_tokens": 0,
             "output_tokens": 2, "reasoning_tokens": 0, "cost_usd": None, "later": True}
    lib.add_exchange(paper_id, "質問", "回答", usage=usage,
                     attachments=[{"page": 1, "side": "original", "text": "本文", "anchor_y": 0.5, "later": 1}])
    lib.add_exchange(paper_id, "次の質問", "次の回答")
    messages = client.get(f"/api/papers/{paper_id}/messages").json()
    assert messages == _as_json(lib.messages(paper_id, with_usage=True))
    # Only a question sent with passages has attachments; every message has its usage, null when none.
    assert ["attachments" in message for message in messages] == [True, False, False, False]
    assert [message["usage"] for message in messages] == [None, usage, None, None]


class _Connection:
    def __init__(self, limits):
        self.spec = specs()[0]
        self._limits = limits

    def limits(self):
        return self._limits


def test_plan_usage_is_passed_on_as_the_service_reports_it(library):
    client, _, _ = library
    limits = {"windows": [{"label": "5時間枠", "used_percent": 12.5, "resets_at": "2026-10-01T00:00:00Z", "later": 1}],
              "checked_at": 1.5}
    with patch.object(deps, "provider_for", lambda *args, **kwargs: _Connection(limits)):
        assert client.get("/api/usage/limits").json() == {**limits, "provider": specs()[0].id}
    with patch.object(deps, "provider_for", lambda *args, **kwargs: _Connection(None)):
        response = client.get("/api/usage/limits")
        assert response.status_code == 200 and response.json() is None


def test_connections_are_described_whole(library):
    client, _, _ = library
    assert client.get("/api/providers").json() == _as_json([asdict(spec) for spec in specs()])
