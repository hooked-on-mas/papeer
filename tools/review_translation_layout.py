"""Rebuild saved translations for offline layout review, without model calls.

Run from the repository root:
    python -m tools.review_translation_layout --papers PATH --output PATH
The library, cache, and original PDFs are read only. Output must be separate.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path

from papeer.core.service import stored_translations
from papeer.pdf.pdf_engine import build_translated_pdf, translation_units
from papeer.layout.math_layout import MATH_TOKEN
from papeer.layout.reading_flow import unit_pages


def rebuild(papers: Path, output: Path) -> dict:
    papers, output = papers.resolve(), output.resolve()
    if output == papers or papers in output.parents or output in papers.parents:
        raise ValueError("出力先は論文ライブラリと別のフォルダーにしてください。")
    output.mkdir(parents=True, exist_ok=True)
    reports = {}
    for folder in sorted(papers.iterdir()):
        if not folder.is_dir():
            continue
        if not (folder / "document.json").exists() or not (folder / "translation-cache.json").exists():
            reports[folder.name] = {"error": "原文の抽出情報または翻訳キャッシュがありません。"}
            (output / "reports.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), "utf-8")
            continue
        document = json.loads((folder / "document.json").read_text("utf-8"))
        cache = stored_translations(json.loads((folder / "translation-cache.json").read_text("utf-8")))
        previous_path = folder / "translation-report.json"
        previous = json.loads(previous_path.read_text("utf-8")) if previous_path.exists() else {}
        units = translation_units(document)
        pages = set(previous.get("translated_pages", [p for u in units if u["id"] in cache for p in unit_pages(u)]))
        grouped = {}
        for unit in units:
            if unit_pages(unit) & pages:
                grouped.setdefault(unit["block"], []).append(unit)
        translations = {key: "\n".join(cache[u["id"]] for u in units)
                        for key, units in grouped.items() if all(u["id"] in cache for u in units)}
        invalid = [u["id"] for u in units if u["id"] in cache and
                   Counter(MATH_TOKEN.findall(u["text"])) != Counter(MATH_TOKEN.findall(cache[u["id"]]))]
        try:
            if invalid:
                raise ValueError(f"抽出情報とキャッシュの数式が一致しません。再翻訳が必要です: {invalid[:5]}")
            if not translations:
                raise ValueError("再配置できる翻訳済みブロックがありません。")
            report = build_translated_pdf(folder / "original.pdf", document, translations, output / (folder.name + ".pdf"), translate_page_numbers=pages)
        except (ValueError, RuntimeError) as error:
            report = {"error": str(error), "scaled_blocks": None}
        report.update(title=document["title"], translated_pages=sorted(pages),
                      review_source="translated.pdf" if (folder / "translated.pdf").exists() else "partial/cache",
                      previous_scaled_blocks=previous.get("scaled_blocks"),
                      missing_cache_blocks=sorted(set(grouped) - translations.keys()))
        reports[folder.name] = report
        (output / "reports.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), "utf-8")
        print(f"{folder.name}: {report['previous_scaled_blocks']} -> {report['scaled_blocks']}", flush=True)
    return reports


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--papers", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    rebuild(args.papers, args.output)
