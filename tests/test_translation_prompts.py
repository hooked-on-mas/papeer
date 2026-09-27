"""The Japanese style shared by the translation prompts, and the paper's title and abstract sent with every request."""
from __future__ import annotations

import json
from pathlib import Path
import threading
from unittest.mock import patch

import pymupdf as fitz
import pytest

from papeer.core import prompts
from papeer.core.config import Settings
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.layout.math_layout import MATH_TOKEN
from papeer.layout.reading_flow import unit_pages
from papeer.pdf.pdf_engine import extract_pdf, translation_units
from papeer.translation.translation import (PAPER_NOTE, TranslationKey, page_fingerprint, sent_instruction,
                                             translate_batch)
from papeer.translation.translation_context import PAPER_CONTEXT_LIMIT, paper_context, request_payload

TRANSLATION_PROMPTS = ("translation", "translation_recovery", "translation_fallback")
STYLE = (Path(prompts.__file__).parent / "prompts" / "_translation_style.txt").read_text("utf-8").strip()
A = "[[PD_MATH_p1b1_0]]"


def test_translation_prompts_share_the_style_section():
    for name in TRANSLATION_PROMPTS:
        template = prompts.builtin(name)
        assert template.count("{{translation_style}}") == 1, name
        sent = prompts.expand(template)
        assert sent.count(STYLE) == 1 and "{{" not in sent, name
    # The shared section is not a prompt of its own: not shown in the settings, not overridable.
    assert "_translation_style" not in prompts.defaults() and "_translation_style" not in prompts.current()
    with pytest.raises(ValueError):
        prompts.save_overrides({"_translation_style": "独自のスタイル"})
    assert prompts.expand("{{unknown_section}} です。") == "{{unknown_section}} です。"


class ScriptedProvider:
    def __init__(self, *answers):
        self.answers = iter(answers)
        self.calls = []

    def generate(self, instruction, data, schema=None):
        self.calls.append((instruction, json.loads(data)))
        return json.dumps(next(self.answers), ensure_ascii=False)


def recover_once(paper=None):
    """A block whose first answer and structured retry both drop its formula, so that all three prompts are sent."""
    unit = {"id": "bad", "page": 1, "text": f"For {A} we use it."}
    provider = ScriptedProvider({"translations": [{"id": "bad", "text": "数式なし。"}]},
                                {"parts": [{"kind": "text", "text": "数式なし。"}]},
                                {"translations": [{"id": "text0", "text": "に対して"}, {"id": "text2", "text": "を使う。"}]})
    saved = []
    translate_batch(provider, [unit], threading.Event(), lambda _: None, saved.append, paper=paper)
    assert saved == [{"bad": f"に対して{A}を使う。"}]
    return provider.calls


def test_overrides_are_sent_as_written_unless_they_hold_the_marker():
    prompts.save_overrides({"translation": "独自の翻訳指示", "translation_recovery": "独自の再試行指示\n{{translation_style}}"})
    try:
        calls = recover_once()
    finally:
        prompts.save_overrides({"translation": "", "translation_recovery": ""})
    # An override written without the marker (such as one from before the section was shared)
    # gets nothing added; one keeping the marker gets the section once.
    assert calls[0][0] == "独自の翻訳指示"
    assert calls[1][0] == "独自の再試行指示\n" + STYLE
    assert calls[2][0] == prompts.expand(prompts.builtin("translation_fallback"))


def test_every_request_starts_with_the_paper_after_the_instruction():
    paper = {"title": "Adaptive Control", "abstract": "We study an adaptive controller."}
    calls = recover_once(paper)
    for (instruction, data), name in zip(calls, TRANSLATION_PROMPTS):
        assert instruction == prompts.expand(prompts.builtin(name)) + "\n" + PAPER_NOTE
        assert instruction == sent_instruction(prompts.builtin(name), paper)
        assert next(iter(data)) == "paper" and data["paper"] == paper
    # Without a title or abstract nothing is added.
    for (instruction, data), name in zip(recover_once(), TRANSLATION_PROMPTS):
        assert instruction == prompts.expand(prompts.builtin(name)) and "paper" not in data
    assert "paper" not in request_payload([{"id": "a", "text": "Text."}], None)


