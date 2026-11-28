import copy
import threading

from _summary_responses import clean_summary_response
from unittest.mock import patch

import pymupdf as fitz
import pytest

from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.core.summary.figures import SUMMARY_CAPTION, render_summary_figure, summary_figures


def add_image(page, rect):
    pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 80, 80), False)
    pixmap.clear_with(128)
    page.insert_image(rect, pixmap=pixmap, keep_proportion=False)


@pytest.mark.parametrize("caption,font,kind,above", [
    ("그림3.1: Excavation environment", "korea", "figure", False),
    ("표4.2: Experiment results", "korea", "table", True),
    ("図2.1：実験結果", "japan", "figure", False),
    ("表2.1：実験結果", "japan", "table", True),
    ("Figure S2: Additional results", "helv", "figure", False),
])
def test_multilingual_chapter_and_supplement_captions(caption, font, kind, above):
    with fitz.open() as pdf:
        page = pdf.new_page(width=500, height=400)
        add_image(page, fitz.Rect(40, 100, 280, 220))
        page.insert_text((40, 90 if above else 238), caption, fontname=font, fontsize=9)
        figures = summary_figures(page, [], 1)
        assert len(figures) == 1
        assert figures[0]["kind"] == kind
        assert "".join(figures[0]["caption"].split()) == "".join(caption.split())


def test_table_caption_description_can_span_multiple_blocks_before_the_cells():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 50), "TABLE II", fontsize=8)
        page.insert_text((40, 62), "Continuous-depletion ablation.", fontsize=8)
        page.insert_text((40, 74), "Success means completion of every episode.", fontsize=8)
        old = [{"id": "p1t1", "page": 1, "kind": "table", "bbox": [40, 95, 280, 190]}]
        figures = summary_figures(page, old, 1)
        assert len(figures) == 1 and figures[0]["caption"].startswith("TABLE II")


def test_borderless_table_is_recovered_without_cached_regions_or_drawings():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 50), "Table 1 Soil parameters.", fontsize=8)
        for row in range(6):
            for col in range(4):
                page.insert_text((40 + col * 65, 70 + row * 15), f"cell{row}{col}", fontsize=8)
        page.insert_text((40, 200), "This is the following body paragraph, outside the table.", fontsize=10)
        figures = summary_figures(page, [], 1)
        assert len(figures) == 1 and figures[0]["kind"] == "table"
        assert figures[0]["rect"].y1 < 180


def test_caption_and_table_cells_in_one_text_block_do_not_hide_the_table():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 70), "Table 1. Time required for each excavator state.", fontsize=9)
        for y in (85, 100, 115):
            page.insert_text((40, y), "parameter 20 30 40", fontsize=9)
        old = [{"id": "p1t1", "page": 1, "kind": "table", "bbox": [40, 73, 280, 123]}]
        figures = summary_figures(page, old, 1)
        assert len(figures) == 1 and figures[0]["kind"] == "table"
        assert "parameter" not in figures[0]["caption"]


def test_vector_path_with_two_caption_separated_plots_recovers_both():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.draw_rect(fitz.Rect(50, 40, 300, 350))
        page.insert_text((50, 170), "Fig. 1. First experiment.", fontsize=9)
        page.insert_text((50, 330), "Fig. 2. Second experiment.", fontsize=9)
        figures = summary_figures(page, [], 1)
        assert len(figures) == 2
        assert figures[0]["rect"].y1 < 170
        assert figures[1]["rect"].y0 > 170 and figures[1]["rect"].y1 < 330


def test_inline_figure_reference_is_not_an_image_caption():
    with fitz.open() as pdf:
        page = pdf.new_page()
        add_image(page, fitz.Rect(40, 40, 220, 140))
        page.insert_text((40, 158), "Figure 2 shows the full comparison with other methods.")
        assert summary_figures(page, [], 1) == []
    assert SUMMARY_CAPTION.match("Figure 6.6a provides insight into the method") is None


@pytest.mark.parametrize("angle", [90, 180, 270])
def test_rotated_content_recovers_distinct_captions_and_renders_upright(angle):
    with fitz.open() as source, fitz.open() as portrait:
        landscape = source.new_page(width=600, height=350)
        for x, number in [(30, 1), (320, 2)]:
            add_image(landscape, fitz.Rect(x, 40, x + 230, 220))
            landscape.insert_text((x, 245), f"Fig. 7.{number}. Separate result plot.", fontsize=9)
        page = portrait.new_page(width=350, height=600)
        page.show_pdf_page(page.rect, source, 0, rotate=angle)
        figures = summary_figures(page, [], 1)
        assert len(figures) == 2
        assert len({item["id"] for item in figures}) == 2
        assert all(item["rotation"] == angle for item in figures)
        for item in figures:
            with fitz.open(stream=render_summary_figure(page, item), filetype="png") as image:
                assert image[0].rect.width > image[0].rect.height


