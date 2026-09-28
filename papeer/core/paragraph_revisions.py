"""Translated paragraphs and their revision by hand: drafting a revision with the AI, adopting one (the
pages are translated again with it) and the history of revisions."""
from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
import json
from pathlib import Path
import threading
from typing import TYPE_CHECKING
import uuid

from papeer.core import prompts
from papeer.core.errors import Conflict, Invalid
from papeer.core.fileio import atomic_write_json
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from papeer.core.terminology import apply_glossary, effective_glossary, validate_revision
from papeer.pdf.pdf_engine import translation_units

if TYPE_CHECKING:
    from papeer.providers.base import ProviderBackend


def translation_paragraphs(lib: Library, paper_id: str) -> list[dict]:
    folder = lib.folder(paper_id)
    document = lib.document(paper_id)
    units = translation_units(document)
    apply_glossary(units, effective_glossary(lib, paper_id))
    cache = PaperFiles.read_json(PaperFiles(folder).translation_cache, {})
    from papeer.translation.translation import page_fingerprint
    from papeer.layout.reading_flow import unit_pages
    done = {}
    for number, entry in cache.get("completed_pages", {}).items():
        page_units = [unit for unit in units if int(number) in unit_pages(unit)]
        if entry.get("source") == page_fingerprint(page_units):
            done.update(entry.get("translations", {}))
    return [dict(id=u["id"], page=u["page"], pages=sorted(unit_pages(u)), source=u["text"],
                 text=done[u["id"]]) for u in units if u["id"] in done]


REVISION_SCHEMA = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"],
                   "additionalProperties": False}


def draft_revision(lib: Library, paper_id: str, paragraph: dict, instruction: str, provider, cancel,
                   char_budget: int | None = None) -> str:
    """A revised translation of one paragraph following the user's instruction; not saved.

    char_budget: about how many characters fit where the paragraph is typeset (a readability
    warning's estimate), when the user asked for a shorter translation.
    """
    from papeer.providers import check_cancel, parse_json_answer

    payload = {"source": paragraph["source"], "current": paragraph["text"],
               "glossary": effective_glossary(lib, paper_id)}
    prompt = prompts.load("revision_draft") + " " + instruction
    if char_budget:
        payload["max_characters"] = char_budget
        prompt += (f" Keep the Japanese text within about {char_budget} characters, not counting math"
                   " placeholders or spaces: it must fit the space of the original paragraph. Make it concise"
                   " by removing redundancy, but do not drop any claim, condition, number or citation.")
    answer = provider.generate(prompt, json.dumps(payload, ensure_ascii=False), REVISION_SCHEMA)
    value = parse_json_answer(answer, REVISION_SCHEMA)
    if not isinstance(value.get("text"), str):
        raise ValueError("AIから修正案を取得できませんでした。再試行してください。")
    text = validate_revision(paragraph["source"], value["text"])
    check_cancel(cancel)
    return text


def find_paragraph(lib: Library, paper_id: str, unit_id: str, expected_text: str | None = None) -> dict:
    """The translated paragraph `unit_id` as translation_paragraphs lists it.

    Invalid when the translation has no such paragraph (a glossary change re-made its units); Conflict when
    its text is no longer `expected_text`, the one the user revised (another window changed it).
    """
    lib.paper_folder(paper_id)  # NotFound for a paper the library does not have
    paragraph = next((item for item in translation_paragraphs(lib, paper_id) if item["id"] == unit_id), None)
    if not paragraph:
        raise Invalid("段落が見つかりません。辞書変更後は再翻訳してください。")
    if expected_text is not None and paragraph["text"] != expected_text:
        raise Conflict("訳文が変更されました。読み込み直してください。")
    return paragraph


def adopt_revision(lib: Library, paper_id: str, unit_id: str, text: str, provider: ProviderBackend,
                   cancel: threading.Event, progress: Callable[[str], None], page_ready: Callable[[str, int], None],
                   expected_text: str | None = None) -> dict:
    """Use `text` (checked by validate_revision) as paragraph `unit_id`'s translation, and record the change.

    The paragraph is looked up again (find_paragraph): the translation may have changed since the request.
    Its pages are translated again with the text in place (PaperService.translate with replacements), so
    their PDF pages are drawn anew, and the previous text goes to the revision history. Returns the
    translation's result.
    """
    from papeer.core.service import PaperService

    current = find_paragraph(lib, paper_id, unit_id, expected_text)
    result = PaperService(lib, provider, cancel, progress, page_ready).translate(
        paper_id, pages=set(current["pages"]), replacements={unit_id: text})
    if result.get("skipped_pages"):
        raise ValueError("修正したページのPDF生成に失敗しました。翻訳の要確認一覧から確認してください。")
    save_revision_history(lib.folder(paper_id), unit_id, current["text"], text)
    return result


def revision_history(folder: Path) -> list[dict]:
    return PaperFiles.read_json(PaperFiles(folder).translation_revisions, [])


def save_revision_history(folder: Path, unit_id: str, before: str, after: str) -> None:
    path = PaperFiles(folder).translation_revisions
    history = PaperFiles.read_json(path, [])
    history.append({"id": uuid.uuid4().hex, "unit_id": unit_id, "before": before, "after": after,
                    "created_at": datetime.now().isoformat(timespec="seconds")})
    atomic_write_json(path, history[-500:])
