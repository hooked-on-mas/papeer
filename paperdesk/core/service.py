from __future__ import annotations

import json
import time
from pathlib import Path

def safe_replace(src: Path, dst: Path) -> None:
    for _ in range(50):
        try:
            src.replace(dst)
            return
        except PermissionError:
            time.sleep(0.1)
    src.replace(dst)

import re
import threading
import uuid
import shutil
from typing import Callable

from paperdesk.pdf.pdf_engine import PDF_LOCK, batches, bilingual_pdf, interleaved_pdf, build_translated_pdf, save_json, translation_units
import pymupdf as fitz
from paperdesk.core.providers import Provider, check_cancel
from paperdesk.core.storage import Library
from paperdesk.layout.math_layout import restore_formula_text
from paperdesk.translation.translation import RetryState, translate_batches, translation_fingerprint
from paperdesk.translation.translation import translation_version, page_fingerprint
from paperdesk.translation.translation_preview import preview_page, translated_page, translated_page_numbers
from paperdesk.translation.translation_context import contextual_units
from paperdesk.layout.reading_flow import unit_pages, expand_pages, materialize_flows
from paperdesk.core import prompts


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
                    links.append(f"[p.{page}](paperdesk://{current_id}/{page})")
                else:
                    links.append(f"[参照未確認: {current_id[:8]} p.{page}]")
        if links:
            return f"[{', '.join(links)}]"
        return f"[{content}]"
    return re.sub(r"\[([0-9a-f]{32}:[^\[\]]+)\]", replace, answer)


def page_translation_text(folder: Path, document: dict, page: int) -> list[str]:
    """Translated blocks of one page with inline math as text.

    The translated PDF draws inline math as images, so text copied from it lacks the formulas.
    """
    units = translation_units(document)
    cache_path = folder / "translation-cache.json"
    cache = json.loads(cache_path.read_text("utf-8")) if cache_path.exists() else {}
    # Cached pages count only while they match the current extraction: after a re-extraction
    # the math tokens of renumbered blocks would resolve to other formulas.
    done = {}
    for number, entry in cache.get("completed_pages", {}).items():
        page_units = [u for u in units if int(number) in unit_pages(u)]
        if page_units and entry.get("source") == page_fingerprint(page_units):
            done.update(entry.get("translations", {}))
    started = {u["block"] for u in units if u["id"] in done}
    block_text = {}
    for unit in units:
        if unit["block"] in started:
            block_text.setdefault(unit["block"], []).append(done.get(unit["id"], unit["text"]))
    rendered_document, rendered_text = materialize_flows(
        document, {key: "\n".join(parts) for key, parts in block_text.items()})
    blocks = [restore_formula_text(rendered_text[b["id"]], b) for b in rendered_document["blocks"]
              if b["page"] == page and b["id"] in rendered_text]
    if blocks:
        return blocks
    # Otherwise the last completed translation, whose sections read "## p.<page> / <block id>".
    markdown_path = folder / "translation.md"
    if not markdown_path.is_file():
        return []
    parts = re.split(r"^## p\.(\d+) / \S+[ \t]*$", markdown_path.read_text("utf-8"), flags=re.M)
    return [body.strip() for number, body in zip(parts[1::2], parts[2::2]) if int(number) == page and body.strip()]


