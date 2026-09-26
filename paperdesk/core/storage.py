from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import uuid

from paperdesk.pdf.pdf_engine import PDF_LOCK, extract_pdf, save_json
from paperdesk.core.translation_review import cached_required_translation_pages
from paperdesk.core.bibliography import extract_bibliography
import pymupdf as fitz
from paperdesk.layout.math_layout import LAYOUT_VERSION


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
                    scope TEXT NOT NULL DEFAULT 'paper',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS collections (
                    name TEXT PRIMARY KEY
                );
                CREATE TABLE IF NOT EXISTS bookmarks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    page INTEGER NOT NULL,
                    side TEXT NOT NULL,
                    quote TEXT NOT NULL,
                    label TEXT NOT NULL DEFAULT '重要',
                    note TEXT NOT NULL DEFAULT '',
                    anchor_y REAL NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS pdf_ink (
                    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                    side TEXT NOT NULL,
                    page INTEGER NOT NULL,
                    strokes TEXT NOT NULL,
                    PRIMARY KEY(paper_id, side, page)
                );
            """)
            if "anchor_y" not in {row[1] for row in db.execute("PRAGMA table_info(bookmarks)")}:
                db.execute("ALTER TABLE bookmarks ADD COLUMN anchor_y REAL NOT NULL DEFAULT 0")
            if "anchor_x" not in {row[1] for row in db.execute("PRAGMA table_info(bookmarks)")}:
                db.execute("ALTER TABLE bookmarks ADD COLUMN anchor_x REAL NOT NULL DEFAULT 0")
            if "usage" not in {row[1] for row in db.execute("PRAGMA table_info(messages)")}:
                db.execute("ALTER TABLE messages ADD COLUMN usage TEXT")
            if "scope" not in {row[1] for row in db.execute("PRAGMA table_info(messages)")}:
                db.execute("ALTER TABLE messages ADD COLUMN scope TEXT NOT NULL DEFAULT 'paper'")
            if "attachments" not in {row[1] for row in db.execute("PRAGMA table_info(messages)")}:
                db.execute("ALTER TABLE messages ADD COLUMN attachments TEXT")
            columns = {row[1] for row in db.execute("PRAGMA table_info(papers)")}
            if "tags" not in columns:
                db.execute("ALTER TABLE papers ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
            if "read_status" not in columns:
                db.execute("ALTER TABLE papers ADD COLUMN read_status TEXT NOT NULL DEFAULT '未読'")
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reading_status_choices'").fetchone():
                db.execute("CREATE TABLE reading_status_choices (name TEXT PRIMARY KEY)")
                db.executemany("INSERT INTO reading_status_choices VALUES(?)",
                               [(name,) for name in ("未読", "読書中", "読了", "再読したい")])
            db.executescript("""
                CREATE TABLE IF NOT EXISTS note_templates (name TEXT PRIMARY KEY, content TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS collection_glossaries (name TEXT PRIMARY KEY, terms TEXT NOT NULL);
            """)
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tag_choices'").fetchone():
                db.execute("CREATE TABLE tag_choices (kind TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(kind,name))")
                db.executemany("INSERT INTO tag_choices VALUES('sticky',?)",
                               [(name,) for name in ("重要", "疑問", "あとで確認", "引用", "確認済み")])
                db.execute("INSERT OR IGNORE INTO tag_choices SELECT 'sticky',label FROM bookmarks WHERE label<>''")
                for row in db.execute("SELECT tags FROM papers").fetchall():
                    db.executemany("INSERT OR IGNORE INTO tag_choices VALUES('paper',?)",
                                   [(name,) for name in json.loads(row[0])])
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

    def import_pdf(self, source: Path, collection_name: str = "", original_name: str = "") -> tuple[str, bool]:
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
                           (paper_id, digest, info["title"], original_name or source.name, info["page_count"],
                            normalize_collection_name(collection_name), info["first_author"], info["publication_year"]))
                if not db.execute("SELECT 1 FROM reading_status_choices WHERE name='未読'").fetchone():
                    db.execute("UPDATE papers SET read_status='' WHERE id=?", (paper_id,))
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
                OR instr(lower(p.collection_name),lower(?))>0 OR instr(lower(p.original_name),lower(?))>0
                OR instr(lower(p.tags),lower(?))>0 OR EXISTS
                (SELECT 1 FROM pages x WHERE x.paper_id=p.id AND instr(lower(x.text),lower(?))>0))"""
            arguments += [query.strip()] * 8
        sql += " ORDER BY created_at DESC, id"
        with self.connection() as db:
            return [dict(row, tags=json.loads(row["tags"])) for row in db.execute(sql, arguments)]

    def paper(self, paper_id: str) -> dict:
        with self.connection() as db:
            row = db.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
        if not row:
            raise KeyError("論文が見つかりません。")
        return dict(row, tags=json.loads(row["tags"]))

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

    def remove_tag(self, name: str) -> int:
        """Remove an exact tag across the library without replacing other paper data."""
        if not name.strip() or len(name) > 80:
            raise ValueError("タグ名は1〜80文字で指定してください。")
        affected = 0
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM tag_choices WHERE kind='paper' AND name=?", (name,))
            for row in db.execute("SELECT id,tags FROM papers").fetchall():
                tags = json.loads(row["tags"])
                if name in tags:
                    db.execute("UPDATE papers SET tags=? WHERE id=?",
                               (json.dumps([tag for tag in tags if tag != name], ensure_ascii=False), row["id"]))
                    affected += 1
        return affected

    def update(self, paper_id: str, **values) -> None:
        if not values or not set(values) <= {"title", "status", "collection_name", "note", "first_author", "publication_year", "tags", "read_status"}:
            raise ValueError("Invalid fields")
        if "tags" in values:
            tags = list(dict.fromkeys(tag.strip() for tag in values["tags"] if tag.strip()))
            if len(tags) > 100 or any(len(tag) > 80 for tag in tags):
                raise ValueError("タグは100件まで、名前は80文字までです。")
            values["tags"] = json.dumps(tags, ensure_ascii=False)
        for name in ("first_author", "publication_year"):
            if name in values:
                values[name] = values[name].strip()
        if values.get("publication_year") and not re.fullmatch(r"[0-9]{4}", values["publication_year"]):
            raise ValueError("出版年は半角数字4桁で入力してください。")
        if "collection_name" in values:
            values["collection_name"] = normalize_collection_name(values["collection_name"])
        with self.connection() as db:
            if values.get("read_status") and not db.execute(
                "SELECT 1 FROM reading_status_choices WHERE name=?", (values["read_status"],)
            ).fetchone():
                raise ValueError("読書状態が不正です。")
            fields = ",".join(f"{name}=?" for name in values)
            db.execute(f"UPDATE papers SET {fields} WHERE id=?", [*values.values(), paper_id])
            if "tags" in values:
                db.executemany("INSERT OR IGNORE INTO tag_choices VALUES('paper',?)", [(name,) for name in tags])
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
            db.executemany("DELETE FROM collection_glossaries WHERE name=?",
                           [(row[0],) for row in db.execute("SELECT name FROM collection_glossaries").fetchall() if inside(row[0])])
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
        """Read display metadata without migrating the extraction cache."""
        with self.connection() as db:
            paper = db.execute("SELECT pages FROM papers WHERE id=?", (paper_id,)).fetchone()
            if paper is None:
                raise KeyError("論文が見つかりません。")
            empty = [row[0] for row in db.execute(
                "SELECT number FROM pages WHERE paper_id=? AND trim(text)='' ORDER BY number",
                (paper_id,))]
        # Use the same units as translation: references, formulas and other
        # deliberately preserved content do not require a translated page.
        required = cached_required_translation_pages(self.folder(paper_id), paper[0])
        return {"page_count": paper[0], "empty_pages": empty, "translation_required_pages": required}

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

    def messages(self, paper_id: str, with_usage: bool = False, scope: str | None = None) -> list[dict]:
        with self.connection() as db:
            condition = " WHERE paper_id=?" + (" AND scope=?" if scope is not None else "")
            values = (paper_id, scope) if scope is not None else (paper_id,)
            rows = db.execute("SELECT role,content,usage,attachments FROM messages" + condition + " ORDER BY id", values)
            result = []
            for row in rows:
                item = {"role": row["role"], "content": row["content"]}
                if row["attachments"]:
                    item["attachments"] = json.loads(row["attachments"])
                if with_usage:
                    item["usage"] = json.loads(row["usage"]) if row["usage"] else None
                result.append(item)
            return result

    def add_exchange(self, paper_id: str, question: str, answer: str, usage: dict | None = None,
                     scope: str = "paper", attachments: list[dict] | None = None) -> None:
        with self.connection() as db:
            db.executemany("INSERT INTO messages(paper_id,role,content,usage,scope,attachments) VALUES(?,?,?,?,?,?)",
                           [(paper_id, "user", question, None, scope,
                             json.dumps(attachments, ensure_ascii=False) if attachments else None),
                            (paper_id, "assistant", answer, json.dumps(usage) if usage else None, scope, None)])

    def search_pages(self, question: str, paper_id: str | None = None, limit: int = 10,
                     paper_ids: set[str] | None = None) -> list[dict]:
        import re
        terms = re.findall(r"[a-zA-Z0-9_-]{2,}|[\u3040-\u30ff\u3400-\u9fff]{2,}", question.lower())
        with self.connection() as db:
            sql = "SELECT x.*, p.title FROM pages x JOIN papers p ON p.id=x.paper_id"
            rows = db.execute(sql + (" WHERE x.paper_id=?" if paper_id else ""), (paper_id,) if paper_id else ()).fetchall()
        scored = []
        for row in rows:
            data = dict(row)
            if paper_ids is not None and data["paper_id"] not in paper_ids:
                continue
            data["score"] = sum(data["text"].lower().count(term) for term in terms)
            scored.append(data)
        scored.sort(key=lambda x: (-x["score"], x["paper_id"], x["number"]))
        return scored[:limit]

    def bookmarks(self, paper_id: str) -> list[dict]:
        self.paper(paper_id)
        with self.connection() as db:
            return [dict(row) for row in db.execute(
                "SELECT * FROM bookmarks WHERE paper_id=? ORDER BY page,id", (paper_id,))]

    def sticky_notes(self) -> list[dict]:
        with self.connection() as db:
            return [dict(row) for row in db.execute(
                "SELECT b.*, p.title AS paper_title, p.original_name AS paper_name "
                "FROM bookmarks b JOIN papers p ON p.id=b.paper_id ORDER BY b.id DESC")]

    def add_bookmark(self, paper_id: str, page: int, side: str, quote: str,
                     label: str = "重要", note: str = "", anchor_y: float = 0, anchor_x: float = 0) -> dict:
        paper = self.paper(paper_id)
        if not 1 <= page <= paper["pages"] or side not in {"original", "translated"} or not 0 <= anchor_y <= 1 or not 0 <= anchor_x <= 1:
            raise ValueError("ページまたは原文・訳文の指定が不正です。")
        quote = quote.strip()[:2000]
        with self.connection() as db:
            cursor = db.execute("INSERT INTO bookmarks(paper_id,page,side,quote,label,note,anchor_y,anchor_x) VALUES(?,?,?,?,?,?,?,?)",
                                (paper_id, page, side, quote, label[:40], note[:1000], anchor_y, anchor_x))
            return dict(db.execute("SELECT * FROM bookmarks WHERE id=?", (cursor.lastrowid,)).fetchone())

    def update_bookmark(self, paper_id: str, bookmark_id: int, label: str, note: str,
                        *, anchor_x: float | None = None, anchor_y: float | None = None) -> dict:
        self.paper(paper_id)
        with self.connection() as db:
            updated = db.execute("UPDATE bookmarks SET label=?,note=?,anchor_x=COALESCE(?,anchor_x),"
                                 "anchor_y=COALESCE(?,anchor_y) WHERE paper_id=? AND id=?",
                                 (label.strip()[:40] or "重要", note[:1000], anchor_x, anchor_y, paper_id, bookmark_id))
            if not updated.rowcount:
                raise ValueError("付箋が見つかりません。")
            return dict(db.execute("SELECT * FROM bookmarks WHERE id=?", (bookmark_id,)).fetchone())

    def delete_bookmark(self, paper_id: str, bookmark_id: int) -> bool:
        self.paper(paper_id)
        with self.connection() as db:
            return db.execute("DELETE FROM bookmarks WHERE paper_id=? AND id=?",
                              (paper_id, bookmark_id)).rowcount > 0
