"""Verify an automatically accepted summary without modifying its article or report.

Usage: python tools/verify_summary_quality.py <paper-folder> [<paper-folder> ...]
Requires a version-3 report from the common generation/review/audit pipeline.
This checks provenance and gate completion, not whether an LLM's judgment is infallible.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

# Also usable as a standalone script from the repository checkout.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from papeer.core import prompts
from papeer.core.summary_review import reference_issues


def verify(folder: Path) -> dict:
    article = (folder / "article.md").read_text("utf-8")
    report = json.loads((folder / "article-review.json").read_text("utf-8"))
    document = json.loads((folder / "document.json").read_text("utf-8"))
    digest = hashlib.sha256(article.encode()).hexdigest()
    audit = report.get("audits", [{}])[-1]
    pages = set(report.get("source_pages", []))
    assets = set(report.get("available_images", []))
    checks = {
        "version": report.get("version") == 3,
        "accepted": report.get("acceptance") == "passed",
        "no_manual_edits": not report.get("manual_edits"),
        "exact_article": digest == report.get("article_sha256") == report.get("acceptance_article_sha256"),
        "clean_full_audit": bool(report.get("audits")) and not audit.get("edits") and not audit.get("rejected_edits")
                            and digest == audit.get("input_sha256") == audit.get("output_sha256")
                            and sorted(pages) == audit.get("checked_pages"),
        "coverage_evidence": bool(report.get("coverage")),
        "valid_scope": bool(pages) and pages <= set(range(1, document["page_count"] + 1)),
        "references": not reference_issues(article, folder.name, pages, assets, folder / "media"),
    }
    for key, name in (("prompt_sha256", "_summary_review"), ("audit_prompt_sha256", "_summary_audit"),
                      ("verify_prompt_sha256", "_summary_verify")):
        checks[name] = report.get(key) == hashlib.sha256(prompts.builtin(name).encode()).hexdigest()
    return {"paper": folder.name, "passed": all(checks.values()), "checks": checks,
            "automatic_edits": len(report.get("edits", [])), "audit_rounds": len(report.get("audits", []))}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("papers", nargs="+", type=Path)
    args = parser.parse_args()
    results = []
    for folder in args.papers:
        try:
            results.append(verify(folder))
        except (OSError, ValueError, KeyError, IndexError) as error:
            results.append({"paper": folder.name, "passed": False, "error": str(error)})
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0 if all(result["passed"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
