from __future__ import annotations

import json
from pathlib import Path
import re
import tempfile
import time
from unittest.mock import patch

from fastapi.routing import iter_route_contexts
from fastapi.testclient import TestClient
import pymupdf as fitz
import pytest

from papeer.core.config import Settings
from papeer.providers import Cancelled
from papeer.layout.math_layout import MATH_TOKEN
from sidecar.app import app
from sidecar.deps import job_manager

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
            if isinstance(units, dict) and "blocks" in units:  # The first request of a batch.
                units = units["blocks"]
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
        with patch.dict("os.environ", {"PAPEER_DATA_DIR": str(tmp_path), "PAPEER_TOKEN": "", "PAPEER_DEV_NO_AUTH": "1"}):
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
        with patch.dict("os.environ", {"PAPEER_DATA_DIR": str(tmp_dir), "PAPEER_TOKEN": "secret-token-123"}):
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
    state["reading_anchors"] = {"test-paper-1": 0.375}
    put_resp = client.put("/api/ui-state", json=state)
    assert put_resp.status_code == 200

    # Read again
    resp2 = client.get("/api/ui-state")
    assert resp2.status_code == 200
    assert resp2.json()["last_paper"] == "test-paper-1"
    assert resp2.json()["reading_pages"]["test-paper-1"] == 3
    assert resp2.json()["sort"] == 2
    assert resp2.json()["reading_anchors"] == {"test-paper-1": 0.375}


def test_ui_state_drops_anchors_that_are_not_fractions_of_a_page(test_env):
    """A hand-edited ui-state.json must not fail the response, which the frontend would retry for ever."""
    client, data_dir = test_env
    (data_dir / "ui-state.json").write_text(json.dumps({
        "reading_pages": {"a": 1},
        "reading_anchors": {"a": 0.5, "b": "x", "c": 0, "d": 1.5, "e": True, "f": None, "g": 1, "h": [0.3]},
    }), "utf-8")
    resp = client.get("/api/ui-state")
    assert resp.status_code == 200
    assert resp.json()["reading_anchors"] == {"a": 0.5, "g": 1.0}
    # Not a mapping at all.
    (data_dir / "ui-state.json").write_text(json.dumps({"reading_anchors": [0.5]}), "utf-8")
    assert client.get("/api/ui-state").json()["reading_anchors"] == {}


def test_ui_state_without_anchors_reads_as_empty(test_env):
    """A ui-state.json written before reading_anchors existed, and a client that doesn't send them."""
    client, _ = test_env
    assert client.put("/api/ui-state", json={"reading_pages": {"p": 2}, "last_paper": "p"}).status_code == 200
    state = client.get("/api/ui-state").json()
    assert state["reading_pages"] == {"p": 2}
    assert state["reading_anchors"] == {}


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


def test_translate_ask_export_workflow(test_env, tmp_path):
    client, _ = test_env

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
    with patch("sidecar.deps.create_provider", FakeProvider):
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
    with patch("sidecar.deps.create_provider", FakeProvider):
        ask_resp = client.post(f"/api/papers/{paper_id}/ask", json={"question": "追従誤差はいくつですか？"})
        assert ask_resp.status_code == 200
        ask_job_id = ask_resp.json()["job_id"]
        while True:
            job = job_manager.get_job(ask_job_id)
            if job and not job.running:
                break
            time.sleep(0.05)
        assert job.result is not None
        assert "papeer://" in job.result.answer  # Citation link!

    # Messages
    msgs = client.get(f"/api/papers/{paper_id}/messages").json()
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
    assert msgs[0]["content"] == "追従誤差はいくつですか？"
    assert msgs[1]["role"] == "assistant"

    # 4. Export translated PDF
    export_dest = tmp_path / "exported_translated.pdf"
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


