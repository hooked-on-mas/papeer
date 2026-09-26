"""The connection list and the settings format that stores per-connection options."""
import json
from pathlib import Path

import pytest

from paperdesk.core.config import DEFAULT_BASE_URL, Settings
from paperdesk.providers import BACKENDS, ProviderBackend, create_provider, spec_for, specs


def test_every_connection_has_a_unique_spec():
    ids = [spec.id for spec in specs()]
    assert ids == ["codex", "claude", "antigravity", "api"]
    assert len(set(ids)) == len(ids)
    for provider_id, backend in BACKENDS.items():
        assert issubclass(backend, ProviderBackend)
        assert backend.spec.id == provider_id
        assert backend.spec.label and backend.spec.description
        # A CLI connection needs a path field and a login; an HTTP one needs a key.
        if backend.spec.kind == "cli":
            assert backend.spec.needs_login and [f.key for f in backend.spec.fields] == ["cli_path"]
        else:
            assert backend.spec.needs_api_key


def test_create_provider_picks_the_chosen_connection():
    for provider_id, backend in BACKENDS.items():
        provider = create_provider(Settings(provider=provider_id))
        assert type(provider) is backend
        assert provider.cancel is not None and not provider.cancel.is_set()


def test_unknown_connection_is_rejected():
    with pytest.raises(ValueError, match="不明な接続先"):
        spec_for("bogus")
    with pytest.raises(ValueError, match="不明な接続先"):
        create_provider(Settings(provider="bogus"))


def test_legacy_flat_settings_are_migrated(tmp_path: Path):
    (tmp_path / "settings.json").write_text(json.dumps({
        "provider": "gemini", "model": "gemini-3.8-flash", "base_url": "http://localhost:11434/v1",
        "codex_path": "C:/codex.exe", "claude_path": "", "gemini_path": "C:/agy.exe", "unknown": 1,
    }), "utf-8")
    settings = Settings.load(tmp_path)
    assert settings.provider == "antigravity"
    assert settings.options("antigravity") == {"cli_path": "C:/agy.exe"}
    assert settings.options("codex") == {"cli_path": "C:/codex.exe"}
    assert "claude" not in settings.provider_options
    assert settings.base_url == "http://localhost:11434/v1"

    settings.save(tmp_path)
    saved = json.loads((tmp_path / "settings.json").read_text("utf-8"))
    assert not {"codex_path", "claude_path", "gemini_path", "base_url", "api_key"} & saved.keys()
    assert saved["provider"] == "antigravity"
    assert saved["provider_options"]["antigravity"] == {
        "cli_path": "C:/agy.exe", "model": "gemini-3.8-flash", "reasoning_effort": ""}
    assert Settings.load(tmp_path).base_url == "http://localhost:11434/v1"


def test_base_url_defaults_for_every_connection():
    # Part of the translation cache identity, so it must not depend on the chosen connection.
    assert Settings().base_url == DEFAULT_BASE_URL
    assert Settings(provider="claude").base_url == DEFAULT_BASE_URL


def test_api_key_comes_from_the_environment(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("PAPERDESK_API_KEY", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "from-openai-env")
    assert Settings.load(tmp_path).api_key == "from-openai-env"
    monkeypatch.setenv("PAPERDESK_API_KEY", "from-paperdesk-env")
    assert Settings.load(tmp_path).api_key == "from-paperdesk-env"
