from __future__ import annotations

import json
from pathlib import Path
import re
import threading
import uuid
import shutil
from typing import Callable

from papeer.core.fileio import atomic_write_bytes, atomic_write_json, atomic_write_text, replace_file
from papeer.pdf.pdf_engine import PDF_LOCK, batches, build_translated_pdf, translation_units
import pymupdf as fitz
from papeer.providers import ProviderBackend, check_cancel
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library
from papeer.layout.math_layout import restore_formula_text
from papeer.layout.ocr_pages import needs_ocr_message, ocr_markdown_note
from papeer.translation.translation import RetryState, TranslationKey, shared_translations, translate_batches, page_fingerprint
from papeer.core.code_version import loaded_version
from papeer.translation.translation_preview import PREVIOUS_CACHE, preview_page, remove_unused_runs, translated_page, translated_page_numbers
from papeer.translation.translation_context import contextual_units, paper_context
from papeer.layout.reading_flow import unit_pages, expand_pages, materialize_flows, translation_blocks, join_unit_translations, resolve_unit_joins
from papeer.core.summary_figures import summary_figures
from papeer.core import exports, prompts
from papeer.core.terminology import effective_glossary, apply_glossary, validate_revision, glossary_for_folder, glossary_warnings, kept_glossary_warnings


def link_citations(answer: str, allowed: dict[str, int]) -> str:
    """Only turn validated document/page identifiers into navigable internal links."""
    def replace(match):
        content = match.group(1)
        parts = content.split(',')
        links = []
        current_id = None
        for part in parts:
            part = part.strip()
            m = re.match(r'([0-9a-f]{32}):(.*)', part)
            if m:
                current_id = m.group(1)
                page_str = m.group(2)
            else:
                page_str = part
            if not current_id:
                continue
            pages = re.findall(r'\d+', page_str)
            for p in pages:
                page = int(p)
                if current_id in allowed and 1 <= page <= allowed[current_id]:
                    links.append(f"[p.{page}](papeer://{current_id}/{page})")
                else:
                    links.append(f"[参照未確認: {current_id[:8]} p.{page}]")
        if links:
            # The frontend renders each link as a label, so no surrounding brackets.
            return " ".join(links)
        return f"[{content}]"
    return re.sub(r"\[([0-9a-f]{32}:[^\[\]]+)\]", replace, answer)


def cached_translations(folder: Path, document: dict) -> tuple[list[dict], dict[str, str]]:
    """The paper's units (with their glossary) and the saved translations of those still current.

    Cached pages count only while they match the current extraction: after a re-extraction
    the math tokens of renumbered blocks would resolve to other formulas.
    """
    units = translation_units(document)
    apply_glossary(units, glossary_for_folder(folder))
    cache = PaperFiles.read_json(PaperFiles(folder).translation_cache, {})
    done = {}
    for number, entry in cache.get("completed_pages", {}).items():
        page_units = [u for u in units if int(number) in unit_pages(u)]
        if page_units and entry.get("source") == page_fingerprint(page_units):
            done.update(entry.get("translations", {}))
    return units, done


def page_translation_text(folder: Path, document: dict, page: int,
                          cached: tuple[list[dict], dict[str, str]] | None = None) -> list[str]:
    """Translated blocks of one page with inline math as text.

    The translated PDF draws inline math as images, so text copied from it lacks the formulas.
    `cached` is cached_translations(folder, document), for a caller reading several pages.
    """
    units, done = cached or cached_translations(folder, document)
    started = {u["block"] for u in units if u["id"] in done}
    block_text = {}
    for unit in units:
        if unit["block"] in started:
            block_text.setdefault(unit["block"], []).append(done.get(unit["id"], unit["text"]))
    rendered_document, rendered_text = materialize_flows(
        document, {key: join_unit_translations(parts) for key, parts in block_text.items()})
    blocks = [restore_formula_text(resolve_unit_joins(rendered_text[b["id"]]), b) for b in rendered_document["blocks"]
              if b["page"] == page and b["id"] in rendered_text]
    if blocks:
        return blocks
    # Otherwise the last completed translation.
    return [text for number, _, text in PaperFiles(folder).translation_sections() if number == page and text]


