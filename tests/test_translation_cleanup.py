"""Translation leftovers: page previews that nothing shows any more, and interleaved.pdf built on demand."""
from __future__ import annotations

import json
import os
from pathlib import Path
import threading
from unittest.mock import patch

from fastapi.testclient import TestClient
import pymupdf as fitz
import pytest

from papeer.core import exports
from papeer.core.fileio import atomic_write_json
from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.providers import Cancelled
from papeer.translation.translation_preview import (
    PREVIOUS_CACHE, read_preview, remove_unused_runs, remove_unused_translation_runs, translated_page,
    translated_page_numbers)
from sidecar.app import app
from test_workflow import FakeProvider


def _pdf(path: Path, *texts: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with fitz.open() as pdf:
        for text in texts:
            pdf.new_page().insert_text((40, 70), text)
        pdf.save(path)


def _paper(folder: Path, run: str, complete, runs: dict[str, list[str]]) -> Path:
    """A paper folder whose preview names `run` (none when complete is None), with the given run folders."""
    folder.mkdir(parents=True)
    if complete is not None:
        atomic_write_json(folder / "translation-preview.json",
                          {"run_id": run, "pages": [1], "total_pages": 2, "complete": complete})
    for name, files in runs.items():
        for file in files:
            path = folder / "translation-pages" / name / file
            if file.endswith(".pdf"):
                _pdf(path, file)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("{}", "utf-8")
    return folder


def _contents(folder: Path) -> set[str]:
    pages = folder / "translation-pages"
    return {p.relative_to(pages).as_posix() for p in pages.rglob("*") if p.is_file()} if pages.exists() else set()


A, B, C = "a" * 32, "b" * 32, "c" * 32


def test_unfinished_run_is_kept_whole_and_other_runs_are_removed(tmp_path):
    folder = _paper(tmp_path / "p", A, False, {A: ["page-1.pdf", "previous-page-2.pdf", PREVIOUS_CACHE],
                                               B: ["page-1.pdf", PREVIOUS_CACHE]})
    (folder / "translation-pages" / "notes.txt").write_text("not a run", "utf-8")
    (folder / "translation-pages" / "not-a-run").mkdir()
    remove_unused_runs(folder)
    assert _contents(folder) == {f"{A}/page-1.pdf", f"{A}/previous-page-2.pdf", f"{A}/{PREVIOUS_CACHE}", "notes.txt"}
    # Only run folders are touched; an empty unknown folder is merely tidied away.
    assert not (folder / "translation-pages" / "not-a-run").exists()
    path, index = translated_page(folder, 0)
    assert path == folder / "translation-pages" / A / "page-1.pdf" and path.is_file() and index == 0


def test_finished_run_keeps_only_the_replaced_cache(tmp_path):
    folder = _paper(tmp_path / "p", A, True, {A: ["page-1.pdf", "assembled.pdf", PREVIOUS_CACHE], B: ["page-1.pdf"]})
    remove_unused_runs(folder)
    assert _contents(folder) == {f"{A}/{PREVIOUS_CACHE}"}
    # Without a cache to keep, translation-pages disappears altogether.
    folder = _paper(tmp_path / "q", A, True, {A: ["page-1.pdf"]})
    remove_unused_runs(folder)
    assert not (folder / "translation-pages").exists()


def test_runs_without_a_preview_are_removed_and_unreadable_previews_keep_everything(tmp_path):
    folder = _paper(tmp_path / "none", A, None, {A: ["page-1.pdf"]})
    remove_unused_runs(folder)
    assert not (folder / "translation-pages").exists()
    for index, text in enumerate(["{broken", json.dumps({"run_id": "../x"}), "[]"]):
        folder = _paper(tmp_path / f"bad{index}", A, None, {A: ["page-1.pdf"], B: ["page-1.pdf"]})
        (folder / "translation-preview.json").write_text(text, "utf-8")
        remove_unused_runs(folder)
        assert _contents(folder) == {f"{A}/page-1.pdf", f"{B}/page-1.pdf"}


def test_startup_removes_leftover_runs_of_every_paper(tmp_path, monkeypatch):
    root = tmp_path / "library"
    unfinished = _paper(root / "papers" / ("1" * 32), A, False, {A: ["page-1.pdf"], B: ["page-1.pdf"]})
    finished = _paper(root / "papers" / ("2" * 32), C, True, {C: ["page-1.pdf", PREVIOUS_CACHE], A: ["page-1.pdf"]})
    stray = _paper(root / "papers" / "not-a-paper", A, None, {B: ["page-1.pdf"]})
    remove_unused_translation_runs(tmp_path / "missing")  # No library yet: nothing to do.
    monkeypatch.setenv("PAPEER_DATA_DIR", str(root))
    with TestClient(app):
        pass
    assert _contents(unfinished) == {f"{A}/page-1.pdf"}
    # Only orphan runs go at startup; a complete run is tidied by the paper's next translation.
    assert _contents(finished) == {f"{C}/page-1.pdf", f"{C}/{PREVIOUS_CACHE}"}
    assert _contents(stray) == {f"{B}/page-1.pdf"}


def test_startup_cleanup_failure_does_not_stop_the_sidecar(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "library"))
    with patch("papeer.translation.translation_preview.remove_unused_translation_runs",
               side_effect=RuntimeError("unexpected")):
        with TestClient(app) as client:
            assert client.get("/health").status_code == 200
    assert "unexpected" in capsys.readouterr().err


