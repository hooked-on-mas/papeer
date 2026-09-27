"""Instructions sent to the AI: built-in texts, which the user may override in the data directory.

A file of the built-in folder whose name starts with "_" is not a prompt but a section shared by
several prompts: a prompt holds it as a marker ({{translation_style}} for _translation_style.txt),
replaced by the section when it is sent (expand). The settings dialog shows and saves the prompts
with their markers, and the shared sections cannot be overridden.
"""
from pathlib import Path
import re

from papeer.core.fileio import atomic_write_text
from papeer.core.paths import data_directory

_BUILTIN_DIR = Path(__file__).parent / "prompts"
_SHARED = re.compile(r"\{\{([a-z_]+)\}\}")


def _custom_dir() -> Path:
    return data_directory() / "prompts"


def load(name: str) -> str:
    custom_path = _custom_dir() / f"{name}.txt"
    if custom_path.exists():
        return custom_path.read_text(encoding="utf-8").strip()
    return builtin(name)


def builtin(name: str) -> str:
    """The text shipped with the app, whether or not the user overrides it."""
    return (_BUILTIN_DIR / f"{name}.txt").read_text(encoding="utf-8").strip()


def defaults() -> dict[str, str]:
    """Built-in texts by name, so the settings dialog can show and restore them."""
    return {p.stem: p.read_text("utf-8").strip() for p in sorted(_BUILTIN_DIR.glob("*.txt"))
            if not p.stem.startswith("_")}


def expand(text: str) -> str:
    """The prompt as sent: each {{name}} replaced by the built-in shared section _name.txt.

    A user's override keeps getting the section (and its later edits) while it holds the marker;
    one without the marker, such as an override written before the section existed, is sent as
    written, so the section is never added twice. Unknown names stay as they are.
    """
    def section(match: re.Match) -> str:
        path = _BUILTIN_DIR / f"_{match[1]}.txt"
        return path.read_text("utf-8").strip() if path.is_file() else match[0]
    return _SHARED.sub(section, text)


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
