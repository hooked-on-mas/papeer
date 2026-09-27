import tempfile
import unittest
from pathlib import Path

import pymupdf as fitz

from papeer.core.bibliography import extract_bibliography, paper_display_name
from papeer.core.storage import Library


class BibliographyTests(unittest.TestCase):
    def test_metadata_and_publication_date(self):
        with fitz.open() as doc:
            doc.new_page().insert_text((72, 72), "Published 2021\nExample paper")
            doc.set_metadata({"author": "Jane Smith; John Doe", "creationDate": "D:20250901"})
            self.assertEqual(extract_bibliography(doc), {"first_author": "Jane Smith", "publication_year": "2021"})
        with fitz.open() as doc:
            doc.new_page()
            doc.set_metadata({"creationDate": "D:20250901"})
            self.assertEqual(extract_bibliography(doc)["publication_year"], "")

    def test_labels(self):
        for author, year, expected in [("Smith", "2021", "Smith (2021) Title"),
                                       ("", "2021", "(2021) Title"),
                                       ("Smith", "", "Smith Title"), ("", "", "Title")]:
            self.assertEqual(paper_display_name(dict(title="Title", first_author=author, publication_year=year)), expected)

    def test_import_migration_and_manual_edits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "paper.pdf"
            with fitz.open() as doc:
                doc.new_page().insert_text((72, 72), "Published 2021\nExample paper")
                doc.set_metadata({"author": "Jane Smith; John Doe"})
                doc.save(source)
            library = Library(root / "library")
            identity, _ = library.import_pdf(source)
            self.assertEqual(library.paper(identity)["first_author"], "Jane Smith")
            with library.connection() as db:
                for name in ("first_author", "publication_year", "bibliography_version"):
                    db.execute(f"ALTER TABLE papers DROP COLUMN {name}")
                db.execute("PRAGMA user_version=0")  # as saved by a version before schema versioning
            library = Library(library.root)
            self.assertEqual(library.paper(identity)["publication_year"], "2021")
            library.update(identity, first_author="山田", publication_year="2020")
            library = Library(library.root)
            self.assertEqual(library.papers("山田")[0]["id"], identity)
            self.assertEqual(library.papers("2020")[0]["id"], identity)
            library.rename_paper(identity, "New title")
            self.assertEqual(paper_display_name(library.paper(identity)), "山田 (2020) New title")
            with self.assertRaises(ValueError):
                library.update(identity, publication_year="abcd")


if __name__ == "__main__":
    unittest.main()
