"""Items other than PDFs and what items hold: the foundation of notebooks, memos and documents.

A notebook row is inserted directly here: nothing makes one yet (the screens come with later stages), but the
library must already list, count, back up, sync and remove them correctly.
"""
from __future__ import annotations

import shutil
import sqlite3
import threading
import uuid
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from papeer.core import drive_sync as sync
from papeer.core.backup import create_backup, restore_backup, validate_library
from papeer.core.errors import Invalid, NotFound
from papeer.core.library_list import library_rows
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from sidecar import deps
from sidecar.app import app

SAMPLE_PDF = Path(__file__).parent / "fixtures" / "sample.pdf"


def add_notebook(lib: Library, *, parent: str | None = None, title: str = "手書きノート", collection: str = "",
                 created: str = "2026-06-01 00:00:00") -> str:
    """A notebook row with its files (notebook.json and the PDF made from it), as stage C will make them."""
    identity = uuid.uuid4().hex
    files = PaperFiles(lib.folder(identity))
    files.folder.mkdir()
    shutil.copyfile(SAMPLE_PDF, files.original_pdf)
    files.notebook_json.write_text("{}", "utf-8")
    with lib.connection() as db:
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,collection_name,kind,parent_id,created_at)"
                   " VALUES(?,?,?,?,1,?,'notebook',?,?)",
                   (identity, "notebook:" + identity, title, "notebook.pdf", collection, parent, created))
    return identity


def another_pdf(tmp_path: Path) -> Path:
    """The sample PDF with a trailing comment: a different file, so a second paper."""
    path = tmp_path / "another.pdf"
    path.write_bytes(SAMPLE_PDF.read_bytes() + b"\n% another paper\n")
    return path


@pytest.fixture
def lib(tmp_path):
    return Library(tmp_path / "library")


def row_ids(rows: list[dict]) -> list[str]:
    return [row["id"] for row in rows]


# --- What is listed ---

def test_papers_are_pdfs_and_items_add_the_notebooks_that_stand_on_their_own(lib, tmp_path):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    standalone = add_notebook(lib, title="独立ノート", created="2026-07-01 00:00:00")
    held = add_notebook(lib, parent=paper, title="専用ノート")
    assert row_ids(lib.papers()) == [paper]
    assert set(row_ids(lib.items())) == {paper, standalone}
    assert held not in row_ids(lib.items()) and held not in row_ids(lib.papers())
    # A search covers the same set: a notebook is found by its name.
    assert row_ids(lib.items("独立")) == [standalone]
    assert lib.papers("独立") == []
    # paper() is by ID, whatever the kind: the reader opens notebooks through it.
    assert lib.paper(held)["parent_id"] == paper
    assert lib.paper(standalone)["kind"] == "notebook" and lib.paper(paper)["kind"] == "pdf"


def test_bibtex_sources_leave_notebooks_out(lib):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    notebook = add_notebook(lib, collection="輪読会")
    lib.update(paper, collection_name="輪読会")
    assert row_ids(lib.collection_papers("輪読会")) == [paper]
    assert row_ids(lib.papers_by_id([paper])) == [paper]
    with pytest.raises(NotFound):
        lib.papers_by_id([paper, notebook])


def test_whole_library_processes_see_pdf_papers_only(lib):
    from papeer.core.citations import citation_graph
    from papeer.core.library_search import library_search
    from papeer.core.reading_choices import all_tags

    paper, _ = lib.import_pdf(SAMPLE_PDF)
    notebook = add_notebook(lib, title="輪読ノート")
    lib.update(notebook, tags=["ノート用"])
    assert [node["id"] for node in citation_graph(lib)["nodes"]] == [paper]
    # The tags of every listed item are offered, and a search finds a notebook by its name.
    assert "ノート用" in all_tags(lib)
    assert [hit["paper_id"] for hit in library_search(lib, "輪読ノート")["results"]] == [notebook]


def test_the_list_rows_carry_kind_and_what_each_item_holds(lib, tmp_path):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    standalone = add_notebook(lib, title="独立ノート")
    held = add_notebook(lib, parent=paper)
    lib.add_attachment(paper, "md", "要約", "# 要約")
    lib.add_attachment(paper, "html", "図解", "<p>図</p>")
    lib.add_attachment(standalone, "md", "メモ", "x")
    lib.link_items(paper, standalone)
    rows = {row["id"]: row for row in library_rows(lib)}
    assert set(rows) == {paper, standalone}
    assert (rows[paper]["kind"], rows[paper]["parent_id"]) == ("pdf", None)
    assert [rows[paper][name] for name in ("attachment_count", "owned_notebook_count", "link_count")] == [2, 1, 1]
    assert [rows[standalone][name] for name in ("attachment_count", "owned_notebook_count", "link_count")] == [1, 0, 1]
    # A notebook has no translation: those fields are the defaults, not worked out from a document.json it lacks.
    assert "translated_count" not in rows[standalone] and "translation_required_count" not in rows[standalone]
    assert "translated_count" in rows[paper]
    # What is counted is what is there.
    assert len(lib.attachments(paper)) == 2 and lib.owned_notebooks(paper) == [held]
    assert lib.linked_ids(paper) == [standalone] and lib.linked_ids(standalone) == [paper]
    # The held notebook is opened through its owner, but its own ID still answers and is kept when listing.
    library_rows(lib)
    assert lib.all_ids() == {paper, standalone, held}


