from __future__ import annotations

import json
from pathlib import Path
import re
import tempfile
import time
from unittest.mock import patch

from fastapi.testclient import TestClient
import pytest

from paperdesk.core.config import Settings
from paperdesk.core.providers import Cancelled
from paperdesk.layout.math_layout import MATH_TOKEN
from sidecar.app import app, job_manager

FIXTURE_PDF = Path(__file__).parent / "fixtures/sample.pdf"


class FakeProvider:
    def __init__(self, settings=None, cancel=None, api_key=None):
        self.settings = settings or Settings()
        self.calls = 0
        self.cancel = cancel
        self.interrupt_after = None

    def generate(self, instruction, data, schema=None):
        self.calls += 1
        if self.interrupt_after == self.calls:
            raise Cancelled("test interruption")
        if schema:
            units = json.loads(data)
            if isinstance(units, dict) and "source_parts" in units:
                return json.dumps({
                    "parts": [
                        dict(part) if part["kind"] == "math" else {"kind": "text", "text": "適応制御の検証結果。追従誤差を18%削減した。"}
                        for part in units["source_parts"]
                    ]
                }, ensure_ascii=False)
            if isinstance(units, dict) and "texts" in units:
                units = units["texts"]
            return json.dumps({
                "translations": [
                    {"id": x["id"], "text": "適応制御の検証結果。追従誤差を18%削減した。" + " ".join(MATH_TOKEN.findall(x["text"]))}
                    for x in units
                ]
            }, ensure_ascii=False)
        if "keywords" in instruction:
            return "adaptive controller tracking error limitations"
        if "research notes" in instruction:
            citation = re.search(r"\[[0-9a-f]{32}:p\d+\]", data)
            return "適応制御の論文です。 " + (citation[0] if citation else "")
        if "previous_dialogue" in data:
            payload = json.loads(data)
            citation = re.search(r"\[[0-9a-f]{32}:p\d+\]", payload["evidence"])
            return "追従誤差は0.82です。 " + (citation[0] if citation else "")
        return "# サマリー\n\n" + data


@pytest.fixture
def test_env():
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        with patch.dict("os.environ", {"PAPERDESK_DATA_DIR": str(tmp_path), "PAPERDESK_TOKEN": ""}):
            client = TestClient(app)
            yield client, tmp_path


def test_health(test_env):
    client, _ = test_env
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "version" in data
    assert "code_version" in data


def test_auth_token():
    with tempfile.TemporaryDirectory() as tmp_dir:
        with patch.dict("os.environ", {"PAPERDESK_DATA_DIR": str(tmp_dir), "PAPERDESK_TOKEN": "secret-token-123"}):
            client = TestClient(app)
            # Without token
            resp = client.get("/api/settings")
            assert resp.status_code == 401

            # With invalid token
            resp = client.get("/api/settings", headers={"Authorization": "Bearer wrong"})
            assert resp.status_code == 401

            # With valid token
            resp = client.get("/api/settings", headers={"Authorization": "Bearer secret-token-123"})
            assert resp.status_code == 200

            # <img> tags pass the token as a query parameter instead of a header.
            assert client.get("/api/settings?token=secret-token-123").status_code == 200
            assert client.get("/api/settings?token=wrong").status_code == 401


def test_ui_state_crud(test_env):
    client, _ = test_env
    # Read initial
    resp = client.get("/api/ui-state")
    assert resp.status_code == 200
    state = resp.json()
    assert "reading_pages" in state

    # Update
    state["last_paper"] = "test-paper-1"
    state["reading_pages"]["test-paper-1"] = 3
    state["sort"] = 2
    put_resp = client.put("/api/ui-state", json=state)
    assert put_resp.status_code == 200

    # Read again
    resp2 = client.get("/api/ui-state")
    assert resp2.status_code == 200
    assert resp2.json()["last_paper"] == "test-paper-1"
    assert resp2.json()["reading_pages"]["test-paper-1"] == 3
    assert resp2.json()["sort"] == 2


def test_collections_crud(test_env):
    client, _ = test_env
    # Create collection
    create_resp = client.post("/api/collections", json={"name": "Machine Learning"})
    assert create_resp.status_code == 200

    # List collections
    list_resp = client.get("/api/collections")
    assert list_resp.status_code == 200
    colls = list_resp.json()
    assert any(c == "Machine Learning" for c in colls)

    # Rename collection
    rename_resp = client.patch(
        "/api/collections/rename",
        json={"old_name": "Machine Learning", "new_name": "AI & ML"},
    )
    assert rename_resp.status_code == 200

    # Delete collection
    del_resp = client.delete("/api/collections/AI & ML")
    assert del_resp.status_code == 200


