"""Reviewable, source-scoped terminology replacements and remembered user preferences."""
from __future__ import annotations

import hashlib
import json

from papeer.core.errors import Conflict, Invalid
from papeer.core.fileio import atomic_write_json
from papeer.core.glossary_draft import validate_terms
from papeer.core.paragraph_revisions import save_revision_history, translation_paragraphs
from papeer.core.paths import PaperFiles
from papeer.core.terminology import (add_glossary_term, apply_glossary, effective_glossary, matching_terms,
                                     paper_glossary, save_paper_glossary, validate_revision)
from papeer.layout.math_layout import MATH_TOKEN
from papeer.layout.reading_flow import unit_pages
from papeer.pdf.pdf_engine import translation_units
from papeer.providers import check_cancel
from papeer.translation.translation import page_source_fingerprint, same_page_source


def replacement_preview(lib, paper_id: str, source: str, before: str, target: str) -> dict:
    term = validate_terms([{"source": source, "target": target}])[0]
    before = before.strip()
    if not before or len(before) > 100 or MATH_TOKEN.search(before + term["target"]):
        raise Invalid("置換前の訳語を1〜100文字で入力してください。数式の目印は置換できません。")
    if before == term["target"]:
        raise Invalid("置換前と異なる訳語を入力してください。")
    paragraphs = translation_paragraphs(lib, paper_id)
    changes = []
    for paragraph in paragraphs:
        if not matching_terms(paragraph["source"], [term]):
            continue
        # Never replace within a formula marker, even if the selected word is 'MATH' or an ID.
        pieces = []
        cursor = 0
        for marker in MATH_TOKEN.finditer(paragraph["text"]):
            pieces.extend([paragraph["text"][cursor:marker.start()].replace(before, term["target"]), marker[0]])
            cursor = marker.end()
        pieces.append(paragraph["text"][cursor:].replace(before, term["target"]))
        text = validate_revision(paragraph["source"], "".join(pieces))
        if text != paragraph["text"]:
            changes.append({**paragraph, "after": text})
    # Bind the preview to all translated paragraphs, the source and preferences, including unchanged ones.
    state = {"paragraphs": paragraphs, "terms": effective_glossary(lib, paper_id), "term": term, "before": before}
    key = hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return {"key": key, "changes": changes}


def apply_replacement(lib, paper_id, source, before, target, expected_key, selected_ids, remember,
                      provider, cancel, progress, page_ready):
    from papeer.core.service import PaperService

    preview = replacement_preview(lib, paper_id, source, before, target)
    if preview["key"] != expected_key:
        raise Conflict("訳文または訳語の設定が変わりました。置換箇所を確認し直してください。")
    allowed = {c["id"] for c in preview["changes"]}
    if not set(selected_ids) <= allowed:
        raise Invalid("置換対象の段落が変わりました。確認し直してください。")
    changes = [c for c in preview["changes"] if c["id"] in selected_ids]
    if not changes and remember == "none":
        raise Invalid("置換する段落を選んでください。")
    check_cancel(cancel)
    if changes:
        pages = {page for c in changes for page in c["pages"]}
        progress("選んだ箇所の訳語を置き換え、PDFに反映しています…")
        result = PaperService(lib, provider, cancel, progress, page_ready).translate(
            paper_id, pages=pages, replacements={c["id"]: c["after"] for c in changes})
        if result.get("skipped_pages"):
            raise Invalid("PDF生成に失敗したページがあります。訳語の保存は行っていません。要確認一覧を確認してください。")
        for change in changes:
            save_revision_history(lib.folder(paper_id), change["id"], change["text"], change["after"])
    if remember != "none":
        # Legacy caches need an extraction-only key before a preference changes. This keeps every
        # saved paragraph readable, while normal translation still checks its glossary-specific key.
        files = PaperFiles(lib.folder(paper_id))
        units = translation_units(lib.document(paper_id))
        apply_glossary(units, effective_glossary(lib, paper_id))
        cache = files.read_json(files.translation_cache, {})
        for number, entry in cache.get("completed_pages", {}).items():
            members = [u for u in units if int(number) in unit_pages(u)]
            if same_page_source(entry, members):
                entry["raw_source"] = page_source_fingerprint(members)
        if cache:
            atomic_write_json(files.translation_cache, cache)
        term = validate_terms([{"source": source, "target": target}])[0]
        if remember == "shared":
            add_glossary_term(lib.root, paper_id, term["source"], term["target"])
        else:
            current = paper_glossary(lib.root, paper_id)
            terms = [t for t in current["terms"] if t["source"].casefold() != term["source"].casefold()] + [term]
            save_paper_glossary(lib.root, paper_id, terms, current["dismissed"],
                               {"terms": current["terms"], "dismissed": current["dismissed"]})
    return {"changed": len(changes), "remember": remember}
