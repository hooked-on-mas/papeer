from __future__ import annotations

import configparser
import json
from pathlib import Path
from typing import Any


DEFAULT_STATE: dict[str, Any] = {
    "reading_pages": {},
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
    except Exception:
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


def load_ui_state(data_dir: Path) -> dict[str, Any]:
    json_path = data_dir / "ui-state.json"
    if json_path.is_file():
        try:
            return json.loads(json_path.read_text("utf-8"))
        except Exception:
            pass

    # Migrate from window.ini if present
    state = migrate_window_ini(data_dir / "window.ini")
    save_ui_state(data_dir, state)
    return state


def save_ui_state(data_dir: Path, state: dict[str, Any]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    json_path = data_dir / "ui-state.json"
    tmp_path = json_path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp_path.replace(json_path)

