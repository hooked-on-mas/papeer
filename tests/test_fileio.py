import json
import os
from pathlib import Path
import re
import threading

import pytest

from papeer.core import fileio
from papeer.core.fileio import atomic_output, atomic_write_bytes, atomic_write_json, atomic_write_text, replace_file

ROOT = Path(__file__).resolve().parents[1]


def test_text_is_written_as_given_and_replaces_the_old_file(tmp_path):
    target = tmp_path / "note.md"
    target.write_bytes(b"old")
    atomic_write_text(target, "一行目\n二行目\n")
    # LF stays LF on Windows too, so synced files are byte-identical across devices.
    assert target.read_bytes() == "一行目\n二行目\n".encode("utf-8")
    assert list(tmp_path.iterdir()) == [target]


def test_json_keeps_japanese_readable(tmp_path):
    target = tmp_path / "settings.json"
    atomic_write_json(target, {"model": "日本語"})
    assert "日本語" in target.read_text("utf-8")
    assert json.loads(target.read_text("utf-8")) == {"model": "日本語"}
    atomic_write_json(target, {"a": 1}, indent=None)
    assert target.read_text("utf-8") == '{"a": 1}'


def test_failed_write_keeps_the_old_file_and_removes_the_temporary(tmp_path):
    target = tmp_path / "document.json"
    target.write_text("old", "utf-8")
    with pytest.raises(RuntimeError):
        with atomic_output(target) as temporary:
            temporary.write_text("half", "utf-8")
            raise RuntimeError("crash")
    assert target.read_text("utf-8") == "old"
    assert list(tmp_path.iterdir()) == [target]
    with pytest.raises(TypeError):
        atomic_write_json(target, {"unserializable": object()})
    assert target.read_text("utf-8") == "old"
    assert list(tmp_path.iterdir()) == [target]


def test_missing_folder_is_not_created(tmp_path):
    # A deleted paper's folder must not come back because a late write arrived.
    with pytest.raises(FileNotFoundError):
        atomic_write_text(tmp_path / "deleted" / "note.md", "x")
    assert not (tmp_path / "deleted").exists()


def test_concurrent_writers_use_their_own_temporary_files(tmp_path):
    target = tmp_path / "translation-preview.json"
    names = []
    with atomic_output(target) as first, atomic_output(target) as second:
        names += [first, second]
        assert first != second and first.parent == second.parent == tmp_path
        assert not first.name.endswith(".json") and not second.name.endswith(".json")
        first.write_text("first", "utf-8")
        second.write_text("second", "utf-8")
    assert target.read_text("utf-8") == "first"  # The outer block finishes last.
    assert list(tmp_path.iterdir()) == [target]

    errors = []

    def write(index):
        try:
            for _ in range(20):
                atomic_write_json(target, {"writer": index})
        except Exception as exc:  # noqa: BLE001  # pragma: no cover - reported below
            errors.append(exc)

    threads = [threading.Thread(target=write, args=(index,)) for index in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert not errors
    assert json.loads(target.read_text("utf-8"))["writer"] in range(4)
    assert list(tmp_path.iterdir()) == [target]


def test_data_is_flushed_before_the_replace(tmp_path, monkeypatch):
    events = []
    real_fsync, real_replace = os.fsync, os.replace
    monkeypatch.setattr(fileio.os, "fsync", lambda fd: (events.append("fsync"), real_fsync(fd))[1])
    monkeypatch.setattr(fileio.os, "replace", lambda a, b: (events.append("replace"), real_replace(a, b))[1])
    atomic_write_bytes(tmp_path / "a.bin", b"data")
    assert events[:2] == ["fsync", "replace"]
    assert (tmp_path / "a.bin").read_bytes() == b"data"


def test_replace_waits_while_windows_briefly_locks_the_target(tmp_path, monkeypatch):
    source, target = tmp_path / "new.pdf", tmp_path / "translated.pdf"
    source.write_bytes(b"new")
    target.write_bytes(b"old")
    real_replace = os.replace
    attempts = []

    def locked_twice(a, b):
        attempts.append(1)
        if len(attempts) <= 2:
            raise PermissionError("in use")
        real_replace(a, b)

    monkeypatch.setattr(fileio.os, "replace", locked_twice)
    monkeypatch.setattr(fileio.time, "sleep", lambda _: None)
    replace_file(source, target)
    assert len(attempts) == 3 and target.read_bytes() == b"new" and not source.exists()

    def always_locked(a, b):
        raise PermissionError("in use")

    source.write_bytes(b"newer")
    monkeypatch.setattr(fileio.os, "replace", always_locked)
    with pytest.raises(PermissionError):
        replace_file(source, target)
    assert target.read_bytes() == b"new"


def test_library_code_writes_files_only_through_fileio():
    # Direct write_text / fixed ".tmp" names were torn or clashed when two writers raced.
    allowed = {
        "papeer/core/fileio.py",
        "papeer/core/code_version.py",  # Build step writing code-version.txt.
        "papeer/providers/codex.py",  # Schema file inside a private temporary directory.
    }
    # PyMuPDF's TextWriter.write_text(page, ...) draws on a PDF page, not into a file; WinRT's
    # DataWriter.write_bytes (papeer.layout.ocr_engines, named buffer_writer) fills a buffer in memory.
    pattern = re.compile(r"\.write_text\((?!page\b)|(?<!buffer_writer)\.write_bytes\(|with_suffix\([^)]*\.tmp|\bdef (save_json|safe_replace)\b")
    offenders = []
    for folder in ("papeer", "sidecar"):
        for path in sorted((ROOT / folder).rglob("*.py")):
            relative = path.relative_to(ROOT).as_posix()
            if relative in allowed:
                continue
            for number, line in enumerate(path.read_text("utf-8").splitlines(), 1):
                if pattern.search(line):
                    offenders.append(f"{relative}:{number}: {line.strip()}")
    assert not offenders, "papeer.core.fileio の atomic_write_* を使ってください:\n" + "\n".join(offenders)


def test_leftover_temporary_files_are_recognized(tmp_path):
    target = tmp_path / "document.json"
    with atomic_output(target) as temporary:
        assert fileio.is_temporary(temporary)
    for name in ("document.json", "note.md", "settings.tmp", ".gitignore", "a.papeer-sync"):
        assert not fileio.is_temporary(tmp_path / name)