# --- Holding and linking ---

def test_attachments_are_files_of_their_owner_in_the_order_added(lib):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    first = lib.add_attachment(paper, "md", "  読書   メモ ", "# 読書", source="imported")
    second = lib.add_attachment(paper, "html", "図解", "<p>図</p>")
    assert (first["title"], first["source"], first["position"], second["position"]) == ("読書 メモ", "imported", 0, 1)
    assert [item["id"] for item in lib.attachments(paper)] == [first["id"], second["id"]]
    files = PaperFiles(lib.folder(paper))
    assert files.attachment(first["id"], "md").read_text("utf-8") == "# 読書"
    assert lib.attachment_text(second["id"]) == "<p>図</p>"
    lib.remove_attachment(first["id"])
    assert not files.attachment(first["id"], "md").exists()
    assert [item["id"] for item in lib.attachments(paper)] == [second["id"]]
    with pytest.raises(NotFound):
        lib.attachment_text(first["id"])
    with pytest.raises(NotFound):
        lib.remove_attachment(first["id"])


def test_attachments_have_one_level_and_a_known_format(lib):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    held = add_notebook(lib, parent=paper)
    with pytest.raises(Invalid):
        lib.add_attachment(paper, "pdf", "x", "")
    with pytest.raises(Invalid):
        lib.add_attachment(held, "md", "x", "")  # What is held holds nothing.
    with pytest.raises(NotFound):
        lib.add_attachment("0" * 32, "md", "x", "")
    # Nothing is left of the refused ones.
    assert lib.attachments(paper) == [] and not PaperFiles(lib.folder(paper)).attachments.exists()


def test_a_link_is_one_row_whichever_way_it_is_made(lib):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    notebook = add_notebook(lib)
    held = add_notebook(lib, parent=paper)
    assert lib.link_items(notebook, paper) is True
    assert lib.link_items(paper, notebook) is False
    with lib.connection() as db:
        [(a, b)] = db.execute("SELECT a,b FROM item_links").fetchall()
    assert (a, b) == tuple(sorted((paper, notebook)))
    with pytest.raises(Invalid):
        lib.link_items(paper, paper)
    with pytest.raises(Invalid):
        lib.link_items(paper, held)  # Only items that stand on their own are linked.
    with pytest.raises(NotFound):
        lib.link_items(paper, "0" * 32)
    assert lib.unlink_items(paper, notebook) is True and lib.unlink_items(paper, notebook) is False
    assert lib.linked_ids(paper) == []
    # Unlinking removed nothing else.
    assert lib.paper(notebook) and lib.paper(paper)


def test_the_database_itself_refuses_a_link_out_of_order_and_an_owner_removed_under_its_notebooks(lib):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    held = add_notebook(lib, parent=paper)
    other = add_notebook(lib)
    low, high = sorted((paper, other))
    with lib.connection() as db:
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("INSERT INTO item_links(a,b) VALUES(?,?)", (high, low))
    with pytest.raises(sqlite3.IntegrityError), lib.connection() as db:
        # No ON DELETE CASCADE on parent_id: a bare delete would leave papers/<held>/ behind.
        db.execute("DELETE FROM papers WHERE id=?", (paper,))
    assert lib.paper(held)["parent_id"] == paper


# --- Removing ---

def test_removing_an_item_removes_what_it_holds_and_every_link_to_it(lib, tmp_path):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    other, _ = lib.import_pdf(another_pdf(tmp_path))
    held = add_notebook(lib, parent=paper)
    standalone = add_notebook(lib, title="独立ノート")
    memo = lib.add_attachment(paper, "md", "メモ", "x")
    lib.link_items(paper, standalone)
    lib.link_items(other, standalone)
    lib.add_bookmark(held, 1, "original", "quote")
    lib.save_ink(held, "original", 1, [{"id": "stroke"}])
    folders = [lib.folder(item) for item in (paper, held)]
    assert all(folder.is_dir() for folder in folders)

    lib.delete_paper(paper)

    assert not any(folder.exists() for folder in folders)
    assert lib.all_ids() == {other, standalone}
    with lib.connection() as db:
        assert db.execute("SELECT COUNT(*) FROM attachments WHERE id=?", (memo["id"],)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM bookmarks WHERE paper_id=?", (held,)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM pdf_ink WHERE paper_id=?", (held,)).fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM papers WHERE parent_id IS NOT NULL").fetchone()[0] == 0
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
    # Links to the other items went; the items themselves, and their other links, stayed.
    assert lib.linked_ids(standalone) == [other]
    assert lib.folder(standalone).is_dir() and lib.folder(other).is_dir()


