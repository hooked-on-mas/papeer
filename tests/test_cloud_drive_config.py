"""Public desktop client configuration and safe build-time overrides, separate from user tokens."""
import json
import sys

import pytest

from papeer.core import cloud_drive_config as config
from papeer.core.code_version import bundle_version

CLIENT = "123-desktop.apps.googleusercontent.com"


@pytest.fixture(autouse=True)
def public_config(tmp_path, monkeypatch):
    path = tmp_path / "public.json"
    path.write_text(json.dumps({"desktop_client_id": CLIENT}), "utf-8")
    monkeypatch.setattr(config, "PUBLIC_CONFIG", path)
    for name in (config.CONFIG_FILE_ENV, config.CLIENT_ID_ENV, config.CLIENT_SECRET_ENV):
        monkeypatch.delenv(name, raising=False)
    return path


def test_public_client_without_secret_requirement_is_ready(public_config, tmp_path):
    credentials = config.desktop_oauth()
    assert credentials.client_id == CLIENT
    assert credentials.configured and not credentials.client_secret
    assert config.setup_status() == {"configured": True, "setup_error": None}
    config.write_bundle(tmp_path)
    assert json.loads((tmp_path / config.BUNDLE_CONFIG).read_text("utf-8")) == {"client_id": CLIENT}


def test_known_client_requirement_blocks_incomplete_builds_and_not_another_client(public_config, monkeypatch, tmp_path, capsys):
    public_config.write_text(json.dumps({"desktop_client_id": CLIENT, "desktop_client_secret_required": True}), "utf-8")
    assert not config.desktop_oauth().configured
    assert not config.setup_status()["configured"]
    assert "更新" in config.setup_status()["setup_error"]
    monkeypatch.setattr(sys, "argv", ["cloud_drive_config", "--require-configured"])
    assert config.main() == 1
    assert "ビルド設定" in capsys.readouterr().err
    monkeypatch.setenv(config.CLIENT_SECRET_ENV, "developer-owned-value")
    assert config.desktop_oauth().configured
    assert config.main() == 0
    assert "developer-owned-value" not in json.dumps(config.setup_status())
    config.write_bundle(tmp_path)
    assert json.loads((tmp_path / config.BUNDLE_CONFIG).read_text("utf-8"))["client_secret"] == "developer-owned-value"
    monkeypatch.delenv(config.CLIENT_SECRET_ENV)
    monkeypatch.setenv(config.CLIENT_ID_ENV, "456-other.apps.googleusercontent.com")
    assert config.desktop_oauth().configured and not config.desktop_oauth().requires_secret


def test_missing_or_bad_build_configuration_does_not_ask_user_for_credentials(public_config):
    public_config.write_text('{"desktop_client_id":""}', "utf-8")
    assert not config.setup_status()["configured"]
    assert "更新" in config.setup_status()["setup_error"]
    public_config.write_text('{"desktop_client_id":"not a client"}', "utf-8")
    assert not config.setup_status()["configured"]
    assert "not a client" not in config.setup_status()["setup_error"]


def test_developer_file_and_env_override_are_not_exposed_in_status(tmp_path, monkeypatch):
    path = tmp_path / "credentials.json"
    path.write_text(json.dumps({"installed": {"client_id": "456-fork.apps.googleusercontent.com",
        "client_secret": "private-desktop-value", "token_uri": "https://untrusted.invalid"}}), "utf-8")
    monkeypatch.setenv(config.CONFIG_FILE_ENV, str(path))
    credentials = config.desktop_oauth()
    assert credentials.client_id == "456-fork.apps.googleusercontent.com"
    assert credentials.client_secret == "private-desktop-value"
    assert "private-desktop-value" not in repr(credentials)
    assert "private-desktop-value" not in json.dumps(config.setup_status())
    config.write_bundle(tmp_path)
    assert json.loads((tmp_path / config.BUNDLE_CONFIG).read_text("utf-8"))["client_secret"] == "private-desktop-value"
    monkeypatch.setenv(config.CLIENT_ID_ENV, "789-override.apps.googleusercontent.com")
    assert config.desktop_oauth().client_id == "789-override.apps.googleusercontent.com"
    config.write_bundle(tmp_path)
    assert json.loads((tmp_path / config.BUNDLE_CONFIG).read_text("utf-8")) == {
        "client_id": "789-override.apps.googleusercontent.com"}


@pytest.mark.parametrize("source", ["file", "bundle"])
@pytest.mark.parametrize(("override_id", "override_secret", "expected_secret"), [
    ("789-other.apps.googleusercontent.com", None, ""),
    ("789-other.apps.googleusercontent.com", "", ""),
    ("789-other.apps.googleusercontent.com", "new-secret", "new-secret"),
    (None, None, "old-secret"),
    ("456-fork.apps.googleusercontent.com", None, "old-secret"),
    (None, "", ""),
    (None, "  ", ""),
])
def test_overrides_do_not_mix_clients_or_restore_explicitly_cleared_secrets(
    tmp_path, monkeypatch, source, override_id, override_secret, expected_secret,
):
    original_id = "456-fork.apps.googleusercontent.com"
    path = tmp_path / config.BUNDLE_NAME
    path.write_text(json.dumps({"client_id": original_id, "client_secret": "old-secret"}), "utf-8")
    if source == "file":
        monkeypatch.setenv(config.CONFIG_FILE_ENV, str(path))
    else:
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    if override_id is not None:
        monkeypatch.setenv(config.CLIENT_ID_ENV, override_id)
    if override_secret is not None:
        monkeypatch.setenv(config.CLIENT_SECRET_ENV, override_secret)
    credentials = config.desktop_oauth()
    assert credentials.client_id == (override_id or original_id)
    assert credentials.client_secret == expected_secret


def test_frozen_app_uses_the_bundled_configuration(tmp_path, monkeypatch):
    (tmp_path / config.BUNDLE_NAME).write_text(json.dumps({"client_id": "456-release.apps.googleusercontent.com"}), "utf-8")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    assert config.desktop_oauth().client_id == "456-release.apps.googleusercontent.com"


def test_web_server_credentials_are_rejected(tmp_path, monkeypatch):
    path = tmp_path / "web.json"
    path.write_text('{"web":{"client_secret":"do-not-display"}}', "utf-8")
    monkeypatch.setenv(config.CONFIG_FILE_ENV, str(path))
    with pytest.raises(ValueError, match="デスクトップ"):
        config.desktop_oauth()
    assert "do-not-display" not in json.dumps(config.setup_status())


def test_bundle_identity_tracks_the_generated_oauth_file(tmp_path):
    for name in ("papeer", "sidecar"):
        (tmp_path / name).mkdir()
    for name in ("sidecar.spec", "pyproject.toml", "uv.lock"):
        (tmp_path / name).write_text("example", "utf-8")
    before = bundle_version(tmp_path)
    config.write_bundle(tmp_path)
    assert bundle_version(tmp_path) != before
    (tmp_path / config.BUNDLE_CONFIG).write_text('{"client_id":"changed"}', "utf-8")
    assert bundle_version(tmp_path) != before
