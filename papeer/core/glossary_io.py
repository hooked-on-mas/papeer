"""Portable JSON dictionaries, staged for review before saving to the library.

A file the user chose that cannot be read or written is theirs to fix, not a bug: Invalid with the OS's message.
"""
from __future__ import annotations

import json
from pathlib import Path

from papeer.core.destinations import inside_library
from papeer.core.errors import Invalid
from papeer.core.fileio import atomic_write_text
from papeer.core.glossary_draft import validate_terms

MAX_FILE_BYTES = 10 * 1024 * 1024


def export_glossary(path: Path, terms: list[dict], library_root: Path) -> int:
    terms = validate_terms(terms)
    if inside_library(path, library_root):
        raise ValueError("辞書はライブラリの外に保存してください。")
    if path.suffix.lower() != ".json":
        raise ValueError("保存先には .json ファイルを指定してください。")
    content = json.dumps({"format": "papeer-glossary", "version": 1, "terms": terms},
                         ensure_ascii=False, indent=2) + "\n"
    if len(content.encode("utf-8")) > MAX_FILE_BYTES:
        raise ValueError("辞書ファイルは10MBまでです。")
    try:
        atomic_write_text(path, content)
    except OSError as exc:
        raise Invalid(str(exc)) from exc
    return len(terms)


def import_glossary(path: Path, existing: list[dict]) -> dict:
    existing = validate_terms(existing)
    try:
        with path.open("rb") as stream:
            content = stream.read(MAX_FILE_BYTES + 1)
    except OSError as exc:
        raise Invalid(str(exc)) from exc
    if len(content) > MAX_FILE_BYTES:
        raise ValueError("辞書ファイルは10MBまでです。")
    try:
        value = json.loads(content.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("UTF-8のJSON辞書ファイルを選択してください。") from exc
    if isinstance(value, dict):
        if value.get("format") not in {"papeer-glossary", "paperdesk-glossary"} or value.get("version") != 1:
            raise ValueError("対応していない辞書形式・バージョンです。")
        value = value.get("terms")
    imported = validate_terms(value)
    known = {term["source"].casefold(): term for term in existing}
    added, conflicts, skipped = [], [], 0
    for term in imported:
        previous = known.get(term["source"].casefold())
        if previous is None:
            added.append(term)
        else:
            skipped += 1
            if previous["target"] != term["target"]:
                conflicts.append({"source": term["source"], "existing": previous["target"], "imported": term["target"]})
    return {"terms": existing + added, "added": added, "skipped": skipped, "conflicts": conflicts}
