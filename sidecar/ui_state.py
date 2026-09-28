from __future__ import annotations

import configparser
import json
import math
from pathlib import Path
from typing import Any

from papeer.core.fileio import atomic_write_json


DEFAULT_STATE: dict[str, Any] = {
    "reading_pages": {},
    "reading_anchors": {},
    "last_paper": "",
    "sort": 0,
    "expanded_collections": [],
}


def migrate_window_ini(ini_path: Path) -> dict[str, Any]:
    state = dict(DEFAULT_STATE)
    if not ini_path.is_file():
        return state

    parser = configparser.ConfigParser()
    try:
        parser.read(str(ini_path), encoding="utf-8")
    except (OSError, ValueError, configparser.Error):  # Unreadable, not UTF-8 or not an ini file.
        return state

    reading_pages: dict[str, int] = {}
    if parser.has_section("reading"):
        for key, val in parser.items("reading"):
            if key == "last_paper":
                state["last_paper"] = val
            else:
                try:
                    reading_pages[key] = max(0, int(val))
                except ValueError:
                    pass
    state["reading_pages"] = reading_pages

    if parser.has_section("library"):
        if parser.has_option("library", "sort"):
            try:
                state["sort"] = int(parser.get("library", "sort"))
            except ValueError:
                pass
        if parser.has_option("library", "expanded_collections"):
            raw_expanded = parser.get("library", "expanded_collections")
            if raw_expanded and not raw_expanded.startswith("@"):
                state["expanded_collections"] = [item.strip() for item in raw_expanded.split(",") if item.strip()]

    return state


def valid_anchors(raw: object) -> dict[str, float]:
    """The places within a page (reading_anchors) that are fractions of it, 0 < x <= 1.

    Anything else, from a hand edit or a newer version, is left out rather than failing the response,
    which the frontend would retry for ever.
    """
    if not isinstance(raw, dict):
        return {}
    return {
        str(key): float(value)
        for key, value in raw.items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
        and math.isfinite(value) and 0 < value <= 1
    }


def load_ui_state(data_dir: Path) -> dict[str, Any]:
    json_path = data_dir / "ui-state.json"
    if json_path.is_file():
        try:
            state = json.loads(json_path.read_text("utf-8"))
            if isinstance(state, dict) and "reading_anchors" in state:
                state["reading_anchors"] = valid_anchors(state["reading_anchors"])
            return state
        except Exception:  # noqa: BLE001
            # Possibly only locked for a moment (e.g. a virus scan): fall back to defaults
            # for this request without overwriting the saved reading positions.
            return migrate_window_ini(data_dir / "window.ini")

    # Migrate from window.ini if present
    state = migrate_window_ini(data_dir / "window.ini")
    # Reading must not create a data folder that is missing (see storage.library_missing).
    if data_dir.is_dir():
        save_ui_state(data_dir, state)
    return state


def save_ui_state(data_dir: Path, state: dict[str, Any]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(data_dir / "ui-state.json", state)

