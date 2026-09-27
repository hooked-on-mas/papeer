"""Validated translations with bounded recovery for damaged formula markers."""
from __future__ import annotations

from collections import Counter, deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
import json
import hashlib
import re
import unicodedata

from papeer.layout.math_layout import MATH_TOKEN
from papeer.providers import check_cancel, parse_json_answer
from papeer.translation.translation_context import recovery_context
from papeer.core.code_version import application_version


TRANSLATION_SCHEMA = {
    "type": "object", "properties": {"translations": {
        "type": "array", "items": {"type": "object", "properties": {
            "id": {"type": "string"}, "text": {"type": "string"}},
            "required": ["id", "text"], "additionalProperties": False}}},
    "required": ["translations"], "additionalProperties": False,
}
from papeer.core import prompts

_RESERVED = re.compile(r"PD[\s_]*MATH", re.I)
_LOOSE_TOKEN = re.compile(r"[\[［]\s*[\[［]([^\[\]［］]+)[\]］]\s*[\]］]")

MAX_BLOCK_RETRIES = 3
# Snapshot once per process: edited code takes effect after restarting the app.
_CODE_VERSION = application_version()


def translation_version():
    """Identify the application source loaded for this session."""
    return _CODE_VERSION


def page_fingerprint(units):
    return hashlib.sha256(json.dumps(units, ensure_ascii=False,
                                     sort_keys=True).encode()).hexdigest()


def translation_fingerprint(settings, units):
    return hashlib.sha256(json.dumps({
        "version": 2, "provider": settings.provider, "model": settings.model,
        "base_url": settings.base_url, "units": units,
    }, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class RetryLimitExceeded(ValueError):
    pass


@dataclass
class RetryState:
    # Persist before sending requests, including requests interrupted in flight.
    # 0: not sent; 1: normal request sent; 2: structured; 3–4: fixed positions.
    attempts: dict[str, int] = field(default_factory=dict)
    retry_calls: int = 0

    @classmethod
    def from_cache(cls, value):
        if value is None:
            return cls()
        if (not isinstance(value, dict) or not isinstance(value.get("attempts"), dict)
                or type(value.get("retry_calls")) is not int or value["retry_calls"] < 0
                or any(not isinstance(k, str) or type(v) is not int or not 1 <= v <= 1 + MAX_BLOCK_RETRIES
                       for k, v in value["attempts"].items())):
            raise ValueError("再翻訳の回数記録が不正です。上限を保護するため停止しました。")
        return cls(dict(value["attempts"]), value["retry_calls"])

    def to_cache(self):
        return {"attempts": dict(self.attempts), "retry_calls": self.retry_calls}

    def exhausted(self, unit):
        return self.attempts.get(unit["id"], 0) >= 1 + MAX_BLOCK_RETRIES

    def check(self, unit):
        if self.exhausted(unit):
            raise RetryLimitExceeded(
                f"p.{unit['page']} / {unit['id']}：再翻訳の上限（初回を除き{MAX_BLOCK_RETRIES}回）に達したためスキップします。")

    def reserve(self, unit, save):
        self.check(unit)
        self.attempts[unit["id"]] = self.attempts.get(unit["id"], 1) + 1
        self.retry_calls += 1
        save()


def validate_translations(answer: str, expected: list[dict]) -> dict[str, str]:
    items = parse_json_answer(answer).get("translations")
    if not isinstance(items, list):
        raise ValueError("翻訳の応答形式が不正です。")
    result = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("text"), str):
            raise ValueError("翻訳のIDまたは本文が不正です。")
        if item["id"] in result or not item["text"].strip():
            raise ValueError("翻訳に重複IDまたは空の本文が含まれています。")
        text = item["text"].strip()
        text = re.sub(r"\$\\(?:mathcal|mathrm|mathbf|mathsf|mathit|text)\s*\{\s*([A-Za-z0-9_]+)\s*\}\$", r"\1", text)
        text = re.sub(r"\$\s*([A-Za-z0-9_]+)\s*\$", r"\1", text)
        result[item["id"]] = text
    if set(result) != {unit["id"] for unit in expected}:
        raise ValueError("翻訳の一部が欠落しました。")
    for unit in expected:
        text = result[unit["id"]]
        if (Counter(MATH_TOKEN.findall(unit.get("text", ""))) != Counter(MATH_TOKEN.findall(text))
                or _RESERVED.search(MATH_TOKEN.sub("", text))):
            raise ValueError("訳文中の数式の目印が欠落・変更・重複しています。")
        source_prose = MATH_TOKEN.sub("", unit.get("text", ""))
        if (len(re.findall(r"[A-Za-z]{2,}", source_prose)) >= 12
                and re.search(r"\b(?:is|are|we|this|which|where)\b", source_prose, re.I)
                and not re.search(r"[\u3040-\u30ff\u3400-\u9fff]", text)):
            raise ValueError("本文が日本語に翻訳されていません。")
    return result


def _normalize_markers(text: str, source: str) -> str:
    known = {token.casefold(): token for token in MATH_TOKEN.findall(source)}
    def replace(match):
        body = re.sub(r"\s+", "", unicodedata.normalize("NFKC", match[1]))
        return known.get(("[[" + body + "]]").casefold(), match[0])
    # Only typography around an exactly known identifier is normalized. Never
    # guess a missing identifier, remove duplicates, or move a formula.
    return _LOOSE_TOKEN.sub(replace, text)


def _valid_items(answer: str, units: list[dict]) -> dict[str, str]:
    try:
        items = parse_json_answer(answer).get("translations")
    except ValueError:
        return {}
    if not isinstance(items, list):
        return {}
    ids = Counter(item.get("id") for item in items if isinstance(item, dict) and isinstance(item.get("id"), str))
    expected = {unit["id"]: unit for unit in units}
    accepted = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("text"), str):
            continue
        identity = item["id"]
        if identity not in expected or ids[identity] != 1:
            continue
        candidate = {"id": identity, "text": _normalize_markers(item["text"], expected[identity]["text"])}
        try:
            accepted.update(validate_translations(json.dumps({"translations": [candidate]}), [expected[identity]]))
        except ValueError:
            pass
    return accepted


