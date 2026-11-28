"""Audit and repair local summaries through the normal generation/review pipeline.

Run with --apply to publish accepted results. Originals and translations are never
modified. Each summary is backed up, regenerated in a separate library, checked,
then published only if the live source and article have not changed meanwhile.
Failed work is resumable; successful model requests are cached by their full input.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import threading
import time
from typing import cast

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz

from papeer.core.config import Settings
from papeer.core.fileio import atomic_write_bytes, atomic_write_json
from papeer.core.paths import PaperFiles, data_directory
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.core.summary.figures import (SUMMARY_IMAGE_VERSION, render_summary_figure, summary_caption_labels,
                                        summary_figures)
from papeer.pdf.pdf_engine import PDF_LOCK
from papeer.providers import ProviderBackend, create_provider
from tools.verify_summary_quality import verify


def digest(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def image_inventory(folder: Path) -> tuple[list[dict], dict[str, bytes], list[dict]]:
    document = json.loads((folder / "document.json").read_text("utf-8"))
    catalog, images, captions = [], {}, []
    with PDF_LOCK, fitz.open(folder / "original.pdf") as pdf:
        for number in range(1, len(pdf) + 1):
            page = pdf[number - 1]
            page.set_rotation(0)
            labels = summary_caption_labels(page)
            if labels:
                captions.append({"page": number, "labels": labels})
            for item in summary_figures(page, document.get("blocks", []), number,
                                        following_page=pdf[number] if number < len(pdf) else None):
                path = f"media/{item['id']}.png"
                catalog.append({"path": path, "page": number, "kind": item["kind"],
                                "caption": item["caption"], "bbox": list(item["rect"]),
                                "rotation": item.get("rotation", 0),
                                "caption_page": item.get("caption_page", number)})
                images[path] = render_summary_figure(page, item)
    if captions and not images:
        raise ValueError("原文に図表キャプションがあるのに画像抽出が0件です。")
    return catalog, images, captions


def assess(folder: Path, images: dict[str, bytes]) -> dict:
    try:
        result = verify(folder, require_image_manifest=False)
    except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
        return {"passed": False, "error": str(error)}
    report = json.loads((folder / "article-review.json").read_text("utf-8"))
    same_catalog = set(images) == set(report.get("available_images", []))
    same_crops = same_catalog and all(
        (folder / path).is_file() and (folder / path).read_bytes() == content
        for path, content in images.items())
    result["checks"].update(current_image_catalog=same_catalog, current_image_crops=same_crops,
                            full_document=report.get("source_pages") == list(range(
                                1, json.loads((folder / "document.json").read_text("utf-8"))["page_count"] + 1)))
    result["passed"] = all(result["checks"].values())
    return result


def backup_summary(folder: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=False)
    for name in ("article.md", "article-review.json", "article-usage.json"):
        if (folder / name).is_file():
            shutil.copy2(folder / name, target / name)
    if (folder / "media").is_dir():
        shutil.copytree(folder / "media", target / "media")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=data_directory())
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=2, choices=range(1, 5))
    parser.add_argument("--ids", nargs="*")
    parser.add_argument("--largest-first", action="store_true", help="Start long papers early in a batch.")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    root, out = args.root.resolve(), args.output.resolve()
    if root == out or root in out.parents:
        parser.error("作業先はライブラリの外に指定してください。")
    out.mkdir(parents=True, exist_ok=True)
    clone = out / "library"
    clone.mkdir(exist_ok=True)
    with sqlite3.connect((root / "library.sqlite3").as_uri() + "?mode=ro", uri=True) as source:
        with sqlite3.connect(clone / "library.sqlite3") as dest:
            source.backup(dest)
        source.row_factory = sqlite3.Row
        papers = [dict(r) for r in source.execute("select id,title,pages from papers where kind='pdf' order by pages")]
    if args.ids:
        papers = [p for p in papers if any(p["id"].startswith(prefix) for prefix in args.ids)]
    if args.largest_first:
        papers.sort(key=lambda paper: paper["pages"], reverse=True)
    settings = Settings.load(root)
    os.environ["PAPEER_DATA_DIR"] = str(root)  # Respect the user's prompt overrides throughout staging.
    library = Library(clone)
    print(f"Inspecting {len(papers)} papers; provider={settings.provider}, model={settings.model}", flush=True)

    def run(paper: dict) -> dict:
        identity = paper["id"]
        live = root / "papers" / identity
        work = clone / "papers" / identity
        state_path = out / f"{identity}-result.json"
        log_path = out / f"{identity}.log"
        def log(message):
            line = time.strftime("%H:%M:%S") + " " + str(message)
            with log_path.open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")
            print(identity[:4], line, flush=True)
        result = {"paper_id": identity, "title": paper["title"], "status": "inspecting"}
        atomic_write_json(state_path, result)
        try:
            source_hash = digest(live / "original.pdf")
            article_hash = digest(live / "article.md")
            report_hash = digest(live / "article-review.json")
            catalog, images, captions = image_inventory(live)
            result["images"] = len(images)
            assessment = assess(live, images)
            result["before"] = assessment
            if assessment["passed"]:
                report = json.loads((live / "article-review.json").read_text("utf-8"))
                if args.apply and report.get("image_extraction_version") != SUMMARY_IMAGE_VERSION:
                    backup = out / "backups" / identity
                    if not backup.exists():
                        backup_summary(live, backup)
                    if digest(live / "article.md") != article_hash or digest(live / "article-review.json") != report_hash:
                        raise RuntimeError("検査中にサマリーが変更されたため保存を見送りました。")
                    report.update(image_extraction_version=SUMMARY_IMAGE_VERSION, image_catalog=catalog,
                                  image_coverage="complete", source_caption_pages=captions,
                                  original_pdf_sha256=source_hash,
                                  image_revalidation={"previous_report_sha256": report_hash,
                                                      "method": "Fresh PDF crops equal accepted assets; article unchanged."})
                    atomic_write_json(live / "article-review.json", report)
                result["status"] = "verified_unchanged"
                log(f"Existing accepted article and all {len(images)} images verified")
            elif not args.apply:
                result["status"] = "needs_repair"
                log(f"Needs repair; {len(images)} source images")
            else:
                backup = out / "backups" / identity
                if not backup.exists():
                    backup_summary(live, backup)
                work.mkdir(parents=True, exist_ok=True)
                if not (work / "original.pdf").exists():
                    os.link(live / "original.pdf", work / "original.pdf")
                shutil.copy2(live / "document.json", work / "document.json")
                backend = create_provider(settings, threading.Event())
                calls = out / "calls" / identity
                calls.mkdir(parents=True, exist_ok=True)
                class Recorder:
                    def generate(self, instruction, data, schema=None):
                        key = hashlib.sha256(json.dumps([
                            settings.provider, settings.model, settings.reasoning_effort,
                            instruction, data, schema], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
                        path = calls / f"{key}.json"
                        if path.is_file():
                            return json.loads(path.read_text("utf-8"))["answer"]
                        log(f"Request {'review' if schema else 'generation'} ({len(data)} chars)")
                        answer = backend.generate(instruction, data, schema)
                        atomic_write_json(path, {"instruction": instruction, "data": data, "schema": schema,
                                                 "answer": answer, "provider": settings.provider,
                                                 "model": settings.model, "effort": settings.reasoning_effort})
                        return answer
                    def usage_report(self):
                        return backend.usage_report()
                result["status"] = "generating"
                atomic_write_json(state_path, result)
                # --apply repairs the complete saved article, including long papers:
                # pass the explicit full-document scope required by the normal UI.
                pages = set(range(1, paper["pages"] + 1))
                PaperService(library, cast(ProviderBackend, Recorder()), backend.cancel, log).article(identity, pages)
                checked = verify(work)
                if not checked["passed"]:
                    raise RuntimeError("生成済みサマリーの検証に失敗: " + json.dumps(checked, ensure_ascii=False))
                if (digest(live / "original.pdf") != source_hash or digest(live / "article.md") != article_hash
                        or digest(live / "article-review.json") != report_hash):
                    raise RuntimeError("処理中に元論文またはサマリーが変わりました。検証済み原稿は作業先に保持しています。")
                # Only a completed, independently checked staging result is published.
                staged_report = json.loads((work / "article-review.json").read_text("utf-8"))
                files = PaperFiles(work)
                (live / "media").mkdir(exist_ok=True)
                for image in files.summary_images():
                    atomic_write_bytes(live / "media" / image.name, image.read_bytes())
                atomic_write_bytes(live / "article-review.json", (work / "article-review.json").read_bytes())
                atomic_write_bytes(live / "article.md", (work / "article.md").read_bytes())
                if files.article_usage.is_file():
                    atomic_write_bytes(live / "article-usage.json", files.article_usage.read_bytes())
                result.update(status="repaired", after=verify(live),
                              images=len(staged_report["available_images"]), usage=backend.usage_report())
                log(f"Published accepted summary with {result['images']} images")
        except Exception as error:  # noqa: BLE001 -- isolate each paper and retain a resumable failure record.
            result.update(status="failed", error=str(error))
            log("FAILED " + str(error))
        atomic_write_json(state_path, result)
        return result

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(run, papers))
    atomic_write_json(out / "results.json", results)
    counts = {status: sum(r["status"] == status for r in results)
              for status in sorted({r["status"] for r in results})}
    print(json.dumps(counts, ensure_ascii=False), flush=True)
    return int(any(r["status"] == "failed" for r in results))


if __name__ == "__main__":
    raise SystemExit(main())
