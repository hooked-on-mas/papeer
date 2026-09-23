from pathlib import Path
import json
import tempfile
import unittest

import pymupdf as fitz

from paperdesk.pdf.pdf_engine import extract_pdf, translation_units
from tools.review_translation_layout import rebuild


class ReviewInventoryTests(unittest.TestCase):
    def test_partial_and_missing_outputs_are_both_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            papers = root / "papers"
            partial = papers / "partial"
            partial.mkdir(parents=True)
            (papers / "missing").mkdir()
            with fitz.open() as pdf:
                pdf.new_page().insert_text((40, 80), "A translated paper paragraph.")
                pdf.save(partial / "original.pdf")
            document = extract_pdf(partial / "original.pdf")
            (partial / "document.json").write_text(json.dumps(document), "utf-8")
            cache = {"translations": {u["id"]: "論文の本文です。" for u in translation_units(document)}}
            (partial / "translation-cache.json").write_text(json.dumps(cache), "utf-8")
            reports = rebuild(papers, root / "review")
            self.assertEqual(set(reports), {"partial", "missing"})
            self.assertTrue(reports["missing"]["error"])
            self.assertEqual(reports["partial"]["review_source"], "partial/cache")
            self.assertTrue((root / "review" / "partial.pdf").exists())
