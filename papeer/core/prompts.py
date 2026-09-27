"""Instructions sent to the AI: built-in texts, which the user may override in the data directory."""
from pathlib import Path

from papeer.core.fileio import atomic_write_text
from papeer.core.paths import data_directory

_BUILTIN_DIR = Path(__file__).parent / "prompts"


def _custom_dir() -> Path:
    return data_directory() / "prompts"


def load(name: str) -> str:
    custom_path = _custom_dir() / f"{name}.txt"
    if custom_path.exists():
        return custom_path.read_text(encoding="utf-8").strip()
    return (_BUILTIN_DIR / f"{name}.txt").read_text(encoding="utf-8").strip()


def defaults() -> dict[str, str]:
    """Built-in texts by name, so the settings dialog can show and restore them."""
    return {p.stem: p.read_text("utf-8").strip() for p in sorted(_BUILTIN_DIR.glob("*.txt"))}


def current() -> dict[str, str]:
    """The text in use for every prompt: the user's override, else the built-in one."""
    return {name: load(name) for name in defaults()}


def save_overrides(texts: dict[str, str]) -> None:
    """Store edited prompts; an empty text removes the override and restores the built-in one."""
    unknown = set(texts) - set(defaults())
    if unknown:
        raise ValueError("不明なプロンプトです: " + ", ".join(sorted(unknown)))
    directory = _custom_dir()
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in texts.items():
        path = directory / f"{name}.txt"
        if content.strip():
            atomic_write_text(path, content.strip())
        elif path.exists():
            path.unlink()