def test_reader_search_bookmarks_glossary_and_scoped_question(test_env):
    client, _ = test_env
    imported = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)],
        "collection": "研究 / 制御"}).json()["job_id"])
    paper_id = imported.result.paper_ids[0]
    base = f"/api/papers/{paper_id}"

    with fitz.open(FIXTURE_PDF) as pdf:
        word = re.search(r"[A-Za-z]{4,}", pdf[0].get_text())
    assert word
    found = client.get(f"{base}/search", params={"q": word.group(), "side": "original"}).json()
    assert found["total"] >= 1 and found["results"][0]["page"] >= 1
    assert 0 <= found["results"][0]["anchor_y"] <= 1
    assert client.get(f"{base}/search", params={"q": "x", "side": "invalid"}).status_code == 400

    bookmark = client.post(f"{base}/sticky-notes", json={"page": 1, "side": "original",
        "quote": word.group(), "label": "あとで確認", "note": "復習", "anchor_y": 0.42}).json()
    assert client.get(f"{base}/sticky-notes").json()[0]["note"] == "復習"
    assert bookmark["anchor_y"] == 0.42
    assert client.delete(f"{base}/sticky-notes/{bookmark['id']}").json()["deleted"]
    assert client.get(f"{base}/sticky-notes").json() == []

    terms = [{"source": word.group(), "target": "検証語"}]
    assert client.put("/api/glossary", json={"terms": terms, "expected_terms": []}).status_code == 200
    assert client.get("/api/glossary").json() == terms
    assert client.put("/api/glossary", json={"terms": terms * 2, "expected_terms": terms}).status_code == 400
    with patch("sidecar.deps.create_provider", FakeProvider):
        job = _wait(client.post(f"{base}/translate", json={"pages": "1"}).json()["job_id"])
        assert job.status == "succeeded"
        first_fingerprint = job.result.translation_version
        scoped = _wait(client.post(f"{base}/ask", json={"question": "結果は？",
            "scope": "selected", "paper_ids": [paper_id]}).json()["job_id"])
        assert scoped.status == "succeeded"
    assert client.get(f"{base}/translation-text/1").json()["blocks"]
    # Changing a term must make the next translation use a new cache identity.
    assert client.put("/api/glossary", json={"terms": [{"source": word.group(), "target": "別の訳語"}],
                                             "expected_terms": terms}).status_code == 200
    with patch("sidecar.deps.create_provider", FakeProvider):
        updated = _wait(client.post(f"{base}/translate", json={"pages": "1"}).json()["job_id"])
    assert updated.status == "succeeded"
    assert updated.result.already_translated_pages == []
    assert updated.result.translation_version == first_fingerprint


def test_removed_compatibility_routes_stay_removed():
    # The window and the sidecar ship together, so no older client calls these any more. Checked against the
    # routes the app serves, those of the included routers too (one left out of the schema would still answer).
    routes = {(method, route.path) for route in iter_route_contexts(app.routes) for method in route.methods or ()}
    removed = {
        ("POST", "/api/papers/upload"),  # a multipart upload; PDFs are added by path (/api/papers/import)
        ("GET", "/api/papers/{paper_id}/reading-blocks/{page}"),
        ("GET", "/api/papers/{paper_id}/bookmarks"), ("POST", "/api/papers/{paper_id}/bookmarks"),
        ("PATCH", "/api/papers/{paper_id}/bookmarks/{bookmark_id}"),
        ("DELETE", "/api/papers/{paper_id}/bookmarks/{bookmark_id}"),
        ("GET", "/api/papers/{paper_id}/glossary"), ("PUT", "/api/papers/{paper_id}/glossary"),
        ("GET", "/api/papers/{paper_id}/ink/{side}/{page}"), ("PUT", "/api/papers/{paper_id}/ink/{side}/{page}"),
        ("POST", "/api/papers/{paper_id}/ink-capture"),
    }
    assert not removed & routes
    assert {("GET", "/api/papers/{paper_id}/sticky-notes"), ("GET", "/api/glossary"),
            ("PUT", "/api/papers/{paper_id}/ink-v2/{side}/{page}"), ("POST", "/api/papers/{paper_id}/ink-capture-v2")} <= routes


