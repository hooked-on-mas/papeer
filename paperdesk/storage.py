from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import uuid

from .pdf_engine import PDF_LOCK, extract_pdf, save_json
from .bibliography import extract_bibliography
import pymupdf as fitz
from .math_layout import LAYOUT_VERSION


def normalize_collection_name(value: str) -> str:
    """Return a stable, display-friendly virtual folder path."""
    return " / ".join(part.strip() for part in re.split(r"[\\/]", value) if part.strip())


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        (root / "papers").mkdir(exist_ok=True)
        with self.connection() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS papers (
                    id TEXT PRIMARY KEY, sha256 TEXT UNIQUE NOT NULL,
                    title TEXT NOT NULL, original_name TEXT NOT NULL,
                    pages INTEGER NOT NULL, status TEXT NOT NULL DEFAULT '追加済み',
                    collection_name TEXT NOT NULL DEFAULT '',
                    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS pages (
                    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    number INTEGER NOT NULL, text TEXT NOT NULL,
                    PRIMARY KEY(paper_id, number)
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    role TEXT NOT NULL, content TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS collections (
                    name TEXT PRIMARY KEY
                );
            """)
            columns = {row[1] for row in db.execute("PRAGMA table_info(papers)")}
            for name in ("first_author", "publication_year"):
                if name not in columns:
                    db.execute(f"ALTER TABLE papers ADD COLUMN {name} TEXT NOT NULL DEFAULT ''")
            if "bibliography_version" not in columns:
                db.execute("ALTER TABLE papers ADD COLUMN bibliography_version INTEGER NOT NULL DEFAULT 0")
            for row in db.execute("SELECT id FROM papers WHERE bibliography_version=0").fetchall():
                try:
                    with PDF_LOCK, fitz.open(self.folder(row["id"]) / "original.pdf") as document:
                        info = extract_bibliography(document)
                except (OSError, ValueError, RuntimeError):
                    continue
                db.execute("UPDATE papers SET first_author=?,publication_year=?,bibliography_version=1 WHERE id=?",
                           (info["first_author"], info["publication_year"], row["id"]))

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.root / "library.sqlite3", timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def folder(self, paper_id: str) -> Path:
        if len(paper_id) != 32 or any(c not in "0123456789abcdef" for c in paper_id):
            raise ValueError("Invalid paper ID")
        return self.root / "papers" / paper_id

    def import_pdf(self, source: Path, collection_name: str = "") -> tuple[str, bool]:
        if source.stat().st_size > 300 * 1024 * 1024:
            raise ValueError("300MB以下のPDFを追加してください。")
        with source.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        with self.connection() as db:
            duplicate = db.execute("SELECT id FROM papers WHERE sha256=?", (digest,)).fetchone()
            if duplicate:
                return duplicate["id"], False
        info = extract_pdf(source)
        if not info["blocks"]:
            raise ValueError("文字を抽出できませんでした。スキャンPDFはOCR済みのコピーを追加してください。")
        paper_id = uuid.uuid4().hex
        folder = self.folder(paper_id)
        folder.mkdir()
        try:
            shutil.copyfile(source, folder / "original.pdf")
            save_json(folder / "document.json", info)
            with self.connection() as db:
                db.execute("""INSERT INTO papers(id,sha256,title,original_name,pages,collection_name,first_author,publication_year,bibliography_version)
                           VALUES(?,?,?,?,?,?,?,?,1)""",
                           (paper_id, digest, info["title"], source.name, info["page_count"],
                            normalize_collection_name(collection_name), info["first_author"], info["publication_year"]))
                db.executemany("INSERT INTO pages(paper_id,number,text) VALUES(?,?,?)",
                               [(paper_id, p["number"], p["text"]) for p in info["pages"]])
        except Exception:
            shutil.rmtree(folder)
            raise
        return paper_id, True

    def papers(self, query: str = "") -> list[dict]:
        sql = "SELECT p.* FROM papers p WHERE 1=1"
        arguments = []
        if query.strip():
            sql += """ AND (instr(lower(p.title),lower(?))>0 OR instr(lower(p.note),lower(?))>0
                OR instr(lower(p.first_author),lower(?))>0 OR instr(p.publication_year,?)>0
                OR instr(lower(p.collection_name),lower(?))>0 OR instr(lower(p.original_name),lower(?))>0 OR EXISTS
                (SELECT 1 FROM pages x WHERE x.paper_id=p.id AND instr(lower(x.text),lower(?))>0))"""
            arguments += [query.strip()] * 7
        sql += " ORDER BY created_at DESC, id"
        with self.connection() as db:
            return [dict(row) for row in db.execute(sql, arguments)]

    def paper(self, paper_id: str) -> dict:
        with self.connection() as db:
            row = db.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
        if not row:
            raise KeyError("論文が見つかりません。")
        return dict(row)

    def collections(self) -> list[str]:
        with self.connection() as db:
            names = [row[0] for row in db.execute(
                "SELECT name FROM collections UNION SELECT collection_name FROM papers")]
        paths = set()
        for name in names:
            parts = normalize_collection_name(name).split(" / ")
            paths.update(" / ".join(parts[:depth]) for depth in range(1, len(parts) + 1))
        return sorted(paths - {""}, key=str.casefold)

    def create_collection(self, name: str) -> str:
        name = normalize_collection_name(name)
        if not name:
            raise ValueError("フォルダー名を入力してください。")
        with self.connection() as db:
            db.execute("INSERT OR IGNORE INTO collections(name) VALUES(?)", (name,))
        return name

    def update(self, paper_id: str, **values) -> None:
        if not values or not set(values) <= {"title", "status", "collection_name", "note", "first_author", "publication_year"}:
            raise ValueError("Invalid fields")
        for name in ("first_author", "publication_year"):
            if name in values:
                values[name] = values[name].strip()
        if values.get("publication_year") and not re.fullmatch(r"[0-9]{4}", values["publication_year"]):
            raise ValueError("出版年は半角数字4桁で入力してください。")
        if "collection_name" in values:
            values["collection_name"] = normalize_collection_name(values["collection_name"])
        with self.connection() as db:
            fields = ",".join(f"{name}=?" for name in values)
            db.execute(f"UPDATE papers SET {fields} WHERE id=?", [*values.values(), paper_id])
        if "note" in values:
            (self.folder(paper_id) / "note.md").write_text(values["note"], "utf-8")

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
            db.execute("DELETE FROM collections")
            db.executemany("INSERT INTO collections(name) VALUES(?)", [(mapped(name),) for name in names])
            for row in db.execute("SELECT id,collection_name FROM papers").fetchall():
                name = normalize_collection_name(row["collection_name"])
                if mapped(name) != name:
                    db.execute("UPDATE papers SET collection_name=? WHERE id=?", (mapped(name), row["id"]))
        return destination

    def delete_collection(self, path: str) -> list[str]:
        """Remove a folder subtree, preserving every paper and its files."""
        path = normalize_collection_name(path)
        if not path:
            raise ValueError("未分類は削除できません。")
        def inside(name):
            name = normalize_collection_name(name)
            return name == path or name.startswith(path + " / ")
        with self.connection() as db:
            names = [row[0] for row in db.execute("SELECT name FROM collections")]
            papers = db.execute("SELECT id,collection_name FROM papers").fetchall()
            if not any(inside(name) for name in names) and not any(inside(row["collection_name"]) for row in papers):
                raise ValueError("フォルダーが見つかりません。")
            # Keep implicit ancestors when their last descendant is removed.
            parent = " / ".join(path.split(" / ")[:-1])
            if parent:
                db.execute("INSERT OR IGNORE INTO collections(name) VALUES(?)", (parent,))
            identities = [row["id"] for row in papers if inside(row["collection_name"])]
            db.executemany("UPDATE papers SET collection_name='' WHERE id=?", [(identity,) for identity in identities])
            db.executemany("DELETE FROM collections WHERE name=?", [(name,) for name in names if inside(name)])
        return identities

    def rename_paper(self, paper_id: str, name: str) -> str:
        name = name.strip()
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
        stem = name[:-4]
        if (not stem.strip() or stem.endswith((" ", ".")) or
                re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or len(name) > 255 or
                stem.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}):
            raise ValueError("Windowsで使用できるファイル名を入力してください。")
        with self.connection() as db:
            if not db.execute("SELECT id FROM papers WHERE id=?", (paper_id,)).fetchone():
                raise KeyError("論文が見つかりません。")
            db.execute("UPDATE papers SET original_name=?,title=? WHERE id=?", (name, stem, paper_id))
        return name

    def reading_info(self, paper_id: str) -> dict:
        """Read display metadata without loading or migrating the extraction cache."""
        with self.connection() as db:
            paper = db.execute("SELECT pages FROM papers WHERE id=?", (paper_id,)).fetchone()
            if paper is None:
                raise KeyError("論文が見つかりません。")
            empty = [row[0] for row in db.execute(
                "SELECT number FROM pages WHERE paper_id=? AND trim(text)='' ORDER BY number",
                (paper_id,))]
        return {"page_count": paper[0], "empty_pages": empty}

    def document(self, paper_id: str) -> dict:
        folder = self.folder(paper_id)
        path = folder / "document.json"
        document = json.loads(path.read_text("utf-8"))
        if document.get("layout_version") != LAYOUT_VERSION:
            refreshed = extract_pdf(folder / "original.pdf")
            refreshed["title"] = document["title"]
            save_json(path, refreshed)
            document = refreshed
        return document

    def messages(self, paper_id: str) -> list[dict]:
        with self.connection() as db:
            return [dict(x) for x in db.execute("SELECT role,content FROM messages WHERE paper_id=? ORDER BY id", (paper_id,))]

    def add_exchange(self, paper_id: str, question: str, answer: str) -> None:
        with self.connection() as db:
            db.executemany("INSERT INTO messages(paper_id,role,content) VALUES(?,?,?)",
                           [(paper_id, "user", question), (paper_id, "assistant", answer)])

    def search_pages(self, question: str, paper_id: str | None = None, limit: int = 10) -> list[dict]:
        import re
        terms = re.findall(r"[a-zA-Z0-9_-]{2,}|[\u3040-\u30ff\u3400-\u9fff]{2,}", question.lower())
        with self.connection() as db:
            sql = "SELECT x.*, p.title FROM pages x JOIN papers p ON p.id=x.paper_id"
            rows = db.execute(sql + (" WHERE paper_id=?" if paper_id else ""), (paper_id,) if paper_id else ()).fetchall()
        scored = []
        for row in rows:
            data = dict(row)
            data["score"] = sum(data["text"].lower().count(term) for term in terms)
            scored.append(data)
        scored.sort(key=lambda x: (-x["score"], x["paper_id"], x["number"]))
        return scored[:limit]
