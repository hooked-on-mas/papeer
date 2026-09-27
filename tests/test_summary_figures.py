import threading
from unittest.mock import patch

import pymupdf as fitz

from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.core.summary_figures import summary_figures


def add_image(page, rect):
    pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 80, 80), False)
    pixmap.clear_with(128)
    page.insert_image(rect, pixmap=pixmap, keep_proportion=False)


def test_separated_panels_share_one_caption_and_unidentified_image_is_excluded():
    with fitz.open() as pdf:
        page = pdf.new_page(width=500, height=500)
        add_image(page, fitz.Rect(40, 40, 160, 140))
        add_image(page, fitz.Rect(220, 40, 340, 140))
        page.insert_text((40, 158), "Figure 2: Single attention and multi-head attention.")
        add_image(page, fitz.Rect(40, 280, 180, 380))
        figures = summary_figures(page, [], 1)
        assert len(figures) == 1
        assert figures[0]["rect"] == fitz.Rect(40, 40, 340, 140)
        assert figures[0]["caption"] == "Figure 2: Single attention and multi-head attention."


def test_label_without_description_is_not_evidence():
    with fitz.open() as pdf:
        page = pdf.new_page()
        add_image(page, fitz.Rect(40, 40, 160, 140))
        page.insert_text((40, 158), "Figure 2:")
        assert summary_figures(page, [], 1) == []


def test_caption_evidence_is_not_truncated():
    with fitz.open() as pdf:
        page = pdf.new_page()
        add_image(page, fitz.Rect(40, 40, 300, 140))
        caption = "Figure 2: " + "Attention combines values using query and key weights. " * 6
        page.insert_textbox(fitz.Rect(40, 150, 400, 250), caption, fontsize=9)
        figures = summary_figures(page, [], 1)
        assert len(figures) == 1
        assert figures[0]["caption"] == caption.strip()


def test_distinct_captions_remain_distinct_even_with_identical_text():
    with fitz.open() as pdf:
        page = pdf.new_page()
        for y in (40, 280):
            add_image(page, fitz.Rect(40, y, 160, y + 100))
            page.insert_text((40, y + 118), "Figure 2: Attention.")
        assert len(summary_figures(page, [], 1)) == 2


def test_vector_and_raster_panels_are_combined():
    with fitz.open() as pdf:
        page = pdf.new_page()
        add_image(page, fitz.Rect(220, 40, 340, 140))
        page.insert_text((40, 158), "Figure 2: Single attention and multi-head attention.")
        blocks = [{"id": "p1b1", "kind": "figure", "page": 1, "bbox": [40, 40, 160, 140]}]
        figures = summary_figures(page, blocks, 1)
        assert len(figures) == 1
        assert figures[0]["id"] == "p1b1"
        assert figures[0]["rect"] == fitz.Rect(40, 40, 340, 140)


def test_article_only_passes_grounded_assets_to_both_stages(tmp_path):
    source = tmp_path / "source.pdf"
    with fitz.open() as pdf:
        page = pdf.new_page(width=500, height=500)
        page.insert_text((40, 25), "Attention uses queries, keys and values to combine information.")
        add_image(page, fitz.Rect(40, 40, 160, 140))
        add_image(page, fitz.Rect(220, 40, 340, 140))
        page.insert_text((40, 158), "Figure 2: Single attention and multi-head attention.")
        add_image(page, fitz.Rect(40, 280, 180, 380))
        pdf.save(source)
    library = Library(tmp_path / "library")
    paper_id, _ = library.import_pdf(source)
    document = library.document(paper_id)
    # Exercise splitting at the old boundary between an image and its caption.
    document["pages"][0]["text"] = "x" * 9990

    class Provider:
        def __init__(self):
            self.inputs = []

        def generate(self, instruction, data):
            self.inputs.append(data)
            return "Notes" if len(self.inputs) == 1 else data

    provider = Provider()
    files = PaperFiles(library.folder(paper_id))
    with patch.object(library, "document", return_value=document):
        PaperService(library, provider, threading.Event()).article(paper_id)
    assert len(provider.inputs) == 2
    for data in provider.inputs:
        assert data.count("![figure") == 1
        assert "Single attention and multi-head attention." in data
        assert any("](media/p1i1.png)" in line
                   and " — Figure 2: Single attention and multi-head attention." in line
                   for line in data.splitlines())
        assert "p1i2.png" not in data
        assert "p1i3.png" not in data
    assert len(files.summary_images()) == 1
    with fitz.open(files.summary_images()[0]) as image:
        assert image[0].rect.width > image[0].rect.height * 2