def block(identity, page, text, size=10.0, bbox=None, **extra):
    return {"id": identity, "page": page, "kind": "text", "text": text, "font_size": size,
            **({"bbox": bbox} if bbox else {}), **extra}


def test_title_and_abstract_of_the_sample_paper():
    # Two columns whose headings ("Abstract", "Method") sit side by side: reading order puts
    # "Method" right after "Abstract", the abstract is the block below its heading.
    context = paper_context(extract_pdf(Path(__file__).parent / "fixtures/sample.pdf"))
    assert context == {"title": "Adaptive Control for Automated Systems",
                       "abstract": "We study an adaptive controller for an automated production system. The controller "
                                   "reduces tracking error by 18 percent in a simulated environment. The result has "
                                   "not been validated on production hardware."}


def test_abstract_in_its_heading_block_and_title_from_the_metadata():
    document = {"title": "Learning  to Control", "blocks": [
        block("p1b0", 1, "Journal of Control", 9, running_header=True),
        block("p1b1", 1, "Learning to\nControl", 14),
        block("p1b2", 1, "Abstract—We learn a con-\ntroller from data.\nIt is stable."),
        block("p1b3", 1, "Index Terms—control, learning"),
        block("p1b4", 1, "1 Introduction")]}
    assert paper_context(document) == {"title": "Learning to Control",
                                       "abstract": "We learn a controller from data. It is stable."}
    # A heading alone takes the blocks after it (in reading order without positions) up to the keywords.
    document["blocks"][2:3] = [block("p1b2", 1, "ABSTRACT"), block("p1b5", 1, "We learn a controller."),
                               block("p1b6", 1, "It is stable.")]
    assert paper_context(document)["abstract"] == "We learn a controller. It is stable."


def test_title_is_not_the_arxiv_stamp_or_the_journal_name():
    body = "We schedule the production lines with a learned policy and compare it with the baselines. " * 3
    document = {"title": "", "blocks": [
        # arXiv's identifier along the left edge: large and vertical.
        block("p1b0", 1, "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023", 20, [12, 200, 32, 600]),
        # A journal's name set a little larger than the title.
        block("p1b1", 1, "Operations Research", 14.5, [60, 40, 300, 58]),
        block("p1b2", 1, "Learning to Schedule Production Lines with", 14, [60, 80, 520, 98]),
        block("p1b3", 1, "Graph Neural Networks", 14, [60, 100, 300, 118]),
        block("p1b4", 1, "Jane Doe, John Roe", 11, [60, 130, 300, 144]),
        block("p1b5", 1, body, 10, [60, 160, 540, 260]),
        block("p1b6", 1, body, 10, [60, 270, 540, 370])]}
    assert paper_context(document) == {"title": "Learning to Schedule Production Lines with Graph Neural Networks"}
    # Not even when laid out horizontally.
    document["blocks"][0] = block("p1b0", 1, "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023 and more words", 20)
    assert paper_context(document)["title"].startswith("Learning to Schedule")


def test_summary_heading_and_what_ends_an_abstract():
    for end in ("CCS Concepts: Computing methodologies", "ACM Reference Format: Doe, J. 2020.",
                "© 2020 Elsevier B.V. All rights reserved.", "Copyright 2020 by the authors.",
                "MSC 2020: 93C40", "General Terms: Algorithms", "Categories and Subject Descriptors: I.2"):
        document = {"title": "", "blocks": [block("p1b1", 1, "Summary"), block("p1b2", 1, "We learn a controller."),
                                            block("p1b3", 1, end), block("p1b4", 1, "More text.")]}
        assert paper_context(document) == {"abstract": "We learn a controller."}, end
    # A summary section later in the paper is not an abstract.
    later = {"title": "", "blocks": [block("p1b1", 1, "Body."), block("p3b1", 3, "Summary"), block("p3b2", 3, "We end.")]}
    assert paper_context(later) is None


