from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
import os
from pathlib import Path
import re
import sys
import threading
from urllib.parse import urlparse

from papeer.core.fileio import atomic_write_json
from papeer.core.paths import app_env, data_directory, device_directory  # noqa: F401  (data_directory re-exported)

REASONING_EFFORTS = ("", "low", "medium", "high", "xhigh", "max")
MAX_TRANSLATION_CONCURRENCY = 8
DEFAULT_BASE_URL = "https://api.openai.com/v1"

# settings.json before provider_options: flat per-connection fields, and "gemini" for agy.
_LEGACY_OPTION_FIELDS = {"codex_path": ("codex", "cli_path"), "claude_path": ("claude", "cli_path"),
                         "gemini_path": ("antigravity", "cli_path"), "base_url": ("api", "base_url"),
                         "api_base": ("api", "base_url")}
_RENAMED_PROVIDERS = {"gemini": "antigravity"}

# Connection options that name a program or server on this PC. A library synced from another PC or
# restored from a backup must not decide what this PC runs (cli_path is executed as it is), so they
# live in the device folder, never in the library's settings.json.
DEVICE_OPTION_KEYS = frozenset({"cli_path", "base_url"})

# Model names go to the CLIs as one command-line argument; a leading "-" would read as an option.
# ASCII only. [ ] @ + appear in real names (Claude Code "opus[1m]", Vertex "claude-opus-4-1@20250805",
# LM Studio "model@q4_k_m") and are safe: arguments are passed as a list without a shell, and none of
# them is special to cmd.exe when a .cmd shim runs the CLI.
MODEL_NAME = re.compile(r"[\w.:/@\[\]][\w.:/@\[\]+-]*", re.ASCII)
MODEL_NAME_ERROR = "モデル名には英数字と . : / @ [ ] + - _ だけを使ってください（先頭に - は使えません）。"

_device_lock = threading.Lock()


def api_key_from_env() -> str:
    """The API key given at launch; it is never written to settings.json."""
    return (app_env("API_KEY", "") or os.environ.get("OPENAI_API_KEY", "")
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
        self.model = self.model.strip() if isinstance(self.model, str) else self.model
        if not all(valid_model(m) for m in (self.model, *(v.get("model", "") for v in self.provider_options.values()))):
            raise ValueError(MODEL_NAME_ERROR)
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
        values = _normalized(values)
        values = {k: v for k, v in values.items() if k in cls.__dataclass_fields__}
        return cls(**values)

    @classmethod
    def load(cls, root: Path) -> "Settings":
        """The library's settings with this PC's connection options (cli_path, base_url) laid over them.

        Device options found in the library's settings.json are moved to the device folder the first
        time this PC loads settings; after that, values there (written by an older Papeer on another
        PC, or brought in by a restored backup) are ignored.
        """
        device = _load_device_options(root)
        values = _normalized(_read_library_file(root))
        library = _split_device_options(values["provider_options"])[0]
        values["provider_options"] = _merge_options(library, device)
        values["api_key"] = api_key_from_env()
        # A hand-edited or synced settings.json with a bad model name must not lock the settings dialog out.
        # Fall back to the connection's own default, not Settings.model's (a Codex model).
        if not valid_model(values.get("model", "")):
            values["model"] = ""
        for options in values["provider_options"].values():
            if not valid_model(options.get("model", "")):
                options.pop("model")
        return cls.from_values(values)

    def save(self, root: Path) -> None:
        """Write the library's settings.json; this PC's connection options go to the device folder."""
        root.mkdir(parents=True, exist_ok=True)
        library, device = _split_device_options(self.provider_options)
        values = asdict(self)
        values.pop("api_key")  # Session-only; never write credentials into the library.
        values["provider_options"] = library
        with _device_lock:
            _write_device_options(device)
            atomic_write_json(root / "settings.json", values)


def valid_model(value) -> bool:
    """A model name is empty (the connection's default) or safe to pass on a command line."""
    return isinstance(value, str) and (not value.strip() or MODEL_NAME.fullmatch(value.strip()) is not None)


def _normalized(values: dict) -> dict:
    """Saved or submitted values in the current shape: legacy flat fields moved into provider_options."""
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
    return values


def _split_device_options(options: dict[str, dict[str, str]]) -> tuple[dict, dict]:
    """(library options, device options), each by provider id, leaving out providers with nothing left."""
    library: dict[str, dict[str, str]] = {}
    device: dict[str, dict[str, str]] = {}
    for provider, values in options.items():
        shared = {k: v for k, v in values.items() if k not in DEVICE_OPTION_KEYS}
        local = {k: v for k, v in values.items() if k in DEVICE_OPTION_KEYS}
        if shared:
            library[provider] = shared
        if local:
            device[provider] = local
    return library, device


def _merge_options(library: dict, device: dict) -> dict[str, dict[str, str]]:
    return {provider: {**library.get(provider, {}), **device.get(provider, {})} for provider in {**library, **device}}


def device_settings_path() -> Path:
    return device_directory() / "device-settings.json"


def _stored_device_options(device: dict) -> dict[str, dict[str, str]]:
    options = device.get("provider_options")
    if not isinstance(options, dict):
        return {}
    return {provider: {k: v for k, v in values.items() if k in DEVICE_OPTION_KEYS and isinstance(v, str)}
            for provider, values in options.items() if isinstance(values, dict)}


def _write_device_options(options: dict[str, dict[str, str]]) -> None:
    """Replace this PC's connection options; the caller holds _device_lock."""
    path = device_settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # "migrated": the library's settings.json has been read once; its device options are ignored from now on.
    atomic_write_json(path, {"version": 1, "migrated": True, "provider_options": options})


def _read_library_file(root: Path) -> dict:
    path = root / "settings.json"
    return json.loads(path.read_text("utf-8")) if path.exists() else {}


def _warn(message: str) -> None:
    print(f"警告: {message}", file=sys.stderr)


def _load_device_options(root: Path) -> dict[str, dict[str, str]]:
    """This PC's connection options, moving the ones in the library's settings.json here on first use.

    Runs once per PC: the device file then records that the move happened, so later calls only read it.
    A value already in the device folder wins over the library's. An unreadable device file counts as
    migrated with no options (the library's values are not trusted again); when the device file cannot
    be written, the library's values serve this call and settings.json is left for the next attempt.
    """
    path = device_settings_path()
    with _device_lock:
        try:
            device = json.loads(path.read_text("utf-8")) if path.exists() else {}
        except (OSError, ValueError) as exc:
            _warn(f"PCごとの設定（{path}）を読み込めないため、CLIのパスとAPI URLは既定値を使います: {exc!r}")
            return {}
        if not isinstance(device, dict):
            _warn(f"PCごとの設定（{path}）の形式が不正なため、CLIのパスとAPI URLは既定値を使います。")
            return {}
        if device.get("migrated"):
            return _stored_device_options(device)
        # Read the library again under the lock, so a save in between is not overwritten with older values.
        stored = _read_library_file(root)
        values = _normalized(stored)
        library, from_library = _split_device_options(values["provider_options"])
        options = _merge_options(from_library, _stored_device_options(device))
        try:
            _write_device_options(options)
        except OSError as exc:
            _warn(f"PCごとの設定（{path}）を保存できませんでした。次回もう一度移行します: {exc!r}")
            return options
        if from_library:
            # Take them out of the library too, so backups and sync no longer carry them.
            values = {k: v for k, v in values.items() if k in Settings.__dataclass_fields__ and k != "api_key"}
            values["provider_options"] = library
            atomic_write_json(root / "settings.json", values)
        return options
