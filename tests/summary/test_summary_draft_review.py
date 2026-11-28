import hashlib
import json

import pymupdf as fitz
import pytest

from _summary_responses import clean_summary_response
from papeer.core.storage import Library
from papeer.providers import ProviderBackend
from tools import review_summary_draft
from tools.verify_summary_quality import verify


def prepare(tmp_path):
    source = tmp_path / "source.pdf"
    with fitz.open() as pdf:
        for _ in range(2):
            page = pdf.new_page()
            page.insert_text((40, 50), "The method reduces prediction error under the stated assumptions.")
        pdf.save(source)
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(source)
    folder = library.folder(identity)
    (folder / "article.md").write_text("Previous summary", "utf-8")
    seed = tmp_path / "unaccepted-draft.md"
    seed.write_text(f"# 結果\n\n仮定の下で予測誤差を低減する。[p.1](papeer://{identity}/1)", "utf-8")
    return library, identity, folder, seed


def test_supplied_draft_still_requires_complete_review_and_clean_audit(tmp_path, monkeypatch):
    library, identity, folder, seed = prepare(tmp_path)
    original = hashlib.sha256((folder / "original.pdf").read_bytes()).hexdigest()
    calls = []

    class Provider(ProviderBackend):
        def _generate(self, instruction, data, schema):
            assert schema is not None  # No new authoring; every request is a review/verification.
            calls.append(json.loads(data))
            return clean_summary_response(data)

    monkeypatch.setenv("PAPEER_DATA_DIR", str(library.root))
    monkeypatch.setattr(review_summary_draft, "create_provider", lambda settings, cancel: Provider(settings, cancel))
    out = tmp_path / "repair"
    result = review_summary_draft.run(library.root, identity, seed, out, apply=True)
    assert result["verification"]["passed"] and verify(folder)["passed"]
    report = json.loads((folder / "article-review.json").read_text("utf-8"))
    assert report["source_pages"] == report["audits"][-1]["checked_pages"] == [1, 2]
    assert report["draft_provenance"]["sha256"] == hashlib.sha256(seed.read_text("utf-8").encode()).hexdigest()
    assert any(call.get("phase") == "acceptance_audit" for call in calls)
    assert (out / "backups" / identity / "article.md").read_text("utf-8") == "Previous summary"
    assert hashlib.sha256((folder / "original.pdf").read_bytes()).hexdigest() == original


def test_unreviewed_seed_never_replaces_the_live_summary(tmp_path, monkeypatch):
    library, identity, folder, seed = prepare(tmp_path)

    class Provider(ProviderBackend):
        def _generate(self, *_):
            raise RuntimeError("Original-page review unavailable")

    monkeypatch.setenv("PAPEER_DATA_DIR", str(library.root))
    monkeypatch.setattr(review_summary_draft, "create_provider", lambda settings, cancel: Provider(settings, cancel))
    with pytest.raises(RuntimeError, match="review unavailable"):
        review_summary_draft.run(library.root, identity, seed, tmp_path / "repair", apply=True)
    assert (folder / "article.md").read_text("utf-8") == "Previous summary"
    assert not (folder / "article-review.json").exists()
