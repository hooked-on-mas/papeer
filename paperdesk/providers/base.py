"""The contract every AI connection implements.

A connection (Codex CLI, Claude Code, an HTTP API, ...) is one ProviderBackend
subclass in its own module, listed in registry.py. The rest of the application
only calls generate(), reads .settings, and asks usage_report(); the settings
dialog and sidecar routes use the spec and the management methods below.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
import threading
from typing import ClassVar, Literal

from paperdesk.core.config import Settings
from paperdesk.providers.common import UsageMeter, check_cancel, latest_limits


@dataclass(frozen=True)
class OptionField:
    """A connection-specific setting shown in the settings dialog, saved in Settings.provider_options."""
    key: str
    label: str
    placeholder: str = ""
    hint: str = ""


@dataclass(frozen=True)
class ProviderSpec:
    id: str
    label: str
    description: str
    kind: Literal["cli", "http"]
    needs_login: bool = False
    needs_api_key: bool = False
    login_service: str = ""  # Named in the login hint, e.g. "ChatGPT".
    fields: tuple[OptionField, ...] = ()


class ProviderBackend(ABC):
    spec: ClassVar[ProviderSpec]

    def __init__(self, settings: Settings, cancel: threading.Event | None = None):
        self.settings = settings
        self.cancel = cancel if cancel is not None else threading.Event()
        self.usage = UsageMeter()

    @property
    def options(self) -> dict[str, str]:
        """This connection's own settings (CLI path, API URL, ...)."""
        return self.settings.options(self.spec.id)

    def generate(self, instruction: str, data: str, schema: dict | None = None) -> str:
        check_cancel(self.cancel)
        answer = self._generate(instruction, data, schema)
        self.usage.count_call()
        return answer

    @abstractmethod
    def _generate(self, instruction: str, data: str, schema: dict | None) -> str:
        """Return the answer text; record tokens with self.usage.add() when the service reports them."""

    def usage_report(self) -> dict | None:
        """Tokens used so far by this provider, for the job's result."""
        return self.usage.report(self.settings)

    # --- Management used by the settings dialog. Defaults mean "not applicable". ---

    def list_models(self) -> list[tuple[str, str]]:
        return []

    def list_efforts(self, model: str = "") -> list[tuple[str, str]]:
        return [("", "既定値")]

    def login_status(self) -> bool | None:
        """True when signed in, False when not, None when the connection has no login."""
        return None

    def login(self) -> str:
        raise RuntimeError("この接続先ではログイン操作は不要です。")

    def check(self) -> str:
        answer = self.generate("Reply with OK only.", "Connection test, no document data.")
        return f"{self.spec.label}から応答を受信しました: " + answer[:120]

    def limits(self) -> dict | None:
        """Plan usage for this connection, or None when the service does not report one."""
        return latest_limits(self.spec.id)
