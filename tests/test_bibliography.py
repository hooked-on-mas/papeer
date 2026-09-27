import tempfile
import unittest
from pathlib import Path

import pymupdf as fitz

from papeer.core.bibliography import (
    clean_arxiv_id, clean_doi, extract_bibliography, extract_identifiers, paper_display_name, typed_doi,
)
from papeer.core.storage import Library
from _legacy_library import mark_unversioned


class BibliographyTests(unittest.TestCase):
    def test_metadata_and_publication_date(self):
        with fitz.open() as doc:
            doc.new_page().insert_text((72, 72), "Published 2021\nExample paper")
            doc.set_metadata({"author": "Jane Smith; John Doe", "creationDate": "D:20250901"})
            self.assertEqual(extract_bibliography(doc), {"first_author": "Jane Smith", "publication_year": "2021",
                                                         "doi": "", "arxiv_id": "", "venue": ""})
        with fitz.open() as doc:
            doc.new_page()
            doc.set_metadata({"creationDate": "D:20250901"})
            self.assertEqual(extract_bibliography(doc)["publication_year"], "")

    def test_identifiers_from_the_first_page(self):
        found = extract_identifiers("arXiv:2101.00001v2  [cs.LG]  4 Jan 2021\n"
                                    "Published as a conference paper at ICLR 2021\nA title\n"
                                    "doi: 10.1145/3292500.3330701, see also 10.9999/other")
        self.assertEqual(found, {"doi": "10.1145/3292500.3330701", "arxiv_id": "2101.00001", "venue": "ICLR 2021"})
        found = extract_identifiers("IEEE TRANSACTIONS ON AUTOMATIC CONTROL, VOL. 60, NO. 5, MAY 2015\nTitle\n"
                                    "Digital Object Identifier 10.1109/TAC.2014.2363123.")
        self.assertEqual(found, {"doi": "10.1109/TAC.2014.2363123", "arxiv_id": "",
                                 "venue": "IEEE Transactions on Automatic Control"})
        self.assertEqual(extract_identifiers("Journal of Machine Learning Research 21 (2020) 1-67\nTitle")["venue"],
                         "Journal of Machine Learning Research")
        self.assertEqual(extract_identifiers("Proceedings of the 2019 Conference on Empirical Methods in Natural "
                                             "Language Processing, pages 1-10")["venue"],
                         "Proceedings of the 2019 Conference on Empirical Methods in Natural Language Processing")
        # Only what is marked as one: a bare number in the text, or a sentence about a journal, is not.
        self.assertEqual(extract_identifiers("We compare 2101.00001 runs.\nOur results in the journal of X agree."),
                         {"doi": "", "arxiv_id": "", "venue": ""})
        # A header line counts only when a volume, pages or a date follows the name, as it does in a header.
        for line, expected in [("Annals of Statistics 2020, Vol. 48", "Annals of Statistics"),
                               ("Proceedings of the 38th International Conference on Machine Learning, PMLR 139, 2021.",
                                "Proceedings of the 38th International Conference on Machine Learning"),
                               ("Physical Review Letters 120, 123456 (2018)", "Physical Review Letters")]:
            self.assertEqual(extract_identifiers(line)["venue"], expected)
        for sentence in ["Letters of recommendation were collected, 2020", "Proceedings of the workshop were informal.",
                         "Journal of Physics", "Review of the literature shows 12, 34 cases"]:
            self.assertEqual(extract_identifiers(sentence)["venue"], "", sentence)
        # A note gives the name without the volume, and none when it names no venue.
        self.assertEqual(extract_identifiers("Published in: IEEE Access ( Volume: 8 )")["venue"], "IEEE Access")
        self.assertEqual(extract_identifiers("Accepted to the main conference.")["venue"], "")
        # The stamp down the side of the paper, not an identifier the text cites before it.
        # The stamp is told by its date: a citation with a bracket after it is not one.
        for cited in ["As in arXiv:1706.03762, attention…", "We use arXiv:1706.03762 [5].",
                      "arXiv: 1706.03762 [cs.CL], 2017."]:
            self.assertEqual(extract_identifiers(f"{cited}\narXiv:2101.00001v2 [cs.LG] 4 Jan 2021")["arxiv_id"],
                             "2101.00001", cited)
        for stamp, expected in [("arXiv:math/0501001v1 3 Jan 2005", "math/0501001"),
                                ("arXiv:math.AG/0501001v1  3  Jan  2005", "math.AG/0501001")]:
            self.assertEqual(extract_identifiers(stamp)["arxiv_id"], expected)
        # Without a stamp: "arXiv:…" under the title, a link to arxiv.org or arXiv's DOI, but not a citation
        # further down the page (nor the year it would give, extract_bibliography).
        body = "Title\nAuthor\nAffiliation\nAbstract\nWe study…\n"
        self.assertEqual(extract_identifiers(body + "as in arXiv:1706.03762")["arxiv_id"], "")
        self.assertEqual(extract_identifiers("Title\narXiv:2203.02155\n" + body)["arxiv_id"], "2203.02155")
        self.assertEqual(extract_identifiers(body + "Code: https://arxiv.org/abs/2203.02155")["arxiv_id"], "2203.02155")
        # An arXiv DOI gives the arXiv ID too.
        self.assertEqual(extract_identifiers("https://doi.org/10.48550/arXiv.2303.08774")["arxiv_id"], "2303.08774")

    def test_identifiers_from_the_pdf_metadata_come_first(self):
        xmp = ('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
               '<rdf:Description xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"'
               ' prism:doi="10.1038/s41586-021-03819-2"><prism:publicationName>Nature</prism:publicationName>'
               '</rdf:Description></rdf:RDF></x:xmpmeta>')
        self.assertEqual(extract_identifiers("doi:10.9999/cited", xmp=xmp),
                         {"doi": "10.1038/s41586-021-03819-2", "arxiv_id": "", "venue": "Nature"})
        found = extract_identifiers("", {"subject": "Automatica, 123 (2021) 109456. doi:10.1016/j.automatica.2020.109456"})
        self.assertEqual(found, {"doi": "10.1016/j.automatica.2020.109456", "arxiv_id": "", "venue": "Automatica"})
        with fitz.open() as doc:
            doc.new_page().insert_text((72, 72), "arXiv:2203.02155v1 [cs.CL] 4 Mar 2022\nTraining language models")
            info = extract_bibliography(doc)
            # The year of the arXiv identifier, when the paper states none.
            self.assertEqual((info["arxiv_id"], info["publication_year"]), ("2203.02155", "2022"))

    def test_cleaning_typed_identifiers(self):
        for typed, expected in [("https://doi.org/10.1016/0021-9991(81)90145-5.", "10.1016/0021-9991(81)90145-5"),
                                ("doi:10.1000/xyz123)", "10.1000/xyz123"), ("10.1000", ""), ("not a doi", "")]:
            self.assertEqual(clean_doi(typed), expected)
        # Typed, a DOI must be whole: what clean_doi would cut short is refused.
        self.assertEqual(typed_doi(" https://doi.org/10.1000/xyz123. "), "10.1000/xyz123")
        self.assertEqual(typed_doi("  "), "")
        for typed in ["10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-O", "10.1000/a b", "10.1000/{x}", "xyz"]:
            with self.assertRaises(ValueError):
                typed_doi(typed)
        for typed, expected in [("arXiv:2101.00001v3", "2101.00001"), ("https://arxiv.org/abs/hep-th/9901001", "hep-th/9901001"),
                                ("https://arxiv.org/pdf/2101.00001v1.pdf", "2101.00001"), ("2101", "")]:
            self.assertEqual(clean_arxiv_id(typed), expected)

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
                doc.new_page().insert_text((72, 72), "Published 2021\nExample paper\ndoi:10.1000/example.7")
                doc.set_metadata({"author": "Jane Smith; John Doe"})
                doc.save(source)
            library = Library(root / "library")
            identity, _ = library.import_pdf(source)
            self.assertEqual(library.paper(identity)["first_author"], "Jane Smith")
            self.assertEqual(library.paper(identity)["doi"], "10.1000/example.7")
            with library.connection() as db:
                for name in ("first_author", "publication_year", "bibliography_version"):
                    db.execute(f"ALTER TABLE papers DROP COLUMN {name}")
                mark_unversioned(db)  # as saved by a version before schema versioning
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
            library.update(identity, doi=" https://doi.org/10.1000/XYZ.1 ", arxiv_id="arXiv:2101.00001v2",
                           venue="  Journal of\n Examples ")
            paper = library.paper(identity)
            self.assertEqual((paper["doi"], paper["arxiv_id"], paper["venue"]), ("10.1000/XYZ.1", "2101.00001", "Journal of Examples"))
            for field, value in [("doi", "xyz"), ("arxiv_id", "12345"), ("venue", "x" * 301)]:
                with self.assertRaises(ValueError):
                    library.update(identity, **{field: value})
            library.update(identity, doi=" ", arxiv_id="", venue="")
            self.assertEqual([library.paper(identity)[name] for name in ("doi", "arxiv_id", "venue")], ["", "", ""])


if __name__ == "__main__":
    unittest.main()
