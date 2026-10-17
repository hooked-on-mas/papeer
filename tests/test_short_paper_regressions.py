"""Regressions found by comparing the installed library's rendered papers."""
from types import SimpleNamespace
from unittest.mock import patch

import pymupdf as fitz

from papeer.layout.math_layout import annotate_math_fonts, layout_blocks, merge_inline_items, _merge_inline_fragments, _math_ranges, _prose_words
from papeer.layout.reference_layout import mark_references
from papeer.pdf.pdf_math_crops import formula_crop, tighten_type3_geometry, _outline_bounds
from papeer.pdf.pdf_typography import merge_wrapped_headings, text_style, text_html, TextStyle, FONT_CSS, font_archive
from papeer.pdf.pdf_engine import extract_pdf


def test_detached_operator_limits_travel_with_the_inline_formula():
    def span(text, x, y, size=10, math=False, height=8):
        return dict(font="CMEX10" if math else "Times-Roman", flags=0, size=size, math_font=math,
                    bbox=[x, y-height, x+len(text)*5, y+2],
                    chars=[dict(c=c, origin=(x+i*5, y), bbox=[x+i*5, y-height, x+i*5+5, y+2])
                           for i, c in enumerate(text)])
    def line(spans):
        box=fitz.Rect(spans[0]['bbox'])
        for s in spans[1:]:box |= fitz.Rect(s['bbox'])
        return dict(bbox=list(box),spans=spans)
    main=line([span("Failure probability ",40,100),span("^",140,100,math=True,height=20)])
    top=line([span("N",140,85,size=7,math=True,height=5)])
    bottom=line([span("i=1",140,110,size=7,math=True,height=7)])
    items=[dict(type=0,bbox=l['bbox'],lines=[l]) for l in (main,top,bottom)]
    blocks=[b for index,item in enumerate(merge_inline_items(items)) for b in layout_blocks(item,1,index)]
    assert len(blocks)==1 and blocks[0]['kind']=='text'
    assert all(c in blocks[0]['formulas'][0]['text'] for c in ('^','N','i=1'))


def test_fraction_descent_reserves_space_above_the_next_text_row():
    token='[[PD_MATH_p1b1_0]]'
    text='value '+token+' next next next next next next next next next next'
    archive=font_archive(text)
    pix=fitz.Pixmap(fitz.csRGB,fitz.IRect(0,0,35,21),False);pix.clear_with(0)
    archive.add((pix.tobytes('png'),'fraction.png'))
    markup=text_html(text,TextStyle('body',10,1.4),{
        token:'<img src="fraction.png" style="width:3.5em;height:2.1em;vertical-align:-.8em">'})
    with fitz.open() as pdf:
        page=pdf.new_page()
        page.insert_htmlbox(fitz.Rect(40,40,145,250),markup,archive=archive,css=FONT_CSS)
        image=fitz.Rect(page.get_image_info()[0]['bbox'])
        following=[fitz.Rect(l['bbox']) for b in page.get_text('dict')['blocks'] if b['type']==0
                   for l in b['lines'] if l['bbox'][1] > image.y0+10]
        assert following and min(r.y0 for r in following) > image.y1
    with fitz.open() as pdf:
        page=pdf.new_page()
        rect=fitz.Rect(40,40,240,70)
        last=text_html('value '+token,TextStyle('body',10,1.4),{
            token:'<img src="fraction.png" style="width:3.5em;height:2.1em;vertical-align:-.8em">'})
        page.insert_htmlbox(rect,last,archive=archive,css=FONT_CSS)
        assert fitz.Rect(page.get_image_info()[0]['bbox']).y1 < rect.y1


def test_bitmap_rules_protect_the_entire_table_header(tmp_path):
    path = tmp_path / "image-rules.pdf"
    with fitz.open() as pdf:
        page = pdf.new_page(width=420, height=420)
        pixel = fitz.Pixmap(fitz.csGRAY, fitz.IRect(0, 0, 1, 1), False)
        pixel.clear_with(0)
        xref = page.insert_image(fitz.Rect(40, 70, 370, 70.8), pixmap=pixel)
        pdf.xref_set_key(xref, "BitsPerComponent", "1")
        pdf.update_stream(xref, b"\0")
        for y in (100, 160): page.insert_image(fitz.Rect(40, y, 370, y + .8), xref=xref)
        for y, row in [(90, ("Degree", "Error")), (120, ("First", "0.001")), (145, ("Second", "0.0006"))]:
            for x, value in zip((50, 230), row): page.insert_text((x, y), value, fontsize=10)
        page.insert_text((40, 185), "Table I: Approximation errors", fontsize=10)
        pdf.save(path)
    document = extract_pdf(path)
    table = next(b for b in document["blocks"] if b["kind"] == "table")
    assert "Degree" in table["text"] and "Error" in table["text"]
    assert table["bbox"][1] < 71
    assert all("Table I" not in b["text"] for b in document["blocks"] if b["kind"] == "table")


