"""Library's folders ("a / b", collection_paths)."""
from __future__ import annotations

import json

from papeer.core.collection_paths import collection_ancestors, in_collection, normalize_collection_name
from papeer.core.errors import Conflict, Invalid
from papeer.core.library_base import LibraryBase


class Collections(LibraryBase):
    """Folders: listing, creating, renaming, deleting with undo."""

    def collections(self) -> list[str]:
        with self.connection() as db:
            names = [row[0] for row in db.execute(
                "SELECT name FROM collections UNION SELECT collection_name FROM papers")]
        return sorted({path for name in names for path in collection_ancestors(name)}, key=str.casefold)

    def create_collection(self, name: str) -> str:
        name = normalize_collection_name(name)
        if not name:
            raise ValueError("フォルダー名を入力してください。")
        with self.connection() as db:
            db.execute("INSERT OR IGNORE INTO collections(name) VALUES(?)", (name,))
        return name

    def rename_collection(self, path: str, leaf: str) -> str:
        path = normalize_collection_name(path)
        leaf = leaf.strip()
        if not path or not leaf or "/" in leaf or "\\" in leaf:
            raise ValueError("区切り文字を含まないフォルダー名を入力してください。")
        names = self.collections()
        if path not in names:
            raise ValueError("フォルダーが見つかりません。")
        destination = " / ".join(path.split(" / ")[:-1] + [leaf])
        if destination == path:
            return path
        if destination in names:
            raise ValueError("同じ名前のフォルダーが既にあります。")
        def mapped(name):
            return destination + name[len(path):] if name == path or name.startswith(path + " / ") else name
        with self.connection() as db:
            # Materialize implicit parents too, so renaming their last child keeps them.
            glossary_rows = db.execute("SELECT name,terms FROM collection_glossaries").fetchall()
            db.execute("DELETE FROM collection_glossaries")
            db.executemany("INSERT INTO collection_glossaries(name,terms) VALUES(?,?)",
                           [(mapped(row["name"]), row["terms"]) for row in glossary_rows])
            db.execute("DELETE FROM collections")
            db.executemany("INSERT INTO collections(name) VALUES(?)", [(mapped(name),) for name in names])
            for row in db.execute("SELECT id,collection_name FROM papers").fetchall():
                name = normalize_collection_name(row["collection_name"])
                if mapped(name) != name:
                    db.execute("UPDATE papers SET collection_name=? WHERE id=?", (mapped(name), row["id"]))
        return destination

    def apply_moves(self, moves: list[dict], expected: dict[str, str]) -> dict:
        """Move papers to folders, all or none: `moves` is [{"paper_id", "to"}], `expected` the folder each
        moved paper must be in now (as when the moves were proposed). A paper that is gone or in another
        folder is a Conflict (code collection_changed) and nothing changes. Missing target folders and their
        parents are created. Returns {"moved": papers whose folder changed, "created": new folder names}."""
        targets: dict[str, str] = {}
        for move in moves:
            if move["paper_id"] in targets:
                raise Invalid("同じ論文が複数回指定されています。")
            if move["paper_id"] not in expected:
                raise Invalid("移動前のフォルダーが指定されていません。")
            targets[move["paper_id"]] = normalize_collection_name(move["to"])
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            known = {path for row in db.execute("SELECT name FROM collections") for path in collection_ancestors(row[0])}
            current: dict[str, str] = {}
            for row in db.execute("SELECT id,collection_name FROM papers").fetchall():
                current[row["id"]] = normalize_collection_name(row["collection_name"])
                known.update(collection_ancestors(row["collection_name"]))
            for paper_id in targets:
                if paper_id not in current:
                    raise Conflict("論文が削除されたため、整理の案を適用できません。もう一度案を作ってください。", code="collection_changed")
                if current[paper_id] != normalize_collection_name(expected[paper_id]):
                    raise Conflict("論文のフォルダーが案を作った後に変更されたため、適用できません。もう一度案を作ってください。",
                                   code="collection_changed")
            created = [path for target in targets.values() for path in collection_ancestors(target) if path not in known]
            created = list(dict.fromkeys(created))
            db.executemany("INSERT OR IGNORE INTO collections(name) VALUES(?)", [(name,) for name in created])
            changed = [(target, paper_id) for paper_id, target in targets.items() if target != current[paper_id]]
            db.executemany("UPDATE papers SET collection_name=? WHERE id=?", changed)
        return {"moved": len(changed), "created": created}

    def delete_collection(self, path: str, *, undo_token: str | None = None) -> list[str]:
        """Remove a folder subtree, preserving every paper and its files."""
        path = normalize_collection_name(path)
        if not path:
            raise ValueError("未分類は削除できません。")
        def inside(name):
            return in_collection(name, path)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            names = [row[0] for row in db.execute("SELECT name FROM collections")]
            papers = db.execute("SELECT id,collection_name FROM papers").fetchall()
            if not any(inside(name) for name in names) and not any(inside(row["collection_name"]) for row in papers):
                raise ValueError("フォルダーが見つかりません。")
            if undo_token:
                db.execute("CREATE TABLE IF NOT EXISTS collection_undo (token TEXT PRIMARY KEY, snapshot TEXT NOT NULL)")
                snapshot = {"path": path, "names": [name for name in names if inside(name)],
                            "papers": [dict(row) for row in papers if inside(row["collection_name"])],
                            "glossaries": [dict(row) for row in db.execute("SELECT name,terms FROM collection_glossaries") if inside(row["name"])]}
                db.execute("INSERT INTO collection_undo VALUES(?,?)", (undo_token, json.dumps(snapshot)))
            # Keep implicit ancestors when their last descendant is removed.
            parent = " / ".join(path.split(" / ")[:-1])
            if parent:
                db.execute("INSERT OR IGNORE INTO collections(name) VALUES(?)", (parent,))
            identities = [row["id"] for row in papers if inside(row["collection_name"])]
            db.executemany("UPDATE papers SET collection_name='' WHERE id=?", [(identity,) for identity in identities])
            db.executemany("DELETE FROM collections WHERE name=?", [(name,) for name in names if inside(name)])
            db.executemany("DELETE FROM collection_glossaries WHERE name=?",
                           [(row[0],) for row in db.execute("SELECT name FROM collection_glossaries").fetchall() if inside(row[0])])
        return identities

    def restore_collection(self, token: str) -> str:
        """Restore a deleted subtree atomically, refusing to overwrite later edits."""
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='collection_undo'").fetchone():
                raise ValueError("復元できるフォルダーが見つかりません。")
            row = db.execute("SELECT snapshot FROM collection_undo WHERE token=?", (token,)).fetchone()
            if not row:
                raise ValueError("復元できるフォルダーが見つかりません。")
            saved = json.loads(row[0])
            path = saved["path"]
            names = [r[0] for r in db.execute("SELECT name FROM collections UNION SELECT collection_name FROM papers UNION SELECT name FROM collection_glossaries")]
            if any(n == path or n.startswith(path + " / ") for n in names):
                raise ValueError("同じ場所にフォルダーが作成されています。名前を変更してから復元してください。")
            for paper in saved["papers"]:
                current = db.execute("SELECT collection_name FROM papers WHERE id=?", (paper["id"],)).fetchone()
                if not current or current[0]:
                    raise ValueError("削除後に論文が移動または削除されています。先にその操作を確認してください。")
            db.executemany("INSERT OR IGNORE INTO collections(name) VALUES(?)", [(n,) for n in [path, *saved["names"]]])
            db.executemany("UPDATE papers SET collection_name=? WHERE id=?", [(p["collection_name"], p["id"]) for p in saved["papers"]])
            db.executemany("INSERT INTO collection_glossaries(name,terms) VALUES(?,?)", [(g["name"], g["terms"]) for g in saved["glossaries"]])
            db.execute("DELETE FROM collection_undo WHERE token=?", (token,))
        return path