def test_scoped_question_only_uses_selected_papers(test_env):
    client, directory = test_env
    ids = []
    for index, collection in enumerate(("物理", "情報")):
        path = directory / f"scope-{index}.pdf"
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_text((72, 72), f"Adaptive controller experiment {index} and measured tracking error.")
            doc.save(path)
        job = _wait(client.post("/api/papers/import", json={"paths": [str(path)], "collection": collection}).json()["job_id"])
        ids.append(job.result.paper_ids[0])
    with patch("sidecar.deps.create_provider", FakeProvider):
        selected = _wait(client.post(f"/api/papers/{ids[0]}/ask", json={"question": "tracking error?",
            "scope": "selected", "paper_ids": [ids[1]]}).json()["job_id"])
        collection = _wait(client.post(f"/api/papers/{ids[0]}/ask", json={"question": "tracking error?",
            "scope": "collection", "collection": "情報"}).json()["job_id"])
    for job in (selected, collection):
        assert job.status == "succeeded"
        assert ids[1] in job.result.answer
        assert ids[0] not in job.result.answer


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
    assert job.result.added == 1
    paper_id = job.result.paper_ids[0]

    deleted = client.delete("/api/collections/制御工学")
    assert deleted.json()["moved"] == [paper_id]
    assert client.get(f"/api/papers/{paper_id}").json()["collection_name"] == ""
    assert client.delete("/api/collections/存在しない").status_code == 400
    token = deleted.json()["undo_token"]
    restored = client.post(f"/api/collections/restore/{token}")
    assert restored.status_code == 200
    assert restored.json()["name"] == "制御工学"
    assert client.get(f"/api/papers/{paper_id}").json()["collection_name"] == "制御工学 / 輪講"
    assert client.post(f"/api/collections/restore/{token}").status_code == 400

    # Importing the same PDF again opens the existing paper instead of adding one.
    again = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"])
    assert again.result.model_dump() == {"paper_ids": [paper_id], "added": 0}


def test_import_announces_page_counts_before_each_paper(test_env):
    client, tmp_dir = test_env
    events = []
    with patch.object(job_manager, "broadcast", side_effect=lambda event: events.append(event.model_dump())):
        job = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"])
    pages = client.get(f"/api/papers/{job.result.paper_ids[0]}").json()["pages"]
    imports = [e for e in events if e["type"].startswith("import.")]
    # The library shows placeholder rows keyed by the path as sent, so both events echo it back.
    assert imports == [
        {"type": "import.pages", "pages": {str(FIXTURE_PDF): pages}},
        {"type": "import.item", "path": str(FIXTURE_PDF), "paper_id": job.result.paper_ids[0]},
    ]


def test_imports_requested_together_run_in_turn(test_env):
    client, _ = test_env
    # Without queueing, both jobs could pass the duplicate check and the second would fail
    # on the UNIQUE sha256 column.
    first = client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"]
    second = client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"]
    first, second = _wait(first), _wait(second)
    assert (first.status, second.status) == ("succeeded", "succeeded")
    assert first.result.added == 1
    assert second.result.model_dump() == {"paper_ids": first.result.paper_ids, "added": 0}


