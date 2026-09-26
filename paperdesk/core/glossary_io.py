"""Portable JSON dictionaries, staged for review before saving to the library."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile

from paperdesk.core.reading_tools import validate_terms

MAX_FILE_BYTES = 10 * 1024 * 1024


def export_glossary(path: Path, terms: list[dict]) -> int:
    terms = validate_terms(terms)
    if path.suffix.lower() != ".json":
        raise ValueError("保存先には .json ファイルを指定してください。")
    content = json.dumps({"format": "paperdesk-glossary", "version": 1, "terms": terms},
                         ensure_ascii=False, indent=2) + "\n"
    if len(content.encode("utf-8")) > MAX_FILE_BYTES:
        raise ValueError("辞書ファイルは10MBまでです。")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return len(terms)


def import_glossary(path: Path, existing: list[dict]) -> dict:
    existing = validate_terms(existing)
    with path.open("rb") as stream:
        content = stream.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise ValueError("辞書ファイルは10MBまでです。")
    try:
        value = json.loads(content.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("UTF-8のJSON辞書ファイルを選択してください。") from exc
    if isinstance(value, dict):
        if value.get("format") != "paperdesk-glossary" or value.get("version") != 1:
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
