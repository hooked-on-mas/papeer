"""Connection options that point at this PC (cli_path, base_url) stay on this PC.

They live in the device folder (%LOCALAPPDATA%\\PapeerSync), never in the library's settings.json,
so neither a synced library nor a restored backup can choose what this PC runs.
"""
from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import shutil
import threading
import time

from fastapi.testclient import TestClient
import pytest

from papeer.core import drive_sync as sync
from papeer.core.config import DEFAULT_BASE_URL, Settings, device_settings_path
from papeer.core.paths import device_directory
from papeer.core.reading_tools import create_backup, restore_backup
from papeer.core.storage import Library

FIXTURE = Path(__file__).parent / "fixtures/sample.pdf"


def read(path: Path) -> dict:
    return json.loads(path.read_text("utf-8"))


def test_device_folder_is_isolated_per_test(isolated_app_data):
    assert device_directory() == isolated_app_data / "PapeerSync"
    assert device_settings_path().is_relative_to(isolated_app_data)


def test_existing_library_settings_are_moved_to_the_device_once(tmp_path):
    library = tmp_path / "data"
    library.mkdir()
    (library / "settings.json").write_text(json.dumps({
        "provider": "claude", "model": "claude-x", "codex_path": "C:/old/codex.exe", "api_base": "http://localhost:1234/v1",
        "provider_options": {"claude": {"cli_path": "C:/claude.exe", "model": "claude-x", "reasoning_effort": "high"}},
    }), "utf-8")

    settings = Settings.load(library)
    assert settings.options("claude") == {"cli_path": "C:/claude.exe", "model": "claude-x", "reasoning_effort": "high"}
    assert settings.options("codex") == {"cli_path": "C:/old/codex.exe"}
    assert settings.base_url == "http://localhost:1234/v1"

    # The library keeps what it shares; the paths and the URL are now only on this PC.
    saved = read(library / "settings.json")
    assert saved["provider"] == "claude" and saved["model"] == "claude-x"
    assert saved["provider_options"] == {"claude": {"model": "claude-x", "reasoning_effort": "high"}}
    assert not {"codex_path", "api_base", "base_url", "api_key"} & saved.keys()
    device = read(device_settings_path())
    assert device["migrated"] is True
    assert device["provider_options"] == {"claude": {"cli_path": "C:/claude.exe"}, "codex": {"cli_path": "C:/old/codex.exe"},
                                          "api": {"base_url": "http://localhost:1234/v1"}}

    # Idempotent: loading again changes neither file and gives the same settings.
    library_text, device_text = (library / "settings.json").read_text("utf-8"), device_settings_path().read_text("utf-8")
    assert Settings.load(library) == settings
    assert (library / "settings.json").read_text("utf-8") == library_text
    assert device_settings_path().read_text("utf-8") == device_text

    # Only once: device options that appear in the library afterwards are ignored.
    saved["provider_options"]["claude"]["cli_path"] = "C:/other/claude.exe"
    saved["provider_options"]["api"] = {"base_url": "http://other.example/v1"}
    (library / "settings.json").write_text(json.dumps(saved), "utf-8")
    again = Settings.load(library)
    assert again.options("claude")["cli_path"] == "C:/claude.exe"
    assert again.base_url == "http://localhost:1234/v1"


def test_saving_keeps_device_options_out_of_the_library(tmp_path):
    settings = Settings(provider="api", model="local-model", provider_options={
        "api": {"base_url": "http://localhost:11434/v1", "model": "local-model"}, "codex": {"cli_path": "C:/codex.exe"}})
    settings.save(tmp_path)
    saved = read(tmp_path / "settings.json")
    assert saved["provider_options"] == {"api": {"model": "local-model"}}
    assert read(device_settings_path())["provider_options"] == {
        "api": {"base_url": "http://localhost:11434/v1"}, "codex": {"cli_path": "C:/codex.exe"}}
    assert replace(Settings.load(tmp_path), api_key="") == settings


def test_first_start_without_settings_ignores_later_library_paths(tmp_path):
    assert Settings.load(tmp_path).options("codex") == {}
    assert read(device_settings_path())["migrated"] is True
    (tmp_path / "settings.json").write_text(json.dumps({"provider_options": {"codex": {"cli_path": "C:/evil.exe"}}}), "utf-8")
    assert Settings.load(tmp_path).options("codex") == {}


def run(lib: Library, **choice):
    return sync.sync(lib, sync.FolderDrive(Path(sync.read_state(lib.root)["folder"])),
                     threading.Event(), lambda _: None, **choice)


