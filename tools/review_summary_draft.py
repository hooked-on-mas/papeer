"""Resume an unaccepted draft through full original-page review and clean final audit.

The input is never an acceptance override. Every page, proposed correction, image
reference and final article must pass the same gates used by normal generation.
The live summary changes only after a staged result passes verification.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf as fitz

from papeer.core.config import Settings
from papeer.core.fileio import atomic_write_bytes, atomic_write_json
from papeer.core.paths import data_directory
from papeer.core.service import link_citations
from papeer.core.summary.figures import SUMMARY_IMAGE_VERSION
from papeer.core.summary.quality import finalize_article
from papeer.core.summary.review import normalize_citation_code, reference_issues
from papeer.core.summary.source import summary_source_text
from papeer.pdf.pdf_engine import PDF_LOCK
from papeer.providers import create_provider
from tools.repair_summaries import backup_summary, digest, image_inventory
from tools.verify_summary_quality import verify


def run(root: Path, identity: str, seed: Path, out: Path, *, apply: bool) -> dict:
    live = root / "papers" / identity
    if not live.resolve().is_relative_to((root / "papers").resolve()):
        raise ValueError("対象の論文フォルダーが不正です。")
    hashes = {name: digest(live / name) for name in ("original.pdf", "document.json", "article.md", "article-review.json")}
    document = json.loads((live / "document.json").read_text("utf-8"))
    catalog, images, captions = image_inventory(live)
    cached = {page["number"]: page["text"] for page in document["pages"]}
    source_units = []
    with PDF_LOCK, fitz.open(live / "original.pdf") as pdf:
        if len(pdf) != document["page_count"]:
            raise ValueError("原本と抽出データのページ数が一致しません。")
        for number in range(1, len(pdf) + 1):
            page = pdf[number - 1]
            page.set_rotation(0)
            figures = [dict(id=Path(item["path"]).stem, rect=fitz.Rect(item["bbox"]))
                       for item in catalog if item["page"] == number]
            text = summary_source_text(page, cached[number], document.get("blocks", []), number, figures)
            for offset in range(0, max(1, len(text)), 10000):
                source_units.append({"id": f"p{number}-{offset}", "page": number, "text": text[offset:offset + 10000]})
    settings = Settings.load(root)
    os.environ["PAPEER_DATA_DIR"] = str(root)
    backend = create_provider(settings, threading.Event())
    calls = out / "calls" / identity
    calls.mkdir(parents=True, exist_ok=True)

    def log(message):
        with (out / f"{identity}.log").open("a", encoding="utf-8") as stream:
            stream.write(str(message) + "\n")
        print(identity[:4], message, flush=True)

    class Recorder:
        def generate(self, instruction, data, schema=None):
            key = hashlib.sha256(json.dumps([settings.provider, settings.model, settings.reasoning_effort,
                instruction, data, schema], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
            path = calls / f"{key}.json"
            if path.is_file():
                return json.loads(path.read_text("utf-8"))["answer"]
            log(f"Request review ({len(data)} chars)")
            answer = backend.generate(instruction, data, schema)
            atomic_write_json(path, {"instruction": instruction, "data": data, "schema": schema, "answer": answer,
                                    "provider": settings.provider, "model": settings.model,
                                    "effort": settings.reasoning_effort})
            return answer

    selected, assets = set(range(1, document["page_count"] + 1)), set(images)
    def validate(text):
        return reference_issues(text, identity, selected, assets, live / "media", pending_assets=assets)
    def link(text):
        return normalize_citation_code(link_citations(text, {identity: document["page_count"]}))

    draft = seed.read_text("utf-8")
    article = link(draft)
    if issues := validate(article):
        raise ValueError("引き継ぐ原稿の図表・引用が不正です: " + "; ".join(issues))
    article, report = finalize_article(article, identity, source_units, Recorder(), backend.cancel, log, link, validate)
    if issues := validate(article):
        raise ValueError("再検査後の図表・引用が不正です: " + "; ".join(issues))
    report.update(available_images=sorted(images), image_extraction_version=SUMMARY_IMAGE_VERSION,
                  image_catalog=catalog, image_coverage="complete", source_caption_pages=captions,
                  reference_checks="passed", article_sha256=hashlib.sha256(article.encode()).hexdigest(),
                  original_pdf_sha256=hashes["original.pdf"],
                  draft_provenance={"path": str(seed), "sha256": hashlib.sha256(draft.encode()).hexdigest(),
                                    "method": "Supplied unaccepted draft; all original pages reviewed and audited again."})
    work = out / "staging" / identity
    work.mkdir(parents=True, exist_ok=True)
    original = work / "original.pdf"
    if not original.exists():
        try:
            os.link(live / "original.pdf", original)
        except OSError:
            shutil.copy2(live / "original.pdf", original)
    if digest(original) != hashes["original.pdf"]:
        raise ValueError("作業先の原本が変わっています。別の作業先を指定してください。")
    shutil.copy2(live / "document.json", work / "document.json")
    (work / "media").mkdir(exist_ok=True)
    for path, blob in images.items():
        atomic_write_bytes(work / path, blob)
    atomic_write_bytes(work / "article.md", article.encode())
    atomic_write_json(work / "article-review.json", report)
    atomic_write_json(work / "article-usage.json", backend.usage_report())
    checked = verify(work)
    if not checked["passed"]:
        raise ValueError("再検査済み原稿の検証に失敗しました: " + json.dumps(checked, ensure_ascii=False))
    if apply:
        if any(digest(live / name) != value for name, value in hashes.items()):
            raise RuntimeError("再検査中に元ファイルが変わりました。検査済み原稿は作業先に保持しています。")
        backup = out / "backups" / identity
        if not backup.exists():
            backup_summary(live, backup)
        (live / "media").mkdir(exist_ok=True)
        for path, blob in images.items():
            atomic_write_bytes(live / path, blob)
        for name in ("article-review.json", "article.md", "article-usage.json"):
            atomic_write_bytes(live / name, (work / name).read_bytes())
        checked = verify(live)
        if not checked["passed"]:
            raise ValueError("保存後のサマリー検証に失敗しました。")
        log(f"Published fully reviewed draft with {len(images)} source images")
    return {"paper_id": identity, "status": "repaired" if apply else "staged", "images": len(images),
            "verification": checked, "draft_provenance": report["draft_provenance"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=data_directory())
    parser.add_argument("--paper-id", required=True)
    parser.add_argument("--seed", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    root, out = args.root.resolve(), args.output.resolve()
    if not re.fullmatch(r"[0-9a-f]{32}", args.paper_id) or root == out or root in out.parents:
        parser.error("論文IDまたは作業先が不正です。")
    out.mkdir(parents=True, exist_ok=True)
    atomic_write_json(out / f"{args.paper_id}-result.json", {"paper_id": args.paper_id, "status": "reviewing"})
    try:
        result = run(root, args.paper_id, args.seed.resolve(), out, apply=args.apply)
    except Exception as error:  # noqa: BLE001 -- leave live files untouched on a failed staged review.
        result = {"paper_id": args.paper_id, "status": "failed", "error": str(error)}
    atomic_write_json(out / f"{args.paper_id}-result.json", result)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return int(result["status"] == "failed")


if __name__ == "__main__":
    raise SystemExit(main())
