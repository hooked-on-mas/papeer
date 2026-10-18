"""Bounded repair/audit loop for summaries; no human-edited acceptance path."""
from __future__ import annotations

import hashlib
import json
import threading
from typing import Callable

from papeer.core import prompts
from papeer.core.summary_evidence import evidence_schema, indexed_sources, resolve_evidence
from papeer.core.summary_review import (CITATION, REVIEW_SCHEMA, _apply_edits, _excerpt_span, _grounded_quote,
                                       review_article)
from papeer.providers import AnswerRejected, check_cancel, parse_json_answer
from papeer.providers.common import matches_schema


AUDIT_SCHEMA = {
    **REVIEW_SCHEMA,
    "required": ["edits", "checked_pages", "coverage"],
    "properties": {**REVIEW_SCHEMA["properties"],
        "checked_pages": {"type": "array", "items": {"type": "integer"}},
        "coverage": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["kind", "page", "evidence", "article_excerpt"],
            "properties": {"kind": {"type": "string", "enum": ["question", "method", "result", "limitation"]},
                "page": {"type": "integer"},
                "evidence_id": {"type": "string"},
                **{key: {"type": "string"} for key in ("evidence", "article_excerpt")}}}}}}

VERDICT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["decisions"],
    "properties": {"decisions": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["index", "supported", "needs_change", "reason", "page", "evidence"],
        "properties": {"index": {"type": "integer"}, "supported": {"type": "boolean"},
            "needs_change": {"type": "boolean"},
            "evidence_id": {"type": "string"},
            "page": {"type": "integer"}, **{key: {"type": "string"} for key in ("reason", "evidence")}}}}}}

MAX_REPAIR_ROUNDS = 3


def _context(sources: list[dict], pages: set[int]) -> list[dict]:
    # Include complete cited pages and their neighbors, not just a short supporting
    # quote. This prevents equating an illustrative figure with a separate sample test.
    nearby = pages | {page + delta for page in pages for delta in (-1, 1)}
    return [{"page": unit["page"], "text": unit["text"]} for unit in sources if unit["page"] in nearby]


def verify_edits(article: str, edits: list[dict], sources: list[dict], provider,
                 cancel: threading.Event, *, allow_rejections: bool = False) -> list[dict]:
    """A second request judges semantic support, not merely existence of a quote."""
    if not edits:
        return []
    pages = {edit["page"] for edit in edits}
    for edit in edits:
        pages.update(int(page) for _, page in CITATION.findall(edit["original"] + edit["replacement"]))
    context = indexed_sources(_context(sources, pages))
    request = {"phase": "verify_edits", "article": article, "edits": edits, "source_pages": context}
    def validate_verdicts(answer: dict) -> None:
        decisions = answer["decisions"]
        if (len(decisions) != len(edits) or {item["index"] for item in decisions} != set(range(len(edits)))):
            raise ValueError("修正案の意味検証に未確認・重複の項目があります。")
        for decision in decisions:
            decision["evidence"] = resolve_evidence(decision, context)
            source = "\n".join(unit["text"] for unit in context if unit["page"] == decision["page"])
            # Keep complete theorem conditions, never truncate supporting evidence.
            if len(decision["reason"]) > 600 or len(decision["evidence"]) > 1600:
                raise ValueError("修正案の意味検証が長すぎます。reasonは400字以内、evidenceは短い原文の引用にしてください。")
            if len(decision["evidence"].strip()) < 12 or not _grounded_quote(decision["evidence"], source):
                raise ValueError(f"意味検証項目{decision['index'] + 1}のPDF p.{decision['page']}の原文と引用が一致しません。"
                                 f"不一致の引用: {decision['evidence'][:120]}。"
                                 "当該ページから12〜300字程度の短い原文を、数式・記号・語句を改変せずコピーしてください。")

    # An invalid verifier quote belongs to the verifier, not to the editor: send
    # the diagnostic back to that same stage without rewriting a sound proposal.
    answer = _request(provider, prompts.builtin("_summary_verify"), request, VERDICT_SCHEMA, cancel,
                      validate=validate_verdicts)
    decisions = answer["decisions"]
    for decision in decisions:
        if not decision["supported"] and not allow_rejections:
            raise ValueError(f"修正案{decision['index'] + 1}は原文の条件・意味を保持していません: {decision['reason']}")
    return decisions