def _source_parts(unit: dict) -> tuple[list[dict], list[str]]:
    parts, tokens, start = [], [], 0
    for match in MATH_TOKEN.finditer(unit["text"]):
        if match.start() > start:
            parts.append({"kind": "text", "text": unit["text"][start:match.start()]})
        parts.append({"kind": "math", "index": len(tokens)})
        tokens.append(match[0])
        start = match.end()
    if start < len(unit["text"]):
        parts.append({"kind": "text", "text": unit["text"][start:]})
    return parts, tokens


def _parts_schema(count: int) -> dict:
    text = {"type": "object", "properties": {"kind": {"type": "string", "enum": ["text"]}, "text": {"type": "string"}},
            "required": ["kind", "text"], "additionalProperties": False}
    item = text
    if count:
        math = {"type": "object", "properties": {"kind": {"type": "string", "enum": ["math"]},
                "index": {"type": "integer", "enum": list(range(count))}},
                "required": ["kind", "index"], "additionalProperties": False}
        item = {"anyOf": [text, math]}
    return {"type": "object", "properties": {"parts": {"type": "array", "items": item}},
            "required": ["parts"], "additionalProperties": False}


def _assemble_parts(answer: str, tokens: list[str]) -> str:
    parts = parse_json_answer(answer).get("parts")
    if not isinstance(parts, list) or not parts:
        raise ValueError("翻訳の部品が欠落しています。")
    indices, text = [], []
    for part in parts:
        if not isinstance(part, dict):
            raise ValueError("翻訳の部品の形式が不正です。")
        if set(part) == {"kind", "text"} and part["kind"] == "text" and isinstance(part["text"], str):
            if _RESERVED.search(part["text"]):
                raise ValueError("数式の目印が本文に混入しています。")
            text.append(part["text"])
        elif set(part) == {"kind", "index"} and part["kind"] == "math" and type(part["index"]) is int and 0 <= part["index"] < len(tokens):
            indices.append(part["index"])
            text.append(tokens[part["index"]])
        else:
            raise ValueError("翻訳の部品の形式が不正です。")
    if Counter(indices) != Counter(range(len(tokens))):
        raise ValueError("数式の番号が欠落・重複しています。")
    value = "".join(text).strip()
    if not value:
        raise ValueError("翻訳の本文が空です。")
    return value


def _locked_translation(provider, unit: dict, parts: list[dict], tokens: list[str], cancel) -> str:
    # Last resort: the model translates prose fragments only. Formula positions
    # and identifiers are reconstructed locally in their original order.
    fragments = [{"id": f"text{i}", "text": part["text"]} for i, part in enumerate(parts)
                 if part["kind"] == "text" and re.search(r"[A-Za-z\u3040-\u30ff\u3400-\u9fff]", part["text"])]
    translated = {}
    if fragments:
        check_cancel(cancel)
        answer = provider.generate(
            prompts.load("translation_fallback"),
            json.dumps({"context_parts": parts, "texts": fragments, "glossary": unit.get("glossary", []),
                        **recovery_context(unit)}, ensure_ascii=False), TRANSLATION_SCHEMA)
        translated = validate_translations(answer, fragments)
    result = []
    for i, part in enumerate(parts):
        result.append(tokens[part["index"]] if part["kind"] == "math" else translated.get(f"text{i}", part["text"]))
    return "".join(result).strip()


