"""Numbers and document furniture need mathematical context before cropping."""
import pytest
import pymupdf as fitz

from papeer.layout.math_layout import _math_ranges, annotate_math_fonts, layout_blocks


@pytest.mark.parametrize('rows', [
    ['0', '41', '69', '135'],
    ['2008-03-15', '2008-05-31', '2009-06-01'],
    ['2.62', '3.83', '12.21'],
    ['(1)', '(2)', '(3)'],
    ['is it', 'in it', 'at it'],
])
def test_repeated_numeric_or_short_prose_spans_are_not_a_math_font(rows):
    with fitz.open() as pdf:
        page = pdf.new_page()
        for i, text in enumerate(rows):
            page.insert_text((40, 60 + i * 25), text, fontname='tiro', fontsize=10)
        items = page.get_text('rawdict')['blocks']
    annotate_math_fonts(items)
    assert not any(s['math_font'] for item in items for line in item['lines'] for s in line['spans'])
    blocks = [b for item in items for b in layout_blocks(item, 1, 1)]
    assert all(b['kind'] == 'text' and not b['formulas'] for b in blocks)


def test_wrapped_toc_formula_tail_does_not_capture_the_dotted_leader():
    # A title ends with a mathematical parameter list on a continuation row.
    # Decimal points use a math face; the leader and page number use roman.
    text = '0.1, 0.2, 0.3) ' + '. ' * 35
    spans = []
    for i, char in enumerate(text):
        math = i < 13 and char in '.,'
        spans.append(dict(font='CMMI10' if math else 'CMR10', math_font=math,
                          flags=2 if math else 0, size=10,
                          chars=[dict(c=char, bbox=[40+i*4, 92, 44+i*4, 102], origin=[40+i*4, 100])]))
    line = dict(bbox=[40, 92, 40+len(text)*4, 102], spans=spans)
    blocks = layout_blocks(dict(lines=[line]), 1, 1)
    assert all(b['kind'] == 'text' for b in blocks)
    assert not any('. . . . . .' in f['text'] for b in blocks for f in b['formulas'])


def test_mixed_use_font_does_not_turn_its_table_numbers_into_equations():
    with fitz.open() as pdf:
        page = pdf.new_page()
        for y, text in [(60, 'x = 1'), (100, '41'), (125, '69'), (150, '2008-03-15')]:
            page.insert_text((40, y), text, fontname='tiro', fontsize=10)
        items = page.get_text('rawdict')['blocks']
    annotate_math_fonts(items)
    blocks = [b for item in items for b in layout_blocks(item, 1, 1)]
    assert [b['text'] for b in blocks if b['kind'] == 'formula'] == ['x = 1']
    assert all(not b['formulas'] for b in blocks if b['kind'] == 'text')


@pytest.mark.parametrize(('text', 'expected'), [
    ('We use 7,000 points.', []),
    ('We use 7, 000 points.', []),
    ('The bound is x = 7,000.', ['x = 7,000']),
])
def test_math_face_thousands_separator_needs_equation_context(text, expected):
    chars = [dict(c=c, font='CMMI10' if c == ',' else 'Times-Roman', math_font=c == ',',
                  size=10, flags=0) for c in text]
    assert [text[a:b] for a, b in _math_ranges(chars)] == expected


def test_opaque_math_font_keeps_a_visible_glyph_encoded_as_carriage_return():
    spans = [dict(font='T7', size=10, flags=0, chars=[dict(c=c) for c in text])
             for text in ['xy', 'yz', 'zz', '\r']]
    annotate_math_fonts([dict(lines=[dict(spans=spans)])])
    chars = [dict(c, font=s['font'], size=s['size'], flags=s['flags'], math_font=s['math_font'])
             for s in spans for c in s['chars']]
    text = ''.join(c['c'] for c in chars)
    assert any('\r' in text[a:b] for a, b in _math_ranges(chars))
