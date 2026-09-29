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
