"""A glossary (terms and their translations) as the user gives it, and one drafted from a paper by the AI."""
from __future__ import annotations

import json

from papeer.core import prompts
from papeer.core.terminology import effective_glossary, matching_terms


def validate_terms(terms: object) -> list[dict[str, str]]:
    if not isinstance(terms, list) or any(not isinstance(item, dict) or
            not isinstance(item.get("source"), str) or not isinstance(item.get("target"), str) for item in terms):
        raise ValueError("辞書には原語（source）と訳語（target）の文字列の一覧が必要です。")
    result = []
    seen = set()
    for item in terms:
        source, target = item.get("source", "").strip(), item.get("target", "").strip()
        if not source or not target or max(len(source), len(target)) > 100 or source.casefold() in seen:
            raise ValueError("用語と訳語を入力し、重複をなくしてください（各100文字まで）。")
        seen.add(source.casefold())
        result.append({"source": source, "target": target})
    return result


def draft_glossary(lib, paper_id, provider, cancel, progress, existing):
    """Suggest terminology from all source pages without persisting unreviewed terms."""
    from papeer.providers import check_cancel, parse_json_answer

    text = "\n\n".join(text for _, text in lib.page_texts(paper_id))
    if not text.strip():
        raise ValueError("専門用語を抽出できる原文がありません。")
    known = {t["source"].casefold(): t for t in effective_glossary(lib, paper_id)}
    known.update({t["source"].casefold(): t for t in existing})
    result = []
    schema = {"type": "object", "properties": {"terms": {"type": "array", "items": {
        "type": "object", "properties": {"source": {"type": "string"}, "target": {"type": "string"}},
        "required": ["source", "target"], "additionalProperties": False}}},
        "required": ["terms"], "additionalProperties": False}
    # Overlap preserves phrases crossing chunk boundaries, while bounding each request.
    chunks = [text[i:i + 24000] for i in range(0, len(text), 23000)]
    for index, chunk in enumerate(chunks):
        check_cancel(cancel)
        progress(f"専門用語の翻訳対応表を作っています… {index + 1}/{len(chunks)}")
        answer = provider.generate(
            prompts.load("glossary_draft"),
            json.dumps({"source": chunk, "existing_terms": matching_terms(chunk, list(known.values()))}, ensure_ascii=False), schema)
        try:
            value = parse_json_answer(answer, schema)
        except ValueError:
            raise ValueError("AIから有効な翻訳対応表を取得できませんでした。再試行してください。") from None
        terms = value.get("terms")
        if not isinstance(terms, list) or any(not isinstance(t, dict) or
                not isinstance(t.get("source"), str) or not isinstance(t.get("target"), str) for t in terms):
            raise ValueError("AIから有効な翻訳対応表を取得できませんでした。再試行してください。")
        # Unlike a user's list, one duplicate or overlong suggestion only drops that term.
        for item in terms:
            term = {"source": item["source"].strip(), "target": item["target"].strip()}
            key = term["source"].casefold()
            if (term["source"] and term["target"] and max(len(term["source"]), len(term["target"])) <= 100
                    # In the source, as a translation finds glossary terms (plural, across lines) or as a part.
                    and key not in known and (key in chunk.casefold() or matching_terms(chunk, [term]))):
                result.append(term)
                known[key] = term
    check_cancel(cancel)
    return {"terms": result}
