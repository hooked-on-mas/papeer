"""Finite-page notebooks. JSON is the source; PDF and page-numbered rows follow one recoverable change.

The synthetic sha256 records the committed generation without changing schema 8. A durable journal
holds both file versions until SQLite commits. On restart, the DB marker chooses rollback or completion.
Only opening the live Library runs recovery; snapshot inspection uses plain, read-only SQL.
"""
from __future__ import annotations

from contextlib import closing
import copy
import json
from pathlib import Path
import sqlite3
import threading
import uuid

import pymupdf

from papeer.core.collection_paths import normalize_collection_name
from papeer.core.errors import Conflict, Invalid, NotFound
from papeer.core.fileio import atomic_write_bytes, atomic_write_text

SIZES = {"A4": (210, 297), "B5": (182, 257), "A5": (148, 210), "Letter": (215.9, 279.4), "16:9": (180, 320)}
TEMPLATES = ("blank", "ruled7", "ruled6", "ruled5", "grid5", "grid10", "dot5", "cornell")
COLORS = {"white": (1, 1, 1), "cream": (1, .97, .88), "dark": (.12, .14, .17)}
_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


def lock(root: Path, identity: str):
    with _locks_guard:
        return _locks.setdefault(str(root.resolve() / identity), threading.RLock())


def page_spec(size="A4", orientation="portrait", template="ruled7", color="white", identity=None) -> dict:
    if size not in SIZES or orientation not in ("portrait", "landscape") or template not in TEMPLATES or color not in COLORS:
        raise Invalid("用紙の設定が不正です。")
    width, height = SIZES[size]
    if orientation == "landscape":
        width, height = height, width
    return {"id": identity or uuid.uuid4().hex, "size": size, "orientation": orientation,
            "width_mm": width, "height_mm": height, "template": template, "color": color}


def pdf(document: dict) -> bytes:
    mm = 72 / 25.4
    with pymupdf.open() as output:
        for spec in document["pages"]:
            width, height = spec["width_mm"] * mm, spec["height_mm"] * mm
            page = output.new_page(width=width, height=height)
            page.draw_rect(page.rect, color=None, fill=COLORS[spec["color"]])
            shade = (.35, .39, .45) if spec["color"] == "dark" else (.75, .79, .83)
            shape = page.new_shape()
            template = spec["template"]
            margin = 15 * mm
            spacing = (int(template[-1]) if template.startswith("ruled") else 10 if template == "grid10" else 5) * mm
            if template.startswith("ruled") or template == "cornell":
                spacing = (7 if template == "cornell" else int(template[-1])) * mm
                bottom = height - (35 * mm if template == "cornell" else margin)
                y = margin + spacing
                while y < bottom:
                    shape.draw_line((margin, y), (width - margin, y))
                    y += spacing
                if template == "cornell":
                    shape.draw_line((width * .28, margin), (width * .28, bottom))
                    shape.draw_line((margin, bottom), (width - margin, bottom))
            elif template.startswith("grid") or template == "dot5":
                x = margin
                while x < width - margin:
                    if template == "dot5":
                        y = margin
                        while y < height - margin:
                            shape.draw_circle((x, y), .45)
                            y += spacing
                    else:
                        shape.draw_line((x, margin), (x, height - margin))
                    x += spacing
                if template != "dot5":
                    y = margin
                    while y < height - margin:
                        shape.draw_line((margin, y), (width - margin, y))
                        y += spacing
            shape.finish(color=shade, width=.35)
            shape.commit()
        return output.tobytes(garbage=4, deflate=True)


def read(lib, identity: str) -> dict:
    with lock(lib.root, identity):
        if lib.paper(identity)["kind"] != "notebook":
            raise Invalid("手書きノートを選んでください。")
        document = json.loads((lib.folder(identity) / "notebook.json").read_text("utf-8"))
        if document.get("version") != 1 or not document.get("pages"):
            raise Invalid("ノートの形式を読み込めません。")
        return document


def _clean(folder: Path):
    # Remove the journal last: interrupted cleanup can still be replayed.
    for name in (".notebook-before.pdf", ".notebook-after.pdf"):
        (folder / name).unlink(missing_ok=True)
    (folder / ".notebook-change.json").unlink(missing_ok=True)


