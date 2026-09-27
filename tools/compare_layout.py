"""Compare PDF extraction (blocks, styles, reading order, translation units) between two code states.

Two steps, so that "before" and "after" can come from different checkouts:

    # 1. Extract every PDF with a given code state (no AI call, the library is only read)
    uv run python tools/compare_layout.py snapshot output/layout/before --code ../papeer-base
    uv run python tools/compare_layout.py snapshot output/layout/after
    # 2. Compare the two snapshots
    uv run python tools/compare_layout.py diff output/layout/before output/layout/after

`--code DIR` imports papeer from another checkout (e.g. `git worktree add ../papeer-base <commit>`);
it has to use the current package layout (papeer.pdf.pdf_engine). Sources default to the
library's papers/*/original.pdf and may instead be PDF files or folders of PDFs.
Promoted from tmp/compare_layout.py, summarize_layout_comparison.py and layout_metrics.py.
"""
from __future__ import annotations

import argparse
from collections import Counter
import importlib
import json
import os
from pathlib import Path
import sys
import time
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    # `python tools/compare_layout.py` puts only tools/ on the path; --code still wins (inserted first).
    sys.path.append(str(ROOT))


def _modules(code: Path | None):
    """Import the extraction functions, optionally from another checkout."""
    if code is not None:
        code = code.resolve()
        if not (code / "papeer").is_dir():
            raise SystemExit(f"{code} に papeer パッケージがありません。")
        sys.path.insert(0, str(code))
        for name in [m for m in sys.modules if m == "papeer" or m.startswith("papeer.")]:
            del sys.modules[name]
    engine = importlib.import_module("papeer.pdf.pdf_engine")
    typography = importlib.import_module("papeer.pdf.pdf_typography")
    return engine, typography


def pdf_sources(sources: list[Path]) -> list[tuple[str, Path]]:
    """(document id, PDF) pairs. A library folder yields papers/<id>/original.pdf, any other folder its *.pdf."""
    found: list[tuple[str, Path]] = []
    for source in sources:
        if source.is_file():
            found.append((source.stem, source))
            continue
        papers = source / "papers" if (source / "papers").is_dir() else source
        originals = sorted(papers.glob("*/original.pdf"))
        found += [(pdf.parent.name, pdf) for pdf in originals] or [(pdf.stem, pdf) for pdf in sorted(source.glob("*.pdf"))]
    ids = [identity for identity, _ in found]
    duplicates = sorted(identity for identity, count in Counter(ids).items() if count > 1)
    if duplicates:
        raise SystemExit(f"文書IDが重複しています: {', '.join(duplicates)}")
    return found


def library_roots(sources: list[Path]) -> list[Path]:
    """Folders a snapshot must stay out of: the library of each source, or the folder of loose PDFs.

    A library or its papers/ folder protects the library root, and papers/<id>/original.pdf protects
    the folder two above papers/<id>, so neither lib, lib/papers/x nor lib/layout is accepted.
    """
    roots = []
    for source in (Path(os.path.abspath(s)) for s in sources):
        if source.is_file():
            folder = source.parent
            roots.append(folder.parent.parent if folder.parent.name.lower() == "papers" else folder)
        elif source.name.lower() == "papers":
            roots.append(source.parent)
        else:
            # A library, a folder of papers/<id> folders not named papers, or a folder of loose PDFs.
            roots.append(source)
    return roots


