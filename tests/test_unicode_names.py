"""File names from macOS come decomposed (NFD); the library keeps them composed (NFC)."""
from __future__ import annotations

import unicodedata

import pymupdf

from papeer.core.storage import Library

NAME = "ガイドブック・論文.pdf"  # "ガ" and "ブ" decompose into a kana and a combining mark.


def test_a_decomposed_file_name_is_kept_composed_and_found_by_a_typed_search(tmp_path):
    decomposed = unicodedata.normalize("NFD", NAME)
    assert decomposed != NAME
    source = tmp_path / decomposed
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((72, 72), "A document with a decomposed file name")
        pdf.save(source)
    lib = Library(tmp_path / "library")
    paper_id, _ = lib.import_pdf(source)
    paper = lib.paper(paper_id)
    assert paper["original_name"] == NAME
    assert paper["title"] == NAME[:-4]  # No title in the PDF: the file name's, composed too.
    assert [row["id"] for row in lib.papers("ガイド")] == [paper_id]
    # A search that arrives decomposed finds it as well.
    assert [row["id"] for row in lib.papers(unicodedata.normalize("NFD", "ブック"))] == [paper_id]
    assert lib.rename_paper(paper_id, unicodedata.normalize("NFD", "がくしゅう")) == "がくしゅう.pdf"
    assert lib.paper(paper_id)["original_name"] == "がくしゅう.pdf"


def test_data_kept_decomposed_is_found_by_a_composed_or_a_decomposed_search(tmp_path):
    from papeer.core.library_search import library_search
    source = tmp_path / "a.pdf"
    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((72, 72), "plain")
        pdf.save(source)
    lib = Library(tmp_path / "library")
    paper_id, _ = lib.import_pdf(source)
    old = unicodedata.normalize("NFD", "ガイドブック")  # As written before names were composed.
    with lib.connection() as db:
        db.execute("UPDATE papers SET title=?,original_name=? WHERE id=?", (old, old + ".pdf", paper_id))
        db.execute("UPDATE pages SET text=? WHERE paper_id=?", (old + " の本文", paper_id))
    for query in ("ガイド", unicodedata.normalize("NFD", "ガイド")):
        assert [row["id"] for row in lib.papers(query)] == [paper_id]
        results = library_search(lib, query)["results"]
        assert {r["side"] for r in results} >= {"metadata", "original"}
        assert {r["paper_id"] for r in results} == {paper_id}
