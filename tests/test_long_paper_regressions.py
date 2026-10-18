"""General geometric regressions discovered in longer, unseen papers."""
import io

import pymupdf as fitz
from PIL import Image

from papeer.layout.math_layout import annotate_math_fonts, layout_blocks, _math_ranges, _piecewise_items
from papeer.layout.table_layout import table_regions
from papeer.layout.figure_layout import figure_regions, raster_crosses_prose, diagram_regions
from papeer.pdf.pdf_engine import _restore_source_region


def test_restored_region_keeps_source_white_gaps_and_colored_content():
    with fitz.open() as source, fitz.open() as output:
        original = source.new_page(width=180, height=140)
        original.draw_rect(fitz.Rect(40, 40, 140, 80), color=None, fill=(.2, .6, .8))
        original.insert_text((50, 65), 'q = 2')
        target = output.new_page(width=180, height=140)
        target.draw_rect(target.rect, color=None, fill=(1, 0, 0))
        region = fitz.Rect(20.25, 20.75, 160.25, 100.75)
        _restore_source_region(target, original, region)
        actual = target.get_pixmap(matrix=fitz.Matrix(4, 4), clip=region, alpha=False)
        expected = original.get_pixmap(matrix=fitz.Matrix(4, 4), clip=region, alpha=False)
        assert actual.samples == expected.samples
        assert 'q = 2' in target.get_text()
        outside = target.get_pixmap(clip=fitz.Rect(0, 110, 10, 120), alpha=False)
        assert outside.pixel(0, 0) == (255, 0, 0)


def test_upright_numeric_power_keeps_base_and_raised_exponent_together():
    text = 'increase 103 times'
    chars = [dict(c=c, size=7 if i == 11 else 10, flags=1 if i == 11 else 0,
                  font='Times-Roman', math_font=False, origin=(i * 5, 97 if i == 11 else 100))
             for i, c in enumerate(text)]
    assert _math_ranges(chars) == [(9, 12)]


def test_plain_number_is_not_mistaken_for_a_numeric_power():
    chars = [dict(c=c, size=10, flags=0, font='Times-Roman', math_font=False,
                  origin=(i*5, 100)) for i,c in enumerate('increase 103 times')]
    assert _math_ranges(chars) == []


def test_case_values_and_equation_terminal_zero_are_protected():
    text = '1 if x = 0 otherwise'
    chars = [dict(c=c, size=10, flags=0, font='Times-Roman', math_font=False)
             for c in text]
    spans = _math_ranges(chars)
    assert any(a <= 0 < b for a,b in spans)
    assert any(a <= text.index('0') < b for a,b in spans)
    assert not any(a <= text.index('if') < b for a,b in spans)


def test_custom_roman_function_denominator_stays_display_math():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((100,100), '8 + CustomIntegral(8)', fontname='tiro', fontsize=10)
        items = page.get_text('rawdict')['blocks']
        annotate_math_fonts(items)
        assert all(b['kind'] == 'formula' for b in layout_blocks(items[0], 1, 1))


def test_table_with_no_internal_data_rules_keeps_all_rows():
    with fitz.open() as pdf:
        page = pdf.new_page(width=600, height=800)
        for y in (100,125,420):
            page.draw_line((80,y),(500,y))
        for y in range(145,410,20):
            for x,t in [(85,'soil-'+str(y)),(260,'38.5'),(380,'0.12'),(465,'12')]:
                page.insert_text((x,y),t,fontsize=9)
        page.insert_text((80,460),'This ordinary paragraph must still be translated.',fontsize=10)
        regions = table_regions(page)
        assert any(fitz.Point(90,400) in r and fitz.Point(470,140) in r for r in regions)
        assert not any(fitz.Point(100,455) in r for r in regions)


def test_backing_image_does_not_cut_a_live_paragraph_into_figure_fragments():
    stream=io.BytesIO();Image.new('RGB',(80,40),'white').save(stream,format='PNG')
    with fitz.open() as pdf:
        page=pdf.new_page(width=500,height=500)
        rect=fitz.Rect(150,100,350,180)
        page.insert_image(rect,stream=stream.getvalue())
        page.insert_text((70,130),'The complete sentence crosses the backing image rectangle.',fontsize=10)
        assert raster_crosses_prose(page,rect)
        assert not any(r.intersects(rect) for r in figure_regions(page))


def test_diagram_can_own_embedded_photos_but_not_a_table_overlap():
    with fitz.open() as pdf:
        page=pdf.new_page(width=500,height=500)
        for n in range(4):
            box=fitz.Rect(40+n*85,60,105+n*85,130)
            page.draw_rect(box)
            page.insert_text((box.x0+4,80),'Input and output of the current stage',fontsize=3)
            if n:
                page.draw_line((box.x0-20,100),(box.x0,100))
                page.draw_polyline([(box.x0-4,97),(box.x0,100),(box.x0-4,103)])
        photo=fitz.Rect(46,90,98,124)
        pix=fitz.Pixmap(fitz.csRGB,fitz.IRect(0,0,52,34),False);pix.clear_with(128)
        page.insert_image(photo,pixmap=pix)
        page.insert_text((40,160),'Figure 1. Multi-stage architecture.',fontsize=10)
        page.insert_text((40,200),'The ordinary body paragraph describes the architecture and its results.',fontsize=10)
        regions=diagram_regions(page,[photo],embedded=[photo])
        assert len(regions)==1 and photo in regions[0]
        assert not diagram_regions(page,[photo])


def test_piecewise_conditions_stay_with_their_tall_brace_and_left_hand_side():
    def line(text,x,y,font='Times-Roman',height=10):
        chars=[dict(c=c,origin=(x+i*5,y+8),bbox=(x+i*5,y,x+(i+1)*5,y+height)) for i,c in enumerate(text)]
        box=(x,y,x+len(text)*5,y+height)
        return dict(bbox=box,spans=[dict(font=font,size=10,flags=0,math_font=font.startswith('CM'),chars=chars,bbox=box)])
    def item(lines):
        box=fitz.Rect(lines[0]['bbox'])
        for l in lines[1:]:box|=fitz.Rect(l['bbox'])
        return dict(type=0,bbox=list(box),lines=lines)
    lhs=item([line('f(x) =',55,103,'CMMI10')])
    brace=item([line('{',90,90,'CMEX10',height=36)])
    cases=item([line('1 if the value exceeds zero',100,94),line('0 otherwise.',100,112)])
    paragraph=item([line('The following paragraph stays translatable.',40,150)])
    combined=_piecewise_items([lhs,brace,cases,paragraph])
    assert len(combined)==2 and paragraph in combined
    display=next(i for i in combined if i.get('display_math'))
    blocks=layout_blocks(display,1,1)
    assert len(blocks)==1 and blocks[0]['kind']=='formula'
    assert 'otherwise' in blocks[0]['text']
    # A tall decorative brace beside prose, without an equation LHS, is not
    # enough to suppress translation of that prose.
    assert not any(i.get('display_math') for i in _piecewise_items([brace,cases,paragraph]))
