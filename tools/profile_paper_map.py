"""Measure one real paper on a read-only source snapshot; never update the live library."""
from __future__ import annotations

import argparse
from contextlib import closing
import json
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from papeer.core import discovery, map_timing
from papeer.core.paths import data_directory
from papeer.core.storage import Library
from papeer.providers import Cancelled


def snapshot(source: Path, destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect((source / "library.sqlite3").as_uri() + "?mode=ro", uri=True)) as original:
        with closing(sqlite3.connect(destination / "library.sqlite3")) as copied:
            original.backup(copied)
            ids = [row[0] for row in copied.execute("SELECT id FROM papers")]
    for paper in ids:
        if not re.fullmatch(r"[0-9a-f]{32}", paper): raise ValueError("Invalid snapshot paper ID")
        document = source / "papers" / paper / "document.json"
        if document.is_file():
            target = destination / "papers" / paper
            target.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(document, target / "document.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, default=data_directory())
    parser.add_argument("--paper-id", default="")
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--cached-only", action="store_true")
    parser.add_argument("--map-output", type=Path, help="Save the map response for separate frontend layout measurement")
    args = parser.parse_args()
    if args.timeout <= 0: parser.error("timeout must be positive")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="papeer-map-profile-") as temporary:
        root = Path(temporary) / "library"
        snapshot(args.library.resolve(), root)
        lib = Library(root)
        with lib.connection() as db:
            candidates = [(json.loads(row[2]).get("checked_at", ""), row[0]) for row in
                          db.execute("SELECT source,origin,data FROM paper_discovery WHERE source=origin")]
        paper_id = args.paper_id or (max(candidates)[1] if candidates else lib.papers()[0]["id"])
        paper = lib.paper(paper_id)
        report = dict(paper_id=paper_id, title=paper["title"], doi=paper.get("doi", ""),
                      library_papers=len(lib.papers()), isolation="sqlite_snapshot_and_copied_documents")
        with map_timing.session() as trace:
            cached = discovery.build(lib, paper_id)
        report["cached_display"] = dict(trace.snapshot("completed"), nodes=len(cached["nodes"]), edges=len(cached["edges"]))
        if args.map_output:
            args.map_output.parent.mkdir(parents=True, exist_ok=True)
            args.map_output.write_text(json.dumps(cached, ensure_ascii=False), encoding="utf-8")
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"保存済み結果: {trace.snapshot('completed')['total_ms'] / 1000:.3f}秒", flush=True)
        if not args.cached_only:
            with lib.connection() as db:
                db.execute("DELETE FROM paper_discovery WHERE source=? AND origin IN (?,?)", (paper_id, paper_id, "bibliography"))
            cancel = threading.Event()
            deadline = threading.Event()
            def stop():
                deadline.set(); cancel.set()
            timer = threading.Timer(args.timeout, stop)
            timer.daemon = True
            timer.start()
            start = time.perf_counter()
            def progress(message):
                print(f"{time.perf_counter() - start:.1f}秒: {message}", flush=True)
            try:
                result = discovery.discover(lib, paper_id, paper_id, cancel, progress, force=True)
                report["fresh_discovery"] = dict(result["timing"], nodes=len(result["nodes"]), edges=len(result["edges"]), warnings=result["warnings"])
                if args.map_output:
                    args.map_output.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            except Cancelled:
                report["fresh_discovery"] = dict(discovery.read_cache(lib, paper_id, paper_id)["timing"],
                                                stop_reason="timeout" if deadline.is_set() else "canceled")
            except Exception:
                report["fresh_discovery"] = discovery.read_cache(lib, paper_id, paper_id).get("timing", {})
                raise
            finally:
                timer.cancel()
                args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"計測結果: {args.report.resolve()}", flush=True)


if __name__ == "__main__":
    main()
