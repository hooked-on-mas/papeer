"""Titles displayed by the library come from page one, with filenames as the fallback."""
import json
from pathlib import Path

import pymupdf as fitz
import pytest

from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from papeer.pdf.pdf_engine import extract_pdf
from papeer.translation.translation_context import paper_context, paper_title


TITLE = "Adaptive Control for Automated Systems"
SAMPLE = Path(__file__).parent / "fixtures" / "sample.pdf"


def make_pdf(path, metadata="", prominent=True):
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((72, 72), "Learning to Control", fontsize=20 if prominent else 10)
        page.insert_textbox(fitz.Rect(72, 140, 500, 650), "Body text explains the controller. " * 50, fontsize=10)
        if metadata:
            pdf.set_metadata({"title": metadata})
        pdf.save(path)
    return path


@pytest.mark.parametrize("metadata", ["", "Microsoft Word - draft.docx", "Unrelated metadata title"])
def test_import_uses_the_visible_title(tmp_path, metadata):
    source = make_pdf(tmp_path / "2401.12345.pdf", metadata)
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(source)
    assert lib.paper(identity)["title"] == "Learning to Control"
    assert lib.paper(identity)["original_name"] == source.name
    assert lib.document(identity)["title"] == "Learning to Control"


def test_title_and_context_share_the_layout_extraction():
    document = extract_pdf(SAMPLE)
    assert document["title"] == document["extracted_title"] == paper_context(document)["title"] == TITLE


@pytest.mark.parametrize("metadata", ["", "Wrong PDF metadata title"])
def test_no_title_uses_the_filename_even_with_unrelated_metadata(tmp_path, metadata):
    source = make_pdf(tmp_path / "fallback.pdf", metadata, prominent=False)
    document = extract_pdf(source)
    assert document["title"] == "fallback"
    assert document["extracted_title"] == ""


def test_visible_metadata_can_identify_a_title_of_body_size(tmp_path):
    source = make_pdf(tmp_path / "filename.pdf", "Learning to Control", prominent=False)
    assert extract_pdf(source)["title"] == "Learning to Control"


def test_file_rename_preserves_an_extracted_or_manual_title(tmp_path):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE)
    lib.rename_paper(identity, "renamed")
    assert lib.paper(identity)["title"] == TITLE
    assert lib.paper(identity)["original_name"] == "renamed.pdf"
    lib.update(identity, title="My own title")
    lib.rename_paper(identity, "another")
    assert lib.paper(identity)["title"] == "My own title"


def test_file_rename_updates_a_filename_fallback(tmp_path):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(make_pdf(tmp_path / "fallback.pdf", prominent=False))
    lib.rename_paper(identity, "renamed")
    assert lib.paper(identity)["title"] == "renamed"


def test_japanese_title_without_spaces_and_long_titles_are_kept_in_full():
    title = "日本語論文のタイトル"
    document = {"title": "filename", "blocks": [
        {"page": 1, "text": title, "font_size": 20},
        {"page": 1, "text": "本文です。" * 60, "font_size": 10}]}
    assert paper_title(document) == title
    long = "Learning to Control " * 15
    document["blocks"][0]["text"] = long
    assert paper_title(document) == long.strip()
    assert len(paper_context(document)["title"]) <= 200


def test_a_later_page_heading_is_not_the_title_of_a_scanned_first_page():
    document = {"title": "filename", "blocks": [
        {"page": 2, "text": "Experimental Results", "font_size": 20},
        {"page": 2, "text": "Body text. " * 60, "font_size": 10}]}
    assert paper_title(document) == ""
    assert paper_context(document) is None


def test_wrapped_title_keeps_lines_before_the_longest_line():
    document = {"title": "", "blocks": [
        {"page": 1, "text": "Learning to", "font_size": 20, "bbox": [72, 70, 240, 90]},
        {"page": 1, "text": "Control Automated Production Systems", "font_size": 20, "bbox": [72, 94, 500, 114]},
        {"page": 1, "text": "Body text. " * 60, "font_size": 10, "bbox": [72, 150, 500, 600]}]}
    assert paper_title(document) == "Learning to Control Automated Production Systems"


def test_a_title_restores_formula_text_instead_of_showing_internal_tokens():
    token = "[[PD_MATH_p1b1_0]]"
    document = {"title": "", "blocks": [
        {"page": 1, "text": f"Control in {token} Spaces", "font_size": 20,
         "formulas": [{"token": token, "text": "L²"}]},
        {"page": 1, "text": "Body text. " * 60, "font_size": 10}]}
    assert paper_title(document) == "Control in L² Spaces"


def test_refreshing_an_extraction_adopts_a_readable_title_and_keeps_manual_edits(tmp_path):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(make_pdf(tmp_path / "fallback.pdf", prominent=False))
    replacement = extract_pdf(SAMPLE)
    lib.replace_extraction(identity, replacement, {})
    assert lib.paper(identity)["title"] == TITLE
    lib.update(identity, title="My own title")
    lib.replace_extraction(identity, dict(replacement, title="Another extracted title"), {})
    assert lib.paper(identity)["title"] == "My own title"


def test_old_cached_document_title_is_upgraded_without_reading_the_pdf(tmp_path, monkeypatch):
    lib = Library(tmp_path / "library")
    identity, _ = lib.import_pdf(SAMPLE)
    path = PaperFiles(lib.folder(identity)).document_json
    document = json.loads(path.read_text("utf-8"))
    document.pop("extracted_title")
    document["title"] = "sample"
    path.write_text(json.dumps(document), "utf-8")
    monkeypatch.setattr("papeer.core.library_papers.extract_pdf", lambda *a, **kw: pytest.fail("PDF re-extracted"))
    assert lib.document(identity)["title"] == TITLE
    assert lib.document(identity)["extracted_title"] == TITLE
