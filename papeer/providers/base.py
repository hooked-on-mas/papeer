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
import time
from typing import Callable, ClassVar, Literal

from papeer.core.config import Settings
from papeer.providers.common import TransientError, UsageMeter, check_cancel, latest_limits

# The longest generate() waits between sends of one request, in all. A service asking for a
# longer wait (Retry-After) gets the error reported instead.
TRANSPORT_WAIT_LIMIT = 120.0


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
    web_search: bool = False


class ProviderBackend(ABC):
    spec: ClassVar[ProviderSpec]
    # Sends of a request after a TransientError (generate), and the first wait between them in seconds.
    transport_retries: ClassVar[int] = 2
    transport_backoff: ClassVar[float] = 2.0

    def __init__(self, settings: Settings, cancel: threading.Event | None = None):
        self.settings = settings
        self.cancel = cancel if cancel is not None else threading.Event()
        self.usage = UsageMeter()
        # Until when (time.monotonic()) every request of this provider (one per job) waits before
        # going out, after the service asked one of them to wait (Retry-After). With parallel
        # translation the other requests would otherwise go on meeting the same rate limit and use
        # up their sends.
        self._resume_at = 0.0
        self._resume_lock = threading.Lock()

    @property
    def options(self) -> dict[str, str]:
        """This connection's own settings (CLI path, API URL, ...)."""
        return self.settings.options(self.spec.id)

    def generate(self, instruction: str, data: str, schema: dict | None = None) -> str:
        """The answer to one request, sent again after a TransientError.

        Waits 2, 4, 8... seconds between sends, or what the service asked for (Retry-After),
        at most `transport_retries` times and TRANSPORT_WAIT_LIMIT seconds in all; a request
        that timed out is sent again only once, as each one can take timeout_seconds. The
        waits end at once on cancel. These sends are separate from translation's retries of
        answers that fail its checks (RetryState), which see one request either way.
        A wait the service asked for holds back the other requests of this provider (one per job)
        too (generate() on other threads, and later calls), without counting toward their own limits.
        """
        return self._send(lambda: self._generate(instruction, data, schema))

    def search_web(self, instruction: str, data: str, schema: dict | None = None) -> str:
        """Explicit research only; ordinary generation never enables external tools."""
        raise ValueError(f"{self.spec.label} はWeb検索に対応していません。設定で対応するAI接続を選んでください。")

    def read_images(self, instruction: str, images: list[bytes], schema: dict | None = None) -> str:
        """The answer to one request that shows the model PNG images (OCR by the AI, papeer.core.ai_ocr),
        sent again after a TransientError as generate() does. RuntimeError when the connection cannot
        take images (image_support)."""
        reason = self.image_support()
        if reason:
            raise RuntimeError(reason)
        return self._send(lambda: self._generate_images(instruction, images, schema))

    def image_support(self) -> str | None:
        """None when read_images() can show this connection images; else why not, for the screen."""
        return f"{self.spec.label} には画像を渡せないため、AI で読み直せません。"

    def _generate_images(self, instruction: str, images: list[bytes], schema: dict | None) -> str:
        """As _generate, with the images after the instruction; only for connections that take images."""
        raise RuntimeError(self.image_support() or "この接続先には画像を渡せません。")

    def _send(self, request: Callable[[], str]) -> str:
        """request() (one call to the service), with generate()'s sends again and waits."""
        retries, waited, timeouts, delay = 0, 0.0, 0, 0.0
        while True:
            check_cancel(self.cancel)
            with self._resume_lock:
                pause = max(delay, self._resume_at - time.monotonic())
            if pause > 0:
                self.cancel.wait(pause)
                check_cancel(self.cancel)
            try:
                answer = request()
                break
            except TransientError as error:
                timeouts += error.timed_out
                delay = error.retry_after if error.retry_after is not None else self.transport_backoff * 2 ** retries
                if retries >= self.transport_retries or timeouts > 1 or waited + delay > TRANSPORT_WAIT_LIMIT:
                    raise
                retries += 1
                waited += delay
                if error.retry_after is not None:
                    with self._resume_lock:
                        self._resume_at = max(self._resume_at, time.monotonic() + delay)
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
