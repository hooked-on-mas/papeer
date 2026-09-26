"""The list of AI connections. Adding one is a new module plus one entry here."""
from __future__ import annotations

import threading

from papeer.core.config import Settings
from papeer.providers.antigravity import AntigravityProvider
from papeer.providers.base import ProviderBackend, ProviderSpec
from papeer.providers.claude_code import ClaudeCodeProvider
from papeer.providers.codex import CodexProvider
from papeer.providers.openai_compat import OpenAICompatProvider

# In the order the settings dialog shows them.
BACKENDS: dict[str, type[ProviderBackend]] = {
    backend.spec.id: backend
    for backend in (CodexProvider, ClaudeCodeProvider, AntigravityProvider, OpenAICompatProvider)
}


def specs() -> list[ProviderSpec]:
    return [backend.spec for backend in BACKENDS.values()]


def backend_class(provider_id: str) -> type[ProviderBackend]:
    try:
        return BACKENDS[provider_id]
    except KeyError:
        raise ValueError(f"不明な接続先です: {provider_id}") from None


def spec_for(provider_id: str) -> ProviderSpec:
    return backend_class(provider_id).spec


def create_provider(settings: Settings, cancel: threading.Event | None = None) -> ProviderBackend:
    """The connection chosen in settings, ready to generate()."""
    return backend_class(settings.provider)(settings, cancel)