def test_removing_a_held_notebook_leaves_its_owner_and_removing_a_standalone_one_its_links(lib):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    held = add_notebook(lib, parent=paper)
    standalone = add_notebook(lib)
    lib.link_items(paper, standalone)
    lib.delete_paper(held)
    assert not lib.folder(held).exists()
    assert lib.owned_notebooks(paper) == [] and lib.folder(paper).is_dir()
    lib.delete_paper(standalone)
    assert not lib.folder(standalone).exists()
    assert lib.linked_ids(paper) == []


# --- Backups ---

def test_backup_validation_asks_each_kind_for_its_own_files(lib, tmp_path):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    notebook = add_notebook(lib)
    memo = lib.add_attachment(paper, "md", "メモ", "x")
    with lib.connection() as db:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    validate_library(lib.root)

    # A notebook's PDF is made again from its pages: its sha256 is no digest, and is not compared.
    PaperFiles(lib.folder(notebook)).original_pdf.write_bytes(SAMPLE_PDF.read_bytes() + b"\n% redrawn\n")
    validate_library(lib.root)
    # A paper's PDF must still be the one recorded.
    PaperFiles(lib.folder(paper)).original_pdf.write_bytes(SAMPLE_PDF.read_bytes() + b"\n% altered\n")
    with pytest.raises(ValueError, match="破損"):
        validate_library(lib.root)
    shutil.copyfile(SAMPLE_PDF, PaperFiles(lib.folder(paper)).original_pdf)
    validate_library(lib.root)

    PaperFiles(lib.folder(notebook)).notebook_json.unlink()
    with pytest.raises(ValueError, match="ノート"):
        validate_library(lib.root)
    PaperFiles(lib.folder(notebook)).notebook_json.write_text("{}", "utf-8")
    PaperFiles(lib.folder(notebook)).original_pdf.unlink()
    with pytest.raises(ValueError, match="論文ファイル"):
        validate_library(lib.root)
    shutil.copyfile(SAMPLE_PDF, PaperFiles(lib.folder(notebook)).original_pdf)

    PaperFiles(lib.folder(paper)).attachment(memo["id"], "md").unlink()
    with pytest.raises(ValueError, match="メモ・資料"):
        validate_library(lib.root)


def test_a_backup_restores_notebooks_memos_and_links(lib, tmp_path):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    notebook = add_notebook(lib)
    held = add_notebook(lib, parent=paper)
    memo = lib.add_attachment(paper, "html", "図解", "<p>図</p>")
    lib.link_items(paper, notebook)
    create_backup(lib, tmp_path / "backup.zip")
    lib.delete_paper(paper)
    lib.delete_paper(notebook)
    restore_backup(lib, tmp_path / "backup.zip")
    restored = Library(lib.root)
    assert set(row_ids(restored.items())) == {paper, notebook}
    assert restored.owned_notebooks(paper) == [held]
    assert restored.attachment_text(memo["id"]) == "<p>図</p>"
    assert restored.linked_ids(paper) == [notebook]


def test_a_backup_of_an_older_schema_is_validated_without_kinds(tmp_path):
    from _legacy_library import legacy_backup, legacy_library

    legacy = tmp_path / "legacy"
    legacy_library(legacy, "oldest")
    validate_library(legacy)  # Neither papers.kind nor the attachments table: every row is a PDF paper.
    legacy_backup(legacy, tmp_path / "old.zip")
    restore_backup(Library(tmp_path / "library"), tmp_path / "old.zip")


# --- Sync counts ---

def test_counts_tell_papers_notebooks_and_memos_apart(lib):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    notebook = add_notebook(lib)
    add_notebook(lib, parent=paper)
    lib.add_attachment(paper, "md", "メモ", "x")
    lib.add_attachment(notebook, "html", "資料", "<p>x</p>")
    counts = sync.library_counts(lib.root)
    assert (counts["papers"], counts["notebooks"], counts["attachments"]) == (1, 2, 2)


