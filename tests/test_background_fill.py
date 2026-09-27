"""The box painted over a translated block takes the color around it (rendering only)."""
from __future__ import annotations

from collections import Counter
from pathlib import Path
import random

import pymupdf as fitz
import pytest

from papeer.pdf.pdf_engine import _Background, _light_text, build_translated_pdf, extract_pdf, translation_units

LINES = ["The proposed controller keeps the vehicle on the planned path.",
         "It also reacts to obstacles detected by the onboard sensors.",
         "Experiments on a test track confirm the expected behavior."]
BLOCK = fitz.Rect(60, 120, 340, 160)


def _source(path: Path, background, text_color=(0, 0, 0)) -> None:
    with fitz.open() as pdf:
        page = pdf.new_page(width=400, height=300)
        background(page)
        for index, line in enumerate(LINES):
            page.insert_text((60, 130 + index * 12), line, fontsize=9, color=text_color)
        page.insert_text((60, 250), "A second paragraph on the white paper below the panel.", fontsize=9)
        pdf.save(path)


def _panel(color):
    def draw(page):
        page.draw_rect(fitz.Rect(40, 100, 360, 180), color=None, fill=color)
    return draw


def _gradient(page):
    # Left to right from pink to light blue, drawn as narrow strips.
    for index in range(80):
        t = index / 79
        page.draw_rect(fitz.Rect(40 + index * 4, 100, 44 + index * 4, 180), color=None, fill=(1 - .2 * t, .8, .8 + .2 * t))


def _hatching(page):
    shape = page.new_shape()
    for x in range(-40, 360, 3):
        shape.draw_line((x, 180), (x + 80, 100))
    shape.finish(color=(.55, .55, .55), width=.4)
    shape.commit()


def _image(pixels):
    def draw(page):
        page.insert_image(fitz.Rect(40, 100, 360, 180), pixmap=pixels)
    return draw


def _solid_image(rgb):
    pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 64, 16), False)
    pixmap.set_rect(pixmap.irect, rgb)
    return pixmap


def _photo():
    generator = random.Random(4)
    pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 64, 16), False)
    for y in range(16):
        for x in range(64):
            pixmap.set_pixel(x, y, tuple(generator.randrange(60, 250) for _ in range(3)))
    return pixmap


def _color(path: Path, rect: fitz.Rect = BLOCK) -> tuple[float, float, float]:
    with fitz.open(path) as pdf:
        return _Background(pdf[0]).color(rect)


def _build(tmp_path: Path) -> tuple[Path, dict]:
    source, output = tmp_path / "source.pdf", tmp_path / "out.pdf"
    document = extract_pdf(source)
    units = translation_units(document)
    translations = {u["block"]: "提案する制御器は計画した経路に車両を保つ。" for u in units}
    return output, build_translated_pdf(source, document, translations, output)


def _pixels(path: Path, rect: fitz.Rect) -> Counter:
    with fitz.open(path) as pdf:
        pixmap = pdf[0].get_pixmap(clip=rect, alpha=False)
    data = pixmap.samples
    return Counter(tuple(data[i:i + 3]) for i in range(0, len(data), 3))


def test_the_paper_stays_exactly_white(tmp_path):
    _source(tmp_path / "source.pdf", lambda page: None)
    assert _color(tmp_path / "source.pdf") == (1, 1, 1)


@pytest.mark.parametrize("fill", [(.85, .85, .85), (.86, .92, 1.0), (1.0, .95, .8)])
def test_a_shaded_or_colored_panel_gives_its_color(tmp_path, fill):
    _source(tmp_path / "source.pdf", _panel(fill))
    assert _color(tmp_path / "source.pdf") == pytest.approx(fill, abs=1 / 255)
    # The translated paragraph is painted with the panel color, not a white box.
    output, _ = _build(tmp_path)
    expected = tuple(round(v * 255) for v in fill)
    common = _pixels(output, BLOCK).most_common(1)[0][0]
    assert max(abs(a - b) for a, b in zip(common, expected)) <= 1
    # The paragraph on the paper keeps a white box.
    assert _pixels(output, fitz.Rect(60, 242, 300, 252)).most_common(1)[0][0] == (255, 255, 255)


def test_a_gradient_gives_its_middle_shade(tmp_path):
    _source(tmp_path / "source.pdf", _gradient)
    # No shade prevails: the average around the block, near the middle of the gradient.
    assert _color(tmp_path / "source.pdf") == pytest.approx((.9, .8, .9), abs=.02)


def test_hatching_gives_a_light_shade_and_keeps_dark_text(tmp_path):
    _source(tmp_path / "source.pdf", _hatching)
    color = _color(tmp_path / "source.pdf")
    assert min(color) >= .55
    output, _ = _build(tmp_path)
    pixels = _pixels(output, BLOCK)
    assert any(max(p) < 80 for p in pixels)  # dark translation text


def test_text_on_an_image_takes_the_image_color(tmp_path):
    _source(tmp_path / "source.pdf", _image(_solid_image((200, 230, 200))))
    assert _color(tmp_path / "source.pdf") == pytest.approx((200 / 255, 230 / 255, 200 / 255), abs=1 / 255)
    # A photo has no prevailing color: its average around the block (random values in 60..249).
    _source(tmp_path / "source.pdf", _image(_photo()))
    assert _color(tmp_path / "source.pdf") == pytest.approx((155 / 255,) * 3, abs=.06)


def test_a_block_beside_an_image_keeps_the_paper_color(tmp_path):
    # An image touching one side of the block does not tint the box on the paper.
    _source(tmp_path / "source.pdf", lambda page: page.insert_image(fitz.Rect(40, 60, 360, 119),
                                                                     pixmap=_solid_image((40, 90, 160))))
    assert _color(tmp_path / "source.pdf") == (1, 1, 1)


def test_a_dark_panel_gets_light_text_inside_the_panel(tmp_path):
    panel = (.1, .15, .3)
    _source(tmp_path / "source.pdf", _panel(panel), text_color=(1, 1, 1))
    output, _ = _build(tmp_path)
    pixels = _pixels(output, BLOCK)
    expected = tuple(round(v * 255) for v in panel)
    assert max(abs(a - b) for a, b in zip(pixels.most_common(1)[0][0], expected)) <= 1
    assert any(min(p) > 200 for p in pixels)  # light translation text
    # Light text never spills onto the white paper around the panel.
    above = _pixels(output, fitz.Rect(40, 60, 360, 99))
    assert set(above) == {(255, 255, 255)}


@pytest.mark.parametrize(("fill", "light"), [((1, 1, 1), False), ((.86, .92, 1.0), False), ((.6, .6, .6), False),
                                             ((.45, .45, .45), True), ((.1, .15, .3), True), ((0, 0, 0), True),
                                             ((0, .7, 0), False), ((0, .5, 0), True), ((.8, 0, 0), True)])
def test_the_text_color_with_more_contrast_is_chosen(fill, light):
    # WCAG contrast of linearized sRGB: mid gray (.45) already favors light text.
    assert _light_text(fill) is light
