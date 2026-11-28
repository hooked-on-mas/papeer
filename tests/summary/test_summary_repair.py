"""The recovery command uses acceptance checks and preserves original documents."""
import hashlib
import json
import sys

import pymupdf as fitz

from _summary_responses import clean_summary_response
from papeer.core.storage import Library
from papeer.providers import ProviderBackend
from tools import repair_summaries
from tools.verify_summary_quality import verify


def test_repair_stages_backs_up_and_publishes_only_an_accepted_summary(tmp_path, monkeypatch):
    source = tmp_path / "source.pdf"
    with fitz.open() as pdf:
        for _ in range(30):
            page = pdf.new_page()
            page.insert_text((40, 50), "Our method reduces the prediction error under the stated assumptions.")
        pdf.save(source)
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(source)
    folder = lib.folder(identity)
    (folder / "article.md").write_text("Old unreviewed draft", "utf-8")
    original = hashlib.sha256((folder / "original.pdf").read_bytes()).hexdigest()

    class Provider(ProviderBackend):
        def _generate(self, instruction, data, schema):
            return clean_summary_response(data) if schema else f"# 結果\n\n予測誤差を低減する。[{identity}:p1]"

    monkeypatch.setattr(repair_summaries, "create_provider", lambda settings, cancel: Provider(settings, cancel))
    out = tmp_path / "repair"
    monkeypatch.setattr(sys, "argv", ["repair", "--root", str(lib.root), "--output", str(out),
                                     "--workers", "1", "--apply"])
    assert repair_summaries.main() == 0
    assert verify(folder)["passed"]
    assert (out / "backups" / identity / "article.md").read_text("utf-8") == "Old unreviewed draft"
    assert hashlib.sha256((folder / "original.pdf").read_bytes()).hexdigest() == original
    assert not (folder / "translated.pdf").exists()
    report = json.loads((folder / "article-review.json").read_text("utf-8"))
    report.pop("image_catalog")
    report["available_images"] = ["media/missing.png"]
    (folder / "article-review.json").write_text(json.dumps(report), "utf-8")
    assert not verify(folder)["passed"]


def test_failed_generation_keeps_the_previous_summary(tmp_path, monkeypatch):
    source = tmp_path / "source.pdf"
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 50), "The full original source is preserved when model generation fails.")
        pdf.save(source)
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(source)
    article = lib.folder(identity) / "article.md"
    article.write_text("Previous summary", "utf-8")

    class Provider(ProviderBackend):
        def _generate(self, *_):
            raise RuntimeError("Provider unavailable")

    monkeypatch.setattr(repair_summaries, "create_provider", lambda settings, cancel: Provider(settings, cancel))
    monkeypatch.setattr(sys, "argv", ["repair", "--root", str(lib.root), "--output", str(tmp_path / "repair"),
                                     "--workers", "1", "--apply"])
    assert repair_summaries.main() == 1
    assert article.read_text("utf-8") == "Previous summary"
