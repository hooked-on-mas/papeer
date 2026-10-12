from pathlib import Path
import tempfile
import unittest

import pymupdf as fitz

from papeer.pdf.pdf_engine import build_translated_pdf, extract_pdf, translation_units
from papeer.pdf.pdf_typography import FONT_DIRECTORY, TextStyle, first_line_indented, heading_space, merge_wrapped_headings, reading_space, running_headers, text_style, text_html


class TypographyTests(unittest.TestCase):
    def test_lettered_subsections_use_heading_typography(self):
        for text in ("A. Partitioning scheme", "B. Problem formulation"):
            block = dict(text=text, bbox=[40, 90, 180, 101], font_size=10, formulas=[])
            self.assertEqual(text_style(block, 10, 792).role, "subsection")
        for label in ("I.", "V.", "X.", "III."):
            block = dict(text=label + " Uncertainty partitioning", bbox=[40, 90, 280, 101],
                         font_size=10, formulas=[])
            self.assertEqual(text_style(block, 10, 792).role, "section")

    def test_wrapped_paper_title_is_sent_as_one_phrase(self):
        lines = ['Uncertainty Partitioning with Probabilistic',
                 'Feasibility and Performance Guarantees for',
                 'Chance-Constrained Optimization']
        blocks = [dict(id=f't{i}', page=1, kind='text', font_size=18,
                       text=line, bbox=[60 if i < 2 else 110, 80 + i*24,
                                        540 if i < 2 else 490, 105 + i*24])
                  for i, line in enumerate(lines)]
        author = dict(id='author', page=1, kind='text', font_size=11,
                      text='Alice Smith and Bob Jones', bbox=[200, 164, 400, 180])
        merged = merge_wrapped_headings(blocks + [author], {1: 792})
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]['translation_text'], ' '.join(lines))
        self.assertEqual(merged[0]['heading_parts'], ['t0', 't1', 't2'])
        document = dict(blocks=merged)
        self.assertEqual(translation_units(document)[0]['text'], ' '.join(lines))
        self.assertEqual(merged[1], author)
        # PDF extractors can also put all three lines in a single block.
        single = dict(blocks[0], text='\n'.join(lines), bbox=[60, 80, 540, 153])
        normalized = merge_wrapped_headings([single], {1: 792})[0]
        self.assertEqual(normalized['translation_text'], ' '.join(lines))
        self.assertEqual(normalized['text'], '\n'.join(lines))
        self.assertNotIn('translation_text', single)
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'title.pdf'
            with fitz.open() as pdf:
                page = pdf.new_page(width=600, height=792)
                for i, line in enumerate(lines):
                    width = fitz.get_text_length(line, fontsize=18)
                    page.insert_text(((600-width)/2, 100+i*27), line, fontsize=18)
                page.insert_text((200, 190), author['text'], fontsize=11)
                pdf.save(source)
            extracted = extract_pdf(source)
            units = translation_units(extracted)
            self.assertEqual(len(units), 2)
            self.assertEqual(units[0]['text'], ' '.join(lines))
            self.assertEqual(units[1]['text'], author['text'])

    def test_centered_heading_continuation_is_one_translation_unit(self):
        first = dict(id='h', page=1, kind='text', bbox=[40, 100, 300, 110],
                     text='V. DISCUSSION ON THE RESULTS AND PRACTICAL', font_size=10)
        tail = dict(id='t', page=1, kind='text', bbox=[120, 114, 220, 124],
                    text='IMPLEMENTATION', font_size=10)
        merged = merge_wrapped_headings([first, tail])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]['translation_text'], first['text'] + ' ' + tail['text'])
        self.assertEqual(merged[0]['bbox'], [40, 100, 300, 124])
        self.assertEqual(text_style(merged[0], 10, 700).role, 'section')
        self.assertNotIn('heading_parts', first)
        for changes in (dict(text='The results are discussed below.'), dict(page=2),
                        dict(font_size=8), dict(bbox=[330, 114, 430, 124]),
                        dict(bbox=[120, 130, 220, 140]), dict(text='VI. CONCLUSIONS'),
                        dict(kind='figure')):
            with self.subTest(changes=changes):
                self.assertEqual(len(merge_wrapped_headings([first, dict(tail, **changes)])), 2)

    def test_split_heading_extraction_and_legacy_render(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.pdf'
            lines = ['V. DISCUSSION ON THE RESULTS AND PRACTICAL', 'IMPLEMENTATION']
            with fitz.open() as pdf:
                page = pdf.new_page(width=400, height=500)
                blocks = []
                for index, text in enumerate(lines):
                    width = fitz.get_text_length(text, fontname='helv', fontsize=10)
                    x, y = (400 - width) / 2, 100 + index * 17
                    page.insert_text((x, y), text, fontsize=10)
                    blocks.append(dict(id=f'h{index}', page=1, kind='text', font_size=10,
                                       text=text, bbox=[x, y-10.75, x+width, y+2.99]))
                pdf.save(source)
            extracted = extract_pdf(source)
            self.assertEqual(len(extracted['blocks']), 1)
            self.assertIn('IMPLEMENTATION', extracted['blocks'][0]['translation_text'])
            document = dict(title='Wrapped heading', page_count=1, pages=[dict(number=1, height=500)], blocks=blocks)
            destination = root / 'out.pdf'
            build_translated_pdf(source, document, {'h0': 'V. 結果と実際の', 'h1': '実装に関する考察'}, destination)
            with fitz.open(destination) as pdf:
                spans = [s for b in pdf[0].get_text('dict')['blocks'] if b['type'] == 0
                         for line in b['lines'] for s in line['spans']]
                self.assertIn('実装に関する考察', ''.join(s['text'] for s in spans))
                self.assertTrue(all('PapeerHeading' in s['font'] for s in spans))
                self.assertEqual(len({round(s['size'], 2) for s in spans}), 1)

    def test_indent_uses_source_first_line_not_block_or_sentence_start(self):
        source = dict(bbox=[40, 50, 280, 90], font_size=10,
                      regions=[[50, 50, 280, 62], [40, 65, 280, 77]])
        self.assertTrue(first_line_indented(source))
        # Continuations after equations, ordinary splits, and page breaks all
        # start flush left, even if the Japanese translator starts a sentence.
        for text in ('where C is the output matrix', 'of the hyper-rectangles',
                     'constrained optimization', 'Hence, the optimal solution'):
            continuation = dict(source, text=text,
                                regions=[[40, 50, 280, 62], [40, 65, 280, 77]])
            self.assertFalse(first_line_indented(continuation))
        self.assertFalse(first_line_indented(dict(source, paragraph_continuation=True)))
        self.assertFalse(first_line_indented(dict(source, regions=[])))
        # Whole-block indentation is already present in the placement box.
        self.assertFalse(first_line_indented(dict(source, bbox=[50, 50, 280, 62],
                                                 regions=[[50, 50, 280, 62]])))

    def test_inline_math_fragments_do_not_create_an_indent(self):
        source = dict(bbox=[40, 48, 280, 90], font_size=10,
                      regions=[[90, 48, 100, 65], [40, 52, 88, 64],
                               [102, 52, 280, 64], [40, 68, 280, 80]])
        self.assertFalse(first_line_indented(source))

    def test_translated_newlines_do_not_invent_paragraph_indentation(self):
        style = TextStyle('body', 10, 1.4)
        text = '\n最初の文。\n続きの文。'
        self.assertNotIn('text-indent:1em', text_html(text, style, {}))
        self.assertEqual(text_html(text, style, {}, first_indent=True).count('text-indent:1em'), 1)
        self.assertNotIn('text-indent:1em', text_html(text, TextStyle('section', 12, 1.2), {}, first_indent=True))

    def test_render_recovers_indent_geometry_for_legacy_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.pdf'
            with fitz.open() as pdf:
                page = pdf.new_page(width=300, height=400)
                page.insert_text((50, 70), 'A new paragraph starts here', fontsize=10)
                page.insert_text((40, 85), 'and continues on this line.', fontsize=10)
                page.insert_text((40, 150), 'where the previous text continues', fontsize=10)
                page.insert_text((40, 165), 'without a paragraph break.', fontsize=10)
                pdf.save(source)
            blocks = [dict(id='start', page=1, kind='text', bbox=[40, 58, 260, 90],
                           text='A new paragraph starts here and continues on this line.', font_size=10),
                      dict(id='tail', page=1, kind='text', bbox=[40, 138, 260, 170],
                           text='where the previous text continues without a paragraph break.', font_size=10)]
            doc = dict(title='Indent', page_count=1, pages=[dict(number=1, height=400)], blocks=blocks)
            build_translated_pdf(source, doc, {'start': '新しい段落。\nその続き。',
                                              'tail': '前からの続き。\nさらに続く。'}, root / 'out.pdf')
            with fitz.open(root / 'out.pdf') as pdf:
                lines = [line for item in pdf[0].get_text('dict')['blocks'] if item['type'] == 0
                         for line in item['lines']]
                positions = {''.join(s['text'] for s in line['spans']): line['bbox'][0] for line in lines}
                self.assertAlmostEqual(positions['新しい段落。'] - positions['その続き。'], 10, delta=.2)
                self.assertAlmostEqual(positions['前からの続き。'], positions['さらに続く。'], delta=.2)
            self.assertTrue(all('regions' not in b for b in blocks))

    def test_prominent_title_after_cover_sheet_keeps_title_style(self):
        title = dict(page=2, bbox=[60,60,550,140], font_size=24,
                     text='A General Method for Systems With Several Sources of Uncertainty')
        self.assertEqual(text_style(title,10,792).role,'title')
        header = dict(title, bbox=[40,30,550,40], font_size=8,
                      text='Journal of General Research, volume 12')
        self.assertEqual(text_style(header,10,792).role,'footer')

    def test_top_header_borrows_only_a_small_clear_space_above(self):
        header = dict(id="header", bbox=[40, 30, 550, 38])
        style = TextStyle("footer", 8, 1.2)
        bounds = fitz.Rect(0, 0, 600, 800)
        expanded = reading_space(header, style, [header], bounds, [])
        self.assertEqual(tuple(expanded), (40, 27, 550, 38))
        rule = fitz.Rect(40, 27, 550, 27)
        blocked = reading_space(header, style, [header], bounds, [rule])
        self.assertEqual(blocked.y0, 29)
        footer = dict(header, bbox=[40, 760, 550, 768])
        self.assertEqual(reading_space(footer, style, [footer], bounds, []), fitz.Rect(footer["bbox"]))

    def test_equation_lead_in_uses_column_width_but_stops_at_same_row_content(self):
        lead = {"id": "lead", "bbox": [40, 100, 120, 112], "text": "for all x", "font_size": 10}
        body = {"id": "body", "bbox": [40, 125, 280, 180], "text": "Paragraph. " * 20, "font_size": 10}
        bounds = fitz.Rect(0, 0, 600, 700)
        style = TextStyle("body", 10, 1.4)
        space = reading_space(lead, style, [lead, body], bounds, [])
        self.assertEqual(space.x1, 280)
        blocked = reading_space(lead, style, [lead, body], bounds, [fitz.Rect(180, 99, 250, 115)])
        self.assertEqual(blocked.x1, 177)
        other_column = dict(body, bbox=[310, 125, 550, 180])
        self.assertEqual(reading_space(lead, style, [lead, other_column], bounds, []).x1, 120)
        # Formula-dense pages may have only a short prose paragraph much lower down.
        distant = dict(body, bbox=[40, 400, 280, 425], text="An introductory paragraph. " * 3)
        self.assertEqual(reading_space(lead, style, [lead, distant], bounds, []).x1, 280)

    def test_overlapping_translated_fragments_share_layout_without_mutating_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            with fitz.open() as pdf:
                page = pdf.new_page(width=300, height=300)
                page.insert_text((40, 65), "A short fragment", fontsize=10)
                page.insert_text((130, 65), "and the continuation", fontsize=10)
                pdf.save(source)
            blocks = [dict(id="a", page=1, kind="text", bbox=[40, 50, 120, 67],
                           text="A short fragment", font_size=10, formulas=[]),
                      dict(id="b", page=1, kind="text", bbox=[41, 52, 260, 80],
                           text="and the continuation", font_size=10, formulas=[])]
            document = dict(title="Fragments", page_count=1, pages=[dict(number=1, height=300)], blocks=blocks)
            translations = {"a": "最初の断片。", "b": "続きの文章。"}
            build_translated_pdf(source, document, translations, root / "out.pdf")
            with fitz.open(root / "out.pdf") as pdf:
                text = pdf[0].get_text()
                self.assertEqual(text.count("最初の断片。"), 1)
                self.assertEqual(text.count("続きの文章。"), 1)
            self.assertEqual(blocks[0]["bbox"], [40, 50, 120, 67])
            self.assertEqual(translations["a"], "最初の断片。")

    def test_long_first_page_title_keeps_heading_typography(self):
        block = {"page": 1, "bbox": [120, 170, 490, 240], "font_size": 17,
                 "text": "A Unifying Framework to Uncertainty Quantification of Polynomial Systems Subject to Aleatory and Epistemic Uncertainty"}
        self.assertEqual(text_style(block, 11, 792).role, "title")

    def test_repeated_body_sized_running_title_is_not_section(self):
        blocks = [{"id": str(p), "page": p, "bbox": [40, 60, 550, 73], "font_size": 10,
                   "text": f"{96+p} Crespo, Giesy, Kenny, Framework for uncertainty quantification"} for p in (2, 4)]
        section = dict(blocks[0], id="section", text="2 Problem formulation")
        document = {"pages": [{"number": p, "height": 792} for p in (2, 4)], "blocks": blocks + [section]}
        result = running_headers(document)
        self.assertEqual(text_style(result[0], 10, 792).role, "footer")
        self.assertEqual(text_style(result[2], 10, 792).role, "section")
        self.assertNotIn("running_header", blocks[0])

    def test_small_all_caps_paper_title_is_not_body_or_author(self):
        block = {"id": "title", "page": 1, "bbox": [130, 150, 482, 188], "font_size": 9.96,
                 "text": "GENERALIZED ADAPTIVE PARTITION-BASED METHOD FOR TWO-STAGE STOCHASTIC PROGRAMS WITH FIXED RECOURSE"}
        self.assertEqual(text_style(block, 10, 792).role, "title")
        self.assertNotEqual(text_style(dict(block, page=2), 10, 792).role, "title")
        self.assertNotEqual(text_style(dict(block, text="CRISTIAN RAMIREZ-PICO AND EDUARDO MORENO"), 10, 792).role, "title")

    def test_numbered_running_author_header_is_not_a_section(self):
        block = {"page": 2, "bbox": [126, 78, 485, 86], "font_size": 7.97,
                 "text": "2 CRISTIAN RAMIREZ-PICO AND EDUARDO MORENO"}
        self.assertEqual(text_style(block, 10, 792).role, "footer")
        journal = dict(block, font_size=9, text="900 CSEE JOURNAL OF POWER AND ENERGY SYSTEMS, VOL. 9, NO. 3, MAY 2023")
        self.assertEqual(text_style(journal, 8.8, 792).role, "footer")

    def test_paragraphs_share_blank_gap_without_touching_figures(self):
        a = {"id": "a", "bbox": [40, 50, 280, 65]}
        b = {"id": "b", "bbox": [40, 85, 280, 100]}
        style = TextStyle("body", 10, 1.4)
        bounds = fitz.Rect(0, 0, 600, 700)
        figure = fitz.Rect(40, 110, 280, 200)
        first = reading_space(a, style, [a, b], bounds, [figure])
        second = reading_space(b, style, [a, b], bounds, [figure])
        self.assertGreater(first.height, 15)
        self.assertLess(first.y1, second.y0)
        self.assertLess(second.y1, figure.y0)

    def test_short_formula_parenthesis_stays_together(self):
        token = "[[PD_MATH_p1b7_123]]"
        markup = text_html("確率空間（Ω" + token + "）を考える。", TextStyle("body", 10, 1.4), {token: '<img src="formula.png">'})
        self.assertIn('nowrap">（Ω<img src="formula.png">）</span>', markup)

    def test_numbered_heading_expands_within_its_column(self):
        heading = {"id": "h", "bbox": [40, 90, 150, 101], "text": "2 Controller Design", "font_size": 10}
        body = {"id": "b", "bbox": [40, 110, 275, 260], "text": "A paragraph of the paper. " * 10}
        other_column = {"id": "r", "bbox": [310, 70, 570, 280], "text": "Another column. " * 10}
        previous = {"id": "p", "bbox": [40, 40, 275, 76], "text": "Previous paragraph."}
        style = text_style(heading, 10, 700)
        rect = heading_space(heading, style, [heading, body, other_column, previous], fitz.Rect(0, 0, 600, 700))
        self.assertEqual(style.role, "section")
        self.assertEqual(rect.x1, 275)
        self.assertGreater(rect.height, 11)
        self.assertGreaterEqual(rect.y0, 79)
        self.assertLess(rect.y1, body["bbox"][1])

    def test_run_in_subsection_keeps_body_typography(self):
        block = {"bbox": [40, 90, 275, 120], "text": "3.1 Methodology. Let a stochastic dynamical system be expressed in the form",
                 "font_size": 10}
        self.assertEqual(text_style(block, 10, 700), TextStyle("runin", 10, 1.4))

    def test_embedded_japanese_faces_and_larger_heading_survive_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            with fitz.open() as pdf:
                page = pdf.new_page(width=600, height=700)
                page.insert_text((40, 100), "2 Controller Design", fontname="hebo", fontsize=10)
                page.insert_textbox(fitz.Rect(40, 115, 275, 250), "We study the behavior of an uncertain linear system. " * 6,
                                    fontname="tiro", fontsize=10)
                pdf.save(source)
            document = extract_pdf(source)
            translations = {b["id"]: "2 制御器の設計" if "Controller Design" in b["text"] else
                            "不確かな線形システムの挙動を調べる。状態と制御入力の制約を満たす制御器を設計する。"
                            for b in document["blocks"]}
            destination = root / "translated.pdf"
            build_translated_pdf(source, document, translations, destination)
            with fitz.open(destination) as pdf:
                self.assertEqual(pdf.page_count, 1)
                spans = [s for b in pdf[0].get_text("dict")["blocks"] if b["type"] == 0 for line in b["lines"] for s in line["spans"]]
                headings = [s for s in spans if "PapeerHeading" in s["font"]]
                body = [s for s in spans if "PapeerSerif" in s["font"]]
                self.assertTrue(headings)
                self.assertTrue(body)
                self.assertGreater(min(s["size"] for s in headings), max(s["size"] for s in body) * 1.2)
                self.assertIn("制御器の設計", pdf[0].get_text())
                self.assertLess(destination.stat().st_size, 2_000_000)
        for family in ("source-han-serif", "source-han-sans"):
            self.assertIn("SIL OPEN FONT LICENSE", (FONT_DIRECTORY / (family + "-LICENSE.txt")).read_text("utf-8"))