def test_neighboring_captions_on_one_baseline_are_never_joined():
    with fitz.open() as pdf:
        page = pdf.new_page(width=600, height=400)
        for x, number in [(40, 1), (300, 2)]:
            add_image(page, fitz.Rect(x, 40, x + 220, 180))
            page.insert_text((x, 205), f"Fig. {number}. Independent experiment.", fontsize=9)
        figures = summary_figures(page, [], 1)
        assert len(figures) == 2
        assert all(item["caption"].count("Fig.") == 1 for item in figures)


def test_zero_images_with_source_captions_does_not_publish_or_call_model(tmp_path):
    source = tmp_path / "source.pdf"
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 50), "Figure 1: An experiment whose graphic was not extracted.")
        pdf.save(source)
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(source)
    files = PaperFiles(library.folder(identity))
    files.article_md.write_text("Previous summary", "utf-8")
    class Provider:
        def generate(self, *_):
            pytest.fail("Extraction must fail before a model request")
    with patch("papeer.core.service.summary_figures", return_value=[]), pytest.raises(ValueError, match="抽出"):
        PaperService(library, Provider(), threading.Event()).article(identity)
    assert files.article_md.read_text("utf-8") == "Previous summary"


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


def test_widely_spaced_caption_recovers_panels_but_not_across_body_text():
    with fitz.open() as pdf:
        page = pdf.new_page()
        add_image(page, fitz.Rect(80, 50, 320, 150))
        page.insert_text((80, 180), "(a) First view and its panel description.", fontsize=9)
        page.insert_text((80, 210), "Figure 1. Two views of the same experiment.", fontsize=9)
        assert len(summary_figures(page, [], 1)) == 1
        page.insert_text((80, 165), "Intervening body prose " * 6, fontsize=6)
        assert not summary_figures(page, [], 1)


def test_caption_carried_to_next_page_keeps_original_pixels_and_source_page():
    with fitz.open() as pdf:
        pdf.new_page(width=600, height=800)
        pdf.new_page(width=600, height=800)
        first, second = pdf[0], pdf[1]
        add_image(first, fitz.Rect(80, 550, 500, 730))
        second.insert_text((80, 85), "Fig. 12. Mining simulation model.", fontsize=10)
        assert not summary_figures(first, [], 1)
        [figure] = summary_figures(first, [], 1, following_page=second)
        assert figure["caption_page"] == 2
        assert figure["caption"] == "Fig. 12. Mining simulation model."
        assert figure["rect"] == fitz.Rect(80, 550, 500, 730)


def test_broad_cached_table_excludes_prose_and_the_next_appendix_heading():
    with fitz.open() as pdf:
        page = pdf.new_page(width=600, height=700)
        page.insert_text((50, 70), "Appendix A.1. State Definition")
        page.insert_text((50, 100), "The state vector contains the current status of the mining complex.")
        page.insert_text((50, 200), "Table A1. State attributes.", fontsize=9)
        page.draw_rect(fitz.Rect(50, 220, 550, 350))
        page.insert_text((60, 240), "Attribute                        Definition", fontsize=9)
        page.insert_text((60, 280), "Status                           Current status", fontsize=9)
        page.insert_text((50, 380), "Appendix A.2. Network Parameters")
        page.insert_text((50, 410), "Table A2. Network settings.", fontsize=9)
        page.draw_rect(fitz.Rect(50, 430, 550, 500))
        old = [{"id": "p1t1", "kind": "table", "page": 1, "bbox": [40, 40, 560, 510]}]
        items = summary_figures(page, old, 1)
        first = next(item for item in items if item["caption"].startswith("Table A1"))
        assert first["rect"].y0 >= 200
        assert first["rect"].y1 < 380


def test_previous_caption_tail_is_not_included_as_an_axis_label():
    with fitz.open() as pdf:
        page = pdf.new_page()
        for y in (50, 200):
            page.draw_rect(fitz.Rect(80, y, 350, y + 100))
        page.insert_text((60, 175), "Fig. 1. First result.\nA separate description of the first result.", fontsize=10)
        page.insert_text((60, 325), "Fig. 2. Second result.", fontsize=10)
        items = summary_figures(page, [], 1)
        second = next(item for item in items if item["caption"].startswith("Fig. 2"))
        assert second["rect"].y0 >= 200


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
    [image_path] = files.summary_images()
    for data in provider.inputs:
        assert data.count("![figure") == 1
        assert "Single attention and multi-head attention." in data
        assert any(f"](media/{image_path.name})" in line
                   and " — Figure 2: Single attention and multi-head attention." in line
                   for line in data.splitlines())
    with fitz.open(image_path) as image:
        assert image[0].rect.width > image[0].rect.height * 2
