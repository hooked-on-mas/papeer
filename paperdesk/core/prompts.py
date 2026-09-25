import os
from pathlib import Path
from paperdesk.core.config import data_directory

_BUILTIN_DIR = Path(__file__).parent / "prompts"

def _get_custom_dir() -> Path:
    env_dir = os.environ.get("PAPERDESK_DATA_DIR")
    if env_dir:
        return Path(env_dir).resolve() / "prompts"
    return data_directory() / "prompts"

def load(name: str) -> str:
    custom_path = _get_custom_dir() / f"{name}.txt"
    if custom_path.exists():
        return custom_path.read_text(encoding="utf-8").strip()
    return (_BUILTIN_DIR / f"{name}.txt").read_text(encoding="utf-8").strip()