def _three_page_paper(tmp_path):
    source = tmp_path / "source.pdf"
    _pdf(source, *(f"Original content on page {n}." for n in range(1, 4)))
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(source)
    return library, identity, library.folder(identity)


def test_failure_before_the_new_preview_is_saved_keeps_the_pages_the_reader_shows(tmp_path):
    library, identity, folder = _three_page_paper(tmp_path)
    provider = FakeProvider()
    service = PaperService(library, provider, threading.Event())
    provider.interrupt_after = 2  # Page 1 is done, page 2 is stopped.
    with pytest.raises(Cancelled):
        service.translate(identity)
    stopped = read_preview(folder)
    assert stopped["pages"] == [1] and not stopped["complete"]
    provider.interrupt_after = None
    cache = PaperFiles(folder).translation_cache
    failing = atomic_write_json

    def write(path, value):
        if Path(path) == cache:
            raise OSError("disk full")
        failing(path, value)

    with patch("papeer.core.service.atomic_write_json", side_effect=write), pytest.raises(OSError):
        service.translate(identity, {3})
    # The new run never became the preview, so its copies go and the stopped run stays.
    assert read_preview(folder)["run_id"] == stopped["run_id"]
    assert {p.name for p in (folder / "translation-pages").iterdir()} == {stopped["run_id"]}
    path, index = translated_page(folder, 0)
    with fitz.open(path) as pdf:
        assert "適応制御" in pdf[index].get_text()
    # Resuming finishes the translation, and then no page preview is left.
    report = service.translate(identity)
    assert report["translated_pages"] == [1, 2, 3]
    assert list((folder / "translation-pages").rglob("*.pdf")) == []
    assert translated_page(folder, 1) == (folder / "translated.pdf", 1)
    assert translated_page_numbers(folder, 3) == [1, 2, 3]


def test_interleaved_pdf_is_built_on_demand_reused_and_exported(tmp_path):
    folder = tmp_path / "paper"
    _pdf(folder / "original.pdf", "Original 1", "Original 2")
    _pdf(folder / "translated.pdf", "訳 1", "訳 2")
    files = PaperFiles(folder)
    # Exporting without a current copy builds straight to the destination and leaves none behind.
    exports.build_paired_pdf(files, "interleaved", tmp_path / "first.pdf")
    assert not files.interleaved_pdf.exists()
    with fitz.open(tmp_path / "first.pdf") as pdf:
        assert pdf.page_count == 4 and "Original 2" in pdf[2].get_text()
    built = exports.interleaved_cache(files)
    assert built == files.interleaved_pdf and exports.interleaved_is_current(files)
    with patch("papeer.core.exports.interleaved_pdf", side_effect=AssertionError("rebuilt")):
        assert exports.interleaved_cache(files) == built
        exports.build_paired_pdf(files, "interleaved", tmp_path / "copy.pdf")
    assert (tmp_path / "copy.pdf").read_bytes() == built.read_bytes()
    # A copy older than the translation is stale.
    earlier = files.translated_pdf.stat().st_mtime_ns - 10**9
    os.utime(built, ns=(earlier, earlier))
    assert not exports.interleaved_is_current(files)
    progress = []
    exports.interleaved_cache(files, progress.append)
    assert progress and exports.interleaved_is_current(files)
    exports.discard_interleaved(files)
    assert not files.interleaved_pdf.exists()
    exports.discard_interleaved(files)  # Already gone: nothing to do.
