import json
from pathlib import Path
import sys
import zipfile

from papeer.core.paths import app_env, data_directory
from papeer.core.glossary_io import import_glossary
from papeer.core.reading_tools import create_backup, restore_backup
from papeer.core.storage import Library


def test_data_directory_no_longer_reads_the_paperdesk_folder(tmp_path, monkeypatch):
    # PaperDesk kept its library in %LOCALAPPDATA%\PaperDesk; one still there is expected to have been moved.
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.delenv("PAPEER_DATA_DIR", raising=False)
    monkeypatch.delenv("PAPERDESK_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    (tmp_path / "PaperDesk" / "papers" / "a").mkdir(parents=True)
    assert data_directory() == tmp_path / "Papeer"
    monkeypatch.setenv("PAPERDESK_DATA_DIR", str(tmp_path / "old"))
    assert data_directory() == tmp_path / "old"
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path / "new"))
    assert data_directory() == tmp_path / "new"


def test_new_env_overrides_legacy_including_empty_token(monkeypatch):
    monkeypatch.delenv("PAPEER_TOKEN", raising=False)
    monkeypatch.setenv("PAPERDESK_TOKEN", "legacy")
    assert app_env("TOKEN") == "legacy"
    monkeypatch.setenv("PAPEER_TOKEN", "")
    assert app_env("TOKEN") == ""


def test_legacy_glossary(tmp_path):
    path = tmp_path / "old.json"
    terms = [{"source": "control", "target": "制御"}]
    path.write_text(json.dumps({"format": "paperdesk-glossary", "version": 1, "terms": terms}))
    assert import_glossary(path, [])['terms'] == terms


def test_legacy_backup_restores_library(tmp_path):
    lib = Library(tmp_path / "library")
    lib.import_pdf(Path(__file__).parent / "fixtures" / "sample.pdf")
    current, legacy = tmp_path / "current.zip", tmp_path / "legacy.zip"
    create_backup(lib, current)
    with zipfile.ZipFile(current) as source, zipfile.ZipFile(legacy, "w") as target:
        for name in source.namelist():
            target.writestr(name.replace("papeer-backup.json", "paperdesk-backup.json"), source.read(name))
    previous = restore_backup(lib, legacy)
    assert previous.is_dir()
    assert (lib.root / "library.sqlite3").is_file()