def recover(root: Path, identity: str | None = None):
    journals = [(root / "papers" / identity / ".notebook-change.json")] if identity else (root / "papers").glob("*/.notebook-change.json")
    for journal in journals:
        identity, folder = journal.parent.name, journal.parent
        with lock(root, identity):
            if not journal.exists():
                continue
            data = json.loads(journal.read_text("utf-8"))
            with closing(sqlite3.connect(root / "library.sqlite3", timeout=30)) as db:
                row = db.execute("SELECT sha256 FROM papers WHERE id=?", (identity,)).fetchone()
            if row is None:
                _clean(folder)
                continue
            committed = row[0] == data["marker"]
            document = data["after" if committed else "before"]
            source = folder / (".notebook-after.pdf" if committed else ".notebook-before.pdf")
            # Cleanup may already have removed a stage: the chosen files were installed before cleanup.
            if source.exists():
                atomic_write_bytes(folder / "original.pdf", source.read_bytes())
            atomic_write_text(folder / "notebook.json", json.dumps(document, ensure_ascii=False))
            _clean(folder)


def create(lib, title: str, spec: dict, collection="", parent_id=None) -> str:
    title = " ".join(title.split())
    if not title or len(title) > 200:
        raise Invalid("ノート名は1〜200文字で入力してください。")
    identity = uuid.uuid4().hex
    document = {"version": 1, "revision": 1, "pages": [page_spec(**spec)]}
    folder = lib.folder(identity)
    try:
        with lock(lib.root, "placement"), lib.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            if parent_id:
                parent = db.execute("SELECT parent_id FROM papers WHERE id=?", (parent_id,)).fetchone()
                if parent is None:
                    raise NotFound("持ち主が見つかりません。")
                if parent[0] is not None:
                    raise Invalid("持ち物のノートには中身を追加できません。")
            folder.mkdir()
            atomic_write_text(folder / "notebook.json", json.dumps(document, ensure_ascii=False))
            atomic_write_bytes(folder / "original.pdf", pdf(document))
            db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status,kind,parent_id,collection_name)"
                       " VALUES(?,?,?,?,1,'not_translated','notebook',?,?)",
                       (identity, f"notebook:{identity}:1", title, title, parent_id,
                        "" if parent_id else normalize_collection_name(collection)))
            db.execute("INSERT INTO pages VALUES(?,1,'')", (identity,))
    except Exception:
        if folder.exists():
            import shutil
            shutil.rmtree(folder)
        raise
    return identity


