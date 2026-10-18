"""One translation of a paper (PaperService.translate): which paragraphs it sends, what it keeps
of earlier runs, how it records its progress in translation-cache.json, and the pages it makes.

TranslationRun holds the state of one run, which the steps below share; translate_batches
(papeer.translation.translation) sends the requests and calls back into the run from its workers.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import threading
import uuid
from typing import Callable

import pymupdf as fitz

from papeer.core import exports, prompts
from papeer.core.code_version import loaded_version
from papeer.core.config import Settings
from papeer.core.fileio import atomic_write_json, atomic_write_text, replace_file
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from papeer.core.terminology import (apply_glossary, effective_glossary, glossary_warnings, kept_glossary_warnings,
                                     validate_revision)
from papeer.core.translation_status import translation_status
from papeer.layout.math_layout import restore_formula_text
from papeer.layout.ocr_pages import needs_ocr_message, ocr_markdown_note
from papeer.layout.reading_flow import (expand_pages, join_unit_translations, materialize_flows, resolve_unit_joins,
                                        translation_blocks, unit_pages)
from papeer.pdf.pdf_engine import PDF_LOCK, batches, build_translated_pdf, translation_units
from papeer.pdf.pdf_typography import fonts_need_conversion, prepare_fonts_in_background
from papeer.providers import ProviderBackend, check_cancel
from papeer.translation.translation import (RetryState, TranslationKey, page_fingerprint, page_source_fingerprint, same_page_source, shared_translations,
                                            translate_batches)
from papeer.translation.translation_context import contextual_units, paper_context
from papeer.translation.translation_preview import (PREVIOUS_CACHE, preview_page, remove_unused_runs, translated_page,
                                                    translated_page_numbers)


class TranslationRun:
    """The translation of the pages `pages` of one paper (all of them when None).

    Made anew for every translation: run() is called once only (the state it builds is this run's).

    `replacements` (paragraph id: text) puts translations revised by hand in place of the saved ones
    on their pages (reading_tools.adopt_revision). The steps, in order:

    1. _select_pages, _reuse_saved_translations, _plan_requests: the pages to make, the saved
       translations still current (TranslationKey), the paragraphs sharing a translation
       (shared_translations) and the batches to send.
    2. _keep_earlier_pages: the pages translated earlier, kept for the reader while this run makes
       its own (and put back if it stops first), and the cache it replaces.
    3. _translate: translate_batches, whose workers record their answers (_accept) and the retry
       budget (_save) holding `lock`; the pages whose paragraphs are all done are made on this
       thread as batches finish (_publish_ready).
    4. _finish: translated.pdf, the report and translation.md; or, when the run stops with an error,
       _put_back_earlier_pages.
    """

    # The paper and the pages asked for (1).
    folder: Path
    files: PaperFiles
    document: dict
    requested: set[int]
    selected: set[int]
    settings: Settings
    instruction: str
    version: str
    fingerprint: str
    glossary_key: str
    cache_path: Path
    # The source units by page, with their glossary (what the cache keys), and each page's fingerprint.
    source_pages: dict[int, list[dict]]
    page_keys: dict[int, str]
    # Translations by unit id: those saved and still current, then those this run takes.
    done: dict[str, str]
    retry_state: RetryState
    completed_pages: dict[str, dict]
    # Pages taken only to apply paragraph revisions, and their paragraphs of another key.
    revised_only: set[int]
    foreign_ids: set[str]
    copies: dict[str, list[str]]
    followers: dict[str, dict]
    already_done: set[int]
    # The units with the context sent with them (contextual_units), and what is sent.
    units: list[dict]
    paper: dict | None
    selected_units: list[dict]
    by_page: dict[int, list[dict]]
    chunks: list[list[dict]]
    preview: dict
    preview_path: Path
    # Earlier translations (2).
    retained: set[int]
    superseded: set[int]
    run_folder: Path
    previous_markdown: str
    previous_report: dict

    def __init__(self, library: Library, provider: ProviderBackend, cancel: threading.Event, paper_id: str,
                 pages: set[int] | None = None, replacements: dict[str, str] | None = None, *,
                 progress: Callable[[str], None] = lambda _: None,
                 page_ready: Callable[[str, int], None] = lambda *_: None,
                 usage: Callable[[], dict | None] = lambda: None):
        self.library, self.provider, self.cancel = library, provider, cancel
        self.paper_id, self.pages, self.replacements = paper_id, pages, replacements
        self.progress, self.page_ready, self.usage = progress, page_ready, usage
        # With parallel translation, the workers of translate_batches change done and retry_state and
        # write translation-cache.json (_accept, _save) holding this lock; this thread reads them holding it.
        self.lock = threading.RLock()
        # Whether _accept took translations that translation-cache.json does not hold yet.
        self.unsaved = False
        self.concurrency = 1
        self.finished_chunks = 0

    def run(self) -> dict:
        self._select_pages()
        self._reuse_saved_translations()
        self._plan_requests()
        self._keep_earlier_pages()
        self.library.update(self.paper_id, status=translation_status(running=True))
        # The first translation on a PC converts the bundled fonts; that overlaps the first requests.
        if fonts_need_conversion():
            self.progress("日本語フォントを準備しています（初回のみ・約30秒）")
        prepare_fonts_in_background()
        try:
            self._translate()
            return self._finish()
        except Exception:
            self._put_back_earlier_pages()
            self.library.update(self.paper_id, status=translation_status(resumable=bool(self.done)))
            raise

    # --- 1. What to translate ---

    def _select_pages(self) -> None:
        """The pages asked for, with those their sentences continue on, and the paper's units."""
        self.folder = self.library.folder(self.paper_id)
        self.files = PaperFiles(self.folder)
        document = self.document = self.library.document(self.paper_id)
        selected = set(range(1, document["page_count"] + 1)) if self.pages is None else set(self.pages)
        if not selected or any(type(p) is not int or not 1 <= p <= document["page_count"] for p in selected):
            raise ValueError(f"翻訳するページは1～{document['page_count']}の範囲で指定してください。")
        units = self.units = translation_units(document)
        glossary = effective_glossary(self.library, self.paper_id)
        self.glossary_key = json.dumps(glossary, ensure_ascii=False, sort_keys=True)
        apply_glossary(units, glossary)
        if not units:
            raise ValueError(needs_ocr_message(document) or "翻訳対象の文字が見つかりませんでした。")
        self.requested = set(selected)
        self.selected = expand_pages(units, selected)
        if self.selected != self.requested:
            self.progress('文の続きを含むページも翻訳します：' + ', '.join(f'p.{p}' for p in sorted(self.selected - self.requested)))

    def _reuse_saved_translations(self) -> None:
        """The saved translations still current (TranslationKey), the retry budget, and the replacements."""
        document, units, replacements = self.document, self.units, self.replacements
        settings = self.settings = self.provider.settings
        # Read once: the prompt that keys the cache is the one sent with this run's requests.
        self.instruction = prompts.load("translation")
        # Effort controls future requests, not cache identity: changing it must not
        # discard completed translations or reset recovery attempt limits. Neither does
        # code: pages are redrawn from saved translations (TranslationKey).
        key = TranslationKey.current(settings, self.instruction, units)
        self.fingerprint, self.version = key.fingerprint, key.identity
        self.cache_path = self.files.translation_cache
        cache = self.files.read_json(self.cache_path, {})
        compatible = key.matches_cache(cache)
        done = self.done = dict(cache.get("translations", {})) if compatible else {}
        self.retry_state = RetryState.from_cache(cache.get("retry_state") if compatible else None)
        source_pages = self.source_pages = {n: [u for u in units if n in unit_pages(u)]
                                            for n in range(1, document["page_count"] + 1)}
        self.page_keys = {n: page_fingerprint(values) for n, values in source_pages.items()}
        # Keep historical page records without treating stale entries as current.
        self.completed_pages = dict(cache.get("completed_pages", {}))
        # Pages taken only to apply paragraph revisions keep the key and model they were
        # translated with: the revision does not make them translations of the current key.
        self.revised_only = set()
        current_ids = set(done)
        for number, page_units in source_pages.items():
            entry = cache.get("completed_pages", {}).get(str(number), {})
            reusable = key.matches_page(entry)
            source_matches = (same_page_source(entry, page_units) if replacements else entry.get("source") == self.page_keys[number])
            if ((reusable or (replacements and number in self.selected)) and source_matches
                    and all(u["id"] in entry.get("translations", {}) for u in page_units)):
                done.update(entry["translations"])
                self.completed_pages[str(number)] = entry
                if reusable:
                    current_ids.update(entry["translations"])
                else:
                    self.revised_only.add(number)
        # Nor do their paragraphs join the current key's translations kept for unfinished pages.
        self.foreign_ids = {u["id"] for n in self.revised_only for u in source_pages[n]} - current_ids
        if replacements:
            by_id = {unit["id"]: unit for unit in units}
            for identity, text in replacements.items():
                if identity not in by_id or identity not in done:
                    raise ValueError("この段落の原文または辞書が変更されています。先に再翻訳してください。")
                done[identity] = validate_revision(by_id[identity]["text"], text)

    def _plan_requests(self) -> None:
        """The paragraphs sharing a translation, the pages needing no request, and the batches to send."""
        document, units, done, selected = self.document, self.units, self.done, self.selected
        # A source text found more than once (a running head on every page) is translated once.
        # A translation revised by hand (now or earlier) applies to its own paragraph only.
        try:
            history = self.files.read_json(self.files.translation_revisions, [])
        except ValueError:  # A damaged history only loses this exclusion; translation goes on.
            history = []
        revised = set(self.replacements or ()) | {entry.get("unit_id")
                                                  for entry in (history if isinstance(history, list) else [])
                                                  if isinstance(entry, dict)}
        marginal_blocks = {b["id"] for b in translation_blocks(document) if b.get("reading_margin") or b.get("running_header")}
        known = len(done)
        self.copies, self.followers = shared_translations(
            units, [u for u in units if unit_pages(u) & selected], done,
            self.foreign_ids | revised, {u["id"] for u in units if u["block"] in marginal_blocks})
        if len(done) > known or self.followers:
            self.progress(f"同じ原文の段落は訳を使い回します（AIに送らない段落：{len(done) - known + len(self.followers)}件）")
        self.already_done = {n for n in selected if self.source_pages[n]
                             and all(u["id"] in done for u in self.source_pages[n])}
        if self.already_done:
            self.progress("保存済みの訳文を使うページ（AIには送りません）：" +
                          ", ".join(f"p.{n}" for n in sorted(self.already_done)))
        # Context is request-only: adding it must not invalidate translations or
        # reset the retry budget of an otherwise unchanged document. So is the paper's
        # title and abstract sent with every request.
        units = self.units = contextual_units(document, units)
        self.paper = paper_context(document)
        self.selected_units = [unit for unit in units if unit_pages(unit) & selected]
        self.by_page = {number: [u for u in units if number in unit_pages(u)]
                        for number in range(1, document["page_count"] + 1)}
        self.chunks = [chunk for number in sorted({u['page'] for u in self.selected_units})
                       for chunk in batches([u for u in self.selected_units if u['page'] == number
                                             and u['id'] not in done and u['id'] not in self.followers])]
        self.preview = {"fingerprint": self.fingerprint, "run_id": uuid.uuid4().hex,
                        "requested_pages": sorted(self.requested), "pages": [], "skipped_pages": [], "page_errors": {},
                        "target_pages": sorted(selected), "total_pages": document["page_count"], "complete": False}
        self.preview_path = self.files.translation_preview

    # --- 2. Earlier translations ---

    def _previous_page(self, number: int) -> Path:
        return self.run_folder / f"previous-page-{number}.pdf"

    def _keep_earlier_pages(self) -> None:
        """Copy the pages translated earlier into this run's folder, and archive the cache it replaces."""
        folder, preview, selected = self.folder, self.preview, self.selected
        # Rendered pages remain valid reading material even when extraction IDs,
        # provider settings or code versions invalidate their translation cache.
        earlier = set(translated_page_numbers(folder, self.document["page_count"]))
        retained = self.retained = earlier - selected
        # Earlier translations of the selected pages, put back if this run stops before redoing them.
        self.superseded = earlier & selected
        self.run_folder = preview_page(folder, preview, 1).parent
        for number in sorted(earlier):
            source, index = translated_page(folder, number - 1)
            if source is None:
                continue
            destination = preview_page(folder, preview, number) if number in retained else self._previous_page(number)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with PDF_LOCK, fitz.open(source) as previous, fitz.open() as single:
                single.insert_pdf(previous, from_page=index, to_page=index)
                single.save(destination)
        files = self.files
        self.previous_markdown = files.translation_md.read_text("utf-8") if files.translation_md.exists() else ""
        previous_report_path = files.translation_report
        self.previous_report = json.loads(previous_report_path.read_text("utf-8")) if previous_report_path.exists() else {}
        preview["pages"] = sorted(retained)
        preview["preserved_pages"] = sorted(retained)
        # Archive the old cache before replacing it, including legacy records
        # that predate the per-page cache format.
        if self.cache_path.exists():
            archive = preview_page(folder, preview, 1).parent / PREVIOUS_CACHE
            archive.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(self.cache_path, archive)

    def _put_back_earlier_pages(self) -> None:
        """After an error: the earlier pages this run did not make again are shown again."""
        folder, preview = self.folder, self.preview
        try:
            restored = sorted(n for n in self.superseded if n not in preview["pages"]
                              and n not in preview["skipped_pages"] and self._previous_page(n).is_file())
            for number in restored:
                self._previous_page(number).replace(preview_page(folder, preview, number))
                preview["pages"].append(number)
            for number in self.superseded - set(restored):
                self._previous_page(number).unlink(missing_ok=True)
            if restored:
                atomic_write_json(self.preview_path, preview)
                self.page_ready(self.paper_id, 0)
            # Keeps the run the saved preview names: this one once its preview was written, else
            # the previous one, whose pages the reader still shows (this run's copies go instead).
            remove_unused_runs(folder)
        except OSError:
            pass

    # --- 3. Translating, and the pages made meanwhile ---

    def _skipped(self, unit: dict) -> bool:
        # A unit taking another's translation is given up with the unit sent for it.
        return unit["id"] not in self.done and self.retry_state.exhausted(self.followers.get(unit["id"], unit))

    def _ready_pages(self) -> dict[int, dict[str, list[str]]]:
        """The pages whose paragraphs are all translated or given up, not made yet, with their text."""
        preview, done = self.preview, self.done
        with self.lock:
            pages = {}
            for number, page_units in self.by_page.items():
                if not page_units and number not in self.selected:
                    continue
                if (number in preview["pages"] or number in preview["skipped_pages"]
                        or any(u["id"] not in done and not self._skipped(u) for u in page_units)):
                    continue
                block_text = {}
                for unit in page_units:
                    block_text.setdefault(unit["block"], []).append(done.get(unit["id"], unit["text"]))
                pages[number] = block_text
            return pages

    def _publish_ready(self) -> None:
        # On this thread only: while pages are made, the translation workers go on (_accept only records;
        # the saves come with the next record).
        preview = self.preview
        for number, block_text in self._ready_pages().items():
            check_cancel(self.cancel)
            self.progress(f"p.{number} の日本語PDFを作成しています…")
            try:
                build_translated_pdf(self.files.original_pdf, self.document,
                    {key: join_unit_translations(parts) for key, parts in block_text.items()},
                    preview_page(self.folder, preview, number), page_numbers={number})
            except Exception as error:
                if isinstance(error, OSError):
                    raise
                check_cancel(self.cancel)
                preview["skipped_pages"].append(number)
                preview["page_errors"][str(number)] = str(error)
                atomic_write_json(self.preview_path, preview)
                self.page_ready(self.paper_id, number)
                self.progress(f"p.{number} のPDF生成に失敗したためスキップし、次のページへ進みます：{error}")
                continue
            preview["pages"].append(number)
            atomic_write_json(self.preview_path, preview)
            self.page_ready(self.paper_id, number)
            self.progress(f"翻訳ページを表示できます：p.{number}（{len(preview['pages'])}/{self.document['page_count']}ページ完了）")

    def _save(self) -> None:
        """Write translation-cache.json with the retry records and every translation so far.

        Each translation is written once: with its completed page ("completed_pages", which
        the next run reuses page by page and search and the reader read), or at the top
        ("translations") while its page is unfinished (stored_translations reads both).
        Caches of earlier versions also held every translation at the top; this code reads
        them as before, and those versions read this format with the same result: the pages
        of this key come back from "completed_pages" (see _reuse_saved_translations).
        The glossary in effect is written once at the top too; earlier versions repeated it
        on every page (a library glossary of a few kilobytes made up half of a long paper's
        file) and read it nowhere: the page's source (page_fingerprint) holds its terms.
        """
        done, completed_pages = self.done, self.completed_pages
        paged = set()  # Paragraphs written with a completed page of this key.
        for number, page_units in self.source_pages.items():
            if page_units and all(u["id"] in done for u in page_units):
                origin = completed_pages[str(number)] if number in self.revised_only else {}
                completed_pages[str(number)] = {
                    "version": origin.get("version", self.version), "source": self.page_keys[number],
                    "raw_source": page_source_fingerprint(self.source_pages[number]),
                    "model": origin.get("model", self.settings.model),
                    "translations": {u["id"]: done[u["id"]] for u in page_units}}
                if number not in self.revised_only:
                    paged.update(u["id"] for u in page_units)
        # Without indentation: only the app reads it, and it is written again for every batch.
        atomic_write_json(self.cache_path, {"fingerprint": self.fingerprint,
                                            "translations": {k: v for k, v in done.items()
                                                             if k not in self.foreign_ids and k not in paged},
                                            "translation_version": self.version,
                                            "model": self.settings.model,
                                            "glossary": self.glossary_key,
                                            "completed_pages": completed_pages,
                                            "retry_state": self.retry_state.to_cache()}, indent=None)
        self.unsaved = False

    def _accept(self, values: dict[str, str]) -> None:
        # Holding `lock`, from translate_batches' workers when translating in parallel. The
        # pages are made once their batch is done (_finished), on this thread.
        self.done.update(values)
        for identity, text in values.items():
            self.done.update(dict.fromkeys(self.copies.get(identity, ()), text))
        # Written with the next save rather than at once: the record of the next request is
        # saved (with everything) before it goes out, which is right away while batches wait
        # to be sent; otherwise _finished and the end or stop of the run write it (_flush).
        # A crash in between loses the answers taken since the last write, those of the last
        # batch or, in parallel, of the last few: their blocks are still on record as sent
        # without an answer (RetryState.unanswered), so resuming sends them again (counting
        # towards MAX_UNANSWERED_SENDS, not towards the retries).
        self.unsaved = True

    def _flush(self) -> None:
        with self.lock:
            if self.unsaved:
                self._save()

    def _report_progress(self) -> None:
        with self.lock:
            completed_units = sum(u["id"] in self.done for u in self.selected_units)
        parallel = f"（同時{self.concurrency}件）" if self.concurrency > 1 else ""
        self.progress(f"翻訳 {self.finished_chunks}/{len(self.chunks)}{parallel} — "
                      f"指定ページの完了 {completed_units}/{len(self.selected_units)} ブロック")

    def _finished(self, _index: int) -> None:
        self.finished_chunks += 1
        if len(self.chunks) - self.finished_chunks < self.concurrency:
            # No batch waits for the worker this one freed, so no record comes to write
            # what _accept took: written now, not only when the slowest batch is done.
            self._flush()
        # Translating one batch at a time, the page this batch completed is shown before its
        # translations are written: the next batch's record writes them a few milliseconds
        # later (after the page PDF is made). Until then the cache lacks the page, so search
        # and copying its text find nothing for it, and a crash sends it again (_accept).
        self._publish_ready()
        self._report_progress()

    def _translate(self) -> None:
        """Send the batches, making each page once its paragraphs are done; the cache is written throughout."""
        self._save()
        atomic_write_json(self.preview_path, self.preview)
        self.page_ready(self.paper_id, 0)
        self._publish_ready()
        self.concurrency = min(self.settings.translation_requests(), max(1, len(self.chunks)))
        self.finished_chunks = 0
        check_cancel(self.cancel)
        self._report_progress()
        try:
            translate_batches(self.provider, self.chunks, self.cancel, self.progress, self._accept, self.retry_state,
                              self._save, concurrency=self.concurrency, finished=self._finished,
                              instruction=self.instruction, paper=self.paper, lock=self.lock)
        except BaseException as error:
            # Also on KeyboardInterrupt or SystemExit: the translations taken are written first.
            try:
                self._flush()
            except Exception:  # noqa: BLE001, S110 - the error that stopped the run is the one to report.
                pass
            # Stopped by an error: batches answered while the run was stopping are saved but not
            # finished, so their pages are made now (not after a cancel, which should end at once).
            if isinstance(error, Exception) and not self.cancel.is_set():
                try:
                    self._publish_ready()
                except Exception:  # noqa: BLE001, S110 - the error that stopped the run is the one to report.
                    pass
            raise
        self._flush()
        check_cancel(self.cancel)

    # --- 4. translated.pdf, the report and translation.md ---

    def _finish(self) -> dict:
        """Make translated.pdf, the report and translation.md of this run and the pages kept; returns the report."""
        preview, retained = self.preview, self.retained
        self._drop_pages_of_failed_sentences()
        block_text = {}
        for unit in self.units:
            if not unit_pages(unit) & (set(preview["pages"]) - retained):
                continue
            block_text.setdefault(unit["block"], []).append(self.done.get(unit["id"], unit["text"]))
        translated = {key: join_unit_translations(parts) for key, parts in block_text.items()}
        self.progress("日本語PDFを作成しています…")
        report = self._assemble_pdf(translated)
        self._write_report(report)
        preview["complete"] = True
        atomic_write_json(self.preview_path, preview)
        self.page_ready(self.paper_id, self.document["page_count"])
        self._write_markdown(translated)
        self.library.update(self.paper_id, status=translation_status(report=report))
        # The reader now shows translated.pdf: the page previews, the earlier pages kept for a
        # stop and the staging files of this run go too, and only the replaced cache stays.
        remove_unused_runs(self.folder)
        return report

    def _drop_pages_of_failed_sentences(self) -> None:
        # A shared sentence must not be published with half its destinations
        # missing. Retain cached translations for retry, but restore all
        # dependent pages to their originals if any destination failed.
        preview = self.preview
        failed_dependencies = expand_pages(self.units, set(preview['skipped_pages']))
        for number in sorted(failed_dependencies - set(preview['skipped_pages'])):
            if number in preview['pages']:
                preview['pages'].remove(number)
            preview['skipped_pages'].append(number)
            preview['page_errors'][str(number)] = '文がつながる別ページのPDF生成に失敗したため、まとめて再開対象にしました。'
            atomic_write_json(self.preview_path, preview)
            self.page_ready(self.paper_id, number)

    def _assemble_pdf(self, translated: dict[str, str]) -> dict:
        """translated.pdf from this run's pages and the pages kept; returns build_translated_pdf's report."""
        folder, preview, retained = self.folder, self.preview, self.retained
        # Drawn again in one pass rather than joined from the page PDFs made above: joining takes
        # almost no time, but every page PDF embeds its own subset of the Japanese font, and the
        # joined file came out about 1.5 times as large (12 pages: 2.1 MB drawn, 3.2 MB joined,
        # the same text); this pass also gives the report (readability warnings and so on).
        staged = preview_page(folder, preview, 1).parent / "assembled.pdf"
        report = build_translated_pdf(self.files.original_pdf, self.document, translated, staged,
                                      translate_page_numbers=set(preview["pages"]) - retained)
        if retained:
            with PDF_LOCK, fitz.open(staged) as assembled:
                for number in sorted(retained):
                    with fitz.open(preview_page(folder, preview, number)) as previous:
                        assembled.delete_page(number - 1)
                        assembled.insert_pdf(previous, start_at=number - 1)
                merged = staged.with_name("merged.pdf")
                assembled.save(merged)
            replace_file(merged, staged)
        replace_file(staged, self.files.translated_pdf)
        # The interleaved PDF is built when it is opened or exported (exports.interleaved_cache).
        exports.discard_interleaved(self.files)
        return report

    def _write_report(self, report: dict) -> None:
        """Complete build_translated_pdf's report with this run's pages and those kept, and write it."""
        units, preview, retained, previous_report = self.units, self.preview, self.retained, self.previous_report
        made = set(preview["pages"]) - retained
        report["skipped_blocks"] = [u["id"] for u in units if unit_pages(u) & made and self._skipped(u)]
        previous_skipped = set(previous_report.get("skipped_blocks", []))
        report["skipped_blocks"] += [u["id"] for u in units if u["id"] in previous_skipped and unit_pages(u) <= retained]
        skipped_ids = set(report["skipped_blocks"])
        report["skipped_block_pages"] = sorted({page for unit in units if unit["id"] in skipped_ids for page in unit_pages(unit)})
        report["readability_warnings"] = report.get("readability_warnings", []) + [
            item for item in previous_report.get("readability_warnings", []) if item.get("page") in retained]
        # Paragraphs whose glossary rendering the translation lacks, for review (kept for kept pages).
        report["glossary_warnings"] = glossary_warnings(
            [u for u in units if unit_pages(u) & made and u["id"] in self.done], self.done)
        report["glossary_warnings"] += kept_glossary_warnings(
            previous_report.get("glossary_warnings", []), {u["id"]: u for u in units if unit_pages(u) <= retained})
        report["requested_pages"] = sorted(self.requested)
        report["translation_version"] = self.version
        # The code that drew this run's pages; preserved pages keep their earlier drawing.
        report["render_version"] = loaded_version()
        report["already_translated_pages"] = sorted(self.already_done)
        report["selected_pages"] = sorted(self.selected)
        report["preserved_pages"] = sorted(retained)
        report["translated_pages"] = sorted(preview["pages"])
        report["untranslated_pages"] = sorted(set(self.by_page) - set(preview["pages"]))
        report["skipped_pages"] = sorted(preview["skipped_pages"])
        report["page_errors"] = preview["page_errors"]
        report["model"] = self.settings.model
        report["usage"] = self.usage()
        atomic_write_json(self.files.translation_report, report)

    def _write_markdown(self, translated: dict[str, str]) -> None:
        """Write translation.md: the sections of the pages kept, then this run's pages."""
        document, preview, retained = self.document, self.preview, self.retained
        lines = [f"# {document['title']} — 日本語訳", "", *ocr_markdown_note(document)]
        for section in re.split(r"(?=^## p\.\d+ / )", self.previous_markdown, flags=re.M):
            match = re.match(r"## p\.(\d+) / ", section)
            if match and int(match[1]) in retained:
                lines += [section.rstrip(), ""]
        rendered_document, rendered_text = materialize_flows(document, translated)
        for block in rendered_document["blocks"]:
            if block['page'] not in preview['pages'] or block['page'] in retained:
                continue
            if block["id"] in rendered_text:
                lines += [f"## p.{block['page']} / {block['id']}", "",
                          restore_formula_text(resolve_unit_joins(rendered_text[block["id"]]), block), ""]
            elif block.get("kind") in {"formula", "table", "reference", "figure", "algorithm"} and block["page"] in preview["pages"]:
                lines += [f"## p.{block['page']} / {block['id']}", "", block["text"], ""]
        atomic_write_text(self.files.translation_md, "\n".join(lines))