def test_removing_memos_is_not_reported_as_papers_lost():
    before = {"papers": 20,  "stickies": 0, "ink": 0, "notebooks": 4, "attachments": 30}
    after = {**before, "attachments": 0}
    assert sync.shrunk_kinds(before, after) == ["attachments"]
    assert "論文" not in sync._kinds_text(sync.shrunk_kinds(before, after))
    # Nor are the notebooks: only the paper count decides about papers.
    assert sync.shrunk_kinds(before, {**before, "notebooks": 0}) == ["notebooks"]
    # Losing every notebook asks, as losing every paper does; a revision from an earlier Papeer has no such count.
    assert sync.shrunk_kinds({"papers": 3}, {"papers": 3, "notebooks": 0}) == []
    assert sync.shrunk_kinds({"papers": 9, "notebooks": 2}, {"papers": 9, "notebooks": 0}) == ["notebooks"]


def test_a_library_of_notebooks_only_is_not_an_empty_one():
    assert sync.holds_items({"papers": 0, "notebooks": 2}) and not sync.holds_no_items({"papers": 0, "notebooks": 2})
    assert sync.holds_no_items({"papers": 0}) and not sync.holds_items({"papers": 0})
    assert sync.holds_no_items({"papers": 0, "notebooks": 0})
    # A revision that says nothing is neither.
    assert not sync.holds_no_items(None) and not sync.holds_items({})


def test_what_differs_lists_items_not_what_they_hold(lib, tmp_path):
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    other = Library(tmp_path / "other")
    add_notebook(lib, title="独立ノート")
    add_notebook(lib, parent=paper, title="専用ノート")
    with lib.connection() as db:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    with other.connection() as db:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    diff = sync.library_difference(lib.root / "library.sqlite3", other.root / "library.sqlite3")
    assert diff["local_only"] == 2
    assert sorted(diff["local_titles"]) == sorted([lib.paper(paper)["title"], "独立ノート"])
    assert diff["remote_only"] == 0


# --- The API ---

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("PAPEER_TOKEN", "")
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    return TestClient(app)


def test_the_list_and_detail_answer_kind_parent_and_counts(client):
    lib = deps.get_library()
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    notebook = add_notebook(lib, title="独立ノート")
    held = add_notebook(lib, parent=paper)
    lib.add_attachment(paper, "md", "メモ", "x")
    lib.link_items(paper, notebook)
    rows = {row["id"]: row for row in client.get("/api/papers").json()}
    assert set(rows) == {paper, notebook}
    assert (rows[paper]["kind"], rows[paper]["parent_id"]) == ("pdf", None)
    assert (rows[paper]["attachment_count"], rows[paper]["owned_notebook_count"], rows[paper]["link_count"]) == (1, 1, 1)
    assert (rows[notebook]["kind"], rows[notebook]["link_count"]) == ("notebook", 1)
    detail = client.get(f"/api/papers/{held}").json()
    assert (detail["kind"], detail["parent_id"], detail["attachment_count"]) == ("notebook", paper, 0)
    # An item holding and linked to nothing says zero.
    lone = add_notebook(lib, title="ひとりノート")
    row = next(row for row in client.get("/api/papers").json() if row["id"] == lone)
    assert (row["attachment_count"], row["owned_notebook_count"], row["link_count"]) == (0, 0, 0)


def test_bibtex_of_a_notebook_is_not_found(client):
    lib = deps.get_library()
    notebook = add_notebook(lib)
    assert client.post("/api/papers/bibtex", json={"paper_ids": [notebook]}).status_code == 404


def test_deleting_an_item_waits_for_jobs_on_what_it_holds(client):
    lib = deps.get_library()
    paper, _ = lib.import_pdf(SAMPLE_PDF)
    held = add_notebook(lib, parent=paper)
    started, release = threading.Event(), threading.Event()

    def action(cancel, progress, page_ready):
        started.set()
        release.wait(5)

    deps.job_manager.submit_job("translate", action, paper_id=held)
    try:
        assert started.wait(5)
        refused = client.delete(f"/api/papers/{paper}")
        assert refused.status_code == 409 and lib.folder(held).is_dir()
    finally:
        release.set()
        assert deps.job_manager.wait_idle(5)
    assert client.delete(f"/api/papers/{paper}").json() == {"status": "deleted"}
    assert not lib.folder(paper).exists() and not lib.folder(held).exists()
    assert lib.all_ids() == set()


def test_idle_covers_several_papers_at_once():
    from sidecar.jobs import ConcurrencyConflict, JobManager

    manager = JobManager()
    started, release = threading.Event(), threading.Event()

    def action(cancel, progress, page_ready):
        started.set()
        release.wait(5)

    manager.submit_job("translate", action, paper_id="held")
    assert started.wait(5)
    try:
        with pytest.raises(ConcurrencyConflict):
            with manager.idle("busy", {"owner", "held"}):
                pass
        with manager.idle("free", {"owner", "elsewhere"}):
            # Until the change is over no job on any of them starts.
            with pytest.raises(ConcurrencyConflict):
                manager.submit_job("translate", lambda *_: None, paper_id="elsewhere")
    finally:
        release.set()
        assert manager.wait_idle(5)
