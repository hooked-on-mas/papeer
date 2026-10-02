"""References stay grounded in bibliography text, even with uncertain or missing metadata."""
import json

from fastapi.testclient import TestClient
import pymupdf

from papeer.core.citations import citation_graph, extract_references
from papeer.core.storage import Library
from papeer.layout.reference_layout import mark_references
from papeer.pdf.pdf_engine import extract_pdf
from sidecar import deps
from sidecar.app import app


def document(*texts):
    blocks = [{"id": str(i), "page": page, "text": text, "bbox": [40, 40 + i * 25, 550, 60 + i * 25],
               "kind": "text", "font_size": 10} for i, (page, text) in enumerate(texts)]
    doc = {"blocks": blocks, "pages": [{"number": p, "width": 600} for p in sorted({p for p, _ in texts})]}
    mark_references(doc)
    return doc


def test_numbered_references_keep_continuations_and_pages():
    doc = document((1, "[9] Not a reference in the body, 2010."), (2, "References"),
                   (2, '[1] A. Smith, “Robust control of systems”,\nIEEE Transactions, 2020. doi:10.1234/ABC.'),
                   (2, '[2] B. Jones, “Neural represen-\ntations for control”.'),
                   (3, 'arXiv:2101.12345v2, 2021.\n[3] C. Doe, Another reference, 2022.'),
                   (3, 'Appendix A'), (3, '[4] This is not a reference, 2023.'))
    refs = extract_references(doc)
    assert len(refs) == 3
    assert refs[0]["doi"] == "10.1234/ABC"
    assert refs[0]["title"] == "Robust control of systems"
    assert refs[1]["arxiv_id"] == "2101.12345"
    assert refs[1]["title"] == "Neural representations for control"
    assert [r["page"] for r in refs] == [2, 2, 3]
    assert [r["label"] for r in refs] == ["1", "2", "3"]


def test_author_date_and_heading_in_same_block():
    refs = extract_references(document((1, "References\nSmith, A. (2020). Learning with long horizons. Journal of Control.\nJones, B. (2021). Planning in uncertain environments. Proceedings of X.")))
    assert len(refs) == 2
    assert refs[0]["title"] == "Learning with long horizons"
    assert refs[1]["year"] == "2021"


def test_bare_numbers_do_not_split_wrapped_volume():
    refs = extract_references(document((1, "References"),
                                      (1, "1 A. Smith, Control of systems. Journal,\n59 (2014), 123-124."),
                                      (1, "2 B. Jones, New research. Journal, 2020.")))
    assert len(refs) == 2
    assert "59 (2014)" in refs[0]["raw"]
    joined = extract_references(document((1, "References\n1 A. Smith, Control of systems, 2014.\n2 B. Jones, New research, 2020.")))
    assert [entry["label"] for entry in joined] == ["1", "2"]


def test_unquoted_title_hint_does_not_replace_title_with_journal():
    refs = extract_references(document((1, "References"),
        (1, "[1] A. Smith and B. Jones. Learning robust control policies. IEEE Transactions, 2020."),
        (1, "[2] A. Smith, Learning robust control policies. IEEE Transactions, 2020.")))
    assert refs[0]["title"] == "Learning robust control policies"
    assert refs[1]["title"] == ""


def test_separate_reference_sections_and_shared_extraction_are_preserved():
    doc = document((1, "References\n[1] A. Smith, A research paper, 2020."),
                   (2, "References\n[1] B. Jones, Another paper, 2021."))
    before = json.dumps(doc)
    assert len(extract_references(doc)) == 2
    assert json.dumps(doc) == before


def test_real_two_column_pdf(tmp_path):
    path = tmp_path / "references.pdf"
    with pymupdf.open() as pdf:
        page = pdf.new_page(width=600, height=800)
        page.insert_text((40, 60), "References", fontsize=12)
        page.insert_textbox((40, 90, 285, 220), '[1] A. Smith, "Learning robust control policies".\nIEEE Transactions, 2020. doi:10.1234/abc', fontsize=10)
        page.insert_textbox((320, 90, 575, 220), '[2] B. Doe, "New directions in control theory".\nIEEE Transactions, 2021. arXiv:2101.12345', fontsize=10)
        pdf.save(path)
    refs = extract_references(extract_pdf(path))
    assert [r["label"] for r in refs] == ["1", "2"]
    assert refs[1]["arxiv_id"] == "2101.12345"


