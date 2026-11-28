"""Integration tests for the one-off M4 legacy data migration CLI (tools/migrate_legacy_data.py)."""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

import pymupdf
import pytest

from papeer.core.edit_model import EditGraph, canonical_json
from papeer.core.edit_repository import SqliteEditRepository, initialize_edit_schema
from papeer.core.edit_storage import edit_storage_root
from papeer.core.edits.datasets import checkpoint_hash
from papeer.core.bootstrap.canonical_initialization_sqlite import initialize_canonical_metadata
from papeer.core.bootstrap.canonical_local_grant_sqlite import provision_local_grant
from sidecar import deps
from sidecar.canonical_host import NativeAuthority
from tools.migrate_legacy_data import (
    backup_legacy_folders,
    inspect_legacy_source,
    list_target_libraries,
    migrate_legacy_library,
)


def _make_pdf_bytes(pages: int = 1) -> bytes:
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=595, height=842)
        page.insert_text((72, 72), f"Page {i + 1}")
    raw = doc.tobytes()
    doc.close()
    return raw


def _make_png_bytes() -> bytes:
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 4, 4), False)
    pix.clear_with(180)
    return pix.tobytes("png")


def _build_legacy_v8_dir(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    db_path = root / "library.sqlite3"
    pdf_id = "11" * 16
    nb_id = "22" * 16
    att_md_id = "att-md-1"
    att_html_id = "att-html-1"

    pdf_bytes = _make_pdf_bytes(2)
    trans_bytes = _make_pdf_bytes(2)
    png_bytes = _make_png_bytes()

    pdf_dir = root / "papers" / pdf_id
    (pdf_dir / "attachments").mkdir(parents=True, exist_ok=True)
    (pdf_dir / "media").mkdir(parents=True, exist_ok=True)
    (pdf_dir / "original.pdf").write_bytes(pdf_bytes)
    (pdf_dir / "translated.pdf").write_bytes(trans_bytes)
    (pdf_dir / "media" / "fig1.png").write_bytes(png_bytes)
    (pdf_dir / "media" / "unused.png").write_bytes(png_bytes)
    (pdf_dir / "attachments" / f"{att_md_id}.md").write_text('# 要約\n![図1](media/fig1.png "Figure 1")\n', encoding="utf-8")
    (pdf_dir / "attachments" / f"{att_html_id}.html").write_text("<html><body><h1>Summary</h1></body></html>", encoding="utf-8")

    nb_dir = root / "papers" / nb_id
    nb_dir.mkdir(parents=True, exist_ok=True)
    nb_json = {
        "version": 1,
        "revision": 2,
        "pages": [{
            "id": "aa" * 16,
            "size": "A4",
            "orientation": "portrait",
            "width_mm": 210,
            "height_mm": 297,
            "template": "grid5",
            "color": "cream",
        }],
    }
    (nb_dir / "notebook.json").write_text(json.dumps(nb_json), encoding="utf-8")

    with closing(sqlite3.connect(db_path)) as con:
        con.execute("PRAGMA user_version = 8")
        con.execute("""
            CREATE TABLE papers (
                id TEXT PRIMARY KEY, sha256 TEXT, title TEXT, original_name TEXT,
                pages INTEGER, status TEXT, favorite INTEGER, collection_name TEXT,
                note TEXT, created_at TEXT, first_author TEXT, publication_year INTEGER,
                bibliography_version INTEGER, tags TEXT, read_status TEXT, doi TEXT,
                arxiv_id TEXT, venue TEXT, kind TEXT, parent_id TEXT
            )
        """)
        con.execute("CREATE TABLE collections (name TEXT PRIMARY KEY)")
        con.execute("CREATE TABLE item_links (a TEXT, b TEXT)")
        con.execute("CREATE TABLE pdf_ink (paper_id TEXT, side TEXT, page INTEGER, strokes TEXT)")
        con.execute("""
            CREATE TABLE bookmarks (
                id TEXT PRIMARY KEY, paper_id TEXT, page INTEGER, side TEXT, quote TEXT,
                label TEXT, note TEXT, created_at TEXT, anchor_y REAL, anchor_x REAL,
                kind TEXT, color TEXT, rects TEXT
            )
        """)
        con.execute("""
            CREATE TABLE attachments (
                id TEXT PRIMARY KEY, owner_id TEXT, format TEXT, title TEXT,
                source TEXT, position INTEGER, created_at TEXT, updated_at TEXT
            )
        """)
        con.execute("INSERT INTO collections VALUES ('Research/ML')")
        con.execute(
            "INSERT INTO papers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                pdf_id, hashlib.sha256(pdf_bytes).hexdigest(), "Test Paper", "test.pdf",
                2, "ready", 0, "Research/ML", "", "2026-05-01 00:00:00",
                "Alice", 2026, 1, json.dumps(["ml", "bounds"]), "読了",
                "10.1000/test", "2601.00001", "ICML", "pdf", None,
            ),
        )
        con.execute(
            "INSERT INTO papers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                nb_id, "", "Research Notebook", "", 1, "ready", 0, "Research",
                "", "2026-05-02T00:00:00Z", None, None, 0, "[]", "unread",
                None, None, None, "notebook", None,
            ),
        )
        con.execute("INSERT INTO item_links VALUES (?, ?)", (pdf_id, nb_id))
        stroke = [{"id": "s1", "color": "#112233", "width": 0.004, "points": [[0.1, 0.2], [0.3, 0.4]], "kind": "pen"}]
        con.execute("INSERT INTO pdf_ink VALUES (?, 'original', 1, ?)", (pdf_id, json.dumps(stroke)))
        con.execute("INSERT INTO pdf_ink VALUES (?, 'translated', 1, ?)", (pdf_id, json.dumps(stroke)))
        con.execute("INSERT INTO pdf_ink VALUES (?, 'original', 1, ?)", (nb_id, json.dumps(stroke)))
        con.execute(
            "INSERT INTO bookmarks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "bm-hl", pdf_id, 1, "original", "Important theorem", "Theorem 1 " + ("x" * 50), "Check proof",
                "2026-05-01 01:00:00", 0.2, 0.1, "highlight", "green",
                json.dumps([[0.1, 0.2, 0.3, 0.05]]),
            ),
        )
        con.execute(
            "INSERT INTO bookmarks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "bm-sticky", pdf_id, 2, "original", "", "", "Sticky comment",
                "2026-05-01 02:00:00", 0.5, 0.5, "note", "pink", None,
            ),
        )
        con.execute(
            "INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?)",
            (att_md_id, pdf_id, "md", "要約メモ", "user", 0, "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z"),
        )
        con.execute(
            "INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?)",
            (att_html_id, pdf_id, "html", "HTMLサマリー", "imported", 1, "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z"),
        )
        con.commit()
    return root


