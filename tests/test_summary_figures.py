import copy
import threading

from _summary_responses import clean_summary_response
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


def test_unpunctuated_caption_with_separate_description_and_protruding_labels():
    with fitz.open() as pdf:
        page = pdf.new_page()
        add_image(page, fitz.Rect(50, 50, 160, 140))
        page.insert_text((50, 158), "Fig. 8", fontsize=9)
        page.insert_text((90, 158), "Residual state distributions.", fontsize=9)
        page.insert_text((42, 70), "max", fontsize=5)
        figures = summary_figures(page, [], 1)
        assert len(figures) == 1
        assert figures[0]["caption"] == "Fig. 8 Residual state distributions."
        assert figures[0]["rect"].x0 == 42


def test_composite_vector_figure_and_legend_survive_old_partial_regions():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.draw_rect(fitz.Rect(50, 50, 150, 150))
        page.draw_rect(fitz.Rect(160, 50, 270, 150))
        page.draw_line((145, 100), (165, 100))
        page.insert_text((230, 70), "Complete legend", fontsize=8)
        page.insert_text((70, 170), "FIGURE 2 Optimal trajectories.", fontsize=9)
        old = [{"id": "p1t1", "page": 1, "kind": "table", "bbox": [160, 50, 270, 150]}]
        figures = summary_figures(page, old, 1)
        assert len(figures) == 1
        assert figures[0]["rect"].x0 == 50
        assert figures[0]["rect"].x1 > 280


def test_stacked_panels_far_from_caption_are_retained_without_crossing_another_caption():
    with fitz.open() as pdf:
        page = pdf.new_page()
        for y in (40, 155, 270):
            page.draw_rect(fitz.Rect(40, y, 200, y + 100))
        page.insert_text((40, 388), "FIGURE 3 All three result panels.")
        figures = summary_figures(page, [], 1)
        assert len(figures) == 1
        assert figures[0]["rect"].y0 == 40 and figures[0]["rect"].y1 == 370


def test_same_baseline_caption_description_with_different_font_size():
    with fitz.open() as pdf:
        page = pdf.new_page()
        add_image(page, fitz.Rect(150, 40, 350, 140))
        page.insert_text((40, 160), "FIGURE 4", fontsize=7)
        page.insert_text((100, 160), "Monte Carlo sampling of the process.", fontsize=12)
        figures = summary_figures(page, [], 1)
        assert len(figures) == 1
        assert "Monte Carlo sampling" in figures[0]["caption"]


def test_caption_splits_plot_from_later_graphics_in_one_cluster():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.draw_rect(fitz.Rect(50, 50, 250, 350))
        page.insert_text((50, 178), "Fig. 2.", fontsize=8)
        page.insert_text((80, 178), "Constraint violations.", fontsize=8)
        figures = summary_figures(page, [], 1)
        assert len(figures) == 1
        assert figures[0]["rect"].y1 < 170


def test_new_plot_cluster_does_not_bind_to_previous_figure_caption():
    with fitz.open() as pdf:
        page = pdf.new_page()
        for y, label in [(50, "1"), (210, "2")]:
            page.draw_rect(fitz.Rect(80, y, 250, y + 100))
            page.insert_text((50, y + 140), f"Fig. {label}. Complete result plot.", fontsize=9)
        old = [{"id": "p1f1", "page": 1, "kind": "figure", "bbox": [80, 50, 250, 165]},
               {"id": "p1f2", "page": 1, "kind": "figure", "bbox": [80, 210, 250, 325]}]
        figures = summary_figures(page, old, 1)
        assert len(figures) == 2
        assert figures[0]["rect"].y1 < 190
        assert figures[1]["rect"].y0 >= 210


def test_top_panel_of_next_stacked_figure_does_not_use_caption_above_it():
    with fitz.open() as pdf:
        page = pdf.new_page()
        old = []
        for index, y in enumerate((40, 100, 160, 260, 320, 380)):
            page.draw_rect(fitz.Rect(80, y, 250, y + 40))
            old.append({"id": f"p1f{index}", "page": 1, "kind": "figure", "bbox": [80, y, 250, y + 48]})
        page.insert_text((50, 230), "Fig. 1. First three panels.", fontsize=9)
        page.insert_text((50, 450), "Fig. 2. Next three panels.", fontsize=9)
        figures = summary_figures(page, old, 1)
        assert len(figures) == 2
        assert figures[0]["rect"].y0 == 40 and figures[0]["rect"].y1 < 230
        assert figures[1]["rect"].y0 == 260 and figures[1]["rect"].y1 < 450


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


def test_tiled_raster_includes_short_final_strip_despite_old_partial_region():
    with fitz.open() as pdf:
        page = pdf.new_page()
        add_image(page, fitz.Rect(40, 40, 240, 100))
        add_image(page, fitz.Rect(40, 100, 240, 160))
        add_image(page, fitz.Rect(40, 160, 240, 185))  # Axis labels can be a short final image tile.
        page.insert_text((40, 202), "Fig. 2. Complete surface and axes.")
        old = [{"id": "p1f1", "page": 1, "kind": "figure", "bbox": [40, 40, 240, 160]}]
        figures = summary_figures(page, old, 1)
        assert len(figures) == 1
        assert figures[0]["rect"] == fitz.Rect(40, 40, 240, 185)


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
    document = copy.deepcopy(library.document(paper_id))  # The shared value is never changed in place.
    # Exercise splitting at the old boundary between an image and its caption.
    document["pages"][0]["text"] = "x" * 9990

    class Provider:
        def __init__(self):
            self.inputs = []

        def generate(self, instruction, data, schema=None):
            if schema:
                return clean_summary_response(data)
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
