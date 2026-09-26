"""Settings, prompts and AI connections (listing, models, login, connection check, plan usage).

Nothing here knows a particular connection: each one is described by its ProviderSpec
and handled through the ProviderBackend interface.
"""
from __future__ import annotations

from dataclasses import asdict, replace
import subprocess
import threading
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from paperdesk.core import prompts
from paperdesk.core.config import Settings
from paperdesk.providers import ProviderBackend, spec_for, specs
from sidecar import deps
from sidecar.schemas import ProviderActionRequest, ProviderSpecModel, SettingsModel

router = APIRouter(dependencies=[Depends(deps.verify_token)])


@router.get("/api/settings", response_model=SettingsModel)
def get_settings() -> SettingsModel:
    values = asdict(deps.get_settings())
    values["api_key"] = deps.runtime_api_key()
    return SettingsModel(**values)


@router.put("/api/settings")
def update_settings(body: SettingsModel) -> dict[str, str]:
    """Apply the fields the client sent; anything omitted keeps its saved value."""
    saved = deps.get_settings()
    values = body.model_dump(exclude={"api_key"}, exclude_unset=True)
    options = dict(saved.provider_options)
    for provider, sent in values.pop("provider_options", {}).items():
        options[provider] = {**options.get(provider, {}), **sent}
    try:
        settings = Settings.from_values({**asdict(saved), **values, "provider_options": options})
        spec_for(settings.provider)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    settings.save(deps.get_data_dir())
    if body.api_key is not None:
        deps.set_runtime_api_key(body.api_key)
    return {"status": "saved"}


@router.get("/api/prompts")
def get_prompts() -> dict[str, str]:
    return prompts.current()


@router.get("/api/prompts/defaults")
def get_default_prompts() -> dict[str, str]:
    """Built-in texts, so the settings dialog can show and restore them."""
    return prompts.defaults()


@router.put("/api/prompts")
def update_prompts(body: dict[str, str]) -> dict[str, str]:
    try:
        prompts.save_overrides(body)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return {"status": "updated"}


@router.get("/api/providers", response_model=list[ProviderSpecModel])
def list_providers() -> list[dict[str, Any]]:
    """The AI connections the settings dialog offers, with the fields each one needs."""
    return [asdict(spec) for spec in specs()]


def _provider_with_path(provider: str, cli_path: str | None) -> ProviderBackend:
    """A connection for listing models/efforts, using the path typed in the dialog when given."""
    try:
        spec_for(provider)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    settings = replace(deps.get_settings(), provider=provider)
    if cli_path is not None:
        settings.set_option(provider, "cli_path", cli_path)
    return deps.provider_for(settings)


@router.get("/api/providers/{provider}/models")
def get_provider_models(provider: str, cli_path: str | None = None) -> list[dict[str, str]]:
    return [{"id": m, "name": name} for m, name in _provider_with_path(provider, cli_path).list_models()]


@router.get("/api/providers/{provider}/efforts")
def get_provider_efforts(provider: str, model: str | None = None, cli_path: str | None = None) -> list[dict[str, str]]:
    efforts = _provider_with_path(provider, cli_path).list_efforts(model or "")
    return [{"id": e, "name": name} for e, name in efforts]


def _requested_provider(body: ProviderActionRequest | None) -> ProviderBackend:
    try:
        return deps.provider_for(deps.settings_from_request(body), api_key=body.api_key if body else None)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


@router.post("/api/providers/login")
def provider_login(body: ProviderActionRequest | None = None) -> dict[str, Any]:
    provider = _requested_provider(body)
    if not provider.spec.needs_login:
        return {"message": "この接続先ではログイン操作は不要です。", "already": False}
    # Launching a second login console is confusing when the CLI is already signed in.
    if provider.login_status():
        return {"message": "すでにログインされています。", "already": True}
    try:
        return {"message": provider.login(), "already": False}
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"CLIの準備エラー: {error}")


@router.post("/api/providers/check")
def provider_check(body: ProviderActionRequest | None = None) -> dict[str, str]:
    provider = _requested_provider(body)

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> str:
        progress("接続を確認しています…")
        provider.cancel = cancel
        return provider.check()

    return deps.submit_job("check", action)


@router.get("/api/usage/limits")
def usage_limits() -> dict[str, Any] | None:
    """Plan usage of the connected AI, when the service reports one."""
    try:
        provider = deps.provider_for()
        limits = provider.limits()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    return dict(limits, provider=provider.spec.id) if limits else None