def test_increment_and_the_whole_numeric_interval_are_math():
    chars = [dict(c=c, font="Times-Roman", flags=0, size=10, math_font=False,
                  origin=(i * 5, 100), bbox=(i * 5, 90, i * 5 + 5, 102))
             for i, c in enumerate("∆2a >= 0; [0, 1]")]
    chars[11]["math_font"] = True  # Only the zero has a mathematical font.
    ranges = _math_ranges(chars)
    assert any(a == 0 for a, _ in ranges)
    assert any(a <= 10 and b >= 16 for a, b in ranges)


def test_compact_article_title_is_one_translation_unit_after_references():
    def block(identity, text, box):
        return dict(id=identity, text=text, translation_text=text, page=6, bbox=box,
                    kind="text", font_size=10, formulas=[], bold_heading=True)
    blocks = [block("a", "Vector Measures of Accuracy for Sampled", [320, 250, 550, 260]),
              block("b", "Data Models of Nonlinear Systems", [340, 262, 530, 272])]
    merged = merge_wrapped_headings(blocks, {6: 792})
    assert len(merged) == 1
    assert " ".join(merged[0]["text"].split()) == "Vector Measures of Accuracy for Sampled Data Models of Nonlinear Systems"
    assert text_style(merged[0], 10, 792).role == "title"


def test_large_inline_symbol_uses_the_prose_baseline():
    def span(text, x, size=10, y=100, math=False):
        return dict(font="Symbol" if math else "Times-Roman", flags=0, size=size, math_font=math,
                    chars=[dict(c=c, origin=(x + i * 5, y), bbox=(x + i * 5, y - 8, x + i * 5 + 5, y + 3))
                           for i, c in enumerate(text)])
    spans = [span("The value ", 40), span("x", 90, 12, 92, True), span(" is measured.", 96)]
    blocks = layout_blocks(dict(lines=[dict(bbox=[40, 84, 166, 103], spans=spans)]), 1, 1)
    formula = next(f for b in blocks for f in b["formulas"])
    assert formula["baseline"] == 100


def test_lowercase_continuation_of_a_prominent_title_is_joined():
    def block(identity, text, box, size):
        return dict(id=identity, text=text, translation_text=text, page=1, bbox=box,
                    kind="text", font_size=size, formulas=[])
    blocks = [block("a", "An inequality involving Bernstein polynomials and", [50, 80, 450, 100], 20),
              block("b", "convex functions", [150, 102, 350, 122], 20),
              block("body", "The body of the paper explains the result and its proof. " * 5,
                    [50, 250, 450, 320], 10)]
    merged = merge_wrapped_headings(blocks, {1: 792})
    assert len(merged) == 2
    assert "convex functions" in merged[0]["text"]


def test_type1_trace_ids_follow_freetype_notdef_swap():
    class Glyph:
        def __init__(self, right): self.right = right
        def draw(self, pen):
            pen.moveTo((0, 0)); pen.lineTo((self.right, 10)); pen.endPath()
    class Font:
        def getGlyphSet(self): return {"integral": Glyph(25), "paren": Glyph(12), ".notdef": Glyph(0)}
        def __getitem__(self, key): return [.001, 0, 0, .001, 0, 0]
    with patch("papeer.pdf.pdf_math_crops.t1Lib.T1Font", Font):
        bounds = _outline_bounds.__wrapped__(b"embedded subset")
    assert bounds[0][2] == 0
    assert bounds[1][2] == 12
    assert bounds[2][2] == 25


def test_empty_math_space_cannot_attach_a_formula_to_the_next_prose_row():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 100), "x + y", fontname="tiit", fontsize=10)
        page.insert_text((40, 112), "The next sentence stays separate.", fontsize=10)
        items = page.get_text("rawdict")["blocks"]
    annotate_math_fonts(items)
    lines = [line for item in items for line in item["lines"]]
    formula = lines[0]
    formula["bbox"] = [40, 90, 80, 118]
    formula["spans"].append(dict(font="CMSY10", flags=0, size=10, math_font=True,
                                  chars=[dict(c=" ", origin=(60, 100), bbox=(60, 90, 62, 118))]))
    rows = _merge_inline_fragments(lines)
    assert len(rows) == 2


def test_large_bullet_does_not_turn_requirements_into_display_math():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 100), "r", fontname="symb", fontsize=12)
        page.insert_text((52, 100), "Capture the rich nonlinear bucket-soil dynamics;", fontsize=10)
        items = page.get_text("rawdict")["blocks"]
    annotate_math_fonts(items)
    blocks = [b for item in merge_inline_items(items) for b in layout_blocks(item, 1, 1)]
    requirement = next(b for b in blocks if "Capture" in b["text"])
    assert requirement["kind"] == "text"
    assert "Capture the rich nonlinear" in requirement["translation_text"]


def test_variance_and_short_italic_products_stay_display_math():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 100), "Var(x) + Cov(x,y) = 0", fontsize=10)
        page.insert_text((40, 150), "(1 + xz)(1 + yz)", fontname="tiit", fontsize=10)
        items = page.get_text("rawdict")["blocks"]
    annotate_math_fonts(items)
    blocks = [b for item in items for b in layout_blocks(item, 1, 1)]
    assert all(b["kind"] == "formula" for b in blocks)


