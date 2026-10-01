"""The AI's two jobs on domain dictionaries: choosing the ones a paper uses, and splitting a big one by subject."""
from __future__ import annotations

import json
from pathlib import Path

from papeer.core import prompts
from papeer.core.errors import Invalid
from papeer.core.terminology import (
    GENERAL_DOMAIN, domain_names, global_glossary, glossary_scope_key, matching_terms,
    paper_domains, save_global_glossary, save_paper_domains, save_paper_scope, term_contexts)
from papeer.translation.translation_context import paper_context

SAMPLE_TERMS = 15  # Terms of a domain shown to the AI to tell what it is about.
NAME_LIMIT = 40  # Characters of a domain's name (validate_terms).
SPLIT_CHUNK = 300  # Terms sent per request when splitting.
SELECT_CHUNK = 40  # The applicability check includes several context excerpts per term.
MIN_DOMAIN = 1  # A small specialist vocabulary must not be merged into an unrelated field.
CONTEXT_PAGE_CHARS = 1500  # The start of page 1 that stands for a paper without a found title and abstract.

_SELECT_SCHEMA = {"type": "object", "properties": {
    "domains": {"type": "array", "items": {"type": "string"}},
    "allowed_terms": {"type": "array", "items": {"type": "integer"}},
    "new_domain": {"anyOf": [{"type": "string"}, {"type": "null"}]}},
    "required": ["domains", "new_domain", "allowed_terms"], "additionalProperties": False}

_SPLIT_SCHEMA = {"type": "object", "properties": {"domains": {"type": "array", "items": {
    "type": "object", "properties": {"name": {"type": "string"}, "sources": {"type": "array", "items": {"type": "string"}}},
    "required": ["name", "sources"], "additionalProperties": False}}},
    "required": ["domains"], "additionalProperties": False}


def select_domains(lib, paper_id: str, provider, cancel) -> dict:
    """Have the AI choose the domain dictionaries a paper uses and record the choice (chosen_by 'ai'; a choice
    the user made stays). Returns {"domains", "new_domain"} as recorded.

    Without any domain dictionary there is nothing to choose: the AI is not asked and nothing is recorded.
    """
    from papeer.providers import check_cancel, parse_json_answer

    terms = global_glossary(lib.root)
    original_record = paper_domains(lib.root, paper_id)
    available = domain_names(terms)
    if not available:
        return {"domains": [], "new_domain": None}
    paper = paper_context(lib.document(paper_id))
    if paper is None:
        paper = {"title": lib.paper(paper_id)["title"], "abstract": lib.page_text(paper_id, 1)[:CONTEXT_PAGE_CHARS]}
    text = "\n\n".join(text for _, text in lib.page_texts(paper_id))
    candidates = matching_terms(text, [t for t in terms if t.get("domain")])
    listing = [{"name": name, "count": len(members), "sample_terms": [t["source"] for t in members[:SAMPLE_TERMS]]}
               for name in available for members in [[t for t in terms if t.get("domain") == name]]]
    check_cancel(cancel)
    allowed = []
    value = None
    # Inspect each source/target in its actual use, including small vocabularies inside broad dictionaries.
    for start in range(0, max(1, len(candidates)), SELECT_CHUNK):
        members = candidates[start:start + SELECT_CHUNK]
        entries = []
        for index, term in enumerate(members, start):
            entries.append({"id": index, **term, "context": "\n…\n".join(term_contexts(text, term))})
        check_cancel(cancel)
        answer = provider.generate(
            prompts.load("glossary_select"),
            json.dumps({"paper": paper, "available_domains": listing, "candidate_terms": entries,
                        "fixed_domains": original_record["domains"] if original_record and original_record["chosen_by"] == "user" else None},
                       ensure_ascii=False), _SELECT_SCHEMA)
        try:
            part = parse_json_answer(answer, _SELECT_SCHEMA)
        except ValueError:
            raise ValueError("AIから有効な分野辞書の選択を取得できませんでした。再試行してください。") from None
        ids = part.get("allowed_terms")
        if not isinstance(ids, list) or any(type(i) is not int for i in ids):
            raise ValueError("AIから有効な用語の適用判定を取得できませんでした。再試行してください。")
        allowed.extend(t for i, t in enumerate(members, start) if i in ids)
        if value is None:
            value = part
    assert value is not None
    if (not isinstance(value.get("domains"), list) or any(not isinstance(name, str) for name in value["domains"])
            or not isinstance(value.get("new_domain"), (str, type(None)))):
        raise ValueError("AIから有効な分野辞書の選択を取得できませんでした。再試行してください。")
    by_folded = {name.casefold(): name for name in available}
    domains: list[str] = []
    for name in value["domains"]:
        canonical = by_folded.get(name.strip().casefold())
        if canonical and canonical not in domains:
            domains.append(canonical)
    new_domain = (value["new_domain"] or "").strip()
    if new_domain in {"", GENERAL_DOMAIN} or len(new_domain) > NAME_LIMIT:
        new_domain = None
    elif new_domain.casefold() in by_folded:  # Already a dictionary: chosen like the others.
        canonical = by_folded[new_domain.casefold()]
        if canonical not in domains:
            domains.append(canonical)
        new_domain = None
    check_cancel(cancel)
    # The term approval is decisive; domain names from other batches need not repeat the first answer.
    for term in allowed:
        if term["domain"] not in domains:
            domains.append(term["domain"])
    expected = {"domains": domains, "new_domain": new_domain, "chosen_by": "ai", "known_domains": available}
    if original_record and original_record["chosen_by"] == "user":
        domains, new_domain = original_record["domains"], original_record["new_domain"]
        expected = original_record
    elif not save_paper_domains(lib.root, paper_id, domains, new_domain, "ai", available, only_if_ai=True):
        record = paper_domains(lib.root, paper_id)
        if record:  # The user chose meanwhile; that stays.
            return {"domains": record["domains"], "new_domain": record["new_domain"]}
    save_paper_scope(lib.root, paper_id, {"key": glossary_scope_key(terms, text), "terms": allowed}, expected)
    return {"domains": domains, "new_domain": new_domain}