def change(lib, identity: str, revision: int, action: str, page_id=None, order=None, spec=None) -> dict:
    with lock(lib.root, identity):
        before = read(lib, identity)
        if revision != before["revision"]:
            raise Conflict("ページ構成が変わりました。再読み込みして操作してください。")
        after = copy.deepcopy(before)
        pages = after["pages"]
        old_numbers = {page["id"]: number for number, page in enumerate(pages, 1)}
        index = next((i for i, page in enumerate(pages) if page["id"] == page_id), -1)
        if action != "append" and action != "reorder" and index < 0:
            raise NotFound("ページが見つかりません。")
        copies = {}
        if action in ("insert", "append", "duplicate"):
            if len(pages) >= 500:
                raise Invalid("ノートは500ページまでです。")
            source = pages[index] if index >= 0 else pages[-1]
            added = page_spec(**(spec or {key: source[key] for key in ("size", "orientation", "template", "color")}))
            pages.insert(len(pages) if action == "append" else index + 1, added)
            if action == "duplicate":
                copies[added["id"]] = source["id"]
        elif action == "delete":
            if len(pages) == 1:
                raise Invalid("最後の1ページは削除できません。")
            pages.pop(index)
        elif action == "paper":
            if spec is None:
                raise Invalid("用紙を指定してください。")
            pages[index] = page_spec(**spec, identity=page_id)
        elif action == "reorder":
            if not order or len(order) != len(set(order)) or set(order) != set(old_numbers):
                raise Invalid("ページ一覧が変わりました。再読み込みしてください。")
            by_id = {page["id"]: page for page in pages}
            after["pages"] = pages = [by_id[page_id] for page_id in order]
        else:
            raise Invalid("ページ操作が不正です。")
        after["revision"] += 1
        folder = lib.folder(identity)
        marker = f"notebook:{identity}:{after['revision']}"
        atomic_write_bytes(folder / ".notebook-before.pdf", (folder / "original.pdf").read_bytes())
        atomic_write_bytes(folder / ".notebook-after.pdf", pdf(after))
        atomic_write_text(folder / ".notebook-change.json", json.dumps({"marker": marker, "before": before, "after": after}, ensure_ascii=False))
        try:
            with lib.connection() as db:
                db.execute("BEGIN IMMEDIATE")
                texts = {row["number"]: row["text"] for row in db.execute("SELECT * FROM pages WHERE paper_id=?", (identity,))}
                inks = {row["page"]: row["strokes"] for row in db.execute("SELECT * FROM pdf_ink WHERE paper_id=? AND side='original'", (identity,))}
                marks = [dict(row) for row in db.execute("SELECT * FROM bookmarks WHERE paper_id=?", (identity,))]
                db.execute("DELETE FROM pages WHERE paper_id=?", (identity,))
                db.execute("DELETE FROM pdf_ink WHERE paper_id=?", (identity,))
                db.execute("DELETE FROM bookmarks WHERE paper_id=?", (identity,))
                for number, page in enumerate(pages, 1):
                    source = old_numbers.get(copies.get(page["id"], page["id"]))
                    db.execute("INSERT INTO pages VALUES(?,?,?)", (identity, number, texts.get(source, "")))
                    if source in inks:
                        db.execute("INSERT INTO pdf_ink VALUES(?,'original',?,?)", (identity, number, inks[source]))
                    for mark in marks:
                        if mark["page"] != source or mark["side"] != "original":
                            continue
                        # Retained page bookmarks keep IDs; a duplicate gets new IDs from SQLite.
                        values = {key: value for key, value in mark.items() if key != "id" or page["id"] not in copies}
                        values["page"] = number
                        db.execute(f"INSERT INTO bookmarks({','.join(values)}) VALUES({','.join('?' for _ in values)})", list(values.values()))
                db.execute("UPDATE papers SET pages=?,sha256=? WHERE id=?", (len(pages), marker, identity))
                atomic_write_text(folder / "notebook.json", json.dumps(after, ensure_ascii=False))
                atomic_write_bytes(folder / "original.pdf", (folder / ".notebook-after.pdf").read_bytes())
            _clean(folder)
        except Exception:
            recover(lib.root, identity)
            raise
        return after


def page_number(lib, identity: str, page_id: str) -> int:
    document = read(lib, identity)
    for number, page in enumerate(document["pages"], 1):
        if page["id"] == page_id:
            return number
    raise NotFound("ページは削除されています。")


def move(lib, identity: str, parent_id: str | None, collection=""):
    with lock(lib.root, "placement"), lock(lib.root, identity), lib.connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT kind FROM papers WHERE id=?", (identity,)).fetchone()
        if row is None or row[0] != "notebook":
            raise Invalid("手書きノートを選んでください。")
        if parent_id:
            parent = db.execute("SELECT parent_id FROM papers WHERE id=?", (parent_id,)).fetchone()
            if parent is None or parent_id == identity:
                raise Invalid("持ち主を選んでください。")
            if parent[0] is not None:
                raise Invalid("持ち物には中身を追加できません。")
            if db.execute("SELECT 1 FROM attachments WHERE owner_id=? UNION SELECT 1 FROM papers WHERE parent_id=?"
                          " UNION SELECT 1 FROM item_links WHERE a=? OR b=?", (identity, identity, identity, identity)).fetchone():
                raise Invalid("中身や紐づけのあるノートは持ち物にできません。先に中身を整理してください。")
        db.execute("UPDATE papers SET parent_id=?,collection_name=? WHERE id=?",
                   (parent_id, "" if parent_id else normalize_collection_name(collection), identity))


def request_page(lib, identity: str, page_id: str | None, number: int, side: str) -> int:
    """Resolve an admitted request under lock; a stale page number is never a notebook address."""
    if lib.paper(identity)["kind"] != "notebook":
        return number
    if not page_id or side != "original":
        raise Conflict("ノートの操作には安定したページIDが必要です。再読み込みしてください。")
    return page_number(lib, identity, page_id)


def bookmarks_with_ids(lib, rows: list[dict]) -> list[dict]:
    documents = {}
    for row in rows:
        identity = row["paper_id"]
        if identity not in documents:
            documents[identity] = read(lib, identity) if lib.paper(identity)["kind"] == "notebook" else None
        document = documents[identity]
        if document and 1 <= row["page"] <= len(document["pages"]):
            row["page_id"] = document["pages"][row["page"]-1]["id"]
    return rows
