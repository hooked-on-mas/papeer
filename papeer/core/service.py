from __future__ import annotations

import json
from pathlib import Path
import re
import threading
from typing import Callable

from papeer.core.fileio import atomic_write_bytes, atomic_write_json, atomic_write_text
from papeer.pdf.pdf_engine import PDF_LOCK, batches, translation_units
import pymupdf as fitz
from papeer.providers import ProviderBackend, check_cancel
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library, in_collection, normalize_collection_name
from papeer.layout.math_layout import restore_formula_text
from papeer.translation.translation import same_page_source
from papeer.layout.reading_flow import unit_pages, materialize_flows, join_unit_translations, resolve_unit_joins
from papeer.core.summary_figures import summary_figures
from papeer.core import prompts
from papeer.core.terminology import apply_glossary, glossary_for_folder
from papeer.core.translation_run import TranslationRun


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


def stored_translations(cache: dict) -> dict[str, str]:
    """Every translation in a translation-cache.json, whatever key it was made with, by unit id.

    PaperService.translate writes each translation once, with its completed page or at the top
    for an unfinished page; caches of earlier versions held all of them at the top as well. For
    tools and tests: translating checks each page's key, search and the reader each page's source
    (cached_translations).
    """
    current = cache.get("translation_version")
    values: dict[str, str] = {}
    # Pages of an earlier key first, so that the current key's text of a paragraph wins.
    for entry in sorted((cache.get("completed_pages") or {}).values(), key=lambda entry: entry.get("version") == current):
        values.update(entry.get("translations") or {})
    values.update(cache.get("translations") or {})
    return values


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
        if page_units and same_page_source(entry, page_units):
            done.update(entry.get("translations", {}))
    return units, done


def cached_page_texts(folder: Path, document: dict) -> dict[int, list[str]]:
    """The translated blocks of every page in the translation cache, by page number, with inline math as text.

    The translated PDF draws inline math as images, so text copied from it lacks the formulas.
    Blocks continued in the next column or on the next page are divided (materialize_flows) once
    for the whole paper, so a caller reading many pages asks for them once.
    """
    units, done = cached_translations(folder, document)
    started = {u["block"] for u in units if u["id"] in done}
    block_text = {}
    for unit in units:
        if unit["block"] in started:
            block_text.setdefault(unit["block"], []).append(done.get(unit["id"], unit["text"]))
    rendered_document, rendered_text = materialize_flows(
        document, {key: join_unit_translations(parts) for key, parts in block_text.items()})
    pages: dict[int, list[str]] = {}
    for block in rendered_document["blocks"]:
        if block["id"] in rendered_text:
            pages.setdefault(block["page"], []).append(
                restore_formula_text(resolve_unit_joins(rendered_text[block["id"]]), block))
    return pages


def page_translation_text(folder: Path, document: dict, page: int) -> list[str]:
    """Translated blocks of one page with inline math as text (cached_page_texts)."""
    blocks = cached_page_texts(folder, document).get(page)
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
        """Translate the pages `pages` of the paper (all when None) and return the report (TranslationRun)."""
        return TranslationRun(self.library, self.provider, self.cancel, paper_id, pages, replacements,
                              progress=self.progress, page_ready=self.page_ready, usage=self.usage).run()

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
            note = self.provider.generate(prompts.expand(prompts.load("summary_notes")), data)
            notes.append(note)
        check_cancel(self.cancel)
        self.progress("日本語のサマリー記事を作成しています…")
        # The notes stage may still drop images, so the article stage also gets the full list.
        catalog = "\n\n## Available images\n" + "\n".join(images) if images else ""
        article = self.provider.generate(
            prompts.expand(prompts.load("summary_article")),
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
            retrieval_query: str = "", max_pages: int = 10, web_search: bool = False,
            research_keys: list[str] | None = None) -> str:
        from papeer.core import web_research

        question = question.strip()
        if not question:
            raise ValueError("メッセージを入力してください。")
        research_records = [web_research.get_record(self.library, paper_id, key) for key in (research_keys or [])[:10]]
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
            folder = normalize_collection_name(collection)
            paper_ids = {p["id"] for p in self.library.papers() if in_collection(p["collection_name"], folder)}
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
        if research_records:
            request["attached_research"] = research_records
        research = None
        if web_search:
            self.progress("Webを検索し、出典を確認しています…")
            answer, research = web_research.search_answer(self.library, paper_id, request, self.provider)
            research["attached_keys"] = research_keys or []
            # Keep the evidence that was attached at send time as well as newly discovered papers.
            fresh_keys = {record["key"] for record in research["records"]}
            research["records"] += [record for record in research_records if record["key"] not in fresh_keys]
        elif research_records:
            instruction = (prompts.load("chat_answer") + "\nThe attached_research is also evidence. Identify it as "
                           "an attached research result, cite [添付N], and state its basis (abstract or full text). "
                           "Never treat an abstract as full text. No new web search is available.")
            answer = self.provider.generate(instruction, json.dumps(request, ensure_ascii=False))
            research = {"web_search": False, "sources": [], "records": research_records, "attached_keys": research_keys or []}
        else:
            answer = self.provider.generate(prompts.load("chat_answer"), json.dumps(request, ensure_ascii=False))
        answer = link_citations(answer, allowed) + "\n\n---\n*" + selection_note + "*"
        self.library.add_exchange(paper_id, question, answer, self.usage(), scope=scope_key,
                                  attachments=attachments, research=research)
        return answer
