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

from papeer.core import prompts, scholarly_lookup
from papeer.core.errors import Invalid
from papeer.providers import ProviderBackend, spec_for, specs
from sidecar import deps
from sidecar.errors import log
from sidecar.job_types import JobKind, JobStarted
from sidecar.schemas.settings import (
    ProviderActionRequest,
    ProviderOption,
    ProviderSpecModel,
    SettingsModel,
    SettingsResponse,
    UsageLimits,
)

router = APIRouter(dependencies=[Depends(deps.verify_token)])


@router.get("/api/settings", response_model=SettingsResponse)
def get_settings() -> SettingsResponse:
    settings, unknown = deps.get_settings_with_unknown_keys()
    values = asdict(settings)
    values["api_key"] = deps.runtime_api_key()
    return SettingsResponse(**values, semantic_scholar_api_key=scholarly_lookup.semantic_api_key(), unknown_keys=unknown)


@router.put("/api/settings")
def update_settings(body: SettingsModel) -> dict[str, str]:
    """Apply the fields the client sent; anything omitted keeps its saved value."""
    current, unknown = deps.get_settings_with_unknown_keys()
    settings = current.updated(body.model_dump(exclude={"api_key", "semantic_scholar_api_key"}, exclude_unset=True))
    spec_for(settings.provider)
    if settings.paper_metadata_provider:
        spec_for(settings.paper_metadata_provider)
    deps.require_library_folder()
    settings.save(deps.get_data_dir())
    if not settings.paper_discovery_enabled:
        for job in deps.job_manager.get_jobs():
            if job.running and job.kind == JobKind.PAPER_DISCOVERY:
                deps.job_manager.cancel_job(job.job_id)
    if not settings.paper_metadata_ai_enabled:
        # Stop reference lookups even when their pane has been closed.
        for job in deps.job_manager.get_jobs():
            if job.running and job.kind in {JobKind.REFERENCE_RESEARCH, JobKind.MAP_GROUPS}:
                deps.job_manager.cancel_job(job.job_id)
    if unknown:
        # The frontend told the user beforehand (settingsVersionNotice.ts); the log keeps what was lost.
        log.warning("settings.json の、この版が知らない項目を保存で削除しました: %s", ", ".join(unknown))
    if body.api_key is not None:
        deps.set_runtime_api_key(body.api_key)
    if body.semantic_scholar_api_key is not None:
        scholarly_lookup.set_semantic_api_key(body.semantic_scholar_api_key)
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
    deps.require_library_folder()
    prompts.save_overrides(body)
    return {"status": "updated"}


@router.get("/api/providers", response_model=list[ProviderSpecModel])
def list_providers() -> list[dict[str, Any]]:
    """The AI connections the settings dialog offers, with the fields each one needs."""
    return [asdict(spec) for spec in specs()]


def _provider_with_path(provider: str, cli_path: str | None) -> ProviderBackend:
    """A connection for listing models/efforts, using the path typed in the dialog when given."""
    spec_for(provider)  # ValueError (400) for an unknown connection
    settings = replace(deps.get_settings(), provider=provider)
    if cli_path is not None:
        settings.set_option(provider, "cli_path", cli_path)
    return deps.provider_for(settings)


@router.get("/api/providers/{provider}/models")
def get_provider_models(provider: str, cli_path: str | None = None) -> list[ProviderOption]:
    return [ProviderOption(id=m, name=name) for m, name in _provider_with_path(provider, cli_path).list_models()]


@router.get("/api/providers/{provider}/efforts")
def get_provider_efforts(provider: str, model: str | None = None, cli_path: str | None = None) -> list[ProviderOption]:
    efforts = _provider_with_path(provider, cli_path).list_efforts(model or "")
    return [ProviderOption(id=e, name=name) for e, name in efforts]


def _requested_provider(body: ProviderActionRequest | None) -> ProviderBackend:
    return deps.provider_for(deps.settings_from_request(body), api_key=body.api_key if body else None)


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
        raise Invalid(f"CLIの準備エラー: {error}") from error


@router.post("/api/providers/check")
def provider_check(body: ProviderActionRequest | None = None) -> JobStarted:
    provider = _requested_provider(body)

    def action(cancel: threading.Event, progress: Any, _page_ready: Any) -> str:
        progress("接続を確認しています…")
        provider.cancel = cancel
        return provider.check()

    return deps.submit_job(JobKind.CHECK, action)


@router.get("/api/usage/limits", response_model=UsageLimits | None)
def usage_limits() -> dict[str, Any] | None:
    """Plan usage of the connected AI, when the service reports one."""
    try:
        provider = deps.provider_for()
        limits = provider.limits()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        # Left as an HTTPException on purpose: the AI service failed, not the request, which none of
        # Invalid/NotFound/Conflict says. The frontend shows the detail like any other error.
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return dict(limits, provider=provider.spec.id) if limits else None
