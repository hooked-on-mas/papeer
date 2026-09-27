"""The translation state stored with a paper (papers.status) is a code, decided in one place."""
from contextlib import closing
from pathlib import Path
import sqlite3
from unittest.mock import patch

from fastapi.testclient import TestClient
import pytest

from papeer.core.storage import SCHEMA_VERSION, Library, database_version
from papeer.core.translation_status import LEGACY_LABELS, TranslationStatus, stored_status, translation_status
from sidecar import deps
from sidecar.app import app


def test_translation_status_decides_the_stored_code():
    assert translation_status(running=True) == TranslationStatus.TRANSLATING
    finished = {"untranslated_pages": [], "skipped_blocks": []}
    assert translation_status(report=finished) == TranslationStatus.TRANSLATED
    assert translation_status(report={**finished, "untranslated_pages": [3]}) == TranslationStatus.PARTIAL
    assert translation_status(report={**finished, "skipped_blocks": ["p2b4"]}) == TranslationStatus.PARTIAL
    # Stopped by a cancel or an error: resumable only when some translated text was saved.
    assert translation_status(resumable=True) == TranslationStatus.RESUMABLE
    assert translation_status() == TranslationStatus.INCOMPLETE
    assert {code.value for code in TranslationStatus} == {
        "not_translated", "translating", "partial", "resumable", "incomplete", "translated"}


def test_the_library_stores_codes_only(tmp_path):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(Path(__file__).parent / "fixtures" / "sample.pdf")
    assert lib.paper(identity)["status"] == "not_translated"
    lib.update(identity, status=TranslationStatus.PARTIAL)
    assert lib.paper(identity)["status"] == "partial"
    for value in ("翻訳済み", "done", ""):
        with pytest.raises(ValueError):
            lib.update(identity, status=value)
    assert lib.paper(identity)["status"] == "partial"


def test_labels_written_after_the_conversion_are_read_as_codes(tmp_path):
    # Papeer up to 0.2.0 opens a converted database without checking its version, so a PC still running it
    # may write a label there (and a sync bring it here), where no migration runs again.
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(Path(__file__).parent / "fixtures" / "sample.pdf")
    assert database_version(lib.root / "library.sqlite3") == SCHEMA_VERSION
    for value, code in [*LEGACY_LABELS.items(), ("謎の状態", "not_translated"), (None, "not_translated")]:
        with closing(sqlite3.connect(lib.root / "library.sqlite3")) as db, db:
            db.execute("UPDATE papers SET status=? WHERE id=?", (value or "", identity))
        assert lib.paper(identity)["status"] == code
        assert [paper["status"] for paper in lib.papers()] == [code]
        assert stored_status(value) == code


def test_the_api_returns_codes_for_labels_in_the_database(tmp_path):
    with patch.dict("os.environ", {"PAPEER_DATA_DIR": str(tmp_path), "PAPEER_TOKEN": "", "PAPEER_DEV_NO_AUTH": "1"}):
        client = TestClient(app)
        lib = Library(deps.get_data_dir())
        identity, _ = lib.import_pdf(Path(__file__).parent / "fixtures" / "sample.pdf")
        with closing(sqlite3.connect(lib.root / "library.sqlite3")) as db, db:
            db.execute("UPDATE papers SET status='翻訳未完了' WHERE id=?", (identity,))
        assert [paper["status"] for paper in client.get("/api/papers").json()] == ["incomplete"]
        assert client.get(f"/api/papers/{identity}").json()["status"] == "incomplete"
