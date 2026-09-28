"""Rules the frontend keeps too, tested here against the same cases as its tests (frontend/tests/sharedCases.test.ts)."""
import json
from pathlib import Path
import re
import unittest

from papeer.core.storage import collection_ancestors, in_collection, normalize_collection_name
from papeer.layout.page_selection import parse_page_selection

FIXTURES = Path(__file__).parent / "fixtures"


def cases(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class SharedCaseTests(unittest.TestCase):
    def test_python_whitespace(self):
        """The fixture the frontend's whitespace is tested against is this Python's."""
        listed = [int(code, 16) for code in cases("python_whitespace.json")["code_points"]]
        self.assertEqual(listed, [code for code in range(0x110000) if chr(code).isspace()])
        self.assertEqual(listed, [code for code in range(0x110000) if re.fullmatch(r"\s", chr(code))])

    def test_page_ranges(self):
        for case in cases("page_ranges.json")["cases"]:
            with self.subTest(value=case["value"], page_count=case["page_count"]):
                if "pages" in case:
                    self.assertEqual(sorted(parse_page_selection(case["value"], case["page_count"])), case["pages"])
                else:
                    with self.assertRaises(ValueError) as raised:
                        parse_page_selection(case["value"], case["page_count"])
                    self.assertEqual(str(raised.exception), case["error"])

    def test_collection_paths(self):
        folders = cases("collection_paths.json")
        for case in folders["normalize"]:
            with self.subTest(normalize=case["value"]):
                self.assertEqual(normalize_collection_name(case["value"]), case["path"])
        for case in folders["ancestors"]:
            with self.subTest(ancestors=case["value"]):
                self.assertEqual(collection_ancestors(case["value"]), case["ancestors"])
        for case in folders["inside"]:
            with self.subTest(inside=case["value"], path=case["path"]):
                self.assertEqual(in_collection(case["value"], case["path"]), case["inside"])


if __name__ == "__main__":
    unittest.main()
