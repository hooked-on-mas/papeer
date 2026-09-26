from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from paperdesk.core.paths import data_directory  # noqa: F401  (re-exported for existing importers)

REASONING_EFFORTS = ("", "low", "medium", "high", "xhigh", "max")
MAX_TRANSLATION_CONCURRENCY = 8
DEFAULT_BASE_URL = "https://api.openai.com/v1"

# settings.json before provider_options: flat per-connection fields, and "gemini" for agy.
_LEGACY_OPTION_FIELDS = {"codex_path": ("codex", "cli_path"), "claude_path": ("claude", "cli_path"),
                         "gemini_path": ("antigravity", "cli_path"), "base_url": ("api", "base_url"),
                         "api_base": ("api", "base_url")}
_RENAMED_PROVIDERS = {"gemini": "antigravity"}


def api_key_from_env() -> str:
    """The API key given at launch; it is never written to settings.json."""
    return (os.environ.get("PAPERDESK_API_KEY", "") or os.environ.get("OPENAI_API_KEY", "")
            or os.environ.get("GEMINI_API_KEY", ""))


@dataclass
class Settings:
    provider: str = "codex"
    model: str = "gpt-5.6-sol"
    reasoning_effort: str = ""
    timeout_seconds: int = 900
    # Translation requests in flight at once; 0 lets translation_requests() decide.
    translation_concurrency: int = 0
    # Session-only; never saved.
    api_key: str = ""
    # Settings that belong to one connection, by provider id: CLI paths, the API URL,
    # and the model/effort last chosen for that connection (kept by the settings dialog).
    provider_options: dict[str, dict[str, str]] = field(default_factory=dict)

    def __post_init__(self):
        if self.reasoning_effort not in REASONING_EFFORTS:
            raise ValueError("effortは既定値・low・medium・high・xhigh・maxから選んでください。")
        if (type(self.translation_concurrency) is not int
                or not 0 <= self.translation_concurrency <= MAX_TRANSLATION_CONCURRENCY):
            raise ValueError(f"翻訳の同時リクエスト数は0（自動）～{MAX_TRANSLATION_CONCURRENCY}で指定してください。")
        if not isinstance(self.provider_options, dict) or not all(
                isinstance(v, dict) for v in self.provider_options.values()):
            raise ValueError("接続先ごとの設定の形式が不正です。")
        self.provider = _RENAMED_PROVIDERS.get(self.provider, self.provider)

    def options(self, provider: str | None = None) -> dict[str, str]:
        """Settings of one connection (the chosen one by default)."""
        return dict(self.provider_options.get(provider or self.provider, {}))

    def set_option(self, provider: str, key: str, value: str) -> None:
        self.provider_options = {**self.provider_options, provider: {**self.options(provider), key: value}}

    @property
    def base_url(self) -> str:
        """The OpenAI-compatible API URL; part of the translation cache identity for every connection."""
        return self.provider_options.get("api", {}).get("base_url") or DEFAULT_BASE_URL

    def translation_requests(self) -> int:
        """How many translation requests to send at once.

        Automatic picks 1 for a model on this machine, whose single GPU would only
        queue parallel requests, and 3 for remote services.
        """
        if self.translation_concurrency:
            return self.translation_concurrency
        local = self.provider == "api" and urlparse(self.base_url.strip()).hostname in {"127.0.0.1", "localhost", "::1"}
        return 1 if local else 3

    @classmethod
    def from_values(cls, values: dict) -> "Settings":
        """Build from saved or submitted values, accepting the older flat format."""
        values = dict(values)
        options = {k: dict(v) for k, v in (values.get("provider_options") or {}).items() if isinstance(v, dict)}
        for legacy, (provider, key) in _LEGACY_OPTION_FIELDS.items():
            value = values.pop(legacy, None)
            if isinstance(value, str) and value:
                options.setdefault(provider, {})[key] = value
        for old, new in _RENAMED_PROVIDERS.items():
            if old in options:
                options[new] = {**options.pop(old), **options.get(new, {})}
        values["provider_options"] = options
        values = {k: v for k, v in values.items() if k in cls.__dataclass_fields__}
        return cls(**values)

    @classmethod
    def load(cls, root: Path) -> "Settings":
        path = root / "settings.json"
        values = json.loads(path.read_text("utf-8")) if path.exists() else {}
        values["api_key"] = api_key_from_env()
        return cls.from_values(values)

    def save(self, root: Path) -> None:
        root.mkdir(parents=True, exist_ok=True)
        values = asdict(self)
        values.pop("api_key")  # Session-only; never write credentials into the library.
        target = root / "settings.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(values, ensure_ascii=False, indent=2), "utf-8")
        temporary.replace(target)