def test_synced_settings_from_another_pc_cannot_set_paths(tmp_path, monkeypatch):
    pc_a, pc_b = tmp_path / "pc-a", tmp_path / "pc-b"
    a, b = Library(tmp_path / "a"), Library(tmp_path / "b")
    folder_a, folder_b = tmp_path / "drive-a", tmp_path / "drive-b"

    monkeypatch.setenv("LOCALAPPDATA", str(pc_b))
    Settings(provider="codex", model="b-model", provider_options={"codex": {"cli_path": "C:/b/codex.exe"}}).save(b.root)
    sync.connect(b.root, str(folder_b))

    # PC A runs an older Papeer that still writes its paths into the library.
    monkeypatch.setenv("LOCALAPPDATA", str(pc_a))
    (a.root / "settings.json").write_text(json.dumps({
        "provider": "api", "model": "a-model", "timeout_seconds": 600,
        "provider_options": {"codex": {"cli_path": "C:/evil/codex.exe"}, "api": {"base_url": "http://evil.example/v1"}},
    }), "utf-8")
    sync.connect(a.root, str(folder_a))
    assert run(a)["status"] == "synced"
    shutil.copytree(folder_a, folder_b, dirs_exist_ok=True)  # Simulate Drive for desktop.

    monkeypatch.setenv("LOCALAPPDATA", str(pc_b))
    assert run(b)["status"] == "conflict"
    head = sync.FolderDrive(folder_b).revisions()[0]["id"]
    assert run(b, choice=head, expected_heads=[head])["status"] == "synced"
    assert "evil" in (b.root / "settings.json").read_text("utf-8")  # The file arrived as sent...
    settings = Settings.load(b.root)
    # ...but only the shared settings are taken from it.
    assert (settings.provider, settings.model, settings.timeout_seconds) == ("api", "a-model", 600)
    assert settings.options("codex") == {"cli_path": "C:/b/codex.exe"}
    assert settings.base_url == DEFAULT_BASE_URL


@pytest.fixture
def library(tmp_path):
    lib = Library(tmp_path / "data")
    lib.import_pdf(FIXTURE)
    return lib


def test_restore_keeps_current_settings_and_prompts_unless_asked(library, tmp_path):
    prompts = library.root / "prompts"
    prompts.mkdir()
    (prompts / "translation.txt").write_text("バックアップ時のプロンプト", "utf-8")
    Settings(model="backup-model", provider_options={"codex": {"cli_path": "C:/codex.exe"}}).save(library.root)
    backup = tmp_path / "snapshot.zip"
    create_backup(library, backup)

    shutil.rmtree(prompts)
    (library.root / "prompts").mkdir()
    (library.root / "prompts" / "chat_answer.txt").write_text("現在のプロンプト", "utf-8")
    Settings(model="current-model", provider_options={"codex": {"cli_path": "C:/codex.exe"}}).save(library.root)

    restore_backup(library, backup, import_settings=False)
    assert Settings.load(library.root).model == "current-model"
    assert sorted(p.name for p in (library.root / "prompts").iterdir()) == ["chat_answer.txt"]

    restore_backup(library, backup, import_settings=True)
    assert Settings.load(library.root).model == "backup-model"
    assert sorted(p.name for p in (library.root / "prompts").iterdir()) == ["translation.txt"]
    # The device's own path was never part of the backup.
    assert "cli_path" not in (library.root / "settings.json").read_text("utf-8")
    assert Settings.load(library.root).options("codex") == {"cli_path": "C:/codex.exe"}


def test_restore_without_current_settings_leaves_none(library, tmp_path):
    Settings(model="backup-model").save(library.root)
    backup = tmp_path / "snapshot.zip"
    create_backup(library, backup)
    (library.root / "settings.json").unlink()
    restore_backup(library, backup, import_settings=False)
    assert not (library.root / "settings.json").exists()


@pytest.mark.parametrize("model", ["gpt-5.6-sol", "llama3.1:8b", "hf.co/user/model-GGUF:Q4_K_M", "claude_opus", "",
                                   "opus[1m]", "claude-sonnet-4-5[1m]", "claude-opus-4-1@20250805", "model@q4_k_m",
                                   "llama3+tools"])
def test_model_names_that_are_accepted(model):
    assert Settings(model=model).model == model


@pytest.mark.parametrize("model", ["-c", "--config=x", "gpt 5", "model;rm", "a\nb", "モデル", "modèle",
                                   "a&b", "a|b", "%PATH%", "a^b", '"quoted"'])
