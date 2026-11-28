"""Synthetic legacy-library source for common-converter/native-save acceptance.

Creation is deliberately limited to the integration test's own temporary folder.
Backup readback uses plain read-only SQLite on a verified private copy, never
Library initialization or recovery of the original input.
"""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from papeer.core import notebook
from papeer.core.ink_model import InkStroke
from papeer.core.migrations.legacy_backup import NativeLegacyBackup
from papeer.core.storage import Library


def readback(root):
    with closing(sqlite3.connect((root / "library.sqlite3").as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        paper = db.execute("SELECT id FROM papers WHERE kind='notebook'").fetchone()[0]
        stored = json.loads((root / "papers" / paper / "notebook.json").read_text("utf-8"))
        pages = []
        for number, spec in enumerate(stored["pages"], 1):
            ink = db.execute("SELECT strokes FROM pdf_ink WHERE paper_id=? AND side='original' AND page=?", (paper, number)).fetchone()
            bookmarks = [dict(row) for row in db.execute("SELECT * FROM bookmarks WHERE paper_id=? AND page=? ORDER BY id", (paper, number))]
            for row in bookmarks:
                row["id"] = str(row["id"])  # JSON numbers cannot carry every SQLite int64 identity.
            pages.append({"sourcePageId": spec["id"], "widthPt": spec["width_mm"] * 72 / 25.4,
                          "heightPt": spec["height_mm"] * 72 / 25.4,
                          "spec": {key: spec[key] for key in ("size", "orientation", "template", "color")},
                          "ink": json.loads(ink[0]) if ink else [], "bookmarks": bookmarks})
        tables = {}
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            if name.startswith(("edit_", "sqlite_")):
                continue
            quoted = '"' + name.replace('"', '""') + '"'
            tables[name] = sorted([dict(row) for row in db.execute("SELECT * FROM " + quoted)], key=lambda row: json.dumps(row, sort_keys=True))
        schema = db.execute("PRAGMA user_version").fetchone()[0]
    files = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(root.rglob("*")) if path.is_file() and path.name not in ("library.sqlite3", "library.sqlite3-wal", "library.sqlite3-shm")}
    fingerprint = hashlib.sha256(json.dumps([schema, tables, files], sort_keys=True).encode()).hexdigest()
    return {"paperId": paper, "pages": pages, "sourceFingerprint": fingerprint}


def main():
    mode, root = sys.argv[1], Path(sys.argv[2]).resolve()
    if root.name != "legacy-library" or not root.parent.name.startswith("papeer-intent-http-") or root.parent.parent != Path(tempfile.gettempdir()).resolve():
        raise ValueError("not-an-isolated-fixture-directory")
    if mode == "backup-read":
        with NativeLegacyBackup(root).analysis_copy(sys.argv[3]) as working:
            print(json.dumps(readback(working)))
        return
    if mode == "create":
        if root.exists():
            raise ValueError("fixture-already-exists")
        lib = Library(root)
        identity = notebook.create(lib, "Legacy annotations", {"size": "Letter", "template": "blank"})
        notebook.change(lib, identity, 1, "append", spec={"size": "A4", "orientation": "landscape", "template": "grid5"})
    elif mode == "populate":
        source = readback(root)
        data = json.loads(Path(sys.argv[3]).read_text("utf-8"))
        if len(data) != len(source["pages"]):
            raise ValueError("fixture-page-count")
        lib = Library(root)
        last = None
        for number, values in enumerate(data, 1):
            strokes = [InkStroke.model_validate(stroke).model_dump(exclude_unset=True) for stroke in values["ink"]]
            lib.save_ink(source["paperId"], "original", number, strokes)
            for row in values["bookmarks"]:
                record = lib.add_bookmark(source["paperId"], number, "original", row["quote"], row["label"], row["note"],
                                          row["anchor_y"], row["anchor_x"], kind=row["kind"], color=row["color"], rects=json.loads(row["rects"]))
                last = record["id"]
                with lib.connection() as db:
                    db.execute("UPDATE bookmarks SET created_at=? WHERE id=?", (row["created_at"], last))
        with lib.connection() as db:
            db.execute("UPDATE bookmarks SET id=9223372036854775807 WHERE id=?", (last,))
    elif mode != "read":
        raise ValueError("unknown-fixture-mode")
    print(json.dumps(readback(root)))


if __name__ == "__main__":
    main()