def test_long_roman_subscripts_and_piecewise_nan_stay_math():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 100), "x", fontname="tiit", fontsize=10)
        page.insert_text((45, 103), "telescope", fontsize=7.5)
        page.insert_text((40, 150), "NaN, else.", fontsize=10)
        page.insert_text((40, 180), "PID(x)", fontsize=10)
        items = page.get_text("rawdict")["blocks"]
    annotate_math_fonts(items)
    blocks = [b for item in items for b in layout_blocks(item, 1, 1)]
    assert blocks[0]["kind"] == "formula"
    assert all(not _prose_words(line) for item in items for line in item["lines"])


def test_detached_named_script_and_upright_membership_set_are_preserved():
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 100), "a", fontname="tiit", fontsize=10)
        page.insert_text((45, 95), "target", fontsize=7)
        items = page.get_text("rawdict")["blocks"]
    # Times Italic is not an explicit math subset: identify the base for this
    # synthetic fixture as a publisher's CMMI font.
    items[0]["lines"][0]["spans"][0]["font"] = "CMMI10"
    annotate_math_fonts(items)
    assert all(s["math_font"] for i in items for l in i["lines"] for s in l["spans"])
    text = "s ∈Rns"
    chars = [dict(c=c, font="Times-Roman", flags=0, size=7 if i > 3 else 10,
                  math_font=False, origin=(40+i*5, 100), bbox=(40+i*5, 90, 45+i*5, 102))
             for i,c in enumerate(text)]
    assert any(a <= 2 and b == len(text) for a,b in _math_ranges(chars))


def test_math_prefix_wraps_to_its_own_row_instead_of_interleaving_prose_above():
    # An exaggerated script box overlaps the next row, as in Type 1 subsets.
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((40, 100), "The preceding sentence stays intact.", fontsize=10)
        page.insert_text((40, 112), "x", fontname="tiit", fontsize=10)
        page.insert_text((48, 112), " satisfies the constraints.", fontsize=10)
        items = page.get_text("rawdict")["blocks"]
    annotate_math_fonts(items)
    # Put the math prefix in the preceding PDF item, the sentence tail in
    # another. This arrangement must not imply that the prefix is row one.
    lines = [line for item in items for line in item["lines"]]
    second = lines[-1]
    prefix = dict(second, spans=[second["spans"][0]], bbox=second["spans"][0]["bbox"])
    tail = dict(second, spans=second["spans"][1:], bbox=second["spans"][1]["bbox"])
    items = [dict(type=0, bbox=[40, 88, 240, 120], lines=[lines[0], prefix]),
             dict(type=0, bbox=list(tail["bbox"]), lines=[tail])]
    blocks = [b for item in merge_inline_items(items) for b in layout_blocks(item, 1, 1)]
    text = "\n".join(b["text"] for b in blocks)
    assert "The preceding sentence stays intact." in text
    assert "x satisfies the constraints." in text


def test_tall_type1_operator_geometry_covers_ink_outside_declared_box():
    char = dict(c="∫", origin=(40, 100), bbox=(40, 99, 45, 110))
    span = dict(font="MTEX", size=10, flags=0, math_font=True, chars=[char])
    item = dict(type=0, bbox=char["bbox"], lines=[dict(bbox=char["bbox"], spans=[span], dir=(1, 0))])
    page = SimpleNamespace(get_fonts=lambda: [(1, "pfa", "Type1", "MTEX")])
    with patch("papeer.pdf.pdf_math_crops.page_glyph_bounds", return_value={(40, 100): fitz.Rect(40, 100, 49, 123)}):
        tighten_type3_geometry(page, [item])
    assert item["bbox"] == (40, 100, 49, 123)
    crop = formula_crop(dict(bbox=(40, 99, 45, 110), glyph_origins=[(40, 100)]),
                        {(40, 100): fitz.Rect(40, 100, 49, 123)})
    assert crop.x1 > 49 and crop.y1 > 123


def test_new_article_title_ends_reference_range_on_same_page():
    def block(identity, text, y, size=8):
        return dict(id=identity, text=text, page=1, bbox=[40, y, 280, y + 12], kind="text", font_size=size)
    blocks = [block("h", "REFERENCES", 50),
              block("r", '[1] A. Smith, "Control", IEEE Transactions, 2020.', 70),
              block("title", "Accuracy of Sampled Data Models", 110, 11),
              block("author", "A. Smith, B. Jones, and C. Brown, Fellow, IEEE", 130, 9),
              block("body", 'We discuss the question, “Accuracy in what sense?”.', 150, 9),
              block("note", "Manuscript received May 17, 2011; accepted May 20, 2012.", 180)]
    mark_references(dict(blocks=blocks, pages=[dict(number=1, width=600)]))
    assert [b["id"] for b in blocks if b["kind"] == "reference"] == ["h", "r"]
