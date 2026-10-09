"""Reviewable, source-scoped terminology replacements and remembered user preferences."""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import Counter

from papeer.core.errors import Conflict, Invalid
from papeer.core.fileio import atomic_write_json
from papeer.core.glossary_draft import validate_terms
from papeer.core.paragraph_revisions import save_revision_history, translation_paragraphs
from papeer.core.paths import PaperFiles
from papeer.core.terminology import (add_glossary_term, apply_glossary, effective_glossary, found_in, global_glossary,
                                     matching_terms, paper_glossary, prepare_search, save_paper_glossary, validate_revision)
from papeer.layout.math_layout import MATH_TOKEN
from papeer.layout.reading_flow import unit_pages
from papeer.pdf.pdf_engine import translation_units
from papeer.providers import check_cancel
from papeer.translation.translation import page_source_fingerprint, same_page_source


# How many cards, variants and characters of a selection one term card looks at.
_MAX_CARDS = 6
_MAX_VARIANTS = 5
_MAX_SELECTION = 100
# Runs of the characters a Japanese rendering of a term is made of (katakana and kanji, no particles).
_TERM_RUN = re.compile("[ァ-ヺー々㐀-䶿一-鿿]{2,}")
_MAX_GRAM = 8
_SAMPLE = 400  # Paragraphs the wording statistics look at, at most.
_WORD = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*")
_STOPWORDS = frozenset("""a an the of and or in on at to for from by with without as is are was were be been being it its this that
these those we our us they their can could may might will would should has have had not no than then also using used use
such which who whom what when where how while into over under between within each both more most other another""".split())


def _fold(text: str) -> str:
    """A text as the card compares translations: NFKC (full-width Ｑ is Q), casefolded, formula markers out."""
    return unicodedata.normalize("NFKC", MATH_TOKEN.sub(" ", text)).casefold()


def term_card(lib, paper_id: str, text: str, side: str) -> dict:
    """What a selected word is called in this paper: its source term, the translation in use, where it is
    used and how the paragraphs that have the source but not that translation render it instead.

    Decided from the paper's effective glossary and the saved translation only (no AI, no quota). The
    result is the card itself when one term fits the selection, and empty when none does; when several do,
    `candidates` holds a card with counts for each and the caller chooses (the wording is worked out once
    one is chosen and asked for again). Translations are compared as _fold does, which is looser than the
    replacement (an exact string match), so a paragraph counted here may be one the replacement leaves as it is.
    """
    raw, text = text.strip(), " ".join(text.split())  # matching_terms joins a word broken at a line end itself.
    empty = {"source": "", "current": "", "count": 0, "missing": 0, "variants": [], "dictionary": [],
             "candidates": [], "source_candidates": []}
    if not text or MATH_TOKEN.search(text):
        return empty
    paragraphs = translation_paragraphs(lib, paper_id)
    terms = effective_glossary(lib, paper_id)
    key = _fold(text)
    if side == "original":
        hits = [t for t in terms if _fold(t["source"]) == key] or matching_terms(raw, terms)
    else:
        hits = [t for t in terms if _fold(t["target"]) == key] or [
            t for t in terms if len(t["target"]) >= 2 and _fold(t["target"]) in key]
    if len(hits) > 1:
        # A selection equal to one source (policy and policy gradient both match "policy gradient") means that one.
        exact = [t for t in hits if key in (_fold(t["source"]), _fold(t["target"]))]
        hits = exact if len(exact) == 1 else hits
    # Each text normalized once, however many terms are tried.
    prepared = [(prepare_search(p["source"]), _fold(p["text"])) for p in paragraphs] if hits or side == "translated" else []
    cards = []
    if len(hits) == 1:
        entries = [t for t in global_glossary(lib.root) if _fold(t["source"]) == _fold(hits[0]["source"])]
        card = _card(paragraphs, prepared, hits[0], [t["target"] for t in entries])
        cards = [{**card, "dictionary": [{"target": t["target"], "domain": t.get("domain", "")} for t in entries]}]
    elif hits:
        # Many matches: only counts, for the few most used; wording is worked out once one is chosen.
        counted = sorted((_card(paragraphs, prepared, t, None) for t in hits), key=lambda c: -c["count"])
        cards = counted[:_MAX_CARDS]
    if len(cards) == 1:
        return {**empty, **cards[0]}
    if cards:
        return {**empty, "candidates": cards}
    # Not in the glossary: the selection itself is the one half that is known.
    if side == "original" and len(text) <= _MAX_SELECTION:
        return {**empty, "source": text}
    if side == "translated" and len(text) <= _MAX_SELECTION:
        return {**empty, "current": text, "count": sum(key in folded for _, folded in prepared),
                "source_candidates": _source_candidates(paragraphs, prepared, key, terms)}
    return empty


def _card(paragraphs: list[dict], prepared: list, term: dict, alternates: list[str] | None) -> dict:
    """The card of one term. Without `alternates` (None) it holds the counts only, no variants."""
    current = _fold(term["target"])
    scope = [(p, folded) for p, (found, folded) in zip(paragraphs, prepared) if found_in(found, term)]
    missing = [p for p, folded in scope if current not in folded]
    variants = _variants(paragraphs, term, missing, alternates) if alternates is not None else []
    return {"source": term["source"], "current": term["target"], "count": len(scope) - len(missing),
            "missing": len(missing), "variants": variants, "dictionary": []}


