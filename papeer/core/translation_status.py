"""The translation state a paper's row keeps (papers.status), stored as a code.

The frontend turns a code into its label (frontend/src/lib/paperStatus.ts). What the library list and
the reader show is mostly worked out from the saved pages (library_list.translation_state); the stored
state tells what the pages cannot: a translation stopped before any page was saved (INCOMPLETE), and
one that finished with paragraphs or pages left untranslated (PARTIAL).
"""
from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum
from typing import Any


class TranslationStatus(StrEnum):
    NOT_TRANSLATED = "not_translated"
    TRANSLATING = "translating"
    # Finished, with pages or paragraphs left untranslated.
    PARTIAL = "partial"
    # Stopped (cancelled or failed) with translated text saved to resume from.
    RESUMABLE = "resumable"
    # Stopped before anything was translated.
    INCOMPLETE = "incomplete"
    TRANSLATED = "translated"


# The labels Papeer stored before the codes, with the code for each. Papeer up to 0.2.0 does not check the
# database's version, so one still running on a synced PC may write them into a converted database too.
LEGACY_LABELS = {
    "追加済み": TranslationStatus.NOT_TRANSLATED,
    "翻訳中": TranslationStatus.TRANSLATING,
    "一部翻訳済み": TranslationStatus.PARTIAL,
    "翻訳途中・再開可": TranslationStatus.RESUMABLE,
    "翻訳未完了": TranslationStatus.INCOMPLETE,
    "翻訳済み": TranslationStatus.TRANSLATED,
}


def stored_status(value: object) -> TranslationStatus:
    """A papers.status value as a code: the one place that reads it (Library rows, library_schema._status_codes).

    A legacy label becomes its code, and anything else unknown (hand-edited) NOT_TRANSLATED: the library
    list works out the rest from the saved pages.
    """
    if isinstance(value, str) and value in LEGACY_LABELS:
        return LEGACY_LABELS[value]
    try:
        return TranslationStatus(value)
    except ValueError:
        return TranslationStatus.NOT_TRANSLATED


def translation_status(*, running: bool = False, report: Mapping[str, Any] | None = None,
                       resumable: bool = False) -> TranslationStatus:
    """The state to store for a paper's translation.

    running: a translation has started. report: the translation report (translation-report.json) of one
    that finished. Otherwise it stopped, and `resumable` says whether it saved translated text.
    """
    if running:
        return TranslationStatus.TRANSLATING
    if report is not None:
        left = report.get("untranslated_pages") or report.get("skipped_blocks")
        return TranslationStatus.PARTIAL if left else TranslationStatus.TRANSLATED
    return TranslationStatus.RESUMABLE if resumable else TranslationStatus.INCOMPLETE