def _checked(unit: dict, text: str) -> dict:
    return validate_translations(json.dumps({"translations": [{"id": unit["id"], "text": text}]}), [unit])


def _recover_unit(provider, unit, cancel, progress, state, save):
    """Retry `unit` until a translation passes the final check; raise RetryLimitExceeded once out of retries."""
    parts, tokens = _source_parts(unit)
    instruction = prompts.load("translation_recovery")
    if state.attempts.get(unit["id"], 1) < 2:
        check_cancel(cancel)
        state.reserve(unit, save)
        progress(f"本文と数式番号を分けて再翻訳 p.{unit['page']} / {unit['id']}"
                 f"（追加1/{MAX_BLOCK_RETRIES}回）")
        answer = provider.generate(instruction, json.dumps({"source_parts": parts, "required_math_indices": list(range(len(tokens))),
                                                           "glossary": unit.get("glossary", []),
                                                           **recovery_context(unit)},
                                                           ensure_ascii=False), _parts_schema(len(tokens)))
        # A translation failing the final check falls through to the fixed-position retries.
        try:
            return _checked(unit, _assemble_parts(answer, tokens))
        except ValueError:
            pass
    while not state.exhausted(unit):
        check_cancel(cancel)
        state.reserve(unit, save)
        progress(f"数式の位置を固定して本文を翻訳 p.{unit['page']} / {unit['id']}"
                 f"（追加{state.attempts[unit['id']] - 1}/{MAX_BLOCK_RETRIES}回）")
        try:
            return _checked(unit, _locked_translation(provider, unit, parts, tokens, cancel))
        except ValueError:
            pass
    state.check(unit)


def translate_batch(provider, units, cancel, progress, accept, state=None, save=lambda: None):
    translate_batches(provider, [units], cancel, progress, accept, state, save)


def translate_batches(provider, batches, cancel, progress, accept, state=None, save=lambda: None,
                      concurrency=1, finished=lambda index: None):
    """Translate `batches`, keeping up to `concurrency` first requests in flight.

    Only each batch's first request runs on a worker thread. Retry records, recovery
    requests and all callbacks stay on the calling thread, so the retry budget is
    saved before every request just as in serial translation. `finished(index)` runs
    once a batch is done; with concurrency, batches may finish out of order.
    """
    state = state if state is not None else RetryState()
    # Read at the start of each run, so a prompt edited in the settings applies to the next translation.
    instruction = prompts.load("translation")

    def recover(unit):
        check_cancel(cancel)
        try:
            state.check(unit)
            accept(_recover_unit(provider, unit, cancel, progress, state, save))
        except RetryLimitExceeded as error:
            # Skip only this paragraph; the rest of the paper goes on.
            progress(str(error))

    def start(units):
        """Recover blocks already sent in an earlier run; return the rest, recorded as sent."""
        check_cancel(cancel)
        previous = [unit for unit in units if state.attempts.get(unit["id"], 0)]
        for unit in previous:
            recover(unit)
        fresh = [unit for unit in units if unit not in previous]
        if fresh:
            check_cancel(cancel)
            for unit in fresh:
                state.attempts[unit["id"]] = 1
            save()
        return fresh

    def request(fresh):
        return provider.generate(instruction, json.dumps(fresh, ensure_ascii=False), TRANSLATION_SCHEMA)

    def finish(fresh, answer):
        accepted = _valid_items(answer, fresh)
        if accepted:
            accept(accepted)
        for unit in fresh:
            if unit["id"] not in accepted:
                recover(unit)

    if concurrency <= 1:
        for index, units in enumerate(batches):
            fresh = start(units)
            if fresh:
                finish(fresh, request(fresh))
            finished(index)
        return

    waiting = deque(enumerate(batches))
    running = {}
    pool = ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="translate")
    try:
        while waiting or running:
            while waiting and len(running) < concurrency:
                index, units = waiting.popleft()
                fresh = start(units)
                if fresh:
                    running[pool.submit(request, fresh)] = (index, fresh)
                else:
                    finished(index)
            completed, _ = wait(running, return_when=FIRST_COMPLETED)
            for future in completed:
                index, fresh = running.pop(future)
                finish(fresh, future.result())
                finished(index)
    except BaseException:
        # Keep answers that were already on their way; blocks without a valid
        # answer are recorded as sent and go to recovery when translation resumes.
        if not cancel.is_set():
            for future, (index, fresh) in running.items():
                try:
                    accepted = _valid_items(future.result(), fresh)
                    if accepted:
                        accept(accepted)
                except Exception:
                    continue
        raise
    finally:
        pool.shutdown(wait=True)