class PaperService:
    def __init__(self, library: Library, provider: Provider, cancel: threading.Event,
                 progress: Callable[[str], None] = lambda _: None,
                 page_ready: Callable[[str, int], None] = lambda *_: None):
        self.library, self.provider = library, provider
        self.cancel, self.progress = cancel, progress
        self.page_ready = page_ready

    def usage(self) -> dict | None:
        """Tokens this job has used so far, when the provider can tell."""
        report = getattr(self.provider, "usage_report", None)
        return report() if report else None

    def translate(self, paper_id: str, pages: set[int] | None = None) -> dict:
        folder = self.library.folder(paper_id)
        document = self.library.document(paper_id)
        selected = set(range(1, document["page_count"] + 1)) if pages is None else set(pages)
        if not selected or any(type(p) is not int or not 1 <= p <= document["page_count"] for p in selected):
            raise ValueError(f"翻訳するページは1～{document['page_count']}の範囲で指定してください。")
        units = translation_units(document)
        if not units:
            raise ValueError("翻訳対象の文字が見つかりませんでした。")
        requested = set(selected)
        selected = expand_pages(units, selected)
        if selected != requested:
            self.progress('文の続きを含むページも翻訳します：' + ', '.join(f'p.{p}' for p in sorted(selected - requested)))
        settings = self.provider.settings
        # Effort controls future requests, not cache identity: changing it must not
        # discard completed translations or reset recovery attempt limits.
        fingerprint = translation_fingerprint(settings, units)
        cache_path = folder / "translation-cache.json"
        cache = json.loads(cache_path.read_text("utf-8")) if cache_path.exists() else {}
        version = translation_version()
        compatible = (cache.get("fingerprint") == fingerprint
                      and cache.get("translation_version") == version)
        done = dict(cache.get("translations", {})) if compatible else {}
        retry_state = RetryState.from_cache(cache.get("retry_state") if compatible else None)
        source_pages = {n: [u for u in units if n in unit_pages(u)]
                        for n in range(1, document["page_count"] + 1)}
        page_keys = {n: page_fingerprint(values) for n, values in source_pages.items()}
        # Keep historical page records without treating stale entries as current.
        completed_pages = dict(cache.get("completed_pages", {}))
        for number, page_units in source_pages.items():
            entry = cache.get("completed_pages", {}).get(str(number), {})
            if (entry.get("version") == version and entry.get("source") == page_keys[number]
                    and all(u["id"] in entry.get("translations", {}) for u in page_units)):
                done.update(entry["translations"])
                completed_pages[str(number)] = entry
        already_done = {n for n in selected if source_pages[n]
                        and all(u["id"] in done for u in source_pages[n])}
        if already_done:
            self.progress("現バージョンで翻訳済みのページをスキップします：" +
                          ", ".join(f"p.{n}" for n in sorted(already_done)))
        # Context is request-only: adding it must not invalidate translations or
        # reset the retry budget of an otherwise unchanged document.
        units = contextual_units(document, units)
        selected_units = [unit for unit in units if unit_pages(unit) & selected]
        by_page = {number: [u for u in units if number in unit_pages(u)]
                   for number in range(1, document["page_count"] + 1)}
        chunks = [chunk for number in sorted({u['page'] for u in selected_units})
                  for chunk in batches([u for u in selected_units if u['page'] == number and u['id'] not in done])]
        preview = {"fingerprint": fingerprint, "run_id": uuid.uuid4().hex,
                   "requested_pages": sorted(requested), "pages": [], "skipped_pages": [], "page_errors": {}, "target_pages": sorted(selected),
                   "total_pages": document["page_count"], "complete": False}
        preview_path = folder / "translation-preview.json"
        # Rendered pages remain valid reading material even when extraction IDs,
        # provider settings or code versions invalidate their translation cache.
        retained = set(translated_page_numbers(folder, document["page_count"])) - selected
        for number in sorted(retained):
            source, index = translated_page(folder, number - 1)
            destination = preview_page(folder, preview, number)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with PDF_LOCK, fitz.open(source) as previous, fitz.open() as single:
                single.insert_pdf(previous, from_page=index, to_page=index)
                single.save(destination)
        previous_markdown = (folder / "translation.md").read_text("utf-8") if (folder / "translation.md").exists() else ""
        preview["pages"] = sorted(retained)
        preview["preserved_pages"] = sorted(retained)
        # Archive the old cache before replacing it, including legacy records
        # that predate the per-page cache format.
        if cache_path.exists():
            archive = preview_page(folder, preview, 1).parent / "previous-translation-cache.json"
            archive.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cache_path, archive)
        self.library.update(paper_id, status="翻訳中")
        try:
            def skipped(unit):
                return unit["id"] not in done and retry_state.exhausted(unit)

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
                        build_translated_pdf(folder / "original.pdf", document,
                            {key: "\n".join(parts) for key, parts in block_text.items()},
                            preview_page(folder, preview, number), page_numbers={number})
                    except Exception as error:
                        if isinstance(error, OSError):
                            raise
                        check_cancel(self.cancel)
                        preview["skipped_pages"].append(number)
                        preview["page_errors"][str(number)] = str(error)
                        save_json(preview_path, preview)
                        self.page_ready(paper_id, number)
                        self.progress(f"p.{number} のPDF生成に失敗したためスキップし、次のページへ進みます：{error}")
                        continue
                    preview["pages"].append(number)
                    save_json(preview_path, preview)
                    self.page_ready(paper_id, number)
                    self.progress(f"翻訳ページを表示できます：p.{number}（{len(preview['pages'])}/{document['page_count']}ページ完了）")

            def save():
                for number, page_units in source_pages.items():
                    if page_units and all(u["id"] in done for u in page_units):
                        completed_pages[str(number)] = {
                            "version": version, "source": page_keys[number],
                            "model": settings.model,
                            "translations": {u["id"]: done[u["id"]] for u in page_units}}
                save_json(cache_path, {"fingerprint": fingerprint, "translations": done,
                                       "translation_version": version,
                                       "model": settings.model,
                                       "completed_pages": completed_pages,
                                       "retry_state": retry_state.to_cache()})

            def accept(values):
                done.update(values)
                save()
                publish_ready()

            save()
            save_json(preview_path, preview)
            self.page_ready(paper_id, 0)
            publish_ready()
            concurrency = min(settings.translation_requests(), max(1, len(chunks)))
            finished_chunks = 0

            def report():
                completed_units = sum(u["id"] in done for u in selected_units)
                parallel = f"（同時{concurrency}件）" if concurrency > 1 else ""
                self.progress(f"翻訳 {finished_chunks}/{len(chunks)}{parallel} — "
                              f"指定ページの完了 {completed_units}/{len(selected_units)} ブロック")

            def finished(_index):
                nonlocal finished_chunks
                finished_chunks += 1
                publish_ready()
                report()

            check_cancel(self.cancel)
            report()
            translate_batches(self.provider, chunks, self.cancel, self.progress, accept, retry_state, save,
                              concurrency=concurrency, finished=finished)
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
                save_json(preview_path, preview)
                self.page_ready(paper_id, number)
            block_text = {}
            for unit in units:
                if not unit_pages(unit) & (set(preview["pages"]) - retained):
                    continue
                block_text.setdefault(unit["block"], []).append(done.get(unit["id"], unit["text"]))
            translated = {key: "\n".join(parts) for key, parts in block_text.items()}
            self.progress("日本語PDFを作成しています…")
            staged = preview_page(folder, preview, 1).parent / "assembled.pdf"
            report = build_translated_pdf(folder / "original.pdf", document, translated, staged,
                                          translate_page_numbers=set(preview["pages"]) - retained)
            if retained:
                with PDF_LOCK, fitz.open(staged) as assembled:
                    for number in sorted(retained):
                        with fitz.open(preview_page(folder, preview, number)) as previous:
                            assembled.delete_page(number - 1)
                            assembled.insert_pdf(previous, start_at=number - 1)
                    merged = staged.with_name("merged.pdf")
                    assembled.save(merged)
                safe_replace(merged, staged)
            safe_replace(staged, folder / "translated.pdf")
            self.progress("原文と日本語訳を交互に並べたPDFを作成しています…")
            interleaved_pdf(folder / "original.pdf", folder / "translated.pdf", folder / "interleaved.pdf")
            report["skipped_blocks"] = [u["id"] for u in units if unit_pages(u) & (set(preview["pages"]) - retained) and skipped(u)]
            report["requested_pages"] = sorted(requested)
            report["translation_version"] = version
            report["already_translated_pages"] = sorted(already_done)
            report["selected_pages"] = sorted(selected)
            report["preserved_pages"] = sorted(retained)
            report["translated_pages"] = sorted(preview["pages"])
            report["untranslated_pages"] = sorted(set(by_page) - set(preview["pages"]))
            report["skipped_pages"] = sorted(preview["skipped_pages"])
            report["page_errors"] = preview["page_errors"]
            report["model"] = settings.model
            report["usage"] = self.usage()
            save_json(folder / "translation-report.json", report)
            preview["complete"] = True
            save_json(preview_path, preview)
            self.page_ready(paper_id, document["page_count"])
            lines = [f"# {document['title']} — 日本語訳", ""]
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
                              restore_formula_text(rendered_text[block["id"]], block), ""]
                elif block.get("kind") in {"formula", "table", "reference", "figure", "algorithm"} and block["page"] in preview["pages"]:
                    lines += [f"## p.{block['page']} / {block['id']}", "", block["text"], ""]
            (folder / "translation.md").write_text("\n".join(lines), "utf-8")
            self.library.update(paper_id, status="一部翻訳済み" if report["untranslated_pages"] or report["skipped_blocks"] else "翻訳済み")
            return report
        except Exception:
            self.library.update(paper_id, status="翻訳途中・再開可" if done else "翻訳未完了")
            raise

    def article(self, paper_id: str) -> str:
        folder = self.library.folder(paper_id)
        document = self.library.document(paper_id)

        media_dir = folder / "media"
        if media_dir.exists():
            for f in media_dir.glob("*.png"):
                f.unlink(missing_ok=True)
        media_dir.mkdir(exist_ok=True)
        blocks_by_page = {}
        for b in document.get("blocks", []):
            if b.get("kind") in {"figure", "table"}:
                blocks_by_page.setdefault(b["page"], []).append(b)

        if blocks_by_page:
            import pymupdf as fitz
            with fitz.open(folder / "original.pdf") as pdf:
                for page_num, blocks in blocks_by_page.items():
                    if 1 <= page_num <= len(pdf):
                        page = pdf[page_num - 1]
                        for b in blocks:
                            image_path = media_dir / f"{b['id']}.png"
                            if not image_path.exists():
                                rect = fitz.Rect(b["bbox"])
                                pix = page.get_pixmap(clip=rect, dpi=150)
                                pix.save(str(image_path))

        page_units = []
        for page in document["pages"]:
            page_text = page["text"]
            if page["number"] in blocks_by_page:
                markers = []
                for b in blocks_by_page[page["number"]]:
                    image_path = media_dir / f"{b['id']}.png"
                    uri = f"media/{b['id']}.png"
                    markers.append(f"\n[図表画像が参照できます。Markdownで出力する際は次の構文をそのまま使ってください: ![{b['kind']} p.{page['number']}]({uri})]")
                page_text += "\n" + "\n".join(markers)

            for offset in range(0, max(1, len(page_text)), 10000):
                page_units.append({"id": f"p{page['number']}-{offset}", "page": page["number"],
                                   "text": page_text[offset:offset + 10000]})
        chunks = list(batches(page_units, limit=18000))
        notes = []
        for index, chunk in enumerate(chunks):
            check_cancel(self.cancel)
            self.progress(f"サマリーの資料を整理 {index + 1}/{len(chunks)}")
            data = "\n\n".join(f"[{paper_id}:p{x['page']}]\n{x['text']}" for x in chunk)
            note = self.provider.generate(prompts.load("summary_notes"), data)
            notes.append(note)
        check_cancel(self.cancel)
        self.progress("日本語のサマリー記事を作成しています…")
        article = self.provider.generate(
            prompts.load("summary_article"),
            "\n\n".join(notes))
        article = link_citations(article, {paper_id: document["page_count"]})
        (folder / "article.md").write_text(article, "utf-8")
        usage_path = folder / "article-usage.json"
        if usage := self.usage():
            save_json(usage_path, usage)
        else:
            usage_path.unlink(missing_ok=True)
        return article

    def ask(self, paper_id: str, question: str, entire_library: bool = False) -> str:
        question = question.strip()
        if not question:
            raise ValueError("質問を入力してください。")
        document = self.library.document(paper_id)
        all_text = "\n\n".join(f"[{paper_id}:p{x['number']}]\n{x['text']}" for x in document["pages"])
        allowed = {paper_id: document["page_count"]}
        context = all_text
        selection_note = "選択した論文の全文テキストを参照しています。"
        if entire_library or len(all_text) > 55000:
            self.progress("関連ページを検索しています…")
            keywords = self.provider.generate(prompts.load("chat_keywords"), question)
            pages = self.library.search_pages(keywords + " " + question,
                                              None if entire_library else paper_id, limit=10)
            if not pages:
                raise ValueError("参照できるページがありません。")
            context_parts = []
            for page in pages:
                allowed[page["paper_id"]] = self.library.paper(page["paper_id"])["pages"]
                context_parts.append(f"[{page['paper_id']}:p{page['number']}] {page['title']}\n" + page["text"][:6000])
            context = "\n\n".join(context_parts)
            selection_note = f"キーワード検索で選んだ{len(pages)}ページの抜粋を参照しています。"
        history = self.library.messages(paper_id)[-6:]
        self.progress("本文を参照して回答しています…")
        answer = self.provider.generate(
            prompts.load("chat_answer"),
            json.dumps({"question": question, "previous_dialogue": history,
                        "retrieval_scope": selection_note, "evidence": context}, ensure_ascii=False))
        answer = link_citations(answer, allowed) + "\n\n---\n*" + selection_note + "*"
        self.library.add_exchange(paper_id, question, answer, self.usage())
        return answer

    def export_bilingual(self, paper_id: str, destination: Path) -> None:
        folder = self.library.folder(paper_id)
        bilingual_pdf(folder / "original.pdf", folder / "translated.pdf", destination)

    def export_interleaved(self, paper_id: str, destination: Path) -> None:
        folder = self.library.folder(paper_id)
        interleaved_pdf(folder / "original.pdf", folder / "translated.pdf", destination)