def test_import_and_file_range_stream(test_env):
    client, _ = test_env
    assert FIXTURE_PDF.is_file()

    # Import paper
    import_resp = client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]})
    assert import_resp.status_code == 200
    job_id = import_resp.json()["job_id"]

    # Wait for import job to finish
    deadline = time.time() + 10
    while time.time() < deadline:
        job = job_manager.get_job(job_id)
        if job and not job.running:
            break
        time.sleep(0.1)

    assert job and not job.running and job.result

    # List papers
    papers = client.get("/api/papers").json()
    assert len(papers) == 1
    paper_id = papers[0]["id"]

    # Reading info
    reading = client.get(f"/api/papers/{paper_id}/reading").json()
    assert reading["page_count"] > 0

    # Range request test (bytes=0-99)
    range_resp = client.get(
        f"/api/papers/{paper_id}/files/original.pdf",
        headers={"Range": "bytes=0-99"},
    )
    assert range_resp.status_code == 206
    assert len(range_resp.content) == 100
    assert range_resp.headers.get("Content-Range") == f"bytes 0-99/{FIXTURE_PDF.stat().st_size}"
    assert range_resp.headers.get("Accept-Ranges") == "bytes"
    etag = range_resp.headers.get("ETag")
    assert etag is not None

    # Test 304 Not Modified
    cond_resp = client.get(
        f"/api/papers/{paper_id}/files/original.pdf",
        headers={"If-None-Match": etag},
    )
    assert cond_resp.status_code == 304

    # Test full file
    full_resp = client.get(f"/api/papers/{paper_id}/files/original.pdf")
    assert full_resp.status_code == 200
    assert len(full_resp.content) == FIXTURE_PDF.stat().st_size


def test_concurrency_conflict(test_env):
    client, _ = test_env

    def slow_action(cancel, progress, page_ready):
        time.sleep(1.0)

    job = job_manager.submit_job("check", slow_action, paper_id=None)
    assert job.running

    # Try to submit another global job -> should conflict (409)
    resp = client.post("/api/providers/check")
    assert resp.status_code == 409

    # Wait for completion
    time.sleep(1.1)


def test_translate_ask_export_workflow(test_env):
    client, tmp_dir = test_env

    # 1. Import
    import_resp = client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]})
    job_id = import_resp.json()["job_id"]
    while True:
        job = job_manager.get_job(job_id)
        if job and not job.running:
            break
        time.sleep(0.05)

    paper_id = client.get("/api/papers").json()[0]["id"]

    # 2. Translate with FakeProvider
    with patch("sidecar.app.Provider", FakeProvider):
        tr_resp = client.post(f"/api/papers/{paper_id}/translate", json={"pages": "1"})
        assert tr_resp.status_code == 200
        tr_job_id = tr_resp.json()["job_id"]
        while True:
            job = job_manager.get_job(tr_job_id)
            if job and not job.running:
                break
            time.sleep(0.05)
        assert job.status != "failed"

    # Reading info after translation
    reading = client.get(f"/api/papers/{paper_id}/reading").json()
    assert 1 in reading["completed_pages"]
    assert reading["has_translated"] is True

    # Check translated.pdf streaming
    tr_pdf_resp = client.get(f"/api/papers/{paper_id}/files/translated.pdf")
    assert tr_pdf_resp.status_code == 200
    assert len(tr_pdf_resp.content) > 0

    # 3. Ask question
    with patch("sidecar.app.Provider", FakeProvider):
        ask_resp = client.post(f"/api/papers/{paper_id}/ask", json={"question": "追従誤差はいくつですか？"})
        assert ask_resp.status_code == 200
        ask_job_id = ask_resp.json()["job_id"]
        while True:
            job = job_manager.get_job(ask_job_id)
            if job and not job.running:
                break
            time.sleep(0.05)
        assert job.result is not None
        assert "paperdesk://" in job.result  # Citation link!

    # Messages
    msgs = client.get(f"/api/papers/{paper_id}/messages").json()
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"] == "追従誤差はいくつですか？"
    assert msgs[1]["role"] == "assistant"

    # 4. Export translated PDF
    export_dest = tmp_dir / "exported_translated.pdf"
    exp_resp = client.post(
        f"/api/papers/{paper_id}/export",
        json={"kind": "translated", "destination": str(export_dest)},
    )
    assert exp_resp.status_code == 200
    assert export_dest.is_file()
    assert export_dest.stat().st_size > 0


def _wait(job_id):
    deadline = time.time() + 30
    while time.time() < deadline:
        job = job_manager.get_job(job_id)
        if job and not job.running:
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_collection_rules_match_old_library(test_env):
    client, _ = test_env
    assert client.post("/api/collections", json={"name": "制御工学/読書会"}).json()["name"] == "制御工学 / 読書会"
    # Duplicates were rejected by the old folder dialog.
    assert client.post("/api/collections", json={"name": "制御工学 / 読書会"}).status_code == 400
    assert client.get("/api/collections").json() == ["制御工学", "制御工学 / 読書会"]

    # new_name is the last segment; renaming keeps the parent.
    renamed = client.patch("/api/collections/rename", json={"old_name": "制御工学 / 読書会", "new_name": "輪講"})
    assert renamed.json()["name"] == "制御工学 / 輪講"

    job = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)], "collection": "制御工学 / 輪講"}).json()["job_id"])
    assert job.result["added"] == 1
    paper_id = job.result["paper_ids"][0]

    deleted = client.delete("/api/collections/制御工学")
    assert deleted.json()["moved"] == [paper_id]
    assert client.get(f"/api/papers/{paper_id}").json()["collection_name"] == ""
    assert client.delete("/api/collections/存在しない").status_code == 400

    # Importing the same PDF again opens the existing paper instead of adding one.
    again = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"])
    assert again.result == {"paper_ids": [paper_id], "added": 0}