def add_paper(lib, number, title, refs="", **metadata):
    paper_id = f"{number:032x}"
    with lib.connection() as db:
        db.execute("INSERT INTO papers(id,sha256,title,original_name,pages,status) VALUES(?,?,?,?,?,?)",
                   (paper_id, str(number), title, f"{number}.pdf", 2, "imported"))
    if metadata:
        lib.update(paper_id, **metadata)
    folder = lib.folder(paper_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "document.json").write_text(json.dumps(document((2, "References"), (2, refs))), encoding="utf-8")
    return paper_id


def test_graph_matches_identifiers_titles_and_shared_external_nodes(tmp_path):
    lib = Library(tmp_path / "library")
    a = add_paper(lib, 1, "The current research paper", '[1] A. Smith, Learning robust control policies, 2020. doi:10.1234/abc.\n[2] B. Doe, An external paper, 2021. arXiv:2101.12345v2.\n[3] C. Doe, Planning in uncertain environments, 2022.')
    b = add_paper(lib, 2, "Learning robust control policies", '[1] B. Doe, An external paper, 2021. arXiv:2101.12345.', doi="10.1234/ABC")
    c = add_paper(lib, 3, "Planning in uncertain environments", publication_year="2022")
    graph = citation_graph(lib)
    refs = [r for r in graph["references"] if r["source"] == a]
    assert [r["match"] for r in refs] == ["identifier", "unresolved", "title"]
    assert refs[0]["target"] == b and refs[2]["target"] == c
    external = [n for n in graph["nodes"] if n["paper_id"] is None]
    assert len(external) == 1
    assert sum(edge["target"] == external[0]["id"] for edge in graph["edges"]) == 2
    assert not graph["warnings"]


def test_ambiguous_or_conflicting_titles_never_choose_arbitrary_paper(tmp_path):
    lib = Library(tmp_path / "library")
    add_paper(lib, 1, "Source", '[1] A. Smith, Learning robust control policies, 2020.\n[2] B. Doe, Planning in uncertain environments, 2022. doi:10.1234/other.')
    add_paper(lib, 2, "Learning robust control policies")
    add_paper(lib, 3, "Learning robust control policies")
    add_paper(lib, 4, "Planning in uncertain environments", doi="10.1234/known")
    assert all(r["match"] == "unresolved" for r in citation_graph(lib)["references"])


def test_metadata_edits_import_delete_and_extraction_replacement_refresh_graph(tmp_path):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source", '[1] A. Smith, Learning robust control policies, 2020. doi:10.1234/abc.')
    assert citation_graph(lib)["references"][0]["match"] == "unresolved"
    target = add_paper(lib, 2, "Other title", doi="10.1234/abc")
    assert citation_graph(lib)["references"][0]["target"] == target
    lib.update(target, doi="10.1234/different")
    assert citation_graph(lib)["references"][0]["match"] == "unresolved"
    lib.update(target, doi="10.1234/abc")
    lib.delete_paper(target)
    assert citation_graph(lib)["references"][0]["match"] == "unresolved"
    path = lib.folder(source) / "document.json"
    path.write_text(json.dumps(document((2, "No bibliography"))), encoding="utf-8")
    assert citation_graph(lib)["references"] == []


def test_missing_extraction_is_reported_without_breaking_other_papers(tmp_path):
    lib = Library(tmp_path / "library")
    source = add_paper(lib, 1, "Source", '[1] A. Smith, A sufficiently long reference, 2020.')
    broken = add_paper(lib, 2, "Unreadable")
    (lib.folder(broken) / "document.json").unlink()
    graph = citation_graph(lib)
    assert graph["references"][0]["source"] == source
    assert graph["warnings"][0]["paper_id"] == broken


def test_api_schema_and_auth(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    add_paper(lib, 1, "Source", '[1] A. Smith, Research paper, 2020. doi:10.1234/abc.')
    monkeypatch.setattr(deps, "get_library", lambda: lib)
    monkeypatch.setenv("PAPEER_TOKEN", "test-token")
    monkeypatch.delenv("PAPEER_DEV_NO_AUTH", raising=False)
    client = TestClient(app)
    assert client.get("/api/citations").status_code == 401
    response = client.get("/api/citations", headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 200, response.text
    assert response.json() == citation_graph(lib)