def test_model_names_that_are_rejected(model):
    with pytest.raises(ValueError, match="モデル名"):
        Settings(model=model)
    with pytest.raises(ValueError, match="モデル名"):
        Settings(provider_options={"codex": {"model": model}})


def test_bad_saved_model_falls_back_instead_of_breaking_settings(tmp_path):
    (tmp_path / "settings.json").write_text(json.dumps(
        {"model": "--dangerous", "provider_options": {"claude": {"model": "-x", "reasoning_effort": "low"}}}), "utf-8")
    settings = Settings.load(tmp_path)
    # The connection's own default, not Settings.model's Codex model handed to another CLI.
    assert settings.model == ""
    assert settings.options("claude") == {"reasoning_effort": "low"}


def test_settings_api_rejects_unsafe_model_names(tmp_path, monkeypatch):
    from sidecar.app import app
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    client = TestClient(app)
    assert client.put("/api/settings", json={"model": "--config=x"}).status_code == 400
    assert client.put("/api/settings", json={"provider_options": {"codex": {"model": "-c"}}}).status_code == 400
    assert client.put("/api/settings", json={"model": "gpt-5.6-sol"}).status_code == 200


def test_unreadable_device_file_counts_as_migrated(tmp_path, capsys):
    device_settings_path().parent.mkdir(parents=True)
    device_settings_path().write_text("{broken", "utf-8")
    library = {"provider_options": {"codex": {"cli_path": "C:/synced/codex.exe"}}}
    (tmp_path / "settings.json").write_text(json.dumps(library), "utf-8")
    settings = Settings.load(tmp_path)
    # The library's value is not trusted again, and the settings API keeps working.
    assert settings.options("codex") == {}
    assert "PCごとの設定" in capsys.readouterr().err
    assert read(tmp_path / "settings.json") == library
    # Saving from the settings dialog repairs the device file.
    Settings(provider_options={"codex": {"cli_path": "C:/codex.exe"}}).save(tmp_path)
    assert Settings.load(tmp_path).options("codex") == {"cli_path": "C:/codex.exe"}


def test_unwritable_device_folder_leaves_library_settings_for_next_time(tmp_path, capsys):
    device_directory().parent.mkdir(parents=True, exist_ok=True)
    device_directory().write_text("a file where the folder should be", "utf-8")
    text = json.dumps({"model": "m", "provider_options": {"codex": {"cli_path": "C:/codex.exe", "model": "m"}}})
    (tmp_path / "settings.json").write_text(text, "utf-8")
    settings = Settings.load(tmp_path)
    assert settings.options("codex") == {"cli_path": "C:/codex.exe", "model": "m"}
    assert "保存できませんでした" in capsys.readouterr().err
    # Nothing moved, so nothing is lost: the migration runs again once the folder is writable.
    assert (tmp_path / "settings.json").read_text("utf-8") == text
    device_directory().unlink()
    assert Settings.load(tmp_path).options("codex") == {"cli_path": "C:/codex.exe", "model": "m"}
    assert "cli_path" not in (tmp_path / "settings.json").read_text("utf-8")