def test_paper_context_is_left_out_or_clipped():
    # A metadata title that is not on the page (a file name) and a first page of one size: no title.
    plain = {"title": "2301 draft v2", "blocks": [block("p1b1", 1, "Some Paper Title Here"),
                                                  block("p1b2", 1, "Abstract algebra is a field of mathematics.")]}
    assert paper_context(plain) is None
    assert paper_context({"title": "x", "blocks": []}) is None
    long = {"title": "", "blocks": [block("p1b1", 1, "A Very Long Study", 20),
                                    block("p1b2", 1, "Abstract. " + "We measure the error again. " * 60),
                                    block("p1b3", 1, "Body text of the paper that follows the abstract. " * 3)]}
    context = paper_context(long)
    assert context["title"] == "A Very Long Study"
    assert len(context["title"]) + len(context["abstract"]) <= PAPER_CONTEXT_LIMIT
    assert context["abstract"].startswith("We measure") and context["abstract"].endswith("…")
    # An abstract below its heading ends at a wide gap.
    spaced = {"title": "", "blocks": [block("p1b1", 1, "a b s t r a c t", bbox=[40, 100, 90, 110]),
                                      block("p1b2", 1, "We learn a controller.", bbox=[40, 115, 300, 140]),
                                      block("p1b3", 1, "Unrelated text far below.", bbox=[40, 400, 300, 420])]}
    assert paper_context(spaced) == {"abstract": "We learn a controller."}


def titled_paper(path: Path) -> Path:
    with fitz.open() as pdf:
        page = pdf.new_page()
        page.insert_text((60, 60), "Adaptive Control of Robots", fontsize=20)
        page.insert_text((60, 100), "Abstract", fontsize=11)
        page.insert_text((60, 120), "We study an adaptive controller for robot arms.", fontsize=11)
        page.insert_text((60, 200), "The controller reduces the tracking error in every trial.", fontsize=11)
        pdf.new_page().insert_text((60, 120), "The second page explains the adaptive controller.", fontsize=11)
        pdf.save(path)
    return path


class RecordingProvider:
    def __init__(self):
        self.settings = Settings(translation_concurrency=1)
        self.calls = []

    def generate(self, instruction, data, schema=None):
        payload = json.loads(data)
        self.calls.append((instruction, payload))
        return json.dumps({"translations": [
            {"id": u["id"], "text": f"訳{u['id']}。" + "".join(MATH_TOKEN.findall(u["text"]))}
            for u in payload["blocks"]]}, ensure_ascii=False)


def test_translation_sends_the_paper_without_changing_the_cache_key(tmp_path):
    def translate(folder_name, context):
        library = Library(tmp_path / folder_name)
        identity, _ = library.import_pdf(titled_paper(tmp_path / "titled.pdf"))
        provider = RecordingProvider()
        with patch("papeer.core.service.paper_context", wraps=context):
            PaperService(library, provider, threading.Event()).translate(identity)
        cache = json.loads((library.folder(identity) / "translation-cache.json").read_text("utf-8"))
        return library.document(identity), provider.calls, cache

    document, calls, cache = translate("with-paper", paper_context)
    expected = paper_context(document)
    assert expected["title"] == "Adaptive Control of Robots"
    assert expected["abstract"].startswith("We study an adaptive controller")
    assert calls and all(instruction == sent_instruction(prompts.builtin("translation"), expected)
                         and list(payload)[0] == "paper" and payload["paper"] == expected
                         for instruction, payload in calls)
    # The key is made from the prompt as written: the same with the paper sent or not.
    units = translation_units(document)
    key = TranslationKey.current(RecordingProvider().settings, prompts.builtin("translation"), units)
    assert (cache["translation_version"], cache["fingerprint"]) == (key.identity, key.fingerprint)
    for number, entry in cache["completed_pages"].items():
        assert entry["version"] == key.identity
        assert entry["source"] == page_fingerprint([u for u in units if int(number) in unit_pages(u)])
    _, bare_calls, bare = translate("without-paper", lambda _document: None)
    assert all("paper" not in payload and instruction == prompts.expand(prompts.builtin("translation"))
               for instruction, payload in bare_calls)
    assert {k: bare[k] for k in ("translation_version", "fingerprint", "completed_pages", "translations")} == \
        {k: cache[k] for k in ("translation_version", "fingerprint", "completed_pages", "translations")}
