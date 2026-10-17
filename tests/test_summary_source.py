import copy
import json
import threading

from _summary_responses import clean_summary_response
from unittest.mock import patch

import pymupdf as fitz
import pytest

from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.core.summary_source import summary_source_text


def test_table_cell_boundaries_reach_both_generation_and_original_source_review(tmp_path):
    source = tmp_path / "source.pdf"
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 50), "Constraint violation [%]")
        page.insert_text((200, 50), "35.58")
        page.insert_text((260, 50), "3.8")
        page.insert_text((320, 50), "0.04")
        pdf.save(source)
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(source)
    document = copy.deepcopy(library.document(identity))
    flattened = "Constraint violation [%]35.583.80.04"
    document["pages"][0]["text"] = "Paper body.\n\n" + flattened
    document["blocks"] = [{"id": "p1t1", "page": 1, "kind": "table", "bbox": [35, 30, 370, 60], "text": flattened}]
    requests = []

    class Provider:
        def generate(self, instruction, data, schema=None):
            requests.append((data, schema))
            return clean_summary_response(data) if schema else f"Summary [{identity}:p1]"

    with patch.object(library, "document", return_value=document), patch("papeer.core.service.summary_figures", return_value=[]):
        PaperService(library, Provider(), threading.Event()).article(identity)
    note = requests[0][0]
    review = json.loads(next(data for data, schema in requests if schema))["source_pages"][0]["text"]
    for text in (note, review):
        assert flattened not in text
        assert "35.58 3.8 0.04" in text
        assert "Paper body." in text
    assert document["pages"][0]["text"].endswith(flattened)  # Shared extraction is not modified.


def test_scanned_or_incomplete_native_table_keeps_complete_cached_ocr():
    original = "Complete OCR table with many cell values 1 2 3 4 5 6 7 8 9 10"
    block = {"id": "p1t1", "page": 1, "kind": "table", "bbox": [20, 20, 300, 80], "text": original}
    with fitz.open() as pdf:
        page = pdf.new_page()
        assert summary_source_text(page, original, [block], 1, []) == original
        page.insert_text((40, 50), "Only header")
        assert summary_source_text(page, original, [block], 1, []) == original


@pytest.mark.parametrize(("script", "offset", "expected"), [("a", -5, "^{a}"), ("2", 3, "_{2}")])
def test_math_scripts_are_recovered_from_pdf_positions_not_guessed(script, offset, expected):
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 50), "y=(a+b)", fontsize=12)
        x = 40 + fitz.get_text_length("y=(a+b)", fontsize=12)
        page.insert_text((x, 50 + offset), script, fontsize=8)
        page.insert_text((200, 50), "(36)", fontsize=12)
        flattened = f"y=(a+b){script} (36)"
        block = dict(page=1, kind="formula", bbox=[35, 25, 235, 60], text=flattened)
        source = summary_source_text(page, flattened, [block], 1, [])
        assert f"y=(a+b){expected}" in source
        assert "(36)" in source


def test_plain_digits_and_multiline_math_are_not_guessed_as_scripts():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 50), "y=x2", fontsize=12)
        block = dict(page=1, kind="formula", bbox=[35, 25, 235, 60], text="y=x2")
        assert summary_source_text(page, "y=x2", [block], 1, []) == "y=x2"
        page.insert_text((40, 70), "z=3", fontsize=12)
        block.update(bbox=[35, 25, 235, 80], text="y=x2 z=3")
        assert summary_source_text(page, "y=x2 z=3", [block], 1, []) == "y=x2 z=3"
