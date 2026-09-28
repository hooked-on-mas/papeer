"""The regions of a scanned page (papeer.layout.ocr_regions): text, formulas and figures, reading order, skew.

The pages are the top halves of synthetic two-column papers rendered at 300 dpi (tests/fixtures/ocr,
four gray levels, made by tools/make_ocr_fixtures.py); truth.json holds their text lines in points. A
"scan" is the same page on gray paper, blurred and turned (deterministic, no noise).
"""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
import pytest

from papeer.layout.ocr_regions import components, estimate_skew, segment_page, unrotate_point

FIXTURES = Path(__file__).parent / "fixtures" / "ocr"
TRUTH = json.loads((FIXTURES / "truth.json").read_text("utf-8"))
DPI = 300
PX = DPI / 72


def page(name: str) -> Image.Image:
    return Image.open(FIXTURES / f"{name}.png").convert("L")


def scanned(image: Image.Image, angle: float) -> Image.Image:
    """Gray paper, ink not black, a little blur, turned by angle degrees."""
    gray = image.point(lambda v: 40 + v * 175 // 255)
    return gray.filter(ImageFilter.GaussianBlur(1)).rotate(angle, resample=Image.Resampling.BICUBIC, fillcolor=215)


def truth_box(name: str, text: str) -> tuple[float, float, float, float]:
    line = next(line for line in TRUTH[name]["lines"] if line[4].startswith(text))
    return tuple(v * PX for v in line[:4])  # type: ignore[return-value]


def inside(inner, outer, margin: float = 0) -> bool:
    return (inner[0] >= outer[0] - margin and inner[1] >= outer[1] - margin
            and inner[2] <= outer[2] + margin and inner[3] <= outer[3] + margin)


def region_of(layout, box):
    """The region holding the middle of box."""
    x, y = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return next(r for r in layout.regions if r.box[0] <= x <= r.box[2] and r.box[1] <= y <= r.box[3])


def test_two_columns_are_read_column_by_column():
    layout = segment_page(page("synth_en_2col"), DPI)
    assert layout.angle == 0
    assert {r.kind for r in layout.regions} <= {"text", "math"}
    middle = layout.image.width / 2
    # Below the title block, every text block lies in one column: none crosses the gutter.
    columns = [b for b in layout.blocks if b.box[1] > truth_box("synth_en_2col", "Abstract")[1] - 10]
    assert columns and all(b.box[2] < middle or b.box[0] > middle for b in columns)
    # The left column is read before the right one.
    order = [i for i, b in enumerate(layout.blocks) if b in columns]
    lefts = [i for i in order if layout.blocks[i].box[2] < middle]
    rights = [i for i in order if layout.blocks[i].box[0] > middle]
    assert lefts and rights and max(lefts) < min(rights)
    # Every line of the body is inside one text block.
    for line in TRUTH["synth_en_2col"]["lines"]:
        box = [v * PX for v in line[:4]]
        if box[1] > columns[0].box[1]:
            assert any(inside(box, b.box, 4) for b in columns), line[4]


def test_title_and_author_lines_are_left_to_the_ocr_text():
    # A centered line is a heading, an author line or a display formula: its shape cannot tell, the
    # OCR text does (papeer.pdf.pdf_ocr.prose_text).
    layout = segment_page(page("synth_en_2col"), DPI)
    authors = region_of(layout, truth_box("synth_en_2col", "David Lee"))
    assert authors.kind == "text" or authors.uncertain


@pytest.mark.parametrize("name", ["synth_en_2col_mathfig", "synth_ja_2col_mathfig"])
def test_formula_and_figure_are_kept_apart_from_the_text(name):
    layout = segment_page(page(name), DPI)
    figures = [r for r in layout.regions if r.kind == "figure"]
    assert len(figures) == 1
    figure = figures[0].box
    # The figure takes its tick labels and legend, and no text of the columns.
    for label in ("N=8", "N=256", "80", "0"):
        line = next(line for line in TRUTH[name]["lines"] if line[4] == label and line[0] * PX > figure[0] - 50)
        assert inside([v * PX for v in line[:4]], figure, 4), label
    for line in TRUTH[name]["lines"]:
        box = [v * PX for v in line[:4]]
        if len(line[4]) > 20:
            assert not inside(box, figure, 0), line[4]
    # The display formula is a formula for certain (its sum is much taller than a line).
    formula = region_of(layout, truth_box(name, "L(θ)"))
    assert formula.kind == "math" and not formula.uncertain
    # No text block reaches into the formula or the figure.
    for block in layout.blocks:
        for other in (formula.box, figure):
            assert min(block.box[2], other[2]) <= max(block.box[0], other[0]) or \
                min(block.box[3], other[3]) <= max(block.box[1], other[1])


def test_the_ends_of_a_frame_do_not_become_text():
    image = Image.new("L", (1200, 900), 255)
    draw = ImageDraw.Draw(image)
    draw.rectangle((100, 100, 1100, 600), outline=0, width=3)
    draw.rectangle((300, 300, 400, 590), fill=90)
    draw.rectangle((600, 200, 700, 590), fill=90)
    layout = segment_page(image, DPI)
    assert [r.kind for r in layout.regions] == ["figure"]
    assert inside((100, 100, 1100, 600), layout.regions[0].box, 2)
    assert layout.blocks == []


def test_blank_and_tiny_pages():
    assert segment_page(Image.new("L", (2480, 3508), 255), DPI).regions == []
    assert segment_page(Image.new("L", (5, 5), 255), DPI).regions == []
    assert segment_page(Image.new("RGB", (40, 40), (255, 255, 255)), DPI).blocks == []


@pytest.mark.parametrize("angle", [1.5, -2.0])
def test_a_skewed_scan_is_turned_straight(angle):
    image = scanned(page("synth_en_2col"), angle)
    layout = segment_page(image, DPI)
    assert layout.angle == pytest.approx(-angle, abs=.15)
    straight = segment_page(page("synth_en_2col"), DPI)
    assert len(layout.blocks) == len(straight.blocks)
    # A point of the straightened page maps back to where the scan has it: the middle of a line.
    box = truth_box("synth_en_2col", "David Lee")
    middle = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
    x, y = layout.unrotate(*middle)
    turned = unrotate_point(middle[0], middle[1], -angle, image.size)
    assert abs(x - turned[0]) < 1 and abs(y - turned[1]) < 1


def test_unrotate_point_inverts_image_rotate():
    image = Image.new("L", (400, 300), 0)
    image.putpixel((300, 80), 255)
    for angle in (2.0, -3.0, 30.0):
        turned = image.rotate(angle, resample=Image.Resampling.NEAREST)
        x0, y0, _, _ = turned.getbbox()  # type: ignore[misc]
        x, y = unrotate_point(x0 + .5, y0 + .5, angle, turned.size)
        assert abs(x - 300.5) <= 1.5 and abs(y - 80.5) <= 1.5


def test_skew_of_a_straight_page_is_zero():
    assert segment_page(page("synth_ja_2col_mathfig"), DPI).angle == 0
    assert estimate_skew(Image.new("L", (4, 4), 0)) == 0


def test_components_are_eight_connected():
    image = Image.new("L", (10, 6), 0)
    for x, y in ((1, 1), (2, 2), (3, 3), (7, 1), (7, 2), (8, 4)):
        image.putpixel((x, y), 255)
    found = sorted(components(image))
    assert found == [(1, 1, 4, 4, 3), (7, 1, 8, 3, 2), (8, 4, 9, 5, 1)]
