"""Check summary references and review claims against original pages, before publishing."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import threading
from typing import Callable

from papeer.core import prompts
from papeer.core.summary_evidence import evidence_schema, indexed_sources, resolve_evidence
from papeer.providers import AnswerRejected, check_cancel, parse_json_answer
from papeer.providers.common import matches_schema


IMAGE = re.compile(r"!\[[^\]\n]*\]\(([^)\s]+)\)")
CITATION = re.compile(r"\[[^\]\n]+\]\(papeer://([^/)]+)/(\d+)\)")
RAW_CITATION = re.compile(r"\[(?:[0-9a-f]{32}|document[ _-]?id|paper[ _-]?id|ID):[^\]]+\]"
                          r"|\[[A-Za-z0-9_-]+:p\d+[^\]]*\]", re.I)

REVIEW_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["edits"],
    "properties": {"edits": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["category", "reason", "original", "replacement", "page", "evidence"],
        "properties": {**{key: {"type": "string"} for key in
                          ("reason", "original", "replacement", "evidence")},
                       "evidence_id": {"type": "string"},
                       "category": {"type": "string", "enum": ["fact", "condition", "guarantee", "omission", "source_conflict"]},
                       "page": {"type": "integer"}}}}}}


def normalize_citation_code(article: str) -> str:
    """A citation is UI, never code; repair only code spans consisting entirely of citations."""
    article = re.sub(r"`(\[p\.\d+\]\(papeer://[0-9a-f]{32}/\d+\)(?:\s+\[p\.\d+\]\(papeer://[0-9a-f]{32}/\d+\))*)`",
                     r"\1", article)
    return re.sub(r"(\[p\.\d+\]\(papeer://[0-9a-f]{32}/\d+\))(?:[ \t]+\1)+", r"\1", article)


def reference_issues(article: str, paper_id: str, selected: set[int], assets: set[str], media: Path, *,
                     pending_assets: set[str] | None = None) -> list[str]:
    issues = []
    paths = IMAGE.findall(article)
    for path in paths:
        if path not in assets or (path not in (pending_assets or set()) and not (media / Path(path).name).is_file()):
            issues.append(f"未提供または存在しない画像: {path}")
    if len(paths) != len(set(paths)):
        issues.append("同じ画像を複数回使用しています")
    if assets and not paths:
        issues.append("提供された図表が一つも使用されていません")
    citations = CITATION.findall(article)
    for identity, page in citations:
        if identity != paper_id or int(page) not in selected:
            issues.append(f"対象外の引用: {identity} p.{page}")
    # Also catch malformed/attachment URLs, HTML images and reference-style images outside the contract.
    if article.count("papeer://") != len(citations):
        issues.append("不正な内部引用の書式があります")
    if RAW_CITATION.search(article) or "参照未確認" in article:
        issues.append("未変換または未確認の引用があります")
    code = re.findall(r"(?ms)^\s*(`{3,}|~{3,})[^\n]*\n(.*?)^\s*\1\s*$", article)
    code_text = [body for _, body in code] + re.findall(r"`+([^`\n]+)`+", article)
    if any("papeer://" in text or RAW_CITATION.search(text) for text in code_text):
        issues.append("引用がコード文字列になっています")
    if any(IMAGE.search(text) for text in code_text):
        issues.append("画像がコード文字列になっています")
    if re.search(r"<img\b|!\[[^\]]*\](?!\()", article, re.I):
        issues.append("未検証の画像書式があります")
    if not article.strip() or not citations:
        issues.append("本文またはページ引用がありません")
    if re.search(r"(?:提供|供給)(?:された)?(?:テキスト|文書|研究ノート)|"
                 r"(?:この|供給された|提供された)ノート|ノートの範囲|"
                 r"供給範囲(?:に|で|は|の)|研究ノートに基づ", article):
        issues.append("内部の研究ノート・入力断片への言及があります。論文の欠落や限界と混同せず、処理上の説明を除いてください")
    return list(dict.fromkeys(issues))


def review_article(article: str, paper_id: str, source_units: list[dict], provider,
                   cancel: threading.Event, progress: Callable[[str], None], link: Callable[[str], str], *,
                   verify: Callable[[str, list[dict]], list[dict]] | None = None,
                   validate: Callable[[str], list[str]] | None = None) -> tuple[str, dict]:
    """One review pass over every original page, not the potentially lossy research notes.

    Edits are local and must quote both the draft and the source. Invalid locations/quotes fail the
    job after a bounded retry; semantically rejected edits stay unapplied. The caller audits the
    complete revised article before publication.
    """
    from papeer.pdf.pdf_engine import batches

    # Keep individual reviews small, including for CLI models with short output limits.
    # Every source unit is still reviewed; the whole draft supplies the coverage context.
    chunks = list(batches(source_units, limit=18000, size=lambda xs: sum(len(x["text"]) + 100 for x in xs)))
    instruction = prompts.builtin("_summary_review")
    report: dict = {"version": 2, "source_pages": sorted({x["page"] for x in source_units}), "edits": [],
                   "prompt_sha256": hashlib.sha256(instruction.encode("utf-8")).hexdigest()}
    for index, chunk in enumerate(chunks):
        check_cancel(cancel)
        progress(f"原文とサマリーを照合 {index + 1}/{len(chunks)}")
        sources = indexed_sources([{"page": x["page"], "text": x["text"]} for x in chunk])
        request = {"paper_id": paper_id, "article": article, "source_pages": sources}
        for attempt in range(2):
            check_cancel(cancel)
            data = json.dumps(request, ensure_ascii=False)
            try:
                answer = parse_json_answer(provider.generate(instruction, data, evidence_schema(REVIEW_SCHEMA)), REVIEW_SCHEMA)
                revised, edits = _apply_edits(article, answer, sources, link)
                if validate and (issues := validate(revised)):
                    raise ValueError("修正案に書式・引用の問題があります: " + "; ".join(issues))
                decisions = verify(article, edits) if verify and edits else []
                rejected = []
                dismissed = []
                if verify and edits:
                    verdicts = {decision["index"]: decision for decision in decisions}
                    rejected = [dict(edit, verification=verdicts[position]) for position, edit in enumerate(edits)
                                if verdicts[position]["needs_change"] and not verdicts[position]["supported"]]
                    dismissed = [dict(edit, verification=verdicts[position]) for position, edit in enumerate(edits)
                                 if not verdicts[position]["needs_change"]]
                    accepted = [edit for position, edit in enumerate(edits)
                                if verdicts[position]["supported"] and verdicts[position]["needs_change"]]
                    if rejected or dismissed:
                        revised, edits = _apply_edits(article, {"edits": accepted}, sources, link)
                        if validate and (issues := validate(revised)):
                            raise ValueError("検証済み修正の引用・書式を確認できません: " + "; ".join(issues))
            except (AnswerRejected, ValueError) as error:
                if attempt:
                    raise ValueError("サマリーの内容レビューを検証できませんでした。既存サマリーは保持されます。 " + str(error)) from error
                request["previous_response_error"] = str(error)
                request["response_format_hint"] = (
                    "Return one valid JSON object only. Escape every backslash inside JSON strings "
                    "(write two backslashes for each literal TeX backslash). Prefer the shortest unique plain-text phrase "
                    "rather than copying long equations or table rows into original/replacement; leave unaffected math untouched.")
                progress("内容レビューの形式・根拠を再確認しています…")
            else:
                article = revised
                report["edits"].extend(edits)
                report.setdefault("verified_edits", []).extend(decision for decision in decisions
                                                                if decision["supported"] and decision["needs_change"])
                report.setdefault("rejected_edits", []).extend(rejected)
                report.setdefault("dismissed_suggestions", []).extend(dismissed)
                break
    check_cancel(cancel)
    return article, report


def _apply_edits(article: str, answer: dict, sources: list[dict], link: Callable[[str], str]) -> tuple[str, list[dict]]:
    if not matches_schema(answer, REVIEW_SCHEMA):
        raise ValueError("内容レビューの形式が不正です。")
    edits = []
    replacements: list[tuple[int, int, str]] = []
    for index, edit in enumerate(answer["edits"]):
        edit = dict(edit, evidence=resolve_evidence(edit, sources))
        original, replacement = edit["original"], edit["replacement"]
        if (len(original) > 1600 or len(replacement) > 2400
                or len(edit["evidence"]) > 800 or len(edit["reason"]) > 200):
            raise ValueError("修正案が長すぎます。originalは1600字、replacementは2400字、evidenceは800字、reasonは200字以内で、文単位の修正にしてください。")
        evidence = _quote_text(edit["evidence"])
        source = " ".join(x["text"] for x in sources if x["page"] == edit["page"])
        location = _excerpt_span(article, original) if original.strip() else None
        if location is None or not replacement.strip():
            raise ValueError(f"修正案{index + 1}の修正箇所・根拠を確認できません。不一致のoriginal: {original[:120]}。"
                             "originalを現在のMarkdownから短く一意にコピーし、replacementを空にしないでください。")
        if len(evidence) < 12 or not _grounded_quote(evidence, source):
            raise ValueError(f"修正案{index + 1}のPDF p.{edit['page']}の原文の根拠が一致しません。"
                             f"不一致の引用: {edit['evidence'][:120]}。"
                             "evidenceを当該ページから12〜300字程度で短く正確にコピーしてください。"
                             "記号・ハイフンを保持し、TeXなど別の表記へ書き換えないでください。")
        replacement = link(replacement)
        start, end = location
        original = article[start:end]
        if sorted(IMAGE.findall(original)) != sorted(IMAGE.findall(replacement)):
            raise ValueError("図表参照を変更する修正は適用できません。元の画像を保持してください。")
        if any(start < other_end and other_start < end for other_start, other_end, _ in replacements):
            raise ValueError("修正箇所が重複しています。originalは現在の本文から互いに重ならない箇所を指定してください。")
        replacements.append((start, end, replacement))
        edits.append(dict(edit, original=original, replacement=replacement))
    # Resolve every location against the immutable input. A replacement may contain
    # another edit's original phrase; string.replace would then modify the wrong one.
    for start, end, replacement in sorted(replacements, reverse=True):
        article = article[:start] + replacement + article[end:]
    return article, edits


def _excerpt_span(article: str, excerpt: str, *, unique: bool = True) -> tuple[int, int] | None:
    """Exact text, optionally without balanced Markdown strong markers; never fuzzy matching.

    Some models copy rendered prose, losing ** around a term. Track offsets back to
    the immutable Markdown and include complete marker pairs. Code, math, punctuation,
    whitespace, citations and the actual letters/numbers are never normalized.
    """
    count = article.count(excerpt)
    if count:
        start = article.index(excerpt)
        return (start, start + len(excerpt)) if count == 1 or not unique else None

    def plain(text: str) -> tuple[str, list[int], list[tuple[int, int, int, int]]]:
        protected = [match.span() for match in re.finditer(
            r"(?s)```.*?```|~~~.*?~~~|`[^`\n]+`|\$\$.*?\$\$|\$[^$\n]*\$|\\\(.*?\\\)|\\\[.*?\\\]", text)]
        strong = [match for match in re.finditer(r"\*\*([^*\n]+)\*\*", text)
                  if not any(match.start() < end and start < match.end() for start, end in protected)]
        removed = {index for match in strong for index in
                   (*range(match.start(), match.start(1)), *range(match.end(1), match.end()))}
        offsets = [index for index in range(len(text)) if index not in removed]
        return "".join(text[index] for index in offsets), offsets, [
            (match.start(), match.start(1), match.end(1), match.end()) for match in strong]

    rendered, offsets, strong = plain(article)
    target, _, _ = plain(excerpt)
    if not target or (rendered.count(target) != 1 if unique else target not in rendered):
        return None
    start = rendered.index(target)
    end = offsets[start + len(target) - 1] + 1
    start = offsets[start]
    for opening, body_start, body_end, closing in strong:
        if start <= body_start and body_end <= end:
            start, end = min(start, opening), max(end, closing)
        elif (opening < start < closing and end > closing) or (start < opening and opening < end < closing):
            return None  # Would remove half a strong span and leave dangling Markdown.
    return start, end


def _quote_text(text: str) -> str:
    # A PDF line break inside "sub-\nbox" is layout whitespace, not a different quote.
    # Expand PDF Latin ligatures to the same letters (efﬁcient == efficient). Do not use
    # general Unicode compatibility normalization, which also changes mathematical symbols.
    text = text.translate(str.maketrans({"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st"}))
    return " ".join(re.sub(r"(?<=\w)-[ \t]*\r?\n[ \t]*(?=\w)", "-", text).split())


def _grounded_quote(evidence: str, source: str) -> bool:
    # A PDF may wrap either "reach-\nable" or the compound "sub-\nbox". Accept the
    # retained or removed hyphen ONLY at those actual alphabetic line-wrap positions.
    # Real hyphens elsewhere and mathematical minus signs must still match exactly.
    source = re.sub(r"(?<=[A-Za-z])-[ \t]*\r?\n[ \t]*(?=[A-Za-z])", "\x00", source)
    source = _quote_text(source)
    evidence = _quote_text(evidence)
    pattern = []
    for index, char in enumerate(evidence):
        before = evidence[index - 1] if index else ""
        after = evidence[index + 1] if index + 1 < len(evidence) else ""
        latin = lambda letter: letter.isascii() and letter.isalpha()
        pattern.append("(?:-|\x00)" if char == "-" and latin(before) and latin(after) else re.escape(char))
        if latin(char) and latin(after):
            pattern.append("\x00?")
    return re.search("".join(pattern), source) is not None
