"""Library's papers: importing, listing, editing and removing them, their extraction and page texts."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import unicodedata
import uuid

from papeer.core.bibliography import clean_arxiv_id, typed_doi
from papeer.core.collection_paths import in_collection, normalize_collection_name
from papeer.core.errors import NotFound
from papeer.core.fileio import atomic_write_json, atomic_write_text
from papeer.core.library_base import LibraryBase
from papeer.core.ocr import load_readings, save_readings
from papeer.core.paths import PaperFiles
from papeer.core.shared_json import read_shared_json, remember
from papeer.core.translation_review import cached_review_pages
from papeer.core.translation_status import TranslationStatus
from papeer.layout.math_layout import LAYOUT_VERSION
from papeer.pdf.pdf_engine import OcrRun, extract_pdf


def write_document(path: Path, document: dict) -> None:
    """Save an extraction as document.json, kept in memory for the next read (Library.document).

    Without indentation: only the app reads it, and a long paper's is a third smaller and written
    in less than half the time (198 pages: 4.2 MB in 0.15 s instead of 6.5 MB in 0.4 s).
    """
    atomic_write_json(path, document, indent=None)
    remember(path, document)


def nfc(text: str) -> str:
    """Text in the composed form (NFC). macOS hands file names over decomposed (NFD: "が" as "か" and a
    combining mark), which looks the same but matches neither a search typed on any PC nor the same name
    from Windows."""
    return unicodedata.normalize("NFC", text)


def search_forms(query: str) -> list[str]:
    """The forms of a search term to look for: composed (NFC) and, if it differs, decomposed (NFD)."""
    composed = nfc(query.strip())
    decomposed = unicodedata.normalize("NFD", composed)
    return [composed] if decomposed == composed else [composed, decomposed]


class PaperRecords(LibraryBase):
    """The papers of the library (papers, pages) and their files."""

    def import_pdf(self, source: Path, collection_name: str = "", ocr: OcrRun | None = None) -> tuple[str, bool]:
        """Add a PDF (or find the paper it already is); (paper ID, whether it is new).

        ocr: how pages that need OCR are read (papeer.core.ocr: the "auto" setting); by default only as
        extract_pdf does without one (PAPEER_OCR). A PDF with no text at all is still added when its
        pages are scans, to be read by OCR afterwards.
        """
        if source.stat().st_size > 300 * 1024 * 1024:
            raise ValueError("300MB以下のPDFを追加してください。")
        with source.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        with self.connection() as db:
            duplicate = db.execute("SELECT id FROM papers WHERE sha256=?", (digest,)).fetchone()
            if duplicate:
                return duplicate["id"], False
        info = extract_pdf(source, run=ocr)
        if not info["blocks"] and not any(entry.get("reason") != "partial" for entry in info["ocr_pages"]):
            raise ValueError("文字を抽出できませんでした。文字も、OCR で読めるページの画像もないPDFです。")
        paper_id = uuid.uuid4().hex
        folder = self.folder(paper_id)
        folder.mkdir()
        try:
            shutil.copyfile(source, PaperFiles(folder).original_pdf)
            if ocr is not None:
                save_readings(folder, ocr.readings)
            write_document(PaperFiles(folder).document_json, info)
            with self.connection() as db:
                db.execute("""INSERT INTO papers(id,sha256,title,original_name,pages,status,collection_name,first_author,
                           publication_year,doi,arxiv_id,venue,bibliography_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)""",
                           (paper_id, digest, nfc(info["title"]), nfc(source.name), info["page_count"],
                            TranslationStatus.NOT_TRANSLATED.value, normalize_collection_name(collection_name),
                            info["first_author"], info["publication_year"],
                            info.get("doi", ""), info.get("arxiv_id", ""), info.get("venue", "")))
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
            # Both the composed (NFC) and decomposed (NFD) forms are looked for: names kept before nfc() may be NFD.
            one = """(instr(lower(p.title),lower(?))>0 OR instr(lower(p.note),lower(?))>0
                OR instr(lower(p.first_author),lower(?))>0 OR instr(p.publication_year,?)>0
                OR instr(lower(p.collection_name),lower(?))>0 OR instr(lower(p.original_name),lower(?))>0
                OR instr(lower(p.tags),lower(?))>0 OR EXISTS
                (SELECT 1 FROM pages x WHERE x.paper_id=p.id AND instr(lower(x.text),lower(?))>0))"""
            forms = search_forms(query)
            sql += " AND (" + " OR ".join([one] * len(forms)) + ")"
            for form in forms:
                arguments += [form] * 8
        sql += " ORDER BY created_at DESC, id"
        with self.connection() as db:
            return [self._paper(row) for row in db.execute(sql, arguments)]

    @classmethod
    def _oldest_first(cls, rows: list[sqlite3.Row]) -> list[dict]:
        """Papers in the order they were added (as BibTeX keys are told apart): created_at counts whole
        seconds, so papers added within one second keep the order they were inserted in (rowid)."""
        rows = sorted(rows, key=lambda row: (row["created_at"], row["insert_order"]))
        return [cls._paper({k: row[k] for k in row.keys() if k != "insert_order"}) for row in rows]

    def papers_by_id(self, paper_ids: list[str]) -> list[dict]:
        """The papers `paper_ids`, oldest first (_oldest_first); raises NotFound (a KeyError) for a missing one."""
        wanted = list(dict.fromkeys(paper_ids))
        for paper_id in wanted:
            self.folder(paper_id)  # Checks the ID's form.
        rows = []
        with self.connection() as db:
            for start in range(0, len(wanted), 500):
                chunk = wanted[start:start + 500]
                rows += db.execute(f"SELECT rowid AS insert_order,* FROM papers WHERE id IN ({','.join('?' * len(chunk))})",
                                   chunk).fetchall()
        if len(rows) != len(wanted):
            raise NotFound("論文が見つかりません。")
        return self._oldest_first(rows)

    def collection_papers(self, path: str) -> list[dict]:
        """The papers in folder `path` and its subfolders, oldest first (_oldest_first)."""
        path = normalize_collection_name(path)
        if not path:
            raise ValueError("フォルダーを指定してください。")
        with self.connection() as db:
            rows = db.execute("SELECT rowid AS insert_order,* FROM papers").fetchall()
        return self._oldest_first([row for row in rows if in_collection(row["collection_name"], path)])

    def update(self, paper_id: str, **values) -> None:
        if not values or not set(values) <= {"title", "status", "collection_name", "note", "first_author", "publication_year",
                                             "tags", "read_status", "doi", "arxiv_id", "venue"}:
            raise ValueError("Invalid fields")
        tags: list[str] = []
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
        # A DOI or arXiv ID may be pasted as a link ("https://doi.org/…", "arXiv:…"); it is kept bare.
        if "doi" in values:
            values["doi"] = typed_doi(values["doi"])
        if values.get("arxiv_id", "").strip():
            values["arxiv_id"] = clean_arxiv_id(values["arxiv_id"])
            if not values["arxiv_id"]:
                raise ValueError("arXiv IDは「2101.00001」のような形式で入力してください。")
        elif "arxiv_id" in values:
            values["arxiv_id"] = ""
        if "venue" in values:
            values["venue"] = " ".join(values["venue"].split())
            if len(values["venue"]) > 300:
                raise ValueError("掲載誌は300文字以内で入力してください。")
        if "collection_name" in values:
            values["collection_name"] = normalize_collection_name(values["collection_name"])
        if "status" in values:
            # Raises ValueError for anything but a code (translation_status.translation_status decides it).
            values["status"] = TranslationStatus(values["status"]).value
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
            atomic_write_text(PaperFiles(self.folder(paper_id)).note_md, values["note"])

    def start_reading(self, paper_id: str) -> bool:
        """An unread paper (未読) becomes 読書中 when opened; whether it changed.

        Only while the paper is still 未読 and 読書中 is among the choices (the user may have removed or
        renamed it; 未読 need not be, as a paper can keep a status removed since). So opening it again writes
        nothing: the database is synced (drive_sync), and a write each time a paper is opened would publish a
        new revision and could conflict with another PC.
        """
        with self.connection() as db:
            return db.execute(
                """UPDATE papers SET read_status='読書中' WHERE id=? AND read_status='未読'
                   AND EXISTS(SELECT 1 FROM reading_status_choices WHERE name='読書中')""", (paper_id,)).rowcount > 0

    def rename_paper(self, paper_id: str, name: str) -> str:
        name = nfc(name.strip())
        if not name.lower().endswith(".pdf"):
            name += ".pdf"
        stem = name[:-4]
        if (not stem.strip() or stem.endswith((" ", ".")) or
                re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or len(name) > 255 or
                stem.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}):
            # Names that any PC can use, Windows' rules being the strictest: a synced library may reach one.
            raise ValueError("どのPCでも使えるファイル名を入力してください（\\ / : * ? \" < > | と、"
                             "末尾の空白・ピリオド、CON・NUL などの名前は使えません）。")
        with self.connection() as db:
            if not db.execute("SELECT id FROM papers WHERE id=?", (paper_id,)).fetchone():
                raise NotFound("論文が見つかりません。")
            db.execute("UPDATE papers SET original_name=?,title=? WHERE id=?", (name, stem, paper_id))
        return name

    def reading_info(self, paper_id: str) -> dict:
        """Read display metadata without migrating the extraction cache."""
        with self.connection() as db:
            paper = db.execute("SELECT pages FROM papers WHERE id=?", (paper_id,)).fetchone()
            if paper is None:
                raise NotFound("論文が見つかりません。")
            empty = [row[0] for row in db.execute(
                "SELECT number FROM pages WHERE paper_id=? AND trim(text)='' ORDER BY number",
                (paper_id,))]
        # Use the same units as translation: references, formulas and other
        # deliberately preserved content do not require a translated page, nor does a
        # page needing OCR (garbled text or a scanned image), which is listed instead.
        review = cached_review_pages(self.folder(paper_id), paper[0])
        return {"page_count": paper[0], "empty_pages": empty, "translation_required_pages": review["required"],
                "ocr_pages": review["ocr"], "ocr_applied": review.get("applied", [])}

    def document(self, paper_id: str) -> dict:
        """The paper's extraction (document.json), extracted again when made by an older LAYOUT_VERSION.

        Extracting again reads no page by OCR (it runs inside a request): pages read before are built
        from the readings the paper keeps (papeer.core.ocr), the others stay 要OCR.

        Shared with every caller until the file changes (shared_json): read it, never modify it in
        place; code that adjusts blocks works on its own copies (materialize_flows and the like).
        """
        folder = self.folder(paper_id)
        path = PaperFiles(folder).document_json
        document = read_shared_json(path)
        if document.get("layout_version") != LAYOUT_VERSION:
            saved = load_readings(folder)
            run = OcrRun(saved=saved)
            refreshed = extract_pdf(PaperFiles(folder).original_pdf, run=run)
            refreshed["title"] = document["title"]
            # Readings this extraction did not use (a page no longer found to need OCR by the new code)
            # are kept: a later version may use them again, and nothing is read twice.
            kept = {**saved, **run.readings}
            if kept != saved:
                save_readings(folder, kept)
            write_document(path, refreshed)
            document = refreshed
        return document

    def replace_extraction(self, paper_id: str, document: dict, readings: dict[str, dict]) -> None:
        """Keep a new extraction of a paper (read again by OCR): its readings, document.json and page texts.

        The readings go first: a document.json whose OCR pages have no reading would lose them at the
        next extraction, while a reading without its document is only unused.
        """
        folder = self.folder(paper_id)
        save_readings(folder, readings)
        write_document(PaperFiles(folder).document_json, document)
        with self.connection() as db:
            db.executemany("UPDATE pages SET text=? WHERE paper_id=? AND number=?",
                           [(page["text"], paper_id, page["number"]) for page in document["pages"]])

    def delete_paper(self, paper_id: str) -> None:
        """Remove a paper, its records and its folder."""
        folder = self.folder(paper_id)
        with self.connection() as db:
            db.execute("DELETE FROM messages WHERE paper_id=?", (paper_id,))
            db.execute("DELETE FROM pages WHERE paper_id=?", (paper_id,))
            db.execute("DELETE FROM papers WHERE id=?", (paper_id,))
            if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='paper_glossary_domains'").fetchone():
                db.execute("DELETE FROM paper_glossary_domains WHERE paper_id=?", (paper_id,))
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)

    def page_texts(self, paper_id: str) -> list[tuple[int, str]]:
        """(page number, extracted text) of every page, in order."""
        with self.connection() as db:
            return [(row["number"], row["text"]) for row in db.execute(
                "SELECT number,text FROM pages WHERE paper_id=? ORDER BY number", (paper_id,))]

    def page_text(self, paper_id: str, number: int) -> str:
        with self.connection() as db:
            row = db.execute("SELECT text FROM pages WHERE paper_id=? AND number=?", (paper_id, number)).fetchone()
        return row[0] if row else ""

    def search_pages(self, question: str, paper_id: str | None = None, limit: int = 10,
                     paper_ids: set[str] | None = None) -> list[dict]:
        import re
        terms = re.findall(r"[a-zA-Z0-9_-]{2,}|[\u3040-\u30ff\u3400-\u9fff]{2,}", question.lower())
        # Only the pages of the papers asked for are read (a folder or a selection, not the whole library):
        # one paper, the papers of paper_ids, or with both that paper only if paper_ids has it.
        chosen = sorted(paper_ids) if paper_ids is not None else None
        if paper_id:
            chosen = [paper_id] if chosen is None or paper_id in chosen else []
        with self.connection() as db:
            sql = "SELECT x.*, p.title FROM pages x JOIN papers p ON p.id=x.paper_id"
            if chosen is None:
                rows = db.execute(sql).fetchall()
            else:
                rows = []
                for start in range(0, len(chosen), 500):
                    part = chosen[start:start + 500]
                    rows += db.execute(sql + f" WHERE x.paper_id IN ({','.join('?' * len(part))})", part).fetchall()
        scored = []
        for row in rows:
            data = dict(row)
            data["score"] = sum(data["text"].lower().count(term) for term in terms)
            scored.append(data)
        scored.sort(key=lambda x: (-x["score"], x["paper_id"], x["number"]))
        return scored[:limit]
