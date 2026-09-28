"""Models of the settings and the AI connections (sidecar/routes/settings.py)."""
from __future__ import annotations

from pydantic import BaseModel, Field

from papeer.core.config import Settings

_DEFAULTS = Settings()


class SettingsModel(BaseModel):
    # Keys the model does not know are ignored (Pydantic's default). This is only the API's shape:
    # settings.json itself is read by Settings.load, which migrates older flat keys (codex_path etc.).
    provider: str = _DEFAULTS.provider
    model: str = _DEFAULTS.model
    reasoning_effort: str = _DEFAULTS.reasoning_effort
    timeout_seconds: int = _DEFAULTS.timeout_seconds
    translation_concurrency: int = _DEFAULTS.translation_concurrency  # 0: automatic (1 for a local model, else 3)
    # By provider id: that connection's own settings (cli_path, base_url, model, reasoning_effort).
    provider_options: dict[str, dict[str, str]] = Field(default_factory=dict)
    api_key: str | None = None


class ProviderActionRequest(BaseModel):
    """Optional unsaved settings from the dialog; omitted fields use the saved settings."""
    provider: str | None = None
    model: str | None = None
    reasoning_effort: str | None = None
    provider_options: dict[str, dict[str, str]] | None = None
    api_key: str | None = None


class ProviderSpecModel(BaseModel):
    id: str
    label: str
    description: str
    kind: str
    needs_login: bool
    needs_api_key: bool
    login_service: str
    fields: list[dict[str, str]]
