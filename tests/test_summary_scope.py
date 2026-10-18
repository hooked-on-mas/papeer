"""Long summaries require a choice; only selected text and figures reach the provider."""
import threading

from _summary_responses import clean_summary_response
import time

from fastapi.testclient import TestClient
import pymupdf as fitz
import pytest

from papeer.core.config import Settings
from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.core.summary_scope import page_ranges, summary_plan, validate_summary_pages
from sidecar import deps
from sidecar.app import app


class RecordingProvider:
    def __init__(self):
        self.calls = []

    def generate(self, instruction, data, schema=None):
        if schema:
            return clean_summary_response(data)
        self.calls.append((instruction, data))
        return data.split("\n\n## Available images")[0]


@pytest.fixture
def summary_env(tmp_path, monkeypatch):
    path = tmp_path / "long.pdf"
    with fitz.open() as pdf:
        for number in range(1, 31):
            page = pdf.new_page()
            page.insert_text((50, 50), f"UNIQUE_PAGE_{number:03d} Research methods and detailed scientific results.")
            pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 20, 20), False)
            pixmap.clear_with(128)
            page.insert_image(fitz.Rect(50, 100, 200, 180), pixmap=pixmap)
            page.insert_text((50, 200), f"Figure {number}: Architecture of method {number}.")
        pdf.set_toc([[1, "Introduction", 1], [1, "Methods", 3], [2, "Experiments", 5], [1, "Results", 9]])
        pdf.save(path)
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(path)
    provider = RecordingProvider()
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setenv("PAPEER_TOKEN", "")
    monkeypatch.setattr(deps, "get_library", lambda: lib)
    monkeypatch.setattr(deps, "get_settings", lambda: Settings())
    monkeypatch.setattr(deps, "provider_for", lambda *_: provider)
    return TestClient(app), lib, identity, provider


@pytest.mark.parametrize("count,requires_choice", [(29, False), (30, True), (186, True)])
def test_threshold_and_explicit_choice(count, requires_choice):
    document = {"page_count": count}
    if requires_choice:
        with pytest.raises(ValueError, match="対象を選択"):
            validate_summary_pages(document, None)
    else:
        validate_summary_pages(document, None)
    validate_summary_pages(document, {2, 3})
    validate_summary_pages(document, set(range(1, count + 1)))
    for invalid in [set(), {0}, {count + 1}, {True}]:
        with pytest.raises(ValueError):
            validate_summary_pages(document, invalid)


def test_plan_reads_chapters_locally_and_respects_nesting(summary_env, monkeypatch):
    client, lib, identity, provider = summary_env
    native_plan = summary_plan(lib, identity)
    assert [chapter["title"] for chapter in native_plan["chapters"]] == ["Introduction", "Methods", "Experiments", "Results"]
    assert native_plan["chapters"][-1]["end_page"] == 30
    # Use top-of-page bookmarks here so exact intervals are independent of set_toc's default y.
    monkeypatch.setattr("papeer.core.summary_scope.original_outline", lambda _: [
        {"title": "Intro", "depth": 0, "page": 1},
        {"title": "External link", "depth": 0},
        {"title": "Methods", "depth": 0, "page": 3},
        {"title": "Experiments", "depth": 1, "page": 5},
        {"title": "Results", "depth": 0, "page": 9},
    ])
    response = client.get(f"/api/papers/{identity}/summary-plan")
    assert response.status_code == 200
    plan = response.json()
    assert plan["requires_selection"] is True and plan["page_count"] == 30
    assert [(c["start_page"], c["end_page"]) for c in plan["chapters"]] == [(1, 2), (3, 8), (5, 8), (9, 30)]
    assert not provider.calls
    monkeypatch.setattr("papeer.core.summary_scope.original_outline", lambda _: [
        {"title": "A", "depth": 0, "page": 2},
        {"title": "B", "depth": 0, "page": 4, "anchor_y": 0.5},
        {"title": "C", "depth": 0, "page": 4, "anchor_y": 0.8},
    ])
    assert [(c["start_page"], c["end_page"]) for c in summary_plan(lib, identity)["chapters"]] == [(2, 4), (4, 4), (4, 30)]
    monkeypatch.setattr("papeer.core.summary_scope.original_outline", lambda _: None)
    assert summary_plan(lib, identity)["chapters"] == []


def test_implicit_full_summary_is_rejected_before_job_or_provider(summary_env, monkeypatch):
    client, lib, identity, provider = summary_env
    def forbidden(*_args, **_kwargs):
        pytest.fail("no job or provider should be created before choosing a scope")
    monkeypatch.setattr(deps, "submit_job", forbidden)
    monkeypatch.setattr(deps, "provider_for", forbidden)
    for body in [None, {}, {"full_document": False}]:
        response = client.post(f"/api/papers/{identity}/article", **({"json": body} if body is not None else {}))
        assert response.status_code == 400
        assert response.json()["code"] == "summary_scope_required"
    for body in [{"pages": ""}, {"pages": "31"}, {"pages": "3-1"}, {"pages": "1", "full_document": True}]:
        assert client.post(f"/api/papers/{identity}/article", json=body).status_code == 400
    with pytest.raises(ValueError, match="対象を選択"):
        PaperService(lib, provider, threading.Event()).article(identity)
    assert not provider.calls and not PaperFiles(lib.folder(identity)).media.exists()


def wait_for_job(job_id):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        job = deps.job_manager.get_job(job_id)
        if job and not job.running:
            assert job.status == "succeeded", job.error
            return
        time.sleep(0.02)
    pytest.fail("summary job did not finish")


def test_selected_pages_exclude_other_text_and_figures_and_preserve_source_numbers(summary_env):
    client, lib, identity, provider = summary_env
    response = client.post(f"/api/papers/{identity}/article", json={"pages": "3-4, 7"})
    assert response.status_code == 200
    wait_for_job(response.json()["job_id"])
    assert len(provider.calls) == 2
    image_ids = {block["page"]: block["id"] for block in lib.document(identity)["blocks"]
                 if block.get("kind") == "figure"}
    for _, data in provider.calls:
        for page in [3, 4, 7]:
            assert f"UNIQUE_PAGE_{page:03d}" in data
            assert f"[{identity}:p{page}]" in data
            assert f"media/{image_ids[page]}.png" in data
        for page in [1, 2, 5, 6, 8, 30]:
            assert f"UNIQUE_PAGE_{page:03d}" not in data
            assert f"media/{image_ids[page]}.png" not in data
    assert "partial-document summary" in provider.calls[-1][0]
    article = PaperFiles(lib.folder(identity)).article_md.read_text("utf-8")
    assert article.startswith("> サマリー対象：PDF p.3-4, 7（全30ページ中3ページ）")
    assert f"papeer://{identity}/7" in article
    assert len(PaperFiles(lib.folder(identity)).summary_images()) == 3
    assert page_ranges({1, 2, 4, 7, 8, 9}) == "1-2, 4, 7-9"


def test_explicit_full_document_is_allowed(summary_env):
    client, lib, identity, provider = summary_env
    response = client.post(f"/api/papers/{identity}/article", json={"full_document": True})
    assert response.status_code == 200
    wait_for_job(response.json()["job_id"])
    assert "UNIQUE_PAGE_001" in provider.calls[0][1]
    assert "UNIQUE_PAGE_030" in provider.calls[-1][1]
    assert not PaperFiles(lib.folder(identity)).article_md.read_text("utf-8").startswith("> サマリー対象")
