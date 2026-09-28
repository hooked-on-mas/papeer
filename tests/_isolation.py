"""The guard that keeps tests away from the user's real Papeer folders (installed by conftest.py).

Import this module before the environment is changed: it records the real folders from it.
"""
from __future__ import annotations

import os
from pathlib import Path
import threading

APP_FOLDERS = ("Papeer", "PaperDesk", "PapeerSync")

# The environment as the test run started, before conftest points it at a temporary folder.
ORIGINAL_LOCALAPPDATA = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local/share")
REAL_LIBRARY = Path(ORIGINAL_LOCALAPPDATA) / "Papeer"


class RealDataAccessError(RuntimeError):
    """A test touched the user's real Papeer data."""


def path_forms(value) -> set[str]:
    """The path as written and with 8.3 short names, junctions and links resolved, case-folded."""
    text = os.fsdecode(value)
    forms = {os.path.normcase(os.path.abspath(text))}
    try:
        forms.add(os.path.normcase(os.path.realpath(text)))
    except (OSError, ValueError):
        pass
    return forms


def _real_roots() -> tuple[str, ...]:
    bases = {Path.home() / ".local/share", Path(ORIGINAL_LOCALAPPDATA)}
    roots = [base / name for base in bases for name in APP_FOLDERS]
    # A developer may point the app at a library elsewhere; that one is real data too.
    roots += [Path(value).expanduser() for key in ("PAPEER_DATA_DIR", "PAPERDESK_DATA_DIR")
              if (value := os.environ.get(key))]
    return tuple(sorted({form for root in roots for form in path_forms(root)}))


REAL_ROOTS = _real_roots()


def is_under(value, roots: tuple[str, ...]) -> bool:
    if not isinstance(value, (str, bytes, os.PathLike)):
        return False
    try:
        forms = path_forms(value)
    except (TypeError, ValueError):
        return False
    return any(form == root or form.startswith(root.rstrip(os.sep) + os.sep) for form in forms for root in roots)


# Audit events that open, list, create, remove or move a path (os.replace raises "os.rename").
PATH_EVENTS = frozenset({
    "open", "os.listdir", "os.scandir", "os.mkdir", "os.remove", "os.rmdir", "os.rename",
    "os.truncate", "os.chmod", "os.utime", "os.link", "os.symlink", "os.startfile",
    "shutil.copyfile", "shutil.copymode", "shutil.copystat", "shutil.copytree", "shutil.move",
    "shutil.rmtree", "shutil.make_archive", "shutil.unpack_archive", "sqlite3.connect", "glob.glob",
})

violations: list[str] = []
_inside_hook = threading.local()


def audit_hook(event: str, args: tuple) -> None:
    """Refuse the operation before it reaches the OS, and remember it in case the error is swallowed."""
    if event not in PATH_EVENTS or getattr(_inside_hook, "active", False):
        return
    # realpath itself touches the filesystem; don't inspect those nested events.
    _inside_hook.active = True
    try:
        touched = next((value for value in args if is_under(value, REAL_ROOTS)), None)
    finally:
        _inside_hook.active = False
    if touched is not None:
        message = f"テストが実データに触れました: {event} {os.fsdecode(touched)}"
        violations.append(message)
        raise RealDataAccessError(message)


def take_violations() -> list[str]:
    found = list(violations)
    violations.clear()
    return found
