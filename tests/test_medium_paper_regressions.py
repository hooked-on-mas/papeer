"""Geometry regressions expressed without paper IDs or paper-specific coordinates."""
from types import SimpleNamespace
from unittest.mock import patch

import pymupdf as fitz

from papeer.layout.math_layout import (_math_ranges, _text_size, annotate_math_fonts, layout_blocks)
from papeer.pdf.pdf_engine import _fit_around_images, _without_images, _fit_story_canvas
from papeer.pdf.pdf_math_crops import page_glyph_bounds
from papeer.pdf.pdf_typography import font_archive, text_html, TextStyle


def test_trace_font_truncated_before_removing_subset_prefix_uses_outlines():
    name = 'ABCDEF+STIXMathExtensions-Regular'
    trace_name = name[:31].split('+')[-1]
    page = SimpleNamespace(get_fonts=lambda: [(1, 'cff', 'Type1', name)],
        parent=SimpleNamespace(extract_font=lambda _: ('font', 'cff', 'Type1', b'test')),
        get_texttrace=lambda: [dict(font=trace_name, dir=(1, 0), size=10,
            chars=[(8721, 0, (40, 100), (40, 92, 50, 102))])])
    with patch('papeer.pdf.pdf_math_crops._cff_outline_bounds', return_value=[(0, -1500, 900, 500)]):
        assert page_glyph_bounds(page)[(40, 100)] == fitz.Rect(40, 95, 49, 115)


def test_large_extension_glyph_does_not_replace_sentence_type_size():
    chars = [dict(c=c, size=10, math_font=False) for c in 'The bound follows']
    chars.append(dict(c='∑', size=24, math_font=True))
    assert _text_size(chars) == 10


def test_italic_word_with_ligature_is_not_split_into_short_math_identifiers():
    text = 'diﬀerent values'
    chars = [dict(c=c, size=10, math_font=False, flags=2, font='Times-Italic') for c in text]
    assert _math_ranges(chars) == []


def test_leading_upright_constant_travels_with_subtracted_sum():
    chars = [dict(c=c, size=10, math_font=(c == '∑'), flags=0,
                  font='CMSY10' if c == '∑' else 'Times-Roman') for c in '1 − ∑']
    assert _math_ranges(chars) == [(0, 5)]


def test_decimal_tail_cannot_be_translated_separately_from_its_equation():
    text = 'x = 0.01'
    chars = [dict(c=c, size=10, math_font=False, flags=0, font='Times-Roman') for c in text]
    assert _math_ranges(chars) == [(0, len(text))]


def test_upright_subscript_fragment_is_preserved_as_math():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 100), 'S1', fontsize=7)
        items = page.get_text('rawdict')['blocks']
    annotate_math_fonts(items)
    assert layout_blocks(items[0], 1, 1)[0]['kind'] == 'formula'


def test_photo_cutouts_cover_only_the_rest_of_a_wrapped_box():
    whole = fitz.Rect(20, 20, 280, 180)
    photo = fitz.Rect(20, 20, 100, 100)
    pieces = _without_images(whole, [photo])
    assert all(not piece.intersects(photo) for piece in pieces)
    assert sum(piece.get_area() for piece in pieces) == whole.get_area() - photo.get_area()


def test_story_flows_beside_then_below_photo_without_shrinking_its_footprint():
    bounds = fitz.Rect(0, 0, 300, 250)
    photo = fitz.Rect(20, 20, 100, 100)
    text = 'The biographical text continues around the photograph. ' * 10
    remaining, scale, data = _fit_around_images(fitz.Rect(20, 20, 280, 200),
        '<div style="font-size:10pt;line-height:1.2"><p style="margin:0">'+text+'</p></div>',
        font_archive(text), bounds, [photo])
    assert remaining >= 0 and scale > .7
    with fitz.open(stream=data, filetype='pdf') as pdf:
        lines = [line for block in pdf[0].get_text('dict')['blocks'] for line in block.get('lines', [])]
        assert all(not fitz.Rect(line['bbox']).intersects(photo) for line in lines)
        assert any(line['bbox'][0] > photo.x1 and line['bbox'][1] < photo.y1 for line in lines)
        assert any(line['bbox'][0] < photo.x1 and line['bbox'][1] > photo.y1 for line in lines)


def test_final_fraction_keeps_all_ink_without_blank_tail_shrinking_body():
    token = '[[PD_MATH_p1b1_0]]'
    archive = font_archive('value')
    pixel = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 35, 21), False)
    pixel.clear_with(0)
    archive.add((pixel.tobytes('png'), 'fraction.png'))
    markup = text_html('value '+token, TextStyle('body', 10, 1.4),
        {token:'<img src="fraction.png" style="width:3.5em;height:2.1em;vertical-align:-.8em">'},
        story_canvas=True)
    rect = fitz.Rect(40, 40, 240, 70)
    remaining, scale, data = _fit_story_canvas(rect, markup, archive, fitz.Rect(0, 0, 300, 200))
    assert remaining >= 0 and scale >= .7
    with fitz.open(stream=data, filetype='pdf') as pdf:
        box = fitz.Rect(pdf[0].get_image_info()[0]['bbox'])
        assert box.y1 <= rect.y1 + .05
        # The bottom of the mathematical image must actually be painted,
        # not merely advertised by an image bbox outside a clipped form.
        rendered = pdf[0].get_pixmap(matrix=fitz.Matrix(4, 4), clip=box + (1, 1, -1, -1))
        assert sum(rendered.samples) < len(rendered.samples) * 3
