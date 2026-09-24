from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path

REASONING_EFFORTS = ("", "low", "medium", "high", "xhigh", "max")


def data_directory() -> Path:
    override = os.environ.get("PAPERDESK_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share"))
    return base / "PaperDesk"


@dataclass
class Settings:
    provider: str = "codex"
    model: str = "gpt-5.6-sol"
    base_url: str = "https://api.openai.com/v1"
    api_key: str = ""
    codex_path: str = ""
    claude_path: str = ""
    gemini_path: str = ""
    timeout_seconds: int = 900
    reasoning_effort: str = ""

    def __post_init__(self):
        if self.reasoning_effort not in REASONING_EFFORTS:
            raise ValueError("effortは既定値・low・medium・high・xhighから選んでください。")

    @classmethod
    def load(cls, root: Path) -> "Settings":
        path = root / "settings.json"
        values = json.loads(path.read_text("utf-8")) if path.exists() else {}
        values = {k: v for k, v in values.items() if k in cls.__dataclass_fields__}
        values["api_key"] = os.environ.get("PAPERDESK_API_KEY", "") or os.environ.get("GEMINI_API_KEY", "")
        return cls(**values)

    def save(self, root: Path) -> None:
        root.mkdir(parents=True, exist_ok=True)
        values = asdict(self)
        values.pop("api_key")  # Session-only; never write credentials into the library.
        target = root / "settings.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(values, ensure_ascii=False, indent=2), "utf-8")
        temporary.replace(target)