class PaperService:
    def __init__(self, library: Library, provider: ProviderBackend, cancel: threading.Event,
                 progress: Callable[[str], None] = lambda _: None,
                 page_ready: Callable[[str, int], None] = lambda *_: None):
        self.library, self.provider = library, provider
        self.cancel, self.progress = cancel, progress
        self.page_ready = page_ready

    def usage(self) -> dict | None:
        """Tokens this job has used so far, when the provider can tell."""
        report = getattr(self.provider, "usage_report", None)
        return report() if report else None

    def translate(self, paper_id: str, pages: set[int] | None = None,
                  replacements: dict[str, str] | None = None) -> dict:
        folder = self.library.folder(paper_id)
        files = PaperFiles(folder)
        document = self.library.document(paper_id)
        selected = set(range(1, document["page_count"] + 1)) if pages is None else set(pages)
        if not selected or any(type(p) is not int or not 1 <= p <= document["page_count"] for p in selected):
            raise ValueError(f"翻訳するページは1～{document['page_count']}の範囲で指定してください。")
        units = translation_units(document)
        glossary = effective_glossary(self.library, paper_id)
        glossary_key = json.dumps(glossary, ensure_ascii=False, sort_keys=True)
        apply_glossary(units, glossary)
        if not units:
            raise ValueError(needs_ocr_message(document) or "翻訳対象の文字が見つかりませんでした。")
        requested = set(selected)
        selected = expand_pages(units, selected)
        if selected != requested:
            self.progress('文の続きを含むページも翻訳します：' + ', '.join(f'p.{p}' for p in sorted(selected - requested)))
        settings = self.provider.settings
        # Read once: the prompt that keys the cache is the one sent with this run's requests.
        instruction = prompts.load("translation")
        # Effort controls future requests, not cache identity: changing it must not
        # discard completed translations or reset recovery attempt limits. Neither does
        # code: pages are redrawn from saved translations (TranslationKey).
        key = TranslationKey.current(settings, instruction, units)
        fingerprint, version = key.fingerprint, key.identity
        cache_path = files.translation_cache
        cache = files.read_json(cache_path, {})
        compatible = key.matches_cache(cache)
        done = dict(cache.get("translations", {})) if compatible else {}
        retry_state = RetryState.from_cache(cache.get("retry_state") if compatible else None)
        source_pages = {n: [u for u in units if n in unit_pages(u)]
                        for n in range(1, document["page_count"] + 1)}
        page_keys = {n: page_fingerprint(values) for n, values in source_pages.items()}
        # Keep historical page records without treating stale entries as current.
        completed_pages = dict(cache.get("completed_pages", {}))
        # Pages taken only to apply paragraph revisions keep the key and model they were
        # translated with: the revision does not make them translations of the current key.
        revised_only = set()
        current_ids = set(done)
        for number, page_units in source_pages.items():
            entry = cache.get("completed_pages", {}).get(str(number), {})
            reusable = key.matches_page(entry)
            if ((reusable or (replacements and number in selected)) and entry.get("source") == page_keys[number]
                    and all(u["id"] in entry.get("translations", {}) for u in page_units)):
                done.update(entry["translations"])
                completed_pages[str(number)] = entry
                if reusable:
                    current_ids.update(entry["translations"])
                else:
                    revised_only.add(number)
        # Nor do their paragraphs join the current key's translations kept for unfinished pages.
        foreign_ids = {u["id"] for n in revised_only for u in source_pages[n]} - current_ids
        if replacements:
            by_id = {unit["id"]: unit for unit in units}
            for identity, text in replacements.items():
                if identity not in by_id or identity not in done:
                    raise ValueError("この段落の原文または辞書が変更されています。先に再翻訳してください。")
                done[identity] = validate_revision(by_id[identity]["text"], text)
        # A source text found more than once (a running head on every page) is translated once.
        # A translation revised by hand (now or earlier) applies to its own paragraph only.
        try:
            history = files.read_json(files.translation_revisions, [])
        except ValueError:  # A damaged history only loses this exclusion; translation goes on.
            history = []
        revised = set(replacements or ()) | {entry.get("unit_id") for entry in (history if isinstance(history, list) else [])
                                            if isinstance(entry, dict)}
        marginal_blocks = {b["id"] for b in translation_blocks(document) if b.get("reading_margin") or b.get("running_header")}
        known = len(done)
        copies, followers = shared_translations(units, [u for u in units if unit_pages(u) & selected], done,
                                                foreign_ids | revised, {u["id"] for u in units if u["block"] in marginal_blocks})
        if len(done) > known or followers:
            self.progress(f"同じ原文の段落は訳を使い回します（AIに送らない段落：{len(done) - known + len(followers)}件）")
        already_done = {n for n in selected if source_pages[n]
                        and all(u["id"] in done for u in source_pages[n])}
        if already_done:
            self.progress("保存済みの訳文を使うページ（AIには送りません）：" +
                          ", ".join(f"p.{n}" for n in sorted(already_done)))
        # Context is request-only: adding it must not invalidate translations or
        # reset the retry budget of an otherwise unchanged document. So is the paper's
        # title and abstract sent with every request.
        units = contextual_units(document, units)
        paper = paper_context(document)
        selected_units = [unit for unit in units if unit_pages(unit) & selected]
        by_page = {number: [u for u in units if number in unit_pages(u)]
                   for number in range(1, document["page_count"] + 1)}
        chunks = [chunk for number in sorted({u['page'] for u in selected_units})
                  for chunk in batches([u for u in selected_units if u['page'] == number
                                        and u['id'] not in done and u['id'] not in followers])]
        preview = {"fingerprint": fingerprint, "run_id": uuid.uuid4().hex,
                   "requested_pages": sorted(requested), "pages": [], "skipped_pages": [], "page_errors": {}, "target_pages": sorted(selected),
                   "total_pages": document["page_count"], "complete": False}
        preview_path = files.translation_preview
        # Rendered pages remain valid reading material even when extraction IDs,
        # provider settings or code versions invalidate their translation cache.
        earlier = set(translated_page_numbers(folder, document["page_count"]))
        retained = earlier - selected
        # Earlier translations of the selected pages, put back if this run stops before redoing them.
        superseded = earlier & selected
        run_folder = preview_page(folder, preview, 1).parent

        def previous_page(number):
            return run_folder / f"previous-page-{number}.pdf"

        for number in sorted(earlier):
            source, index = translated_page(folder, number - 1)
            if source is None:
                continue
            destination = preview_page(folder, preview, number) if number in retained else previous_page(number)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with PDF_LOCK, fitz.open(source) as previous, fitz.open() as single:
                single.insert_pdf(previous, from_page=index, to_page=index)
                single.save(destination)
        previous_markdown = files.translation_md.read_text("utf-8") if files.translation_md.exists() else ""
        previous_report_path = files.translation_report
        previous_report = json.loads(previous_report_path.read_text("utf-8")) if previous_report_path.exists() else {}
        preview["pages"] = sorted(retained)
        preview["preserved_pages"] = sorted(retained)
        # Archive the old cache before replacing it, including legacy records
        # that predate the per-page cache format.
        if cache_path.exists():
            archive = preview_page(folder, preview, 1).parent / PREVIOUS_CACHE
            archive.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cache_path, archive)
        self.library.update(paper_id, status="翻訳中")
        try:
            def skipped(unit):
                # A unit taking another's translation is given up with the unit sent for it.
                return unit["id"] not in done and retry_state.exhausted(followers.get(unit["id"], unit))

            def publish_ready():
                for number, page_units in by_page.items():
                    if not page_units and number not in selected:
                        continue
                    if (number in preview["pages"] or number in preview["skipped_pages"]
                            or any(u["id"] not in done and not skipped(u) for u in page_units)):
                        continue
                    check_cancel(self.cancel)
                    block_text = {}
                    for unit in page_units:
                        block_text.setdefault(unit["block"], []).append(done.get(unit["id"], unit["text"]))
                    self.progress(f"p.{number} の日本語PDFを作成しています…")
                    try:
                        build_translated_pdf(files.original_pdf, document,
                            {key: join_unit_translations(parts) for key, parts in block_text.items()},
                            preview_page(folder, preview, number), page_numbers={number})
                    except Exception as error:
                        if isinstance(error, OSError):
                            raise
                        check_cancel(self.cancel)
                        preview["skipped_pages"].append(number)
                        preview["page_errors"][str(number)] = str(error)
                        atomic_write_json(preview_path, preview)
                        self.page_ready(paper_id, number)
                        self.progress(f"p.{number} のPDF生成に失敗したためスキップし、次のページへ進みます：{error}")
                        continue
                    preview["pages"].append(number)
                    atomic_write_json(preview_path, preview)
                    self.page_ready(paper_id, number)
                    self.progress(f"翻訳ページを表示できます：p.{number}（{len(preview['pages'])}/{document['page_count']}ページ完了）")

            def save():
                for number, page_units in source_pages.items():
                    if page_units and all(u["id"] in done for u in page_units):
                        origin = completed_pages[str(number)] if number in revised_only else {}
                        completed_pages[str(number)] = {
                            "version": origin.get("version", version), "source": page_keys[number], "glossary": glossary_key,
                            "model": origin.get("model", settings.model),
                            "translations": {u["id"]: done[u["id"]] for u in page_units}}
                atomic_write_json(cache_path, {"fingerprint": fingerprint,
                                       "translations": {k: v for k, v in done.items() if k not in foreign_ids},
                                       "translation_version": version,
                                       "model": settings.model,
                                       "completed_pages": completed_pages,
                                       "retry_state": retry_state.to_cache()})

            def accept(values):
                done.update(values)
                for identity, text in values.items():
                    done.update(dict.fromkeys(copies.get(identity, ()), text))
                save()
                publish_ready()

            save()
            atomic_write_json(preview_path, preview)
            self.page_ready(paper_id, 0)
            publish_ready()
            concurrency = min(settings.translation_requests(), max(1, len(chunks)))
            finished_chunks = 0

            def report_progress():
                completed_units = sum(u["id"] in done for u in selected_units)
                parallel = f"（同時{concurrency}件）" if concurrency > 1 else ""
                self.progress(f"翻訳 {finished_chunks}/{len(chunks)}{parallel} — "
                              f"指定ページの完了 {completed_units}/{len(selected_units)} ブロック")

            def finished(_index):
                nonlocal finished_chunks
                finished_chunks += 1
                publish_ready()
                report_progress()

            check_cancel(self.cancel)
            report_progress()
            translate_batches(self.provider, chunks, self.cancel, self.progress, accept, retry_state, save,
                              concurrency=concurrency, finished=finished, instruction=instruction, paper=paper)
            check_cancel(self.cancel)
            # A shared sentence must not be published with half its destinations
            # missing. Retain cached translations for retry, but restore all
            # dependent pages to their originals if any destination failed.
            failed_dependencies = expand_pages(units, set(preview['skipped_pages']))
            for number in sorted(failed_dependencies - set(preview['skipped_pages'])):
                if number in preview['pages']:
                    preview['pages'].remove(number)
                preview['skipped_pages'].append(number)
                preview['page_errors'][str(number)] = '文がつながる別ページのPDF生成に失敗したため、まとめて再開対象にしました。'
                atomic_write_json(preview_path, preview)
                self.page_ready(paper_id, number)
            block_text = {}
            for unit in units:
                if not unit_pages(unit) & (set(preview["pages"]) - retained):
                    continue
                block_text.setdefault(unit["block"], []).append(done.get(unit["id"], unit["text"]))
            translated = {key: join_unit_translations(parts) for key, parts in block_text.items()}
            self.progress("日本語PDFを作成しています…")
            staged = preview_page(folder, preview, 1).parent / "assembled.pdf"
            report = build_translated_pdf(files.original_pdf, document, translated, staged,
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
            replace_file(staged, files.translated_pdf)
            # The interleaved PDF is built when it is opened or exported (exports.interleaved_cache).
            exports.discard_interleaved(files)
            report["skipped_blocks"] = [u["id"] for u in units if unit_pages(u) & (set(preview["pages"]) - retained) and skipped(u)]
            previous_skipped = set(previous_report.get("skipped_blocks", []))
            report["skipped_blocks"] += [u["id"] for u in units if u["id"] in previous_skipped and unit_pages(u) <= retained]
            skipped_ids = set(report["skipped_blocks"])
            report["skipped_block_pages"] = sorted({page for unit in units if unit["id"] in skipped_ids for page in unit_pages(unit)})
            report["readability_warnings"] = report.get("readability_warnings", []) + [
                item for item in previous_report.get("readability_warnings", []) if item.get("page") in retained]
            # Paragraphs whose glossary rendering the translation lacks, for review (kept for kept pages).
            report["glossary_warnings"] = glossary_warnings(
                [u for u in units if unit_pages(u) & (set(preview["pages"]) - retained) and u["id"] in done], done)
            report["glossary_warnings"] += kept_glossary_warnings(
                previous_report.get("glossary_warnings", []), {u["id"]: u for u in units if unit_pages(u) <= retained})
            report["requested_pages"] = sorted(requested)
            report["translation_version"] = version
            # The code that drew this run's pages; preserved pages keep their earlier drawing.
            report["render_version"] = loaded_version()
            report["already_translated_pages"] = sorted(already_done)
            report["selected_pages"] = sorted(selected)
            report["preserved_pages"] = sorted(retained)
            report["translated_pages"] = sorted(preview["pages"])
            report["untranslated_pages"] = sorted(set(by_page) - set(preview["pages"]))
            report["skipped_pages"] = sorted(preview["skipped_pages"])
            report["page_errors"] = preview["page_errors"]
            report["model"] = settings.model
            report["usage"] = self.usage()
            atomic_write_json(files.translation_report, report)
            preview["complete"] = True
            atomic_write_json(preview_path, preview)
            self.page_ready(paper_id, document["page_count"])
            lines = [f"# {document['title']} — 日本語訳", "", *ocr_markdown_note(document)]
            for section in re.split(r"(?=^## p\.\d+ / )", previous_markdown, flags=re.M):
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
            atomic_write_text(files.translation_md, "\n".join(lines))
            self.library.update(paper_id, status="一部翻訳済み" if report["untranslated_pages"] or report["skipped_blocks"] else "翻訳済み")
            # The reader now shows translated.pdf: the page previews, the earlier pages kept for a
            # stop and the staging files of this run go too, and only the replaced cache stays.
            remove_unused_runs(folder)
            return report
        except Exception:
            try:
                restored = sorted(n for n in superseded if n not in preview["pages"]
                                  and n not in preview["skipped_pages"] and previous_page(n).is_file())
                for number in restored:
                    previous_page(number).replace(preview_page(folder, preview, number))
                    preview["pages"].append(number)
                for number in superseded - set(restored):
                    previous_page(number).unlink(missing_ok=True)
                if restored:
                    atomic_write_json(preview_path, preview)
                    self.page_ready(paper_id, 0)
                # Keeps the run the saved preview names: this one once its preview was written, else
                # the previous one, whose pages the reader still shows (this run's copies go instead).
                remove_unused_runs(folder)
            except OSError:
                pass
            self.library.update(paper_id, status="翻訳途中・再開可" if done else "翻訳未完了")
            raise

    def article(self, paper_id: str) -> str:
        folder = self.library.folder(paper_id)
        files = PaperFiles(folder)
        document = self.library.document(paper_id)

        # Text-only generation receives only crops bound to source captions.
        figures_by_page = {}
        figure_images = {}
        with PDF_LOCK, fitz.open(files.original_pdf) as pdf:
            for number in range(1, len(pdf) + 1):
                page = pdf[number - 1]
                page.set_rotation(0)
                for figure in summary_figures(page, document.get("blocks", []), number):
                    figure_images[f"{figure['id']}.png"] = page.get_pixmap(clip=figure["rect"], dpi=150).tobytes("png")
                    figures_by_page.setdefault(number, []).append(figure)
        # Same-named figures are overwritten in place, so the current article.md keeps its images
        # even if this run fails; captures pasted into notes share media/ and are never touched.
        files.media.mkdir(exist_ok=True)
        for name, data in figure_images.items():
            atomic_write_bytes(files.media / name, data)

        page_units = []
        images = []
        for page in document["pages"]:
            page_text = page["text"]
            for offset in range(0, max(1, len(page_text)), 10000):
                page_units.append({"id": f"p{page['number']}-{offset}", "page": page["number"],
                                   "text": page_text[offset:offset + 10000]})
            if page["number"] in figures_by_page:
                for figure in figures_by_page[page["number"]]:
                    image = f"![{figure['kind']} p.{page['number']}](media/{figure['id']}.png)"
                    caption = f" — {figure['caption']}" if figure["caption"] else ""
                    images.append(f"- {image} [{paper_id}:p{page['number']}]{caption}")
                    # Keep each image and its evidence together across chunk boundaries.
                    page_units.append({"id": figure["id"], "page": page["number"],
                                       "text": f"{image}{caption}"})
        chunks = list(batches(page_units, limit=18000, size=lambda chunk: sum(len(x["text"]) + 100 for x in chunk)))
        notes = []
        for index, chunk in enumerate(chunks):
            check_cancel(self.cancel)
            self.progress(f"サマリーの資料を整理 {index + 1}/{len(chunks)}")
            data = "\n\n".join(f"[{paper_id}:p{x['page']}]\n{x['text']}" for x in chunk)
            note = self.provider.generate(prompts.load("summary_notes"), data)
            notes.append(note)
        check_cancel(self.cancel)
        self.progress("日本語のサマリー記事を作成しています…")
        # The notes stage may still drop images, so the article stage also gets the full list.
        catalog = "\n\n## Available images\n" + "\n".join(images) if images else ""
        article = self.provider.generate(
            prompts.load("summary_article"),
            "\n\n".join(notes) + catalog)
        article = link_citations(article, {paper_id: document["page_count"]})
        atomic_write_text(files.article_md, article)
        for image in files.summary_images():
            if image.name not in figure_images:
                try:
                    image.unlink(missing_ok=True)
                except OSError:  # Locked on Windows (viewer, scan): the next successful run removes it.
                    pass
        usage_path = files.article_usage
        if usage := self.usage():
            atomic_write_json(usage_path, usage)
        else:
            usage_path.unlink(missing_ok=True)
        return article

    def ask(self, paper_id: str, question: str, entire_library: bool = False,
            paper_ids: set[str] | None = None, collection: str | None = None,
            attachments: list[dict] | None = None, reference_pages: set[int] | None = None,
            retrieval_query: str = "", max_pages: int = 10) -> str:
        question = question.strip()
        if not question:
            raise ValueError("メッセージを入力してください。")
        document = self.library.document(paper_id)
        attachments = [dict(item, text=item["text"].strip()[:4000]) for item in (attachments or [])[:20]
                       if item.get("text", "").strip()]
        for item in attachments:
            if item.get("side") not in {"original", "translated"} or not 1 <= int(item["page"]) <= document["page_count"]:
                raise ValueError("添付した箇所のページが不正です。")
        passages = [{"page": item["page"], "side": "原文" if item["side"] == "original" else "日本語訳",
                     "text": item["text"]} for item in attachments]
        # Attached passages say what the question is about, so they also steer the page search.
        search_text = " ".join([retrieval_query, question, *(item["text"][:500] for item in attachments)])
        all_text = "\n\n".join(f"[{paper_id}:p{x['number']}]\n{x['text']}" for x in document["pages"])
        allowed = {paper_id: document["page_count"]}
        context = all_text
        selection_note = "選択した論文の全文テキストを参照しています。"
        if collection is not None:
            paper_ids = {p["id"] for p in self.library.papers()
                         if p["collection_name"] == collection or p["collection_name"].startswith(collection + " / ")}
            if not paper_ids:
                raise ValueError("指定したフォルダーに論文がありません。")
        if paper_ids is not None:
            if not paper_ids or any(not re.fullmatch(r"[0-9a-f]{32}", item) for item in paper_ids):
                raise ValueError("参照する論文を選択してください。")
            for item in paper_ids:
                self.library.paper(item)
            allowed = {}
        scope_key = ("ids:" + ",".join(sorted(paper_ids)) if paper_ids is not None
                     else "all" if entire_library else "paper")
        if entire_library or paper_ids is not None or len(all_text) > 55000:
            self.progress("関連ページを検索しています…")
            keywords = self.provider.generate(prompts.load("chat_keywords"), search_text)
            pages = self.library.search_pages(keywords + " " + search_text,
                                              None if entire_library or paper_ids is not None else paper_id,
                                              limit=max_pages, paper_ids=paper_ids)
            if not pages:
                raise ValueError("参照できるページがありません。")
            context_parts = []
            for page in pages:
                allowed[page["paper_id"]] = self.library.paper(page["paper_id"])["pages"]
                context_parts.append(f"[{page['paper_id']}:p{page['number']}] {page['title']}\n" + page["text"][:6000])
            context = "\n\n".join(context_parts)
            references = []
            for page in pages:
                title = " ".join(re.sub(r"[][()!*_`<>]", "", page["title"]).split())[:80]
                references.append(f"[{title} p.{page['number']}]"
                                  f"(papeer://{page['paper_id']}/{page['number']})")
            selection_note = f"キーワード検索で選んだ{len(pages)}ページの抜粋を参照しています：{', '.join(references)}"
        if reference_pages:
            if any(not 1 <= page <= document["page_count"] for page in reference_pages):
                raise ValueError("追加参照ページが範囲外です。")
            allowed[paper_id] = document["page_count"]
            context += "\n\n" + "\n\n".join(f"[{paper_id}:p{x['number']}]\n{x['text']}"
                                                   for x in document["pages"] if x["number"] in reference_pages)
            selection_note += " 追加参照：" + ", ".join(f"[p.{page}](papeer://{paper_id}/{page})" for page in sorted(reference_pages))
        history = [{"role": item["role"], "content": item["content"] + "".join(
                        f"\n\n[添付 p.{x['page']}] {x['text'][:1000]}" for x in item.get("attachments", []))}
                   for item in self.library.messages(paper_id, scope=scope_key)[-6:]]
        self.progress("本文を参照して回答しています…")
        request = {"question": question, "previous_dialogue": history,
                   "retrieval_scope": selection_note, "evidence": context}
        if passages:
            request["attached_passages"] = passages
        answer = self.provider.generate(prompts.load("chat_answer"), json.dumps(request, ensure_ascii=False))
        answer = link_citations(answer, allowed) + "\n\n---\n*" + selection_note + "*"
        self.library.add_exchange(paper_id, question, answer, self.usage(), scope=scope_key,
                                  attachments=attachments)
        return answer
