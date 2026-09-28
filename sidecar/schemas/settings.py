"""Models of the settings and the AI connections (sidecar/routes/settings.py)."""
from __future__ import annotations

from typing import Literal, TypedDict

from pydantic import BaseModel, ConfigDict, Field

from papeer.core.config import Settings
from sidecar.schemas.common import Stored

_DEFAULTS = Settings()


class SettingsModel(BaseModel):
    # Keys the model does not know are ignored (Pydantic's default). This is only the API's shape:
    # settings.json itself is read by Settings.load, which migrates older flat keys (codex_path etc.).
    # GET answers every field, which PUT may leave out: the schema has SettingsModel-Output and -Input.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)
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


class ProviderField(BaseModel):
    """A connection-specific setting the settings dialog shows (providers.base.OptionField)."""
    key: str
    label: str
    placeholder: str
    hint: str


class ProviderSpecModel(BaseModel):
    """An AI connection as GET /api/providers describes it (providers.base.ProviderSpec)."""
    id: str
    label: str
    description: str
    kind: Literal["cli", "http"]
    needs_login: bool
    needs_api_key: bool
    login_service: str
    fields: list[ProviderField]


class ProviderOption(BaseModel):
    """A model or reasoning effort the connection offers: its id, and the name shown."""
    id: str
    name: str


class LimitWindow(TypedDict):
    """One window of the plan's usage, as the service reports it (resets_at: seconds since the epoch)."""
    label: str
    used_percent: float
    resets_at: float | None


class UsageLimits(BaseModel):
    """GET /api/usage/limits: the connected AI's plan usage (providers.common.remember_limits).
    The windows come from the service (a CLI's output or an API's headers), so they are passed on as they are."""
    provider: str
    windows: Stored[list[LimitWindow]]
    checked_at: float
