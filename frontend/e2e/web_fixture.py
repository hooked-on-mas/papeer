"""Real PC snapshot used by the browser test; all files are synthetic and under output/web-library."""
import hashlib
import json
import mimetypes
from pathlib import Path
import sys
import threading

import pymupdf

from papeer.core.cloud_annotations import import_operations
from papeer.core.cloud_drive import snapshot
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library


target = Path(sys.argv[2]).resolve()
assert target.is_relative_to(Path(__file__).resolve().parents[2] / "output" / "web-library")
target.mkdir(parents=True, exist_ok=True)
lib = Library(target / "pc-library")
if sys.argv[1] == "prepare":
    source = target / "original.pdf"
    with pymupdf.open() as pdf:
        for i in range(2):
            pdf.new_page(width=600, height=800 if i == 0 else 500).insert_text((40, 40), f"PC original page {i + 1}")
        pdf.save(source)
    paper, _ = lib.import_pdf(source)
    files = PaperFiles(lib.folder(paper))
    with pymupdf.open(source) as pdf:
        for page in pdf:
            page.insert_text((40, 100), "PCで翻訳したPDFです。", fontname="japan", fontsize=16)
        pdf.save(files.translated_pdf)
    lib.save_ink(paper, "translated", 1, [{"id": "pc-ink", "color": "#0066ff", "width": .004, "points": [[.1, .2], [.4, .2]]}])
    (target / "paper-id").write_text(paper, "utf-8")
else:
    operations = json.loads((target / "operations.json").read_text("utf-8"))
    class Remote:
        def list(self, _query):
            return [{"id": str(i), "size": len(json.dumps(op))} for i, op in enumerate(operations)]

        def json(self, url):
            return operations[int(url.split("/")[-1].split("?")[0])]
    import_operations(lib, Remote(), "library", threading.Event())
paper = (target / "paper-id").read_text("utf-8")
dest = target / ("snapshot-" + sys.argv[1]); dest.mkdir(exist_ok=True)
manifest = snapshot(lib, dest, threading.Event())
manifest.update({"revision": sys.argv[1], "updated_at": "2026-10-18T06:00:00Z", "folder_id": "folder", "files": {}})
for path in dest.rglob("*"):
    if path.is_file():
        data = path.read_bytes()
        manifest["files"][path.relative_to(dest).as_posix()] = {"id": "fixture-" + hashlib.sha256(data).hexdigest(),
            "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
            "mime": mimetypes.guess_type(path.name)[0] or "application/octet-stream"}
(target / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), "utf-8")
print(json.dumps({"paper": paper, "strokes": len(lib.ink(paper, "translated", 1))}))