def _source_candidates(paragraphs: list[dict], prepared: list, key: str, terms: list[dict]) -> list[dict]:
    """English wording that the paragraphs holding an unregistered translation have in common: dictionary
    sources found in them, and word runs (up to three words) that most of them share and the other
    paragraphs rarely do. Several paragraphs are needed to tell a term from the rest of their wording."""
    holding = [i for i, (_, folded) in enumerate(prepared) if key in folded]
    if len(holding) < 2:
        return []
    holding = holding[::max(1, len(holding) // 1000)]
    chosen = set(holding)
    others = [i for i in range(len(paragraphs)) if i not in chosen]
    others = others[::max(1, len(others) // _SAMPLE)]
    inside, spelled = _phrases([paragraphs[i]["source"] for i in holding])
    outside, _ = _phrases([paragraphs[i]["source"] for i in others])
    found: dict[str, tuple[int, str, bool]] = {}
    for gram, count in inside.items():
        if count < 2 or count / len(holding) < 0.5:
            continue
        elsewhere = outside[gram] / max(1, len(others))
        if count / len(holding) >= 2 * elsewhere + 0.1:
            found[gram] = (count, spelled[gram].most_common(1)[0][0], False)
    sample = holding[::max(1, len(holding) // 200)]
    for term in terms:
        count = sum(found_in(prepared[i][0], term) for i in sample)
        folded = _fold(term["source"])
        if count >= 2 and count / len(sample) >= 0.5 and count >= found.get(folded, (0, "", False))[0]:
            found[folded] = (count, term["source"], True)
    ranked = sorted(found.values(), key=lambda f: (-f[0], not f[2], len(f[1].split()), f[1]))
    return [{"text": text, "count": count} for count, text, _ in ranked[:_MAX_VARIANTS]]


def _phrases(sources: list[str]) -> tuple[Counter[str], dict[str, Counter[str]]]:
    """In how many of the texts each run of one to three words (not starting or ending on a function
    word) appears, casefolded, and how it is spelled there."""
    paragraphs: Counter[str] = Counter()
    spelled: dict[str, Counter[str]] = {}
    for source in sources:
        words = _WORD.findall(MATH_TOKEN.sub(" ", source))
        seen = {}
        for size in (1, 2, 3):
            for i in range(len(words) - size + 1):
                run = words[i:i + size]
                if run[0].lower() in _STOPWORDS or run[-1].lower() in _STOPWORDS:
                    continue
                if size == 1 and len(run[0]) < 3 and not run[0].isupper():
                    continue
                text = " ".join(run)
                seen.setdefault(text.casefold(), text)
        for gram, text in seen.items():
            paragraphs[gram] += 1
            spelled.setdefault(gram, Counter())[text] += 1
    return paragraphs, spelled


def _variants(paragraphs: list[dict], term: dict, missing: list[dict], alternates: list[str]) -> list[dict]:
    """The renderings used where `current` is absent: known alternatives (the dictionaries' other entries
    for the source, the source left untranslated as it is spelled there), then wording that is shared by
    several of those paragraphs but rare in the others. The statistical ones are suggestions: the preview
    shows what changes."""
    if not missing:
        return []
    current = term["target"]
    bodies = [MATH_TOKEN.sub(" ", p["text"]) for p in missing]
    folded_bodies = [_fold(p["text"]) for p in missing]
    found: dict[str, int] = {}
    for alternate in dict.fromkeys(alternates):
        if alternate != current:
            found[alternate] = sum(_fold(alternate) in body for body in folded_bodies)
    # The source left in Latin letters inside the translation: each spelling that is there counts by itself,
    # since replacing "Policy" leaves "policy" as it is.
    pattern = re.compile(re.escape(term["source"]), re.IGNORECASE)
    spellings: Counter[str] = Counter()
    for body in bodies:
        spellings.update({m.group(0) for m in pattern.finditer(body)})
    found.update(spellings)
    known = {text: count for text, count in found.items() if count}
    if len(missing) >= 2:
        # A large paper is judged on an even sample; the counts shown are taken over all of them below.
        sample = bodies[::max(1, len(bodies) // _SAMPLE)]
        floor = max(2, len(sample) // 10)
        grams: Counter[str] = Counter()
        for body in sample:
            seen = set()
            for run in _TERM_RUN.findall(body):
                for size in range(2, min(_MAX_GRAM, len(run)) + 1):
                    seen.update(run[i:i + size] for i in range(len(run) - size + 1))
            grams.update(seen)
        absent = {p["id"] for p in missing}
        others = [p for p in paragraphs if p["id"] not in absent]
        rest = [MATH_TOKEN.sub(" ", p["text"]) for p in others[::max(1, len(others) // _SAMPLE)]]
        chosen: dict[str, int] = {}
        for gram, count in grams.most_common(400):
            if count < floor or gram in current or current in gram or any(gram in k or k in gram for k in known):
                continue
            elsewhere = sum(gram in body for body in rest) / max(1, len(rest))
            if count / len(sample) >= 2 * elsewhere + 0.1:
                chosen[gram] = count
        # Closed n-grams: drop a part that is no more frequent than a longer string containing it.
        closed = {g: c for g, c in chosen.items() if not any(g != o and g in o and c <= oc for o, oc in chosen.items())}
        known.update({g: sum(g in body for body in bodies) for g in closed})
    ranked = sorted(known.items(), key=lambda item: (-item[1], -len(item[0])))
    return [{"text": text, "count": count} for text, count in ranked[:_MAX_VARIANTS]]


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
            # Also saves the term as this paper's own preference (add_glossary_term), so "shared" is "paper" plus the dictionary.
            add_glossary_term(lib.root, paper_id, term["source"], term["target"])
        else:
            current = paper_glossary(lib.root, paper_id)
            terms = [t for t in current["terms"] if t["source"].casefold() != term["source"].casefold()] + [term]
            save_paper_glossary(lib.root, paper_id, terms, current["dismissed"],
                               {"terms": current["terms"], "dismissed": current["dismissed"]})
    return {"changed": len(changes), "remember": remember}