def test_paper_metadata_reading_and_export_guards(test_env, tmp_path):
    client, library_root = test_env
    job = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"])
    paper_id = job.result.paper_ids[0]

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

    # Untranslated papers cannot be exported, and nothing is written inside the library.
    blocked = client.post(f"/api/papers/{paper_id}/export", json={"kind": "translated", "destination": str(tmp_path / "x.pdf")})
    assert blocked.status_code == 400
    folder = Path(client.get(f"/api/papers/{paper_id}").json()["folder_path"])
    long_form = Path("\\\\?\\" + str(library_root.resolve()))
    for inside in (folder / "original.pdf", folder / "copy.pdf", library_root / "library.sqlite3",
                   library_root / "exports" / "x.pdf", long_form / "copy.pdf", Path(f"{library_root} ") / "copy.pdf"):
        refused = client.post(f"/api/papers/{paper_id}/export", json={"kind": "original", "destination": str(inside)})
        assert refused.status_code == 400 and refused.json()["detail"] == "ライブラリの外に保存先を選んでください。"
    assert not (folder / "copy.pdf").exists() and not (library_root / "exports").exists()
    assert client.post(f"/api/papers/{paper_id}/export",
                       json={"kind": "original", "destination": str(tmp_path / "original.pdf")}).status_code == 200
    assert (tmp_path / "original.pdf").read_bytes() == (folder / "original.pdf").read_bytes()

    with patch("sidecar.deps.create_provider", FakeProvider):
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

    # Paired PDFs run as paper jobs; interleaved.pdf is built for external viewers when first opened.
    started = client.post(f"/api/papers/{paper_id}/export", json={"kind": "bilingual", "destination": str(tmp_path / "b.pdf")})
    assert _wait(started.json()["job_id"]).status == "succeeded"
    assert (tmp_path / "b.pdf").is_file()
    assert not (folder / "interleaved.pdf").exists()
    prepared = _wait(client.post(f"/api/papers/{paper_id}/interleaved").json()["job_id"])
    built = Path(prepared.result.path)
    assert built == (folder / "interleaved.pdf").resolve()
    stamp = built.stat().st_mtime_ns
    # Opened again with the translation unchanged, the same file is reused; the export copies it.
    again = _wait(client.post(f"/api/papers/{paper_id}/interleaved").json()["job_id"])
    assert Path(again.result.path) == built and built.stat().st_mtime_ns == stamp
    started = client.post(f"/api/papers/{paper_id}/export", json={"kind": "interleaved", "destination": str(tmp_path / "i.pdf")})
    assert _wait(started.json()["job_id"]).status == "succeeded"
    assert (tmp_path / "i.pdf").read_bytes() == built.read_bytes()


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


def test_translation_concurrency_setting_round_trips(test_env):
    client, _ = test_env
    settings = client.get("/api/settings").json()
    assert settings["translation_concurrency"] == 0

    assert client.put("/api/settings", json={**settings, "translation_concurrency": 2}).status_code == 200
    assert client.get("/api/settings").json()["translation_concurrency"] == 2

    rejected = client.put("/api/settings", json={**settings, "translation_concurrency": 99})
    assert rejected.status_code == 400
    assert client.get("/api/settings").json()["translation_concurrency"] == 2


def test_providers_are_listed_for_the_settings_dialog(test_env):
    client, _ = test_env
    providers = client.get("/api/providers").json()
    assert [p["id"] for p in providers] == ["codex", "claude", "antigravity", "api"]
    api = providers[-1]
    assert api["needs_api_key"] and not api["needs_login"]
    assert [f["key"] for f in api["fields"]] == ["base_url"] and api["fields"][0]["hint"]
    assert client.get("/api/providers/bogus/models").status_code == 400
    assert client.get("/api/providers/api/efforts").json() == [{"id": "", "name": "既定値"}]


def test_connection_settings_round_trip_per_provider(test_env):
    client, tmp_path = test_env
    settings = client.get("/api/settings").json()
    body = {**settings, "provider": "api", "model": "local-model",
            "provider_options": {"api": {"base_url": "http://localhost:11434/v1", "model": "local-model"},
                                 "claude": {"cli_path": "C:/claude.exe"}}}
    assert client.put("/api/settings", json=body).status_code == 200
    saved = client.get("/api/settings").json()
    assert saved["provider"] == "api"
    assert saved["provider_options"]["api"]["base_url"] == "http://localhost:11434/v1"
    assert saved["provider_options"]["api"]["model"] == "local-model"
    assert saved["provider_options"]["claude"] == {"cli_path": "C:/claude.exe"}
    assert client.put("/api/settings", json={**body, "provider": "bogus"}).status_code == 400

    # A partial update keeps every other saved value.
    assert client.put("/api/settings", json={"translation_concurrency": 2}).status_code == 200
    partial = client.get("/api/settings").json()
    assert partial["translation_concurrency"] == 2
    assert partial["provider"] == "api" and partial["provider_options"]["claude"] == {"cli_path": "C:/claude.exe"}
    # Keys the API does not know, such as the flat codex_path/api_base of settings.json before
    # provider_options, are ignored in a request: only the settings file is migrated (Settings.load).
    assert client.put("/api/settings", json={"provider": "codex", "codex_path": "C:/codex.exe",
                                             "api_base": "http://localhost:9999/v1"}).status_code == 200
    flat = client.get("/api/settings").json()
    assert flat["provider"] == "codex" and "codex" not in flat["provider_options"]
    assert flat["provider_options"]["api"]["base_url"] == "http://localhost:11434/v1"
    assert not {"codex_path", "api_base"} & flat.keys()