def _request(provider, instruction: str, request: dict, schema: dict, cancel: threading.Event, *,
             validate: Callable[[dict], None] | None = None) -> dict:
    # Retry schema/literal-evidence errors at their originating stage. A negative
    # semantic verdict is returned to the caller, never retried into an approval.
    for attempt in range(2):
        check_cancel(cancel)
        try:
            answer = parse_json_answer(provider.generate(instruction, json.dumps(request, ensure_ascii=False), evidence_schema(schema)), schema)
            if not matches_schema(answer, schema):
                raise ValueError("JSONが検証スキーマと一致しません。")
            if validate:
                validate(answer)
            return answer
        except (AnswerRejected, ValueError) as error:
            if attempt:
                raise ValueError("サマリーの自動検証の応答を確認できませんでした: " + str(error)) from error
            request = dict(request, previous_response_error=str(error),
                           response_format_hint="Return compact JSON only; escape each literal TeX backslash as two backslashes.")
    raise AssertionError("unreachable")


def _check_coverage(answer: dict, article: str, context: list[dict], pages: set[int]) -> list[dict]:
    checked = answer["checked_pages"]
    if len(checked) != len(set(checked)) or set(checked) != pages:
        raise ValueError("最終検査で対象ページの確認が欠けています。")
    coverage = answer["coverage"]
    for index, point in enumerate(coverage):
        point["evidence"] = resolve_evidence(point, context)
        source = "\n".join(unit["text"] for unit in context if unit["page"] == point["page"])
        if point["page"] not in pages:
            raise ValueError(f"網羅性項目{index + 1}のページが対象外です。pageは{sorted(pages)}から選んでください。")
        if not 12 <= len(point["evidence"].strip()) <= 800 or not _grounded_quote(point["evidence"], source):
            raise ValueError(f"網羅性項目{index + 1}のPDF p.{point['page']}の原文と引用が一致しません。"
                             f"不一致の引用: {point['evidence'][:120]}。"
                             "当該ページから12〜300字程度の短い原文を、数式・記号・語句を改変せずコピーしてください。")
        location = _excerpt_span(article, point["article_excerpt"], unique=False) if point["article_excerpt"].strip() else None
        if location is None or len(point["article_excerpt"]) > 1600:
            raise ValueError(f"網羅性項目{index + 1}に対応する本文を確認できません。"
                             f"不一致のexcerpt: {point['article_excerpt'][:120]}。"
                             "article_excerptは現在のMarkdownから短く正確にコピーしてください。欠落なら修正案を返してください。")
        point["article_excerpt"] = article[location[0]:location[1]]
    return coverage