def test_inspect_and_backup_legacy_source(tmp_path: Path):
    src = _build_legacy_v8_dir(tmp_path / "legacy-src")
    info = inspect_legacy_source(src)
    assert info["schemaVersion"] == 8
    assert info["papers"] == {"total": 2, "pdf": 1, "notebook": 1, "markdown": 0}
    assert info["collections"] == 1
    assert info["links"] == 1
    assert info["pdfInkBySide"] == {"original": 2, "translated": 1}
    assert info["bookmarksBySide"] == {"original": 2}
    assert info["attachments"] == {"markdown": 1, "html": 1, "other": 0}
    assert info["mediaPngCounts"] == {"referenced": 1, "total": 2}
    assert info["oversizedResources"] == []

    backup_dir = tmp_path / "backup-1"
    manifest = backup_legacy_folders(src, backup_dir, include_device_dir=False)
    assert manifest["data"]["files"] >= 6
    assert (backup_dir / "backup-manifest.json").is_file()
    with pytest.raises(FileExistsError):
        backup_legacy_folders(src, backup_dir, include_device_dir=False)
    with pytest.raises(ValueError):
        backup_legacy_folders(src, src / "nested-backup", include_device_dir=False)


def test_migrate_new_local_library_and_open_with_canonical_host(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    src = _build_legacy_v8_dir(tmp_path / "legacy-src")
    target_dir = tmp_path / "target-data"
    target_dir.mkdir()

    summary = migrate_legacy_library(src, target_dir, title="研究ライブラリ", translations="ink-only")
    assert summary.folders_created == 2  # Research + Research/ML
    assert summary.pdfs_migrated == 1
    assert summary.translations_attached == 1
    assert summary.notebooks_migrated == 1
    assert summary.markdown_migrated == 1
    assert summary.attachments_migrated == 1
    assert summary.links_migrated == 1
    assert summary.ink_strokes_migrated == 3
    assert summary.bookmarks_migrated == 2
    assert summary.warnings == []

    targets = list_target_libraries(target_dir)
    assert len(targets) == 1
    assert targets[0]["title"] == "研究ライブラリ"
    assert targets[0]["storage"] == "local"

    # Re-running against the same libraryId is idempotent and creates zero duplicates.
    rerun = migrate_legacy_library(src, target_dir, library_id=summary.library_id, translations="ink-only")
    assert rerun.pdfs_migrated == 0
    assert rerun.notebooks_migrated == 0
    assert rerun.markdown_migrated == 0
    assert rerun.attachments_migrated == 0
    assert rerun.skipped_already_present == 4

    # Verify the real sidecar NativeAuthority opens and reads back every migrated record cleanly.
    monkeypatch.setenv("PAPEER_DATA_DIR", str(target_dir))
    monkeypatch.setenv("PAPEER_TOKEN", "test-m4-token")
    deps._cached_data_dir = None
    deps._cached_auth_token = None
    auth = NativeAuthority()
    header = "Bearer test-m4-token"
    lease_id = auth.issue(header)
    disc = auth.discover(header, lease_id)
    assert len(disc["libraries"]) == 1
    assert disc["libraries"][0]["title"] == "研究ライブラリ"
    assert disc["libraries"][0]["status"] == "available"
    admitted = auth.inspect_handle(header, lease_id, disc["libraries"][0]["handleId"])
    repo = SqliteEditRepository(auth.bind_repository(header, lease_id, admitted["admissionId"]), admitted["scope"])
    def _snap(target_id: str) -> dict:
        view = repo.read(target_id)
        assert len(view["heads"]) == 1
        return EditGraph(view["checkpoint"]).states[view["heads"][0]]

    snap = _snap(summary.library_id)
    assert len(snap["folders"]) == 2
    assert len(snap["items"]) == 4  # 1 pdf + 1 notebook + 1 md attachment + 1 html attachment
    assert len(snap["links"]) == 1
    pdf_item = next(it for it in snap["items"] if it["kind"] == "pdf")
    assert pdf_item["tags"] == ["ml", "bounds"]
    assert pdf_item["read"] is True
    assert pdf_item["metadata"]["firstAuthor"] == "Alice"
    pdf_doc = _snap(pdf_item["id"])
    assert len(pdf_doc["pages"]) == 2
    assert len(pdf_doc["pages"][0]["annotations"]) == 2  # 1 ink + 1 highlight
    hl = next(a for a in pdf_doc["pages"][0]["annotations"] if a["kind"] == "highlight")
    assert hl["color"] == "#86efac"
    assert hl["metadata"]["createdAt"] == "2026-05-01T01:00:00Z"
    assert len(hl["metadata"]["label"]) == 40
    assert len(pdf_doc["pages"][1]["annotations"]) == 1  # 1 sticky
    assert pdf_doc["pages"][1]["annotations"][0]["color"] == "#f9a8d4"
    assert "translation" in pdf_doc and len(pdf_doc["translation"]["pages"][0]["annotations"]) == 1
    md_item = next(it for it in snap["items"] if it["kind"] == "markdown")
    assert md_item["ownerId"] == pdf_item["id"]
    md_snap = _snap(md_item["id"])
    assert "papeer://resource/" in md_snap["content"]
    assert len(md_snap["imageResources"]) == 1
    att_item = next(it for it in snap["items"] if it["kind"] == "attachment")
    assert att_item["ownerId"] == pdf_item["id"]
    att_res = repo.read_resource(att_item["resourceId"])
    assert att_res is not None and att_res["metadata"]["mediaType"] == "text/html"
    auth.release(header, lease_id)


def test_migrate_into_existing_drive_library_marks_batches_pending(tmp_path: Path):
    src = _build_legacy_v8_dir(tmp_path / "legacy-src")
    target_dir = tmp_path / "drive-target"
    target_dir.mkdir()
    db_path = edit_storage_root(target_dir) / "content.sqlite3"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    grant = provision_local_grant(db_path)
    account = grant["namespaceId"]
    lib_id = str(uuid4())
    epoch = str(uuid4())
    scope = {"accountId": account, "libraryId": lib_id, "epoch": epoch}
    root = {"kind": "library", "id": lib_id, "version": str(uuid4()), "items": [], "folders": [], "links": [], "deletions": []}
    cp = {"version": 1, "libraryId": lib_id, "roots": [root], "edits": []}
    manifest = {"version": 1, "id": str(uuid4()), "scope": scope, "checkpointSha256": checkpoint_hash(cp), "resources": []}
    ctl_id = str(uuid4())
    control = {
        "version": 1, "id": ctl_id, "identity": {"accountId": account, "libraryId": lib_id},
        "active": manifest, "epochs": [epoch],
        "transition": {
            "id": ctl_id, "mode": "import", "phase": "activated", "source": None,
            "publication": {"manifest": manifest, "checkpoint": cp, "checkpointObjectId": str(uuid4())},
        },
    }
    profile = {
        "version": 1, "revision": str(uuid4()), "identity": {"accountId": account, "libraryId": lib_id},
        "title": "Drive ライブラリ",
        "origin": {"kind": "activated-installation", "source": "import", "controlId": ctl_id, "manifestId": manifest["id"], "installedScope": scope},
        "initialization": None,
        "remote": {"kind": "drive", "folderId": "drive-folder-123"},
    }
    peer = {"version": 1, "accountId": account, "peerId": str(uuid4())}
    with closing(sqlite3.connect(db_path)) as db:
        initialize_edit_schema(db)
        initialize_canonical_metadata(db)
        ns = canonical_json([account, lib_id, epoch])
        ident = canonical_json([account, lib_id])
        db.execute("INSERT INTO canonical_peers VALUES (?, ?)", (account, canonical_json(peer)))
        db.execute("INSERT INTO edit_roots VALUES (?, ?, ?)", (ns, lib_id, canonical_json(root)))
        db.execute("INSERT INTO edit_checkpoints VALUES (?, ?)", (ns, manifest["checkpointSha256"]))
        db.execute("INSERT INTO edit_datasets VALUES (?, ?, ?)", (ns, manifest["id"], canonical_json(manifest)))
        db.execute("INSERT INTO edit_dataset_controls VALUES (?, ?, ?, ?, ?, ?)", (ident, canonical_json(control), epoch, None, 0, canonical_json([epoch])))
        db.execute("INSERT INTO canonical_profiles VALUES (?, ?, ?, ?, ?)", (ident, account, lib_id, None, canonical_json(profile)))
        db.commit()

    targets = list_target_libraries(target_dir)
    assert targets[0]["storage"] == "google-drive"

    summary = migrate_legacy_library(src, target_dir, library_id=lib_id, translations="none")
    assert summary.pdfs_migrated == 1
    assert summary.translations_attached == 0
    assert summary.notebooks_migrated == 1
    assert summary.markdown_migrated == 1
    assert summary.attachments_migrated == 1

    # Every migrated batch stays upload='pending' so sync_once uploads all items + resources to Google Drive.
    from tools.migrate_legacy_data import _DirectSqliteAuthority
    repo = SqliteEditRepository(_DirectSqliteAuthority(db_path, account), scope)
    pending = repo.pending_records()
    assert len(pending) == 6  # 1 folders + 4 items + 1 links


def test_skipped_missing_pdf_does_not_create_dangling_attachment_or_link(tmp_path: Path):
    src = _build_legacy_v8_dir(tmp_path / "legacy-src")
    missing_pdf = "33" * 16
    with closing(sqlite3.connect(src / "library.sqlite3")) as con:
        con.execute(
            "INSERT INTO papers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                missing_pdf, "0" * 64, "Missing PDF", "missing.pdf",
                1, "ready", 0, "Research", "inline note for missing pdf", "2026-05-03 00:00:00",
                None, None, 0, "[]", "未読", None, None, None, "pdf", None,
            ),
        )
        con.execute(
            "INSERT INTO attachments VALUES (?,?,?,?,?,?,?,?)",
            ("att-orphan", missing_pdf, "md", "Orphan MD", "user", 0, "2026-05-03 00:00:00", "2026-05-03 00:00:00"),
        )
        con.execute("INSERT INTO item_links VALUES (?, ?)", (missing_pdf, "22" * 16))
        con.commit()

    target_dir = tmp_path / "target-data"
    target_dir.mkdir()
    summary = migrate_legacy_library(src, target_dir, title="SkipSafe", translations="none")
    assert summary.pdfs_migrated == 1
    assert summary.markdown_migrated == 1
    assert summary.links_migrated == 1
    assert any(missing_pdf in w for w in summary.warnings)