def test_settings_file_with_keys_of_a_newer_version_still_loads(test_env):
    # settings.json lives in the (synced) library, so a newer Papeer on another PC may have written keys this one
    # does not know. They must not stop the settings from loading or being saved.
    client, tmp_path = test_env
    (tmp_path / "settings.json").write_text(json.dumps(
        {"provider": "claude", "model": "claude-x", "future_option": {"a": 1}}), "utf-8")
    settings = client.get("/api/settings").json()
    assert settings["provider"] == "claude" and settings["model"] == "claude-x"
    assert "future_option" not in settings
    assert client.put("/api/settings", json={**settings, "timeout_seconds": 600}).status_code == 200
    assert client.get("/api/settings").json()["timeout_seconds"] == 600


def test_legacy_settings_file_is_served_in_the_new_shape(test_env):
    client, tmp_path = test_env
    (tmp_path / "settings.json").write_text(json.dumps(
        {"provider": "gemini", "model": "gemini-x", "gemini_path": "C:/agy.exe"}), "utf-8")
    settings = client.get("/api/settings").json()
    assert settings["provider"] == "antigravity"
    assert settings["provider_options"]["antigravity"]["cli_path"] == "C:/agy.exe"


def test_unknown_effort_for_one_run_is_rejected(test_env):
    client, _ = test_env
    imported = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"])
    paper_id = imported.result.paper_ids[0]
    response = client.post(f"/api/papers/{paper_id}/translate", json={"pages": "1", "effort": "ultra"})
    assert response.status_code == 400 and "effort" in response.json()["detail"]


def test_api_connection_needs_no_login(test_env):
    client, _ = test_env
    response = client.post("/api/providers/login", json={"provider": "api"})
    assert response.status_code == 200
    assert response.json()["already"] is False
    assert client.post("/api/providers/login", json={"provider": "bogus"}).status_code == 400


def test_ask_with_attached_passages(test_env):
    client, _ = test_env
    imported = _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"])
    base = f"/api/papers/{imported.result.paper_ids[0]}"
    requests = []

    class RecordingProvider(FakeProvider):
        def generate(self, instruction, data, schema=None):
            requests.append(data)
            return super().generate(instruction, data, schema)

    attachment = {"page": 1, "side": "original", "text": "  tracking error was reduced  ",
                  "anchor_y": 0.3, "start": 10, "end": 37, "raw": "tracking error was\nreduced"}
    with patch("sidecar.deps.create_provider", RecordingProvider):
        job = _wait(client.post(f"{base}/ask", json={"question": "これはどういう意味？",
            "attachments": [attachment]}).json()["job_id"])
        assert job.status == "succeeded"
        sent = json.loads(requests[-1])
        assert sent["attached_passages"] == [{"page": 1, "side": "原文", "text": "tracking error was reduced"}]

        # Earlier attachments stay in the dialogue the next answer sees.
        followup = _wait(client.post(f"{base}/ask", json={"question": "続けて"}).json()["job_id"])
        assert followup.status == "succeeded"
        sent = json.loads(requests[-1])
        assert "attached_passages" not in sent
        assert "[添付 p.1] tracking error was reduced" in sent["previous_dialogue"][0]["content"]

        invalid = _wait(client.post(f"{base}/ask", json={"question": "?",
            "attachments": [{**attachment, "page": 999}]}).json()["job_id"])
        assert invalid.status == "failed"

    messages = client.get(f"{base}/messages").json()
    assert messages[0]["attachments"] == [{**attachment, "text": "tracking error was reduced"}]
    assert "attachments" not in messages[2]
