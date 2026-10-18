"""The rules of the library's virtual folder paths ("a / b"), shared with the frontend."""
from __future__ import annotations

import re


# The frontend keeps the same folder rules (frontend/src/lib/collectionPath.ts): both are tested against
# tests/fixtures/collection_paths.json.
def normalize_collection_name(value: str) -> str:
    """Return a stable, display-friendly virtual folder path."""
    return " / ".join(part.strip() for part in re.split(r"[\\/]", value) if part.strip())


def collection_ancestors(value: str) -> list[str]:
    """The folder `value` and its parents, outermost first: "a / b" -> ["a", "a / b"]; none for 未分類."""
    parts = normalize_collection_name(value).split(" / ")
    return [" / ".join(parts[:depth]) for depth in range(1, len(parts) + 1) if parts[0]]


def in_collection(name: str, path: str) -> bool:
    """Whether the folder `name` is the normalized folder `path` or one of its subfolders."""
    name = normalize_collection_name(name)
    return name == path or name.startswith(path + " / ")
