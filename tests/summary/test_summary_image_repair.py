"""Image-only recovery preserves prose and never fabricates model acceptance."""
import json

from tools import repair_summary_images as repair


def catalog():
    return [{"path": "media/p1f1.png", "page": 1, "caption": "Fig. 1. Experiment [A]."},
            {"path": "media/p2t1.png", "page": 2, "caption": "Table 1. Results."}]


def test_supplement_is_complete_idempotent_and_preserves_prose():
    article = "# Result\n\nOriginal claim.\n\n![Existing figure](media/p1f1.png)\n"
    revised, preserved = repair.supplement(article, catalog(), "abc")
    assert revised.startswith(article)
    assert "Table 1. Results." in revised and "papeer://abc/2" in revised
    assert repair.IMAGE.findall(revised) == ["media/p1f1.png", "media/p2t1.png"]
    assert repair.supplement(revised, catalog(), "abc") == (revised, preserved)


def test_supplement_removes_stale_and_duplicate_image_links_only():
    article = "Keep this.\n\n![bad](media/obsolete.png)\n![one](media/p1f1.png)\n![two](media/p1f1.png)\n"
    revised, _ = repair.supplement(article, catalog(), "abc")
    assert "Keep this." in revised and "obsolete.png" not in revised
    assert repair.IMAGE.findall(revised) == ["media/p1f1.png", "media/p2t1.png"]


def test_complete_article_and_its_accepted_hash_are_not_changed_for_whitespace():
    article = "# Result\n\n![Existing](media/p1f1.png)\n\n![Table](media/p2t1.png)"
    assert repair.supplement(article, catalog(), "abc")[0] == article


def test_repair_backs_up_preserves_review_evidence_and_checks_source(tmp_path, monkeypatch):
    folder = tmp_path / "library" / "abc"
    folder.mkdir(parents=True)
    article = "# Original prose\n\nA claim with its source [p.1](papeer://abc/1).\n"
    (folder / "article.md").write_text(article, "utf-8")
    (folder / "original.pdf").write_bytes(b"original PDF remains unchanged")
    report = {"acceptance": "passed", "acceptance_article_sha256": repair.sha(article), "audits": [{"unchanged": True}]}
    (folder / "article-review.json").write_text(json.dumps(report), "utf-8")
    images = {item["path"]: b"source pixels" for item in catalog()}
    monkeypatch.setattr(repair, "image_inventory", lambda _: (catalog(), images, []))
    monkeypatch.setattr(repair, "verify", lambda *a, **k: {"passed": True})
    result = repair.repair(folder, tmp_path / "recovery", apply=True)
    assert result["verification"]["passed"]
    after = json.loads((folder / "article-review.json").read_text("utf-8"))
    assert after["acceptance"] == "image-repaired-content-review-pending"
    assert after["acceptance_article_sha256"] == report["acceptance_article_sha256"]
    assert after["audits"] == report["audits"]
    assert (tmp_path / "recovery/backups/abc/article.md").read_text("utf-8") == article
    record = json.loads((folder / "article-image-repair.json").read_text("utf-8"))
    (folder / "media/p1f1.png").write_bytes(b"wrong image")
    assert not repair.verify_images(folder, catalog(), images, record)["passed"]