def finalize_article(article: str, paper_id: str, source_units: list[dict], provider,
                     cancel: threading.Event, progress: Callable[[str], None], link: Callable[[str], str],
                     validate: Callable[[str], list[str]]) -> tuple[str, dict]:
    """Publish only after a complete audit makes no edits to the exact final article.

    The reviewer and auditor use separate prompts/requests on the configured model.
    This is a quality gate, not a mathematical proof that an LLM made no mistakes.
    """
    from papeer.pdf.pdf_engine import batches

    def verifier(draft: str, edits: list[dict]) -> list[dict]:
        check_cancel(cancel)
        progress("修正案が原文の条件・意味を保持しているか検証しています…")
        return verify_edits(draft, edits, source_units, provider, cancel, allow_rejections=True)

    article, report = review_article(article, paper_id, source_units, provider, cancel, progress, link,
                                     verify=verifier, validate=validate)
    instruction = prompts.builtin("_summary_audit")
    report.update(version=3, acceptance="pending", audit_prompt_sha256=hashlib.sha256(instruction.encode()).hexdigest(),
                  verify_prompt_sha256=hashlib.sha256(prompts.builtin("_summary_verify").encode()).hexdigest(), audits=[],
                  source_sha256=hashlib.sha256(json.dumps(source_units, ensure_ascii=False, sort_keys=True).encode()).hexdigest())
    chunks = list(batches(source_units, limit=18000, size=lambda xs: sum(len(x["text"]) + 100 for x in xs)))
    # Reserve a clean confirmation pass after the last permitted repair. Finding
    # a valid correction in round 3 must not consume its own confirmation budget.
    for round_index in range(MAX_REPAIR_ROUNDS + 1):
        check_cancel(cancel)
        initial = article
        audit = {"round": round_index + 1, "input_sha256": hashlib.sha256(article.encode()).hexdigest(),
                 "edits": [], "rejected_edits": [], "dismissed_suggestions": [], "coverage": [], "checked_pages": []}
        for index, chunk in enumerate(chunks):
            check_cancel(cancel)
            progress(f"サマリーの最終検査 {round_index + 1}/{MAX_REPAIR_ROUNDS + 1}・原文 {index + 1}/{len(chunks)}")
            pages = {unit["page"] for unit in chunk}
            context = indexed_sources(_context(source_units, pages))
            request = {"phase": "acceptance_audit", "paper_id": paper_id, "article": article,
                       "review_pages": sorted(pages), "source_pages": context}
            for attempt in range(2):
                try:
                    answer = _request(provider, instruction, request, AUDIT_SCHEMA, cancel)
                    coverage = _check_coverage(answer, article, context, pages)
                    revised, edits = _apply_edits(article, {"edits": answer["edits"]}, context, link)
                    if issues := validate(revised):
                        raise ValueError("最終検査の修正案に書式・引用の問題があります: " + "; ".join(issues))
                    decisions = verifier(article, edits) if edits else []
                    verdicts = {decision["index"]: decision for decision in decisions}
                    rejected = [dict(edit, verification=verdicts[position]) for position, edit in enumerate(edits)
                                if verdicts[position]["needs_change"] and not verdicts[position]["supported"]]
                    dismissed = [dict(edit, verification=verdicts[position]) for position, edit in enumerate(edits)
                                 if not verdicts[position]["needs_change"]]
                    accepted = [edit for position, edit in enumerate(edits)
                                if verdicts[position]["supported"] and verdicts[position]["needs_change"]]
                    if rejected or dismissed:
                        revised, edits = _apply_edits(article, {"edits": accepted}, context, link)
                        if issues := validate(revised):
                            raise ValueError("検証済み修正の引用・書式を確認できません: " + "; ".join(issues))
                except (AnswerRejected, ValueError) as error:
                    if attempt:
                        raise ValueError("サマリーの最終検査を完了できませんでした。既存サマリーは保持されます。 " + str(error)) from error
                    request["previous_response_error"] = str(error)
                    progress("最終検査の修正案・根拠を再確認しています…")
                else:
                    if edits and round_index == MAX_REPAIR_ROUNDS:
                        raise ValueError("サマリーの修正が自動検査で収束しませんでした。既存サマリーは保持されます。再生成してください。")
                    article = revised
                    audit["edits"].extend(edits)
                    audit["rejected_edits"].extend(rejected)
                    audit["dismissed_suggestions"].extend(dismissed)
                    audit["coverage"].extend(coverage)
                    audit["checked_pages"].extend(sorted(pages))
                    report.setdefault("verified_edits", []).extend(decision for decision in decisions
                                                                    if decision["supported"] and decision["needs_change"])
                    report.setdefault("rejected_edits", []).extend(rejected)
                    report.setdefault("dismissed_suggestions", []).extend(dismissed)
                    report["edits"].extend(edits)
                    break
        audit["checked_pages"] = sorted(set(audit["checked_pages"]))
        audit["output_sha256"] = hashlib.sha256(article.encode()).hexdigest()
        report["audits"].append(audit)
        # Even an edit followed by its reversal requires another full clean pass.
        if not audit["edits"] and not audit["rejected_edits"] and article == initial:
            if not audit["coverage"]:
                raise ValueError("問題なしという判定に、本文と原文を結ぶ網羅性の根拠がありません。")
            report.update(acceptance="passed", acceptance_article_sha256=audit["output_sha256"],
                          coverage=audit["coverage"])
            check_cancel(cancel)
            return article, report
    raise ValueError("サマリーの修正が自動検査で収束しませんでした。既存サマリーは保持されます。再生成してください。")
