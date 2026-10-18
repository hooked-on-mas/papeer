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


def test_official_client_id_is_ready_without_a_secret(public_config, tmp_path):
    credentials = config.desktop_oauth()
    assert credentials.client_id == CLIENT
    assert credentials.configured and not credentials.client_secret
    assert config.setup_status() == {"configured": True, "setup_error": None}
    config.write_bundle(tmp_path)
    assert json.loads((tmp_path / config.BUNDLE_CONFIG).read_text("utf-8")) == {"client_id": CLIENT}


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
    monkeypatch.setenv(config.CLIENT_ID_ENV, "789-override.apps.googleusercontent.com")
    assert config.desktop_oauth().client_id == "789-override.apps.googleusercontent.com"
    config.write_bundle(tmp_path)
    assert json.loads((tmp_path / config.BUNDLE_CONFIG).read_text("utf-8"))["client_secret"] == "private-desktop-value"


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
