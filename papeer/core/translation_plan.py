"""What starting a translation would do, told before it starts (the translation dialog).

The dialog asks before offering the AI's glossary check (itself an AI request) and before
spending usage on pages that already have a translation. The rules must stay those of
PaperService.translate: tests/test_translation_plan.py runs the real translation and checks
that the pages called reusable here are exactly the pages it takes from the cache.
"""
from __future__ import annotations

from typing import Any

from papeer.core import prompts
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from papeer.core.terminology import apply_glossary, effective_glossary
from papeer.layout.reading_flow import expand_pages, unit_pages
from papeer.pdf.pdf_engine import translation_units
from papeer.translation.translation import TranslationKey, page_fingerprint
from papeer.translation.translation_preview import translated_page_numbers


def _cache_matchers(settings, units):
    """(whole cache, one completed page) -> whether translate() may reuse it with these settings."""
    key = TranslationKey.current(settings, prompts.load("translation"), units)
    return key.matches_cache, key.matches_page


def translation_plan(library: Library, paper_id: str, settings, pages: set[int] | None = None) -> dict[str, Any]:
    """Which of the requested pages the model would translate and which come from saved translations.

    `settings` are those of the run (the dialog's model included). Nothing is written.
    """
    folder = library.folder(paper_id)
    files = PaperFiles(folder)
    document = library.document(paper_id)
    page_count = document["page_count"]
    requested = set(range(1, page_count + 1)) if pages is None else set(pages)
    units = translation_units(document)
    apply_glossary(units, effective_glossary(library, paper_id))
    if not units:
        raise ValueError("翻訳対象の文字が見つかりませんでした。")
    selected = expand_pages(units, requested)
    cache = files.read_json(files.translation_cache, {})
    cache_matches, page_matches = _cache_matchers(settings, units)
    done = set(cache.get("translations", {})) if cache_matches(cache) else set()
    records = cache.get("completed_pages", {})
    source_pages = {n: [u for u in units if n in unit_pages(u)] for n in range(1, page_count + 1)}
    for number, page_units in source_pages.items():
        entry = records.get(str(number), {})
        if (page_matches(entry) and entry.get("source") == page_fingerprint(page_units)
                and all(u["id"] in entry.get("translations", {}) for u in page_units)):
            done.update(entry["translations"])
    reusable = sorted(n for n in selected if source_pages[n] and all(u["id"] in done for u in source_pages[n]))
    pending = sorted(n for n in selected if any(u["id"] not in done for u in source_pages[n]))
    # Pages that show a translation now and would be sent to the model again.
    retranslated = sorted(set(pending) & set(translated_page_numbers(folder, page_count)))
    previous_models = sorted({records[str(n)]["model"] for n in retranslated
                              if isinstance(records.get(str(n)), dict) and records[str(n)].get("model")})
    return {
        "model": settings.model,
        "selected_pages": sorted(selected),
        "reusable_pages": reusable,
        "pending_pages": pending,
        "retranslated_pages": retranslated,
        "previous_models": previous_models,
        # False when every requested page comes from saved translations: starting only redraws the PDF.
        "needs_ai": bool(pending),
    }