def snapshot(output: Path, sources: list[Path], code: Path | None = None, out=None) -> list[dict]:
    """Extract every source into output/<id>.json and write output/summary.json."""
    out = sys.stdout if out is None else out
    output = output.resolve()
    documents = pdf_sources(sources)
    if not documents:
        raise SystemExit("PDFが見つかりません。")
    from papeer.core.destinations import inside_library
    from papeer.core.paths import data_directory

    for root in [*library_roots(sources), data_directory()]:
        if inside_library(output, root):
            raise SystemExit(f"出力先はライブラリ ({root}) の外にしてください。")
    engine, typography = _modules(code)
    output.mkdir(parents=True, exist_ok=True)
    summary = []
    for identity, pdf in documents:
        start = time.perf_counter()
        document = engine.extract_pdf(pdf)
        elapsed = time.perf_counter() - start
        heights = {page["number"]: page["height"] for page in document["pages"]}
        body_sizes = {number: typography.body_font_size([b for b in document["blocks"] if b["page"] == number])
                      for number in heights}
        for block in document["blocks"]:
            style = typography.text_style(block, body_sizes[block["page"]], heights[block["page"]])
            block["comparison_style"] = {"role": style.role, "size": style.size}
        document["comparison_units"] = engine.translation_units(document)
        (output / f"{identity}.json").write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
        summary.append({
            "id": identity, "source": str(pdf), "title": document["title"], "pages": document["page_count"],
            "seconds": round(elapsed, 3), "blocks": len(document["blocks"]),
            "units": len(document["comparison_units"]),
            "formulas": sum(len(b.get("formulas", [])) for b in document["blocks"]),
            "kinds": dict(Counter(b.get("kind", "text") for b in document["blocks"])),
            "styles": dict(Counter(b["comparison_style"]["role"] for b in document["blocks"])),
            "continuations": len(document.get("continuations", [])),
        })
        print(f"{identity[:12]:12}  {document['page_count']:4} ページ  {elapsed:6.2f} 秒", file=out, flush=True)
    code_root = code.resolve() if code else ROOT
    (output / "summary.json").write_text(json.dumps(
        {"code": str(code_root), "layout_version": document.get("layout_version"), "documents": summary},
        ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def _counts(document: dict) -> dict:
    return {"pages": document["page_count"], "blocks": len(document["blocks"]),
            "units": len(document.get("comparison_units", [])),
            "formulas": sum(len(b.get("formulas", [])) for b in document["blocks"]),
            "continuations": len(document.get("continuations", []))}


def _characters(document: dict, page: int) -> Counter:
    return Counter(c for b in document["blocks"] if b["page"] == page
                   for c in unicodedata.normalize("NFKD", b["text"]) if not c.isspace())


def compare_documents(before: dict, after: dict) -> dict:
    """Differences of one document between two snapshots, keyed by block id."""
    old = {b["id"]: b for b in before["blocks"]}
    new = {b["id"]: b for b in after["blocks"]}
    styles, margins, content = [], [], []
    for key in sorted(old.keys() & new.keys()):
        x, y = old[key], new[key]
        if x.get("comparison_style") != y.get("comparison_style"):
            styles.append({"id": key, "page": y["page"], "text": y["text"][:240], "bbox": y["bbox"],
                           "before": x.get("comparison_style"), "after": y.get("comparison_style")})
        flags = [(bool(b.get("reading_margin")), bool(b.get("running_header"))) for b in (x, y)]
        if flags[0] != flags[1]:
            margins.append({"id": key, "page": y["page"], "text": y["text"][:240], "bbox": y["bbox"],
                            "before": list(flags[0]), "after": list(flags[1])})
        if any(x.get(k) != y.get(k) for k in ("text", "translation_text", "kind", "formulas", "bbox")):
            content.append(key)
    pages = sorted({p["number"] for p in before["pages"]} | {p["number"] for p in after["pages"]})
    order, characters = [], []
    for number in pages:
        left = [b["id"] for b in before["blocks"] if b["page"] == number]
        right = [b["id"] for b in after["blocks"] if b["page"] == number]
        if left != right:
            order.append({"page": number, "before": left, "after": right})
        a, b = _characters(before, number), _characters(after, number)
        removed, added = a - b, b - a
        if removed or added:
            characters.append({"page": number, "removed": sum(removed.values()), "added": sum(added.values()),
                               "removed_chars": dict(removed), "added_chars": dict(added)})
    groups = [{tuple(g["blocks"]) for g in d.get("continuations", [])} for d in (before, after)]

    def describe(found: set) -> list[dict]:
        return [{"ids": list(ids), "texts": [(new.get(k) or old[k])["text"][:180] for k in ids]} for ids in sorted(found)]

    return {"counts": {"before": _counts(before), "after": _counts(after)},
            "added_blocks": sorted(new.keys() - old.keys()), "removed_blocks": sorted(old.keys() - new.keys()),
            "content_changed": content, "styles": styles, "margins": margins, "order": order,
            "characters": characters,
            "removed_continuations": describe(groups[0] - groups[1]),
            "added_continuations": describe(groups[1] - groups[0])}


def _documents(folder: Path) -> dict[str, Path]:
    return {path.stem: path for path in sorted(folder.glob("*.json")) if path.name != "summary.json"}


def diff(before: Path, after: Path, output: Path | None = None, out=None) -> dict:
    """Compare two snapshot folders, write the details as JSON and print a Markdown table."""
    out = sys.stdout if out is None else out
    left, right = _documents(before), _documents(after)
    if not left or not right:
        raise SystemExit("比較するスナップショットが空です。先に snapshot を実行してください。")
    results = []
    for identity in sorted(left.keys() & right.keys()):
        a = json.loads(left[identity].read_text(encoding="utf-8"))
        b = json.loads(right[identity].read_text(encoding="utf-8"))
        results.append({"id": identity, "title": b["title"], **compare_documents(a, b)})
    report = {"before": str(before.resolve()), "after": str(after.resolve()),
              "only_before": sorted(left.keys() - right.keys()), "only_after": sorted(right.keys() - left.keys()),
              "documents": results}
    output = output or after.parent / f"{before.name}-vs-{after.name}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("| 文書 | ページ | ブロック | 翻訳単位 | 書式変化 | 読み順変化ページ | 継続 -/+ | 文字変化ページ |", file=out)
    print("|---|---|---|---|---|---|---|---|", file=out)
    for r in results:
        a, b = r["counts"]["before"], r["counts"]["after"]
        print(f"| {r['id'][:8]} | {b['pages']} | {a['blocks']} → {b['blocks']} | {a['units']} → {b['units']} "
              f"| {len(r['styles'])} | {len(r['order'])} "
              f"| -{len(r['removed_continuations'])}/+{len(r['added_continuations'])} | {len(r['characters'])} |", file=out)
    for label, ids in (("before のみ", report["only_before"]), ("after のみ", report["only_after"])):
        if ids:
            print(f"{label}: {', '.join(ids)}", file=out)
    print(f"詳細: {output}", file=out)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    take = commands.add_parser("snapshot", help="PDFを抽出してJSONに保存する")
    take.add_argument("output", type=Path, help="保存先フォルダー (例: output/layout/after)")
    take.add_argument("sources", type=Path, nargs="*",
                      help="PDF、PDFのフォルダー、またはライブラリ (既定: 現在のライブラリ)")
    take.add_argument("--code", type=Path, help="papeer を読み込む別のチェックアウト")
    compare = commands.add_parser("diff", help="2つのスナップショットを比較する")
    compare.add_argument("before", type=Path)
    compare.add_argument("after", type=Path)
    compare.add_argument("--output", type=Path, help="詳細JSONの保存先 (既定: <after の親>/<before>-vs-<after>.json)")
    args = parser.parse_args(argv)
    if args.command == "snapshot":
        sources = args.sources
        if not sources:
            from papeer.core.paths import data_directory
            sources = [data_directory() / "papers"]
        snapshot(args.output, sources, args.code)
    else:
        diff(args.before, args.after, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
