import json

import pymupdf as fitz
from fastapi.testclient import TestClient

from papeer.core.storage import Library
from sidecar.app import app
from papeer.core.translation_review import required_translation_pages
from papeer.layout.reference_layout import reference_evidence


def test_review_only_requires_pages_with_translatable_content(tmp_path, monkeypatch):
    source = tmp_path / "references.pdf"
    with fitz.open() as pdf:
        for lines in (
            [(72, "We show that the proposed method improves accuracy.")],
            [(72, "References"), (110, "[1] A. Smith, Example study, IEEE, 2024.")],
            [(72, "[2] B. Jones, Another study, IEEE, 2023.")],
            [(72, "Appendix"), (110, "We prove the remaining result here.")],
        ):
            page = pdf.new_page()
            for y, text in lines:
                page.insert_text((72, y), text)
        pdf.save(source)
    root = tmp_path / "library"
    lib = Library(root)
    paper_id, _ = lib.import_pdf(source)
    monkeypatch.setenv("PAPEER_DATA_DIR", str(root))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    with TestClient(app) as client:
        reading = client.get(f"/api/papers/{paper_id}/reading").json()
    assert reading["translation_required_pages"] == [1, 4]
    assert reading["completed_pages"] == []
    assert reading["empty_pages"] == []

    from papeer.core.library_list import translation_state
    (lib.folder(paper_id) / "translated.pdf").write_bytes(b"%PDF-1.7")
    (lib.folder(paper_id) / "translation-report.json").write_text(json.dumps({"translated_pages": [1, 4]}), "utf-8")
    state = translation_state(lib.folder(paper_id), 4)
    assert state["translation_required_count"] == 2
    assert state["translation_completed_required_count"] == 2
    assert state["translated_count"] == 2

    # A page containing both references and body text still needs review.
    cache = lib.folder(paper_id) / "document.json"
    document = json.loads(cache.read_text("utf-8"))
    prose = dict(next(b for b in document["blocks"] if b["page"] == 1), id="mixed-body", page=2)
    document["blocks"].append(prose)
    cache.write_text(json.dumps(document), encoding="utf-8")
    assert lib.reading_info(paper_id)["translation_required_pages"] == [1, 2, 4]

    cache.write_text("invalid cache", encoding="utf-8")
    assert lib.reading_info(paper_id)["translation_required_pages"] == [1, 2, 3, 4]


def test_old_reference_cache_with_headers_contact_and_wrapped_volume():
    from copy import deepcopy

    reference = "6. Daniel Espinoza and Eduardo Moreno, A primal-dual aggregation algorithm,\nComputational Optimization and Applications\n59 (2014), no. 3, 617-638."
    assert reference_evidence(reference)

    def block(identity, page, text, y):
        return dict(id=identity, page=page, text=text, kind="text", bbox=[40, y, 550, y + 15])

    document = dict(pages=[dict(number=p, width=600, height=800) for p in range(1, 5)], blocks=[
        block("h1", 1, "1 AUTHORS", 50),
        block("body", 1, "We show that the method improves accuracy.", 150),
        block("h2", 2, "2 AUTHORS", 50),
        block("heading", 2, "References", 150),
        block("r2", 2, reference, 200),
        block("h3", 3, "3 AUTHORS", 50),
        block("r3", 3, "7. Example reference, Journal of Research (2020).", 150),
        block("contact", 3, "Faculty of Engineering, Example University. E-mail address: author@example.org", 300),
        block("appendix", 4, "Appendix A", 150),
        block("proof", 4, "We prove the remaining result here.", 200),
    ])
    original = deepcopy(document)
    assert required_translation_pages(document) == [1, 4]
    assert document == original
    document["blocks"].insert(-2, block("mixed", 3, "We discuss the limitations of this method.", 400))
    assert required_translation_pages(document) == [1, 3, 4]