def split_target(terms: list[dict], domain: str) -> tuple[str, list[int]]:
    """(the dictionary's name, "" for the general one; the indexes of its terms) for `domain`, matched
    ignoring case; Invalid when there is no such dictionary or it has no terms."""
    name = domain.strip()
    if name.casefold() == GENERAL_DOMAIN.casefold():
        name = ""
    else:
        name = next((n for n in domain_names(terms) if n.casefold() == name.casefold()), None)
        if name is None:
            raise Invalid("その分野辞書が見つかりません。辞書を開き直してください。")
    indexes = [i for i, term in enumerate(terms) if term.get("domain", "") == name]
    if not indexes:
        raise Invalid("分ける用語がありません。")
    return name, indexes


def _assignments(chunk: list[dict], answer_domains: list, names: dict[str, str], own: set[str]) -> dict[int, str]:
    """{index in chunk: new dictionary name} from the AI's groups. A source is taken once (the first group
    that has it), a source not in the chunk is ignored, and a group named like the dictionary being split
    (or 共通) keeps its terms where they are. `names` (folded name -> name) grows with the names used."""
    by_source: dict[str, list[int]] = {}
    for index, term in enumerate(chunk):
        by_source.setdefault(term["source"].casefold(), []).append(index)
    result: dict[int, str] = {}
    taken: set[str] = set()
    for group in answer_domains:
        name = group["name"].strip()
        if not name or len(name) > NAME_LIMIT:
            continue
        if name.casefold() in own:
            name = ""
        else:
            name = names.setdefault(name.casefold(), name)
        for source in group["sources"]:
            key = source.strip().casefold()
            if key in by_source and key not in taken:
                taken.add(key)
                if name:
                    result.update({index: name for index in by_source[key]})
    return result


def split_domain(root: Path, provider, cancel, progress, domain: str, *, preview: bool = False) -> dict:
    """Have the AI split one dictionary ("共通" for the general one) into domain dictionaries by subject.

    The terms stay where they are in the glossary: only a term's domain is written, so the order (which
    translations are cached by) does not change. A new dictionary of fewer than MIN_DOMAIN terms is not made,
    and a term whose source the target dictionary already has stays. Saved only if the glossary is still
    what it was at the start (GlossaryConflict otherwise). Returns {"moved", "domains": [{"name", "count"}]}
    of all the domain dictionaries afterwards.
    """
    from papeer.providers import check_cancel, parse_json_answer

    terms = global_glossary(root)
    original = json.loads(json.dumps(terms))
    name, indexes = split_target(terms, domain)
    others = [n for n in domain_names(terms) if n != name]
    names = {n.casefold(): n for n in others}  # Dictionaries a group may name: the others and those made so far.
    own = {GENERAL_DOMAIN.casefold()} | ({name.casefold()} if name else set())
    chunks = [indexes[i:i + SPLIT_CHUNK] for i in range(0, len(indexes), SPLIT_CHUNK)]
    assigned: dict[int, str] = {}
    for number, chunk in enumerate(chunks, 1):
        check_cancel(cancel)
        progress(f"辞書を分野ごとに分けています… {number}/{len(chunks)}")
        members = [terms[i] for i in chunk]
        answer = provider.generate(
            prompts.load("glossary_split"),
            json.dumps({"domain": name or GENERAL_DOMAIN,
                        "terms": [{"source": t["source"], "target": t["target"]} for t in members],
                        "existing_domains": list(names.values())}, ensure_ascii=False), _SPLIT_SCHEMA)
        try:
            value = parse_json_answer(answer, _SPLIT_SCHEMA)
        except ValueError:
            raise ValueError("AIから有効な分野分けを取得できませんでした。再試行してください。") from None
        groups = value.get("domains")
        if not isinstance(groups, list) or any(
                not isinstance(g, dict) or not isinstance(g.get("name"), str) or not isinstance(g.get("sources"), list)
                or any(not isinstance(s, str) for s in g["sources"]) for g in groups):
            raise ValueError("AIから有効な分野分けを取得できませんでした。再試行してください。")
        assigned.update({chunk[i]: new for i, new in _assignments(members, groups, names, own).items()})
    check_cancel(cancel)
    # A new dictionary needs MIN_DOMAIN terms in all; naming a dictionary that exists is always fine.
    counts: dict[str, int] = {}
    for new in assigned.values():
        counts[new] = counts.get(new, 0) + 1
    assigned = {i: new for i, new in assigned.items() if new in others or counts[new] >= MIN_DOMAIN}
    # A source may be once in a dictionary: a term whose source is already there stays.
    splitting = set(indexes)
    occupied = {(t.get("domain", ""), t["source"].casefold()) for i, t in enumerate(terms) if i not in splitting}
    occupied |= {(name, terms[i]["source"].casefold()) for i in indexes if i not in assigned}
    moved = 0
    for index in indexes:
        new = assigned.get(index)
        if new is None:
            continue
        key = (new, terms[index]["source"].casefold())
        if key in occupied:
            continue
        occupied.add(key)
        terms[index] = {**terms[index], "domain": new}
        moved += 1
    if moved and not preview:
        save_global_glossary(root, terms, expected=original)
    return {"moved": moved, "domains": [{"name": n, "count": sum(t.get("domain") == n for t in terms)}
                                        for n in domain_names(terms)],
            **({"terms": terms, "original": original} if preview else {})}