def test_import_announces_page_counts_before_each_paper(test_env):
    client, tmp_dir = test_env
    events = []
    with patch.object(job_manager, "broadcast", side_effect=events.append):
        job = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"])
    pages = client.get(f"/api/papers/{job.result['paper_ids'][0]}").json()["pages"]
    imports = [e for e in events if e["type"].startswith("import.")]
    # The library shows placeholder rows keyed by the path as sent, so both events echo it back.
    assert imports == [
        {"type": "import.pages", "pages": {str(FIXTURE_PDF): pages}},
        {"type": "import.item", "path": str(FIXTURE_PDF), "paper_id": job.result["paper_ids"][0]},
    ]


def test_imports_requested_together_run_in_turn(test_env):
    client, _ = test_env
    # Without queueing, both jobs could pass the duplicate check and the second would fail
    # on the UNIQUE sha256 column.
    first = client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"]
    second = client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"]
    first, second = _wait(first), _wait(second)
    assert (first.status, second.status) == ("succeeded", "succeeded")
    assert first.result["added"] == 1
    assert second.result == {"paper_ids": first.result["paper_ids"], "added": 0}


def test_paper_metadata_reading_and_export_guards(test_env):
    client, tmp_dir = test_env
    job = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"])
    paper_id = job.result["paper_ids"][0]

    assert client.patch(f"/api/papers/{paper_id}", json={"year": "2024", "author": "Smith"}).status_code == 200
    assert client.patch(f"/api/papers/{paper_id}", json={"year": ""}).status_code == 200
    assert client.patch(f"/api/papers/{paper_id}", json={"year": "24"}).status_code == 400
    assert client.patch(f"/api/papers/{paper_id}", json={"title": "  "}).status_code == 400
    assert client.get("/api/papers/not-a-paper").status_code == 404

    renamed = client.post(f"/api/papers/{paper_id}/rename", json={"new_title": "renamed"})
    assert renamed.json()["name"] == "renamed.pdf"

    reading = client.get(f"/api/papers/{paper_id}/reading").json()
    assert reading["translated_pages"]["1"] is None  # nothing translated yet
    assert reading["empty_pages"] == []
    assert reading["in_progress"] is False
    assert client.get(f"/api/papers/{paper_id}/translation-text/1").json() == {"blocks": []}

    # Untranslated papers cannot be exported, and library files are never overwritten.
    blocked = client.post(f"/api/papers/{paper_id}/export", json={"kind": "translated", "destination": str(tmp_dir / "x.pdf")})
    assert blocked.status_code == 400
    folder = Path(client.get(f"/api/papers/{paper_id}").json()["folder_path"])
    same = client.post(f"/api/papers/{paper_id}/export", json={"kind": "original", "destination": str(folder / "original.pdf")})
    assert same.status_code == 400

    with patch("sidecar.app.Provider", FakeProvider):
        _wait(client.post(f"/api/papers/{paper_id}/translate", json={"pages": "1"}).json()["job_id"])
    reading = client.get(f"/api/papers/{paper_id}/reading").json()
    assert reading["translated_pages"]["1"]["file"] == "translated.pdf"
    assert reading["translated_pages"]["1"]["index"] == 0
    assert reading["page_versions"]["1"]["sha"]
    # Text for copying from the translated page; inline math tokens are restored as text.
    blocks = client.get(f"/api/papers/{paper_id}/translation-text/1").json()["blocks"]
    assert any("適応制御の検証結果" in block for block in blocks)
    assert not any(MATH_TOKEN.search(block) for block in blocks)
    assert client.get(f"/api/papers/{paper_id}/translation-text/99").json() == {"blocks": []}

    # Paired PDFs run as paper jobs; interleaved.pdf is rebuilt for external viewers.
    started = client.post(f"/api/papers/{paper_id}/export", json={"kind": "bilingual", "destination": str(tmp_dir / "b.pdf")})
    assert _wait(started.json()["job_id"]).status == "succeeded"
    assert (tmp_dir / "b.pdf").is_file()
    prepared = _wait(client.post(f"/api/papers/{paper_id}/interleaved").json()["job_id"])
    assert Path(prepared.result["path"]).is_file()


def test_prompts_customize_and_reset(test_env):
    client, _ = test_env
    defaults = client.get("/api/prompts/defaults").json()
    assert "translation" in defaults
    assert client.get("/api/prompts").json() == defaults

    client.put("/api/prompts", json={"translation": "custom instruction"})
    assert client.get("/api/prompts").json()["translation"] == "custom instruction"
    assert client.get("/api/prompts/defaults").json()["translation"] == defaults["translation"]

    client.put("/api/prompts", json={"translation": ""})
    assert client.get("/api/prompts").json()["translation"] == defaults["translation"]
