"""Global terminology used by translations and validation of edited math tokens."""
from __future__ import annotations

from collections import Counter
from contextlib import closing
import json
from pathlib import Path
import sqlite3

from paperdesk.layout.math_layout import MATH_TOKEN


def global_glossary(root: Path) -> list[dict[str, str]]:
    """Migrate legacy dictionaries once, then use a single library-wide dictionary."""
    with closing(sqlite3.connect(root / "library.sqlite3", timeout=30)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS global_glossary (id INTEGER PRIMARY KEY CHECK(id=1), terms TEXT NOT NULL)")
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT terms FROM global_glossary WHERE id=1").fetchone()
        if row:
            return json.loads(row[0])
        merged = {}
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='collection_glossaries'").fetchone():
            for row in db.execute("SELECT terms FROM collection_glossaries ORDER BY name"):
                for term in json.loads(row[0]):
                    merged[term["source"].casefold()] = term
        # Keep legacy files intact, including alternate translations for conflicting terms.
        for path in sorted((root / "papers").glob("*/glossary.json")):
            for term in json.loads(path.read_text("utf-8")):
                merged[term["source"].casefold()] = term
        terms = list(merged.values())
        db.execute("INSERT INTO global_glossary VALUES(1,?)", (json.dumps(terms, ensure_ascii=False),))
        return terms


class GlossaryConflict(ValueError):
    pass


def save_global_glossary(root: Path, terms: list[dict[str, str]], expected=None) -> None:
    global_glossary(root)
    with closing(sqlite3.connect(root / "library.sqlite3", timeout=30)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        current = json.loads(db.execute("SELECT terms FROM global_glossary WHERE id=1").fetchone()[0])
        if expected is not None and current != expected:
            raise GlossaryConflict("共通辞書が別の画面で変更されました。辞書を開き直してから変更を適用してください。")
        db.execute("UPDATE global_glossary SET terms=? WHERE id=1", (json.dumps(terms, ensure_ascii=False),))


def glossary_for_folder(folder: Path) -> list[dict[str, str]]:
    root = folder.parent.parent
    return global_glossary(root) if (root / "library.sqlite3").is_file() else []


def effective_glossary(lib, paper_id: str) -> list[dict[str, str]]:
    lib.paper(paper_id)
    return global_glossary(lib.root)


def apply_glossary(units: list[dict], terms: list[dict]) -> None:
    for unit in units:
        matches = [item for item in terms if item["source"].casefold() in unit["text"].casefold()]
        if matches:
            unit["glossary"] = matches


def validate_revision(source: str, text: str) -> str:
    text = text.strip()
    if not text or len(text) > 50000:
        raise ValueError("訳文を入力してください（50000文字まで）。")
    if Counter(MATH_TOKEN.findall(source)) != Counter(MATH_TOKEN.findall(text)):
        raise ValueError("数式の目印は削除・追加・変更せずに残してください。")
    return text
