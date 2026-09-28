"""When each paper was last opened on this PC: the library's 最近開いた順 and the reader's 続きから読む.

Kept in this PC's device directory (paths.opened_papers_path), like the reading position (ui-state.json,
which sync leaves out too), rather than in the library database: the database is synced, so a column
written whenever a paper is opened would make every PC publish a new revision after merely reading, and
two PCs reading at the same time would conflict (drive_sync). "Recently opened" is therefore this PC's
own: each PC lists what was opened on it, and a backup or a new PC starts with nothing opened.

Times are UTC, "2026-09-28T12:34:56.789Z", so that sorting the text sorts the times and the frontend's
Date reads them. Safe to share between threads; a failed write only forgets that one opening.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import threading
from typing import TYPE_CHECKING, Any

from papeer.core.fileio import atomic_write_json
from papeer.core.paths import opened_papers_path

if TYPE_CHECKING:
    from papeer.core.storage import Library

OPENED_FORMAT = 1
_LOCK = threading.Lock()


def now_text() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read(root: Path) -> dict[str, str]:
    try:
        value = json.loads(opened_papers_path(root).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    # Written for another library at the same place (a hand-edited or copied file) or by a later format: ignored.
    if not (isinstance(value, dict) and value.get("format") == OPENED_FORMAT and value.get("root") == str(Path(root).resolve())
            and isinstance(value.get("papers"), dict)):
        return {}
    return {paper_id: at for paper_id, at in value["papers"].items() if isinstance(paper_id, str) and isinstance(at, str)}


def _write(root: Path, papers: dict[str, str]) -> None:
    path = opened_papers_path(root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_json(path, {"format": OPENED_FORMAT, "root": str(Path(root).resolve()), "papers": papers}, indent=None)
    except OSError:
        pass


def opened_times(root: Path) -> dict[str, str]:
    """When each paper was last opened on this PC, by paper ID; papers never opened here are missing."""
    with _LOCK:
        return _read(root)


def record_opened(root: Path, paper_id: str, at: str | None = None) -> str:
    """Remember that the paper was opened now (or `at`); returns the time recorded."""
    at = at or now_text()
    with _LOCK:
        papers = _read(root)
        papers[paper_id] = at
        _write(root, papers)
    return at


def forget_removed(root: Path, keep: set[str]) -> None:
    """Drop the papers the library no longer has (`keep`: the ones it has)."""
    with _LOCK:
        papers = _read(root)
        if not set(papers) <= keep:
            _write(root, {paper_id: at for paper_id, at in papers.items() if paper_id in keep})


def mark_opened(lib: Library, paper_id: str) -> dict[str, Any]:
    """The paper was opened: record when (on this PC), and an unread one becomes 読書中 (Library.start_reading).

    Returns the time recorded and the fields that changed, as paper.changed names them.
    """
    at = record_opened(lib.root, paper_id)
    started = lib.start_reading(paper_id)
    return {"last_opened_at": at, "started_reading": started,
            "fields": ["last_opened_at", "read_status"] if started else ["last_opened_at"]}
