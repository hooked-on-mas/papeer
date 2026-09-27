"""The library list (GET /api/papers): rows, order, the pages kept per PC, and what changes announce."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import time
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
import pytest

from papeer.core import drive_sync, translation_review
from papeer.core.code_version import RENDER_SOURCES
from papeer.core.fileio import atomic_write_json
from papeer.core.library_list import LibrarySort, library_rows, translation_state
from papeer.core.paths import review_cache_path
from papeer.core.storage import Library
from sidecar.app import app
from sidecar.deps import job_manager

FIXTURE_PDF = Path(__file__).parent / "fixtures/sample.pdf"


@pytest.fixture(autouse=True)
def settled(monkeypatch):
    """Files written by the test count as written long ago, so their pages are recorded at once."""
    monkeypatch.setattr(translation_review, "_now_ns", lambda: time.time_ns() + 10 * translation_review.RACY_NS)


@pytest.fixture
def library(tmp_path, monkeypatch):
    root = tmp_path / "library"
    monkeypatch.setenv("PAPEER_DATA_DIR", str(root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    return Library(root)


def _add(lib: Library, tmp_path: Path, name: str, title: str) -> str:
    """Another paper from the sample PDF (a copy with a different digest)."""
    source = tmp_path / f"{name}.pdf"
    source.write_bytes(FIXTURE_PDF.read_bytes() + f"\n% {name}\n".encode())
    paper_id, _ = lib.import_pdf(source)
    lib.update(paper_id, title=title)
    return paper_id


@pytest.fixture
def computed(monkeypatch):
    """The papers whose pages needing translation were worked out from document.json."""
    folders: list[str] = []
    original = translation_review._review_pages

    def counting(folder, page_count):
        folders.append(Path(folder).name)
        return original(folder, page_count)

    monkeypatch.setattr(translation_review, "_review_pages", counting)
    return folders


def _new_process() -> None:
    """Forget the caches kept in memory, as a restarted sidecar would."""
    translation_review._CACHES.clear()


def test_pages_needing_translation_are_worked_out_once_per_document(library, tmp_path, computed):
    first = _add(library, tmp_path, "a", "A")
    second = _add(library, tmp_path, "b", "B")
    computed.clear()
    rows = library_rows(library)
    assert sorted(computed) == sorted([first, second])
    assert [row["translation_required_count"] for row in rows] == [2, 2]

    computed.clear()
    assert library_rows(library) == rows
    _new_process()
    assert library_rows(library) == rows
    # The reader's page list uses the same pages.
    assert library.reading_info(first)["translation_required_pages"] == [1, 2]
    assert computed == []

    # Extracting again writes a new document.json: only that paper is worked out again.
    document = json.loads((library.folder(first) / "document.json").read_text("utf-8"))
    document["blocks"] = [block for block in document["blocks"] if block["page"] != 1]
    atomic_write_json(library.folder(first) / "document.json", document)
    rows = {row["id"]: row for row in library_rows(library)}
    assert computed == [first]
    assert rows[first]["translation_required_count"] == 1 and rows[second]["translation_required_count"] == 2


def test_other_code_works_the_pages_out_again(library, tmp_path, computed, monkeypatch):
    paper_id = _add(library, tmp_path, "a", "A")
    library_rows(library)
    computed.clear()
    _new_process()
    monkeypatch.setattr(translation_review, "loaded_version", lambda: "code-sha256-" + "0" * 64)
    library_rows(library)
    assert computed == [paper_id]
    # So editing translation_review.py changes the key too (tests/test_code_version.py covers the hash).
    assert "core/translation_review.py" in RENDER_SOURCES


def test_documents_written_just_now_or_without_a_file_id_are_not_recorded(library, tmp_path, computed, monkeypatch):
    paper_id = _add(library, tmp_path, "a", "A")
    written = (library.folder(paper_id) / "document.json").stat().st_mtime_ns
    computed.clear()
    monkeypatch.setattr(translation_review, "_now_ns", lambda: written + translation_review.RACY_NS)
    first = library_rows(library)
    assert library_rows(library) == first
    assert computed == [paper_id, paper_id]
    assert not review_cache_path(library.root).exists()

    # Recorded once it has settled.
    monkeypatch.setattr(translation_review, "_now_ns", lambda: written + translation_review.RACY_NS + 1)
    computed.clear()
    library_rows(library)
    library_rows(library)
    assert computed == [paper_id]

    # Without file IDs a replaced file could keep its size and time.
    _new_process()
    review_cache_path(library.root).unlink()
    real_fstat = os.fstat
    monkeypatch.setattr(os, "fstat", lambda fd: SimpleNamespace(
        st_size=real_fstat(fd).st_size, st_mtime_ns=real_fstat(fd).st_mtime_ns, st_ino=0))
    computed.clear()
    library_rows(library)
    library_rows(library)
    assert computed == [paper_id, paper_id]


def test_kept_pages_stay_on_this_pc_and_leave_the_library_as_it_was(library, tmp_path, computed):
    paper_id = _add(library, tmp_path, "a", "A")
    before = drive_sync.fingerprint(library)
    library_rows(library)
    path = review_cache_path(library.root)
    assert path.is_file() and not path.is_relative_to(library.root)
    assert drive_sync.fingerprint(library) == before

    # A damaged file is worked out again rather than trusted.
    path.write_text('{"format": 1, "papers": ', "utf-8")
    _new_process()
    computed.clear()
    assert library_rows(library)[0]["translation_required_count"] == 2
    assert computed == [paper_id]
    assert json.loads(path.read_text("utf-8"))["papers"][paper_id]["required"] == [1, 2]


def test_removed_papers_are_forgotten_once_the_whole_library_is_listed(library, tmp_path):
    kept = _add(library, tmp_path, "a", "A")
    removed = _add(library, tmp_path, "b", "B")
    library_rows(library)
    library.delete_paper(removed)
    library_rows(library, query="A")  # A filtered list does not know about the others.
    assert set(json.loads(review_cache_path(library.root).read_text("utf-8"))["papers"]) == {kept, removed}
    library_rows(library)
    assert set(json.loads(review_cache_path(library.root).read_text("utf-8"))["papers"]) == {kept}


def test_rows_leave_out_the_memo_and_follow_the_chosen_order(library, tmp_path):
    ids = [_add(library, tmp_path, name, title) for name, title in (("a", "beta"), ("b", "Alpha"), ("c", "gamma"))]
    library.update(ids[0], note="長いメモ" * 100)
    with TestClient(app) as client:
        rows = client.get("/api/papers").json()
        assert all("note" not in row for row in rows)
        assert rows[0]["folder_path"] == str(library.folder(rows[0]["id"]).resolve())
        titles = {sort: [row["title"] for row in client.get(f"/api/papers?sort={sort}").json()] for sort in LibrarySort}
        assert titles[LibrarySort.TITLE] == ["Alpha", "beta", "gamma"]
        assert titles[LibrarySort.TITLE_DESCENDING] == ["gamma", "beta", "Alpha"]
        assert titles[LibrarySort.OLDEST] == list(reversed(titles[LibrarySort.NEWEST]))
        assert client.get("/api/papers?sort=9").status_code == 400
        # The memo pane reads the paper itself.
        assert client.get(f"/api/papers/{ids[0]}").json()["note"] == "長いメモ" * 100


def test_translation_state_counts_the_saved_pages(library, tmp_path):
    paper_id = _add(library, tmp_path, "a", "A")
    folder = library.folder(paper_id)
    state = translation_state(folder, 2)
    assert (state["translated_count"], state["has_translated"], state["translation_has_issues"]) == (0, False, None)

    (folder / "translated.pdf").write_bytes(b"%PDF-1.7")
    (folder / "translation-report.json").write_text(json.dumps({"translated_pages": [1], "skipped_blocks": ["x"]}))
    state = translation_state(folder, 2)
    assert state["translated_count"] == state["translation_completed_required_count"] == 1
    assert state["has_translated"] and state["translation_has_issues"] is True

    # A report that cannot be read counts no page, as before.
    (folder / "translation-report.json").write_text("{", "utf-8")
    state = translation_state(folder, 2)
    assert state["translated_count"] == 0 and state["translation_has_issues"] is None

    # An unfinished translation counts the pages of its preview.
    (folder / "translation-preview.json").write_text(json.dumps(
        {"run_id": "0" * 32, "complete": False, "pages": [1], "total_pages": 2}), "utf-8")
    state = translation_state(folder, 2)
    assert state["translated_count"] == 1 and state["translation_in_progress"] is True


def test_a_row_without_its_folder_is_still_listed(library, tmp_path):
    paper_id = _add(library, tmp_path, "a", "A")
    shutil.rmtree(library.folder(paper_id))
    [row] = library_rows(library)
    assert row["id"] == paper_id and row["translation_required_count"] == row["pages"]


def test_changing_one_paper_announces_only_that_paper(library, tmp_path):
    paper_id = _add(library, tmp_path, "a", "A")
    events: list[dict] = []
    with TestClient(app) as client, patch.object(job_manager, "broadcast", side_effect=events.append):
        assert client.patch(f"/api/papers/{paper_id}", json={"note": "メモ"}).status_code == 200
        assert client.patch(f"/api/papers/{paper_id}", json={"tags": ["制御"], "collection": "論文"}).status_code == 200
        assert client.patch(f"/api/papers/{paper_id}", json={}).status_code == 200
        assert client.post(f"/api/papers/{paper_id}/rename", json={"new_title": "renamed"}).status_code == 200
    assert events == [
        {"type": "paper.changed", "paper_id": paper_id, "fields": ["note"]},
        {"type": "paper.changed", "paper_id": paper_id, "fields": ["collection_name", "tags"]},
        {"type": "paper.changed", "paper_id": paper_id, "fields": ["original_name", "title"]},
    ]