def test_restore_api_keeps_current_settings_by_default(library, tmp_path, monkeypatch):
    from sidecar import deps
    from sidecar.app import app
    from sidecar.jobs import JobManager
    monkeypatch.setenv("PAPEER_DATA_DIR", str(library.root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setattr("sidecar.deps.job_manager", JobManager())
    Settings(model="backup-model").save(library.root)
    backup = tmp_path / "snapshot.zip"
    create_backup(library, backup)
    Settings(model="current-model").save(library.root)

    with TestClient(app) as client:
        def restore(body):
            job = deps.job_manager.get_job(client.post("/api/restore", json=body).json()["job_id"])
            deadline = time.monotonic() + 10
            while job.running and time.monotonic() < deadline:
                time.sleep(.02)
            assert job.status == "succeeded", job.error

        restore({"path": str(backup)})
        assert client.get("/api/settings").json()["model"] == "current-model"
        restore({"path": str(backup), "import_settings": True})
        assert client.get("/api/settings").json()["model"] == "backup-model"


def test_settings_update_keeps_what_was_left_out_and_merges_connection_options():
    saved = Settings(model="saved-model", timeout_seconds=300,
                     provider_options={"codex": {"cli_path": "C:/codex.exe", "model": "m"}, "api": {"base_url": "http://x"}})
    updated = saved.updated({"reasoning_effort": "high", "provider_options": {"codex": {"model": "n"}}})
    assert (updated.model, updated.timeout_seconds, updated.reasoning_effort) == ("saved-model", 300, "high")
    assert updated.provider_options == {"codex": {"cli_path": "C:/codex.exe", "model": "n"}, "api": {"base_url": "http://x"}}
    assert saved.provider_options["codex"]["model"] == "m"  # The saved settings are left as they were.
    with pytest.raises(ValueError):
        saved.updated({"reasoning_effort": "extreme"})


# --- Keys of settings.json this version does not know (written by a newer Papeer on another PC) ---

def test_unknown_keys_are_reported_and_dropped_only_by_saving(tmp_path):
    (tmp_path / "settings.json").write_text(json.dumps({
        "provider": "claude", "model": "claude-x", "timeout_seconds": 600, "translation_concurrency": 2,
        "reasoning_effort": "high", "provider_options": {"claude": {"model": "claude-x", "future_option": "1"}},
        "future_setting": True, "another_new": {"a": 1},
    }), "utf-8")
    settings, unknown = Settings.load_with_unknown_keys(tmp_path)
    assert unknown == ["another_new", "future_setting"]
    assert settings == Settings.load(tmp_path)
    assert settings.provider == "claude" and settings.timeout_seconds == 600
    # Loading leaves the file as it is; saving writes only what this version knows.
    assert read(tmp_path / "settings.json")["future_setting"] is True
    settings.save(tmp_path)
    saved = read(tmp_path / "settings.json")
    assert not {"future_setting", "another_new"} & saved.keys()
    # An option this version does not know inside provider_options is kept, so it is not reported.
    assert saved["provider_options"]["claude"]["future_option"] == "1"
    assert Settings.load_with_unknown_keys(tmp_path)[1] == []


def test_older_and_migrated_keys_are_not_unknown(tmp_path):
    # Every field, the flat per-connection keys from before provider_options, the renamed provider,
    # and an api_key an old version may have written: all read (or knowingly dropped) by this version.
    (tmp_path / "settings.json").write_text(json.dumps({
        "provider": "gemini", "model": "m", "reasoning_effort": "", "timeout_seconds": 900, "translation_concurrency": 0,
        "api_key": "old", "provider_options": {"gemini": {"model": "m"}},
        "codex_path": "C:/codex.exe", "claude_path": "C:/claude.exe", "gemini_path": "C:/agy.exe",
        "base_url": "http://localhost:1234/v1", "api_base": "http://localhost:1234/v1",
    }), "utf-8")
    settings, unknown = Settings.load_with_unknown_keys(tmp_path)
    assert unknown == []
    assert settings.provider == "antigravity"
    assert Settings.load_with_unknown_keys(tmp_path / "missing")[1] == []


def test_moving_device_options_keeps_unknown_keys_for_the_notice(tmp_path):
    # The first load on this PC rewrites settings.json without the device options; that is not a save
    # by the user, so a newer version's keys stay (and are reported).
    (tmp_path / "settings.json").write_text(json.dumps({
        "model": "m", "codex_path": "C:/codex.exe", "future_setting": 1}), "utf-8")
    assert Settings.load_with_unknown_keys(tmp_path)[1] == ["future_setting"]
    saved = read(tmp_path / "settings.json")
    assert "codex_path" not in saved and saved["future_setting"] == 1
    assert read(device_settings_path())["provider_options"] == {"codex": {"cli_path": "C:/codex.exe"}}


def test_settings_api_reports_unknown_keys_and_logs_dropping_them(tmp_path, monkeypatch, caplog):
    from sidecar.app import app
    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    (tmp_path / "settings.json").write_text(json.dumps({"model": "m", "future_setting": 1, "codex_path": ""}), "utf-8")
    client = TestClient(app)
    body = client.get("/api/settings").json()
    assert body["unknown_keys"] == ["future_setting"]
    assert body["model"] == "m"
    # Sending the list back changes nothing: PUT ignores it.
    with caplog.at_level("WARNING", logger="papeer.sidecar"):
        assert client.put("/api/settings", json={**body, "model": "n"}).status_code == 200
    assert "future_setting" in caplog.text
    assert "unknown_keys" not in read(tmp_path / "settings.json")
    after = client.get("/api/settings").json()
    assert after["unknown_keys"] == [] and after["model"] == "n"
    caplog.clear()
    with caplog.at_level("WARNING", logger="papeer.sidecar"):
        assert client.put("/api/settings", json={"model": "o"}).status_code == 200
    assert "削除" not in caplog.text
