"""Fitting a translation into its source box: leading, footnote/caption size, then a warning
with a length estimate (T24)."""
from pathlib import Path

import pymupdf as fitz
import pytest

from papeer.layout.reading_flow import footnote_ids, order_page, source_body_size
from papeer.pdf.pdf_engine import build_translated_pdf
from papeer.pdf.pdf_typography import TIGHT_LEADING, TextStyle, character_budget, readable_size, text_style

# Full-width characters without punctuation, so that line breaking is exact.
KANA = "あいうえおかきくけこさしすせそたちつてとなにぬねの"


def japanese(count: int) -> str:
    return (KANA * (count // len(KANA) + 1))[:count]


def block(identity, bbox, text="Source text of the paragraph.", size=10, **extra):
    return dict(id=identity, page=1, kind="text", bbox=bbox, text=text, font_size=size, formulas=[], **extra)


def fenced(identity, bbox):
    """A block with source blocks 2pt above and below it, so that its box cannot grow."""
    x0, y0, x1, y1 = bbox
    return [block(identity + "-above", [x0, y0 - 40, x1, y0 - 2]), block(identity, bbox),
            block(identity + "-below", [x0, y1 + 2, x1, y1 + 40])]


def build(tmp_path: Path, blocks: list[dict], translations: dict[str, str], name="out.pdf"):
    source = tmp_path / "source.pdf"
    if not source.exists():
        with fitz.open() as pdf:
            pdf.new_page(width=400, height=500)
            pdf.save(source)
    document = dict(title="Fitting", page_count=1, pages=[dict(number=1, width=400, height=500)], blocks=blocks)
    output = tmp_path / name
    report = build_translated_pdf(source, document, translations, output)
    with fitz.open(output) as pdf:
        spans = [(span["text"], span["size"]) for item in pdf[0].get_text("dict")["blocks"]
                 for line in item.get("lines", []) for span in line["spans"] if "Papeer" in span["font"]]
    return report, spans


def test_leading_is_tightened_before_the_type_shrinks(tmp_path):
    # 20 characters a line in 53pt of height: 3 lines at leading 1.4 (14pt), 4 lines at 1.25 (12.5pt).
    blocks = fenced("body", [40, 100, 245, 155])
    report, spans = build(tmp_path, blocks, {"body": japanese(70)})
    assert report["tight_leading_blocks"] == ["body"]
    assert report["readability_warnings"] == []
    assert {round(size, 2) for _, size in spans} == {10}
    # What still fits at the regular leading keeps it.
    report, spans = build(tmp_path, blocks, {"body": japanese(55)}, "short.pdf")
    assert report["tight_leading_blocks"] == []
    assert {round(size, 2) for _, size in spans} == {10}


def test_footnotes_and_captions_keep_their_own_smaller_size(tmp_path):
    body_text = "We study the behavior of an uncertain linear system and design a controller for it. " * 3
    blocks = [block("body", [40, 60, 360, 200], body_text),
              block("caption", [40, 220, 360, 240], "Fig. 2. Closed-loop trajectories.", size=8),
              block("note", [40, 420, 360, 440], "1 This work was supported by a grant.", size=7)]
    report, spans = build(tmp_path, blocks, {"body": japanese(120), "caption": "図2：閉ループの軌道。",
                                              "note": "本研究は助成を受けた。"})
    sizes = {text: round(size, 2) for text, size in spans}
    assert sizes["図2：閉ループの軌道。"] == 8
    assert sizes["本研究は助成を受けた。"] == 7
    assert report["note_blocks"] == ["caption", "note"]
    # Set in its own 7pt, a footnote is not reported as unreadable.
    assert report["readability_warnings"] == []


def test_note_and_caption_roles():
    note = block("n", [40, 420, 360, 440], "1 This work was supported by a grant.", size=7.5)
    assert text_style(note, 10, 500, footnote=True) == TextStyle("note", 7.5, TIGHT_LEADING)
    # Without the footnote judgment a short numbered line is taken for a heading, as before.
    heading_like = dict(note, text="1 Supported by a grant")
    assert text_style(heading_like, 10, 500).role == "section"
    assert text_style(heading_like, 10, 500, footnote=True).role == "note"
    # Never larger than the body size, never below 6pt.
    assert text_style(dict(note, font_size=12), 10, 500, footnote=True).size == 10
    assert text_style(dict(note, font_size=4), 10, 500, footnote=True).size == 6
    caption = block("c", [40, 200, 360, 220], "Fig. 3. The proposed method.")
    assert text_style(caption, 10, 500) == TextStyle("caption", 10, TIGHT_LEADING)
    assert text_style(dict(caption, text="TABLE II\nCOMPARISON OF METHODS"), 10, 500).role == "caption"
    # Headings keep their roles, which extraction (merge_wrapped_headings) relies on.
    assert text_style(dict(caption, text="TABLE I", font_size=18), 10, 500).role == "title"
    # Prose that merely starts with a figure label is body text unless it is set smaller.
    prose = dict(caption, text="Table 3 shows that the proposed method reduces the cost considerably.")
    assert text_style(prose, 10, 500).role == "body"
    assert text_style(dict(prose, text="Table 3 Results of the experiments", font_size=8.5), 10, 500) \
        == TextStyle("caption", 8.5, TIGHT_LEADING)
    # The point of a section-numbered figure is not the caption's punctuation.
    assert text_style(dict(prose, text="Figure 3.2 shows the closed-loop response of the system."), 10, 500).role == "body"
    assert text_style(dict(prose, text="Fig. 3.2: The closed-loop response."), 10, 500).role == "caption"
    # "Smaller type" is relative to the page's unrounded body size: in a paper set in 8pt,
    # 8pt prose starting with a label is body text although the typesetting rounds 8pt up to 8.8pt.
    small_paper = dict(prose, text="Table 3 lists the parameters of the experiments.", font_size=8)
    assert text_style(small_paper, 8.8, 500, source_body=8).role == "body"
    assert text_style(dict(small_paper, font_size=7), 8.8, 500, source_body=8).role == "caption"


def test_footnotes_are_judged_as_at_extraction():
    paragraph = "A body paragraph long enough to set the body type size of the page for this test. " * 2
    blocks = [block("left", [40, 60, 190, 300], paragraph), block("right", [210, 60, 360, 300], paragraph),
              block("note", [40, 400, 360, 420], "1 A footnote in small type.", size=8),
              block("low", [40, 440, 360, 460], paragraph)]
    assert footnote_ids(blocks, 500) == {"note"}
    ordered, _ = order_page(blocks, 400, 500)
    # Stored blocks carry the flags order_page set; the judgment does not change.
    assert footnote_ids(ordered, 500) == {"note"}
    assert next(b for b in ordered if b["id"] == "note")["reading_margin"]
    # References are marked after order_page; they still count for the body size.
    assert source_body_size(ordered) == source_body_size([dict(b, kind="reference") for b in ordered]) == 10


def test_readable_size_and_character_budget():
    assert readable_size(TextStyle("body", 10, 1.4)) == 8
    assert readable_size(TextStyle("footer", 8, 1.2)) == 6
    assert readable_size(TextStyle("note", 7, 1.25)) == 6
    assert readable_size(TextStyle("caption", 9, 1.25)) == pytest.approx(7.65)
    # 100pt × 50pt of text area at 10pt with leading 1.25: 40 characters, 36 with the 10% margin.
    assert character_budget(fitz.Rect(0, 0, 102, 52), 10, 1.25) == 36
    assert character_budget(fitz.Rect(0, 0, 102, 52), 10, 1.25, math_ems=6) == 30
    # Not one line at the readable size, or nothing left besides the math: no length would do.
    assert character_budget(fitz.Rect(0, 0, 102, 11), 8, 1.4) is None
    assert character_budget(fitz.Rect(0, 0, 102, 52), 10, 1.25, math_ems=36) is None


def test_overflow_warning_estimates_a_length_that_fits(tmp_path):
    blocks = fenced("body", [40, 100, 245, 155])
    report, _ = build(tmp_path, blocks, {"body": japanese(260)})
    [warning] = report["readability_warnings"]
    assert warning["block"] == "body" and warning["role"] == "body"
    assert warning["font_size"] < 8
    assert warning["chars"] == 260
    assert warning["source_blocks"] == ["body"]
    assert 0 < warning["char_budget"] < 260
    # A translation of the estimated length is typeset at a readable size.
    report, spans = build(tmp_path, blocks, {"body": japanese(warning["char_budget"])}, "budget.pdf")
    assert report["readability_warnings"] == []
    assert min(size for _, size in spans) >= 8


def test_a_box_too_small_for_any_readable_length_has_no_estimate(tmp_path):
    # Even the compact leading for short equation lead-ins cannot fit one readable line.
    blocks = fenced("b", [40, 100, 245, 108])
    blocks[1]["text"] = "where x is the state and u is the input of the system"
    report, _ = build(tmp_path, blocks, {"b": japanese(60)})
    [warning] = report["readability_warnings"]
    assert warning["char_budget"] is None and warning["chars"] == 60


def test_compact_leading_budget_fits_a_readable_short_equation_lead_in(tmp_path):
    blocks = fenced("b", [40, 100, 245, 111])
    blocks[1]["text"] = "where x is the state and u is the input of the system"
    report, _ = build(tmp_path, blocks, {"b": japanese(60)})
    [warning] = report["readability_warnings"]
    assert "b" in report["compact_blocks"]
    assert 0 < warning["char_budget"] < 60
    report, spans = build(tmp_path, blocks, {"b": japanese(warning["char_budget"])}, "budget.pdf")
    assert report["readability_warnings"] == []
    assert min(size for _, size in spans) >= 8


def test_a_warning_names_the_translation_block_of_a_continued_paragraph(tmp_path):
    first = block("first", [40, 60, 245, 90], "The paragraph starts in this column and continues", size=10)
    rest = block("rest", [40, 100, 245, 115], "in the next column with the rest of the sentence.", size=10)
    source = tmp_path / "source.pdf"
    with fitz.open() as pdf:
        pdf.new_page(width=400, height=500)
        pdf.save(source)
    document = dict(title="Flow", page_count=1, pages=[dict(number=1, width=400, height=500)],
                    blocks=[first, rest, block("wall", [40, 117, 245, 160])],
                    continuations=[dict(blocks=["first", "rest"])])
    report = build_translated_pdf(source, document, {"first": japanese(300) + "。" + japanese(300)},
                                  tmp_path / "out.pdf")
    warned = {w["block"]: w for w in report["readability_warnings"]}
    assert warned
    assert all(w["source_blocks"] == ["first"] for w in warned.values())
