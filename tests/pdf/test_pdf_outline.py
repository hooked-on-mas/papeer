from pathlib import Path
from unittest.mock import patch

import pymupdf
import pytest

from papeer.core.pdf_outline import OUTLINE_LIMIT, original_outline


def make_pdf(path: Path, toc: list) -> None:
    with pymupdf.open() as doc:
        for _ in range(3):
            doc.new_page()
        doc.set_toc(toc)
        doc.save(path)


def test_outline_is_available_without_rendering_and_keeps_depth_and_destination(tmp_path):
    path = tmp_path / "original.pdf"
    make_pdf(path, [[1, "Introduction", 1], [2, "  Details  ", 2], [1, "Conclusion", 3]])
    entries = original_outline(path)
    assert entries is not None
    assert [(item["title"], item["depth"], item["page"]) for item in entries] == [
        ("Introduction", 0, 1), ("Details", 1, 2), ("Conclusion", 0, 3),
    ]
    assert all(0 <= item["anchor_y"] <= 1 for item in entries)
    # A caller changing its list does not change the cache; repeated progress requests do not reopen.
    entries.clear()
    with patch("papeer.core.pdf_outline.pymupdf.open", side_effect=AssertionError("opened again")):
        assert len(original_outline(path)) == 3


def test_no_outline_is_distinct_from_unknown_and_a_replaced_pdf_is_read_again(tmp_path):
    path = tmp_path / "original.pdf"
    make_pdf(path, [])
    assert original_outline(path) == []
    replacement = tmp_path / "new.pdf"
    make_pdf(replacement, [[1, "New section", 2]])
    replacement.replace(path)
    assert original_outline(path)[0]["title"] == "New section"
    assert original_outline(tmp_path / "missing.pdf") is None
    path.write_bytes(b"broken PDF")
    assert original_outline(path) is None


def test_large_outline_keeps_the_same_bound_as_the_browser(tmp_path):
    path = tmp_path / "large.pdf"
    make_pdf(path, [[1, f"Section {index}", 1] for index in range(OUTLINE_LIMIT + 20)])
    entries = original_outline(path)
    assert len(entries) == OUTLINE_LIMIT
    assert entries[-1]["title"] == f"Section {OUTLINE_LIMIT - 1}"


def test_named_destination_keeps_its_resolved_page_and_anchor(tmp_path):
    path = tmp_path / "named.pdf"
    with pymupdf.open() as doc:
        for _ in range(3):
            doc.new_page(width=600, height=800)
        doc.set_toc([[1, "Named section", 3]])
        outline_xref = doc.get_toc(simple=False)[0][3]["xref"]
        page_xref = doc.page_xref(2)
        doc.xref_set_key(doc.pdf_catalog(), "Names", f"<< /Dests << /Names [(section.1) [{page_xref} 0 R /XYZ 72 600 0]] >> >>")
        doc.xref_set_key(outline_xref, "A", "<< /S /GoTo /D (section.1) >>")
        doc.save(path)
    with pymupdf.open(path) as doc:
        assert doc.get_toc(simple=False)[0][3]["kind"] == pymupdf.LINK_NAMED
    assert original_outline(path) == [{"title": "Named section", "depth": 0, "page": 3, "anchor_y": 0.25}]


@pytest.mark.parametrize("destination, anchor", [
    ("/Fit", None), ("/FitB", None), ("/FitV 72", None),
    ("/XYZ null null null", None), ("/XYZ 72 null 0", None),
    ("/FitH null", None), ("/FitBH null", None),
    ("/XYZ 72 0 0", 1.0), ("/FitH 0", 1.0),
    ("/FitH 600", 0.25), ("/FitBH 600", 0.25),
    ("/FitR 72 100 300 600", 0.25),
])
@pytest.mark.parametrize("old_style", [False, True])
def test_named_destination_only_sets_an_anchor_when_height_is_specified(tmp_path, destination, anchor, old_style):
    path = tmp_path / "named-height.pdf"
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=800)
        page_xref = page.xref
        doc.set_toc([[1, "Section", 1]])
        outline_xref = doc.get_toc(simple=False)[0][3]["xref"]
        target = f"[{page_xref} 0 R {destination}]"
        if old_style:
            doc.xref_set_key(doc.pdf_catalog(), "Dests", f"<< /section {target} >>")
        else:
            doc.xref_set_key(doc.pdf_catalog(), "Names", f"<< /Dests << /Names [(section) << /D {target} >>] >> >>")
        doc.xref_set_key(outline_xref, "A", "<< /S /GoTo /D (section) >>")
        doc.save(path)
    expected = {"title": "Section", "depth": 0, "page": 1}
    if anchor is not None:
        expected["anchor_y"] = anchor
    assert original_outline(path) == [expected]
