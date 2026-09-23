from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import pymupdf as fitz

from paperdesk.pdf.pdf_engine import build_translated_pdf, extract_pdf, translation_units
from paperdesk.layout.table_layout import separate_tables, table_regions


def make_table(path, horizontal_only=False, rotation=0):
    with fitz.open() as pdf:
        page = pdf.new_page(width=420, height=420)
        page.insert_text((40, 45), "Table 1. Experimental results")
        for y in (70, 100, 130, 160):
            page.draw_line((40, y), (370, y))
        if not horizontal_only:
            for x in (40, 150, 260, 370):
                page.draw_line((x, 70), (x, 160))
        for y, row in zip((90, 120, 150),
                          (("Method", "Accuracy", "Time"),
                           ("Baseline", "0.85", "12"),
                           ("Proposed", "0.97", "8"))):
            for x, value in zip((50, 160, 270), row):
                page.insert_text((x, y), value)
        page.insert_text((40, 195), "Our proposed method improves the results.")
        page.set_rotation(rotation)
        pdf.save(path)


class TableLayoutTests(unittest.TestCase):
    def test_filled_segmented_rules_do_not_swallow_two_column_prose(self):
        for rotation in (0, 90):
            with self.subTest(rotation=rotation), tempfile.TemporaryDirectory() as tmp:
                source = Path(tmp) / "source.pdf"
                with fitz.open() as pdf:
                    page = pdf.new_page(width=600, height=800)
                    # Two stacked column tables and a wide table below the body.
                    # Rules are filled rectangles; header rules are overlapping
                    # segments, as in publisher PDFs rather than stroked lines.
                    for index, (top, bottom, right) in enumerate(
                            ((100, 165, 280), (200, 285, 280), (520, 650, 550)), 1):
                        page.insert_text((70, top - 10), f"Table {index}. Control points", fontsize=9)
                        for y in (top, top + 2.5, bottom - 2.5, bottom):
                            page.draw_rect(fitz.Rect(50, y, right, y + .5), color=None, fill=(0, 0, 0))
                        step = (right - 50) / 5
                        for col in range(5):
                            left = 50 + col * step
                            page.draw_rect(fitz.Rect(left, top + 18, min(right, left + step + 10), top + 18.5),
                                           color=None, fill=(0, 0, 0))
                            for row, y in enumerate((top + 13, top + 32, bottom - 10)):
                                page.insert_text((left + 3, y), f"{col}.{row}00", fontsize=8)
                    for y in (110, 125, 140, 220, 235, 250, 330, 345):
                        page.insert_text((315, y), "This is the kinetic and potential energy.", fontsize=9)
                    for y in (330, 345, 360):
                        page.insert_text((50, y), "The residual energy is a quadratic term.", fontsize=9)
                    page.set_rotation(rotation)
                    pdf.save(source)
                document = extract_pdf(source)
                tables = [b for b in document["blocks"] if b["kind"] == "table"]
                self.assertEqual(len(tables), 3)
                self.assertTrue(all("energy" not in b["text"] and "Table" not in b["text"] for b in tables))
                units = translation_units(document)
                text = " ".join(u["text"] for u in units)
                for expected in ("kinetic and potential energy", "residual energy", "Table 1", "Table 2", "Table 3"):
                    self.assertIn(expected, text)

    def test_local_rules_restore_sparse_outer_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.pdf"
            make_table(source, horizontal_only=True)
            with fitz.open(source) as pdf:
                candidate = SimpleNamespace(row_count=3, col_count=2, bbox=(130, 70, 300, 160))
                with patch.object(fitz.Page, "find_tables", return_value=SimpleNamespace(tables=[candidate])):
                    regions = table_regions(pdf[0])
                self.assertEqual(len(regions), 1)
                self.assertLessEqual(regions[0].x0, 40)
                self.assertGreaterEqual(regions[0].x1, 370)

    def test_candidate_that_bisects_prose_words_is_rejected(self):
        with fitz.open() as pdf:
            page = pdf.new_page()
            for y in (50, 70, 90, 110):
                page.insert_text((40, y), "Repeated ordinary prose sentences continue here.")
            candidate = SimpleNamespace(row_count=3, col_count=2, bbox=(55, 30, 160, 120))
            with patch.object(fitz.Page, "find_tables", return_value=SimpleNamespace(tables=[candidate])):
                self.assertEqual(table_regions(page), [])

    def test_shared_block_and_overlapping_redaction(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, output = Path(tmp) / "source.pdf", Path(tmp) / "out.pdf"
            make_table(source)
            with fitz.open(source) as pdf:
                items = pdf[0].get_text("rawdict")["blocks"]
                shared = dict(items[0], lines=[line for item in items for line in item.get("lines", [])])
                prose, tables = separate_tables([shared], table_regions(pdf[0]), 1)
                self.assertEqual(len(tables), 1)
                self.assertGreaterEqual(len(prose), 2)
                self.assertFalse(any(fitz.Rect(line["bbox"]).intersects(fitz.Rect(tables[0]["bbox"]))
                                     for item in prose for line in item["lines"]))
            document = extract_pdf(source)
            table = next(b for b in document["blocks"] if b["kind"] == "table")
            caption = next(b for b in document["blocks"] if "Table 1" in b["text"])
            caption["bbox"][3] = table["bbox"][3]
            build_translated_pdf(source, document, {caption["id"]: "実験結果"}, output)
            with fitz.open(source) as before, fitz.open(output) as after:
                clip = fitz.Rect(table["bbox"])
                self.assertEqual(before[0].get_pixmap(clip=clip).samples,
                                 after[0].get_pixmap(clip=clip).samples)

    def test_tables_preserved_and_prose_translated(self):
        for horizontal_only in (False, True):
            for rotation in (0, 90):
                with self.subTest(horizontal_only=horizontal_only, rotation=rotation), tempfile.TemporaryDirectory() as tmp:
                    source, output = Path(tmp) / "source.pdf", Path(tmp) / "out.pdf"
                    make_table(source, horizontal_only, rotation)
                    document = extract_pdf(source)
                    tables = [b for b in document["blocks"] if b["kind"] == "table"]
                    self.assertEqual(len(tables), 1)
                    units = translation_units(document)
                    self.assertTrue(any("Table 1" in u["text"] for u in units))
                    self.assertTrue(any("improves" in u["text"] for u in units))
                    self.assertFalse(any("Baseline" in u["text"] or "Accuracy" in u["text"] for u in units))
                    translations = {u["block"]: "翻訳された本文です。" for u in units}
                    # Even stale/unexpected translations must not overwrite tables.
                    translations[tables[0]["id"]] = "broken table"
                    report = build_translated_pdf(source, document, translations, output)
                    self.assertEqual(report["preserved_table_blocks"], 1)
                    with fitz.open(source) as before, fitz.open(output) as after:
                        self.assertEqual(after[0].rotation, rotation)
                        self.assertIn("翻訳された本文", after[0].get_text())
                        before[0].set_rotation(0)
                        after[0].set_rotation(0)
                        clip = fitz.Rect(tables[0]["bbox"])
                        self.assertEqual(before[0].get_pixmap(clip=clip).samples,
                                         after[0].get_pixmap(clip=clip).samples)

    def test_prose_is_not_a_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.pdf"
            with fitz.open() as pdf:
                page = pdf.new_page()
                for y in (50, 70, 90, 110):
                    page.insert_text((40, y), "This is ordinary prose with several aligned words.")
                pdf.save(source)
            self.assertFalse(any(b["kind"] == "table" for b in extract_pdf(source)["blocks"]))


if __name__ == "__main__":
    unittest.main()
