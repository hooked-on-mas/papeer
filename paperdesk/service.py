from __future__ import annotations

import json
import re
import threading
import uuid
from pathlib import Path
from typing import Callable

from .pdf_engine import batches, bilingual_pdf, interleaved_pdf, build_translated_pdf, save_json, translation_units
from .providers import Provider, check_cancel
from .storage import Library
from .math_layout import restore_formula_text
from .translation import RetryState, TRANSLATION_SCHEMA, translate_batch, validate_translations, translation_fingerprint
from .translation import translation_version, page_fingerprint
from .translation_preview import preview_page
from .translation_context import contextual_units
from .reading_flow import unit_pages, expand_pages, materialize_flows


def link_citations(answer: str, allowed: dict[str, int]) -> str:
    """Only turn validated document/page identifiers into navigable internal links."""
    def replace(match):
        identity, page = match.group(1), int(match.group(2))
        if identity in allowed and 1 <= page <= allowed[identity]:
            return f"[p.{page}](paperdesk://{identity}/{page})"
        return f"[参照未確認: {identity[:8]} p.{page}]"
    return re.sub(r"\[([0-9a-f]{32}):p(\d+)\]", replace, answer)


class PaperService:
    def __init__(self, library: Library, provider: Provider, cancel: threading.Event,
                 progress: Callable[[str], None] = lambda _: None,
                 page_ready: Callable[[str, int], None] = lambda *_: None):
        self.library, self.provider = library, provider
        self.cancel, self.progress = cancel, progress
        self.page_ready = page_ready

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
        completed_pages = {}
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
                    except (ValueError, RuntimeError) as error:
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
                            "translations": {u["id"]: done[u["id"]] for u in page_units}}
                save_json(cache_path, {"fingerprint": fingerprint, "translations": done,
                                       "translation_version": version,
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
            for index, chunk in enumerate(chunks):
                check_cancel(self.cancel)
                completed_units = sum(u["id"] in done for u in selected_units)
                self.progress(f"翻訳 {index + 1}/{len(chunks)} — 指定ページの完了 {completed_units}/{len(selected_units)} ブロック")
                translate_batch(self.provider, chunk, self.cancel, self.progress, accept, retry_state, save)
                publish_ready()
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
                if not unit_pages(unit) & set(preview["pages"]):
                    continue
                block_text.setdefault(unit["block"], []).append(done.get(unit["id"], unit["text"]))
            translated = {key: "\n".join(parts) for key, parts in block_text.items()}
            self.progress("日本語PDFを作成しています…")
            report = build_translated_pdf(folder / "original.pdf", document, translated, folder / "translated.pdf",
                                          translate_page_numbers=set(preview["pages"]))
            self.progress("原文と日本語訳を交互に並べたPDFを作成しています…")
            interleaved_pdf(folder / "original.pdf", folder / "translated.pdf", folder / "interleaved.pdf")
            report["skipped_blocks"] = [u["id"] for u in units if unit_pages(u) & set(preview["pages"]) and skipped(u)]
            report["requested_pages"] = sorted(requested)
            report["translation_version"] = version
            report["already_translated_pages"] = sorted(already_done)
            report["selected_pages"] = sorted(selected)
            report["translated_pages"] = sorted(preview["pages"])
            report["untranslated_pages"] = sorted(set(by_page) - set(preview["pages"]))
            report["skipped_pages"] = sorted(preview["skipped_pages"])
            report["page_errors"] = preview["page_errors"]
            save_json(folder / "translation-report.json", report)
            preview["complete"] = True
            save_json(preview_path, preview)
            self.page_ready(paper_id, document["page_count"])
            lines = [f"# {document['title']} — 日本語訳", ""]
            rendered_document, rendered_text = materialize_flows(document, translated)
            for block in rendered_document["blocks"]:
                if block['page'] not in preview['pages']:
                    continue
                if block["id"] in rendered_text:
                    lines += [f"## p.{block['page']} / {block['id']}", "",
                              restore_formula_text(rendered_text[block["id"]], block), ""]
                elif block.get("kind") in {"formula", "table", "reference"} and block["page"] in preview["pages"]:
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
        page_units = []
        for page in document["pages"]:
            for offset in range(0, max(1, len(page["text"])), 10000):
                page_units.append({"id": f"p{page['number']}-{offset}", "page": page["number"],
                                   "text": page["text"][offset:offset + 10000]})
        chunks = list(batches(page_units, limit=18000))
        notes = []
        for index, chunk in enumerate(chunks):
            check_cancel(self.cancel)
            self.progress(f"解説の資料を整理 {index + 1}/{len(chunks)}")
            data = "\n\n".join(f"[{paper_id}:p{x['page']}]\n{x['text']}" for x in chunk)
            note = self.provider.generate(
                "Write concise Japanese research notes covering the supplied pages: research question, method, "
                "findings, quantitative results, limitations. Retain page citations exactly in [documentid:pN] format. "
                "Use only the supplied text, distinguish claims from inference, and do not invent missing figures.", data)
            notes.append(note)
        check_cancel(self.cancel)
        self.progress("日本語の解説記事を作成しています…")
        article = self.provider.generate(
            "Write a clear Japanese Markdown article from these research notes, with sections for overview, "
            "problem, method, results, limitations, and how to read the paper. Use technical English terms "
            "in parentheses. Cite the original page markers [documentid:pN], preserving their exact IDs. "
            "Do not invent facts or numerical results. Do not add external links or image syntax.",
            "\n\n".join(notes))
        article = link_citations(article, {paper_id: document["page_count"]})
        (folder / "article.md").write_text(article, "utf-8")
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
            keywords = self.provider.generate(
                "Return 3 to 8 English search keywords for finding evidence to answer this research question. "
                "Return only space-separated keywords; no explanation.", question)
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
            "Answer the question in Japanese using only the provided paper text. Cite factual claims "
            "with [documentid:pN] markers copied from the evidence. Explain technical terms with English "
            "in parentheses. Clearly say when the selected excerpts cannot establish an answer. "
            "Previous dialogue is context, not evidence. Do not add external links or image syntax.",
            json.dumps({"question": question, "previous_dialogue": history,
                        "retrieval_scope": selection_note, "evidence": context}, ensure_ascii=False))
        answer = link_citations(answer, allowed) + "\n\n---\n*" + selection_note + "*"
        self.library.add_exchange(paper_id, question, answer)
        return answer

    def export_bilingual(self, paper_id: str, destination: Path) -> None:
        folder = self.library.folder(paper_id)
        bilingual_pdf(folder / "original.pdf", folder / "translated.pdf", destination)

    def export_interleaved(self, paper_id: str, destination: Path) -> None:
        folder = self.library.folder(paper_id)
        interleaved_pdf(folder / "original.pdf", folder / "translated.pdf", destination)
