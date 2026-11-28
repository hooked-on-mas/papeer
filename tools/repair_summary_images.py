"""Restore original-PDF figures without rewriting summary prose or invoking a model.

This recovery path has a separate, deterministic image verification report. It never
claims that a changed article passed the model's full-content review. The normal
generation and review gates remain unchanged.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import html
import json
from pathlib import Path
import re
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from papeer.core.fileio import atomic_write_bytes, atomic_write_json
from papeer.core.paths import data_directory
from papeer.core.summary.figures import SUMMARY_IMAGE_VERSION
from papeer.core.summary.review import IMAGE
from tools.repair_summaries import backup_summary, digest, image_inventory
from tools.verify_summary_quality import verify

# Markdown link definitions stay invisible even in renderers that escape HTML comments.
START = "[papeer-source-image-supplement-start]: #"
END = "[papeer-source-image-supplement-end]: #"
SUPPLEMENT = re.compile(
    re.escape(START) + r".*?" + re.escape(END)
    + r"|<!-- papeer-source-image-supplement:start -->.*?<!-- papeer-source-image-supplement:end -->", re.S)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def supplement(article: str, catalog: list[dict], identity: str) -> tuple[str, str]:
    """Keep prose and existing valid image positions; add omitted source assets."""
    base = SUPPLEMENT.sub("", article).rstrip()
    assets = {item["path"]: item for item in catalog}
    used: set[str] = set()

    def image(match: re.Match) -> str:
        path = match[1]
        if path not in assets or path in used:
            return ""
        used.add(path)
        return match[0]

    revised = IMAGE.sub(image, base)
    missing = [item for item in catalog if item["path"] not in used]
    if missing:
        lines = [START, "", "## 原文の図表", ""]
        page = None
        for item in missing:
            if item["page"] != page:
                page = item["page"]
                lines.extend([f"### 原文 p.{page}", ""])
            caption = html.escape(item["caption"], quote=False).replace("[", "&#91;").replace("]", "&#93;")
            lines.extend([f"![{caption}]({item['path']})", "",
                          f"{caption} [p.{page}](papeer://{identity}/{page})", ""])
        lines.append(END)
        revised = revised.rstrip() + "\n\n" + "\n".join(lines) + "\n"
    else:
        revised = article if revised == base and not SUPPLEMENT.search(article) else revised.rstrip() + "\n"
    return revised, sha(IMAGE.sub("", base).rstrip())


def verify_images(folder: Path, catalog: list[dict], images: dict[str, bytes], record: dict) -> dict:
    article = (folder / "article.md").read_text("utf-8")
    paths = IMAGE.findall(article)
    base = SUPPLEMENT.sub("", article).rstrip()
    checks = {
        "exact_article": sha(article) == record["article_sha256"],
        "prose_preserved": sha(IMAGE.sub("", base).rstrip()) == record["preserved_prose_sha256"],
        "every_source_image_once": Counter(paths) == Counter(images.keys()),
        "exact_source_crops": all((folder / path).read_bytes() == blob for path, blob in images.items()),
        "current_extractor": record["image_extraction_version"] == SUMMARY_IMAGE_VERSION,
        "exact_manifest": record["image_catalog"] == catalog,
        "original_unchanged": digest(folder / "original.pdf") == record["original_pdf_sha256"],
    }
    return {"passed": all(checks.values()), "checks": checks}


def repair(folder: Path, out: Path, *, apply: bool) -> dict:
    before = (folder / "article.md").read_text("utf-8")
    before_hash, original_hash = sha(before), digest(folder / "original.pdf")
    before_file_hash = digest(folder / "article.md")
    report_path = folder / "article-review.json"
    report_hash = digest(report_path)
    catalog, images, captions = image_inventory(folder)
    article, preserved = supplement(before, catalog, folder.name)
    # No-change accepted text can retain its independent review. A changed article
    # must never inherit a passed acceptance or a fabricated audit hash.
    try:
        content_review = verify(folder, require_image_manifest=False)
    except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
        content_review = {"passed": False, "error": str(error)}
    record = {
        "version": 1, "method": "original-pdf-image-supplement",
        "article_sha256": sha(article), "before_article_sha256": before_hash,
        "preserved_prose_sha256": preserved, "original_pdf_sha256": original_hash,
        "image_extraction_version": SUMMARY_IMAGE_VERSION,
        "image_catalog": catalog, "source_caption_pages": captions,
        "images": {path: hashlib.sha256(blob).hexdigest() for path, blob in images.items()},
        "prior_content_review": content_review,
        "full_content_review_after_repair": "unchanged" if article == before else "not_performed",
    }
    result = {"paper_id": folder.name, "images": len(images), "article_changed": article != before,
              "prior_content_review_passed": content_review["passed"], "applied": apply}
    if not apply:
        return result
    backup = out / "backups" / folder.name
    if not backup.exists():
        backup_summary(folder, backup)
        if (prior := folder / "article-image-repair.json").is_file():
            (backup / prior.name).write_bytes(prior.read_bytes())
    if (digest(folder / "article.md") != before_file_hash or digest(report_path) != report_hash
            or digest(folder / "original.pdf") != original_hash):
        raise RuntimeError("検査中に元ファイルが変更されました。")
    (folder / "media").mkdir(exist_ok=True)
    for path, blob in images.items():
        atomic_write_bytes(folder / path, blob)
    atomic_write_bytes(folder / "article.md", article.encode("utf-8"))
    report = json.loads(report_path.read_text("utf-8")) if report_path.exists() else {}
    if article != before:
        report["prior_acceptance"] = report.get("acceptance")
        report["acceptance"] = "image-repaired-content-review-pending"
        report["image_only_repair"] = "article-image-repair.json"
    report.update(image_extraction_version=SUMMARY_IMAGE_VERSION, image_catalog=catalog,
                  available_images=list(images), image_coverage="complete", source_caption_pages=captions)
    atomic_write_json(report_path, report)
    record["verification"] = verify_images(folder, catalog, images, record)
    atomic_write_json(folder / "article-image-repair.json", record)
    if not record["verification"]["passed"]:
        raise ValueError("図表の補修検査に失敗しました。")
    result["verification"] = record["verification"]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=data_directory())
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--ids", nargs="*", help="Limit recovery to the selected paper IDs or prefixes.")
    args = parser.parse_args()
    root, out = args.root.resolve(), args.output.resolve()
    if root == out or root in out.parents:
        parser.error("作業先はライブラリの外に指定してください。")
    out.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect((root / "library.sqlite3").as_uri() + "?mode=ro", uri=True) as db:
        ids = [row[0] for row in db.execute("select id from papers where kind='pdf' order by id")]
    if args.ids:
        ids = [identity for identity in ids if any(identity.startswith(prefix) for prefix in args.ids)]
    results = []
    for identity in ids:
        try:
            result = repair(root / "papers" / identity, out, apply=args.apply)
            print(identity[:4], result["images"], "images", "updated" if result["article_changed"] else "verified", flush=True)
        except Exception as error:  # noqa: BLE001 -- preserve every other paper's recovery on one failure.
            result = {"paper_id": identity, "error": str(error)}
            print(identity[:4], "FAILED", str(error), flush=True)
        results.append(result)
        atomic_write_json(out / "results.json", results)
    return int(any("error" in result for result in results))


if __name__ == "__main__":
    raise SystemExit(main())
