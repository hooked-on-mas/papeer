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
from papeer.providers import AnswerRejected, check_cancel, parse_json_answer
from papeer.translation.translation_context import recovery_context


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
# How many times one request of a block (its first request or one retry) may go out without an
# answer coming back (a timeout, a lost connection, the app closed mid-request) before it counts
# as a failed answer. Up to then, resuming sends the same request again instead of spending a
# retry on it; beyond, it is charged as before, so a request that never answers cannot be sent
# forever. Temporary failures are already retried inside ProviderBackend.generate first.
MAX_UNANSWERED_SENDS = 3
# A saved translation is reused while what the model receives stays the same: the source
# units (with their glossary), the translation prompt in use (prompt_identity), the provider
# and model, the response schema, and this number. Editing code does not retranslate anything
# by itself, so raise this by hand when a change to how translations are requested or checked
# should make existing papers translate again (drawing changes only redraw from saved translations).
TRANSLATION_PROTOCOL = 1
# The built-in translation.txt counts by this number, not by its text: raise it only when an
# edit of the built-in prompt should retranslate existing papers. Editing the text without
# raising it keeps translations made with the earlier text (tests/test_page_selection.py pins
# the text's hash so that every edit makes this decision).
BUILTIN_PROMPT_REVISION = 1
# Cache entries written before TranslationKey carry the hash of the pipeline source
# ("code-sha256-...") instead, and no prompt or provider. They are adopted as protocol 1
# made with built-in prompt revision 1. This is the text of revision 1 (translation.txt when
# TranslationKey was added), so that a user override still holding that text counts as
# revision 1 after the built-in prompt changes. Never update it.
_LEGACY_PROTOCOL = 1
LEGACY_PROMPT_SHA256 = "ba81d7adc7ad4747c848d34313425193809a93595f312ba0142e54289dbfb450"
_LEGACY_PROMPT = "builtin-1"
_LEGACY_VERSION = re.compile(r"code-sha256-[0-9a-f]{64}")


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def prompt_identity(instruction: str) -> str:
    """The translation prompt as cache identity: a built-in revision, or the hash of the user's own text."""
    # The settings dialog drops an override equal to the built-in text, but one saved otherwise
    # (or an older built-in text kept as an override) must not count as the user's own prompt.
    if instruction == prompts.builtin("translation"):
        return f"builtin-{BUILTIN_PROMPT_REVISION}"
    if _sha256(instruction) == LEGACY_PROMPT_SHA256:
        return _LEGACY_PROMPT
    return "custom-sha256-" + _sha256(instruction)


def translation_identity(settings, instruction: str) -> str:
    """Everything besides the source units that decides a translation's content."""
    return "translation-sha256-" + _sha256(json.dumps({
        "protocol": TRANSLATION_PROTOCOL, "provider": settings.provider, "model": settings.model,
        # Only the OpenAI-compatible API sends requests to base_url. It is kept per PC,
        # so the CLI connections must not depend on whatever value a PC has stored.
        "base_url": settings.base_url.strip().rstrip("/") if settings.provider == "api" else None,
        "prompt": prompt_identity(instruction), "schema": TRANSLATION_SCHEMA,
    }, ensure_ascii=False, sort_keys=True))


def page_fingerprint(units):
    return hashlib.sha256(json.dumps(units, ensure_ascii=False,
                                     sort_keys=True).encode()).hexdigest()


def translation_fingerprint(settings, units):
    return hashlib.sha256(json.dumps({
        "version": 3, "provider": settings.provider, "model": settings.model,
        "base_url": settings.base_url.strip().rstrip("/") if settings.provider == "api" else None,
        "units": units,
    }, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def legacy_translation_fingerprint(settings, units):
    # translation_fingerprint as written by caches from before TranslationKey.
    return hashlib.sha256(json.dumps({
        "version": 2, "provider": settings.provider, "model": settings.model,
        "base_url": settings.base_url, "units": units,
    }, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


@dataclass(frozen=True)
class TranslationKey:
    """What saved translations must match to be reused instead of asking the model again.

    `identity` is stored as the cache's "translation_version" and each completed page's
    "version"; `fingerprint` also covers every unit of the paper, for the translations of
    unfinished pages and the retry budget kept at the top of translation-cache.json.
    """
    identity: str
    fingerprint: str
    model: str
    legacy_fingerprint: str | None

    @classmethod
    def current(cls, settings, instruction: str, units: list[dict]) -> "TranslationKey":
        legacy = TRANSLATION_PROTOCOL == _LEGACY_PROTOCOL and prompt_identity(instruction) == _LEGACY_PROMPT
        return cls(translation_identity(settings, instruction), translation_fingerprint(settings, units),
                   settings.model, legacy_translation_fingerprint(settings, units) if legacy else None)

    def _legacy(self, version) -> bool:
        return self.legacy_fingerprint is not None and isinstance(version, str) and bool(_LEGACY_VERSION.fullmatch(version))

    def matches_cache(self, cache: dict) -> bool:
        if cache.get("translation_version") == self.identity:
            return cache.get("fingerprint") == self.fingerprint
        # The fingerprint written then holds the provider, model and endpoint of that run.
        return self._legacy(cache.get("translation_version")) and cache.get("fingerprint") == self.legacy_fingerprint

    def matches_page(self, entry: dict) -> bool:
        """Whether a completed page's record was translated with this key (its source is checked separately)."""
        if entry.get("version") == self.identity:
            return True
        # Old page records name their model but not the provider; the model decides.
        return self._legacy(entry.get("version")) and entry.get("model") == self.model


class RetryLimitExceeded(ValueError):
    pass


@dataclass
class RetryState:
    # Persist before sending requests, including requests interrupted in flight.
    # 0: not sent; 1: normal request sent; 2: structured; 3–4: fixed positions.
    attempts: dict[str, int] = field(default_factory=dict)
    retry_calls: int = 0
    # Blocks whose latest request (the one attempts names) is sent but not answered yet:
    # how many times it went out without an answer. Recorded with the attempt before sending
    # and removed once an answer (valid or not) arrives, so what is left after a run ended by an
    # error, a cancel or a crash is exactly the requests that got no answer. Caches from before
    # this record have attempts only; their blocks count as answered, as they did then.
    unanswered: dict[str, int] = field(default_factory=dict)

    @classmethod
    def from_cache(cls, value):
        if value is None:
            return cls()
        unanswered = value.get("unanswered", {}) if isinstance(value, dict) else None
        if (not isinstance(value, dict) or not isinstance(value.get("attempts"), dict)
                or type(value.get("retry_calls")) is not int or value["retry_calls"] < 0
                or any(not isinstance(k, str) or type(v) is not int or not 1 <= v <= 1 + MAX_BLOCK_RETRIES
                       for k, v in value["attempts"].items())
                or not isinstance(unanswered, dict)
                or any(k not in value["attempts"] or type(v) is not int or not 1 <= v <= MAX_UNANSWERED_SENDS
                       for k, v in unanswered.items())):
            raise ValueError("再翻訳の回数記録が不正です。上限を保護するため停止しました。")
        return cls(dict(value["attempts"]), value["retry_calls"], dict(unanswered))

    def to_cache(self):
        return {"attempts": dict(self.attempts), "retry_calls": self.retry_calls,
                "unanswered": dict(self.unanswered)}

    def resendable(self, unit) -> bool:
        """Whether the block's latest request got no answer and may go out again as it is."""
        return 0 < self.unanswered.get(unit["id"], 0) < MAX_UNANSWERED_SENDS

    def answered_level(self, unit) -> int:
        """The latest request of the block that came back with an answer (the levels of `attempts`)."""
        level = self.attempts.get(unit["id"], 0)
        return level - 1 if self.resendable(unit) else level

    def exhausted(self, unit):
        return self.answered_level(unit) >= 1 + MAX_BLOCK_RETRIES

    def check(self, unit):
        if self.exhausted(unit):
            raise RetryLimitExceeded(
                f"p.{unit['page']} / {unit['id']}：再翻訳の上限（初回を除き{MAX_BLOCK_RETRIES}回）に達したためスキップします。")

    def _send(self, unit, level):
        identity = unit["id"]
        if self.resendable(unit) and self.attempts.get(identity) == level:
            self.unanswered[identity] += 1
        else:
            self.attempts[identity] = level
            self.unanswered[identity] = 1

    def send_first(self, units, save):
        """Record the first request of `units` as sent (again, for blocks whose first request got no answer)."""
        for unit in units:
            self._send(unit, 1)
        save()

    def reserve(self, unit, save):
        """Record the next retry of `unit` as sent, or the same retry again when it got no answer."""
        self.check(unit)
        # A block reaching recovery has had its first request answered, even with no record of it.
        self._send(unit, max(self.answered_level(unit), 1) + 1)
        self.retry_calls += 1
        save()

    def answered(self, units):
        """An answer came back for `units`; whether it passes the checks is up to the caller. Saved with the next record."""
        for unit in units:
            self.unanswered.pop(unit["id"], None)


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


def _locked_request(provider, unit: dict, parts: list[dict], cancel) -> tuple[list[dict], str]:
    # Last resort: the model translates prose fragments only. Formula positions
    # and identifiers are reconstructed locally in their original order (_locked_translation).
    fragments = [{"id": f"text{i}", "text": part["text"]} for i, part in enumerate(parts)
                 if part["kind"] == "text" and re.search(r"[A-Za-z\u3040-\u30ff\u3400-\u9fff]", part["text"])]
    if not fragments:
        return fragments, ""
    check_cancel(cancel)
    return fragments, provider.generate(
        prompts.load("translation_fallback"),
        json.dumps({"context_parts": parts, "texts": fragments, "glossary": unit.get("glossary", []),
                    **recovery_context(unit)}, ensure_ascii=False), TRANSLATION_SCHEMA)


def _locked_translation(answer: str, fragments: list[dict], parts: list[dict], tokens: list[str]) -> str:
    translated = validate_translations(answer, fragments) if fragments else {}
    result = []
    for i, part in enumerate(parts):
        result.append(tokens[part["index"]] if part["kind"] == "math" else translated.get(f"text{i}", part["text"]))
    return "".join(result).strip()


def _received(state, save, units, send):
    """send() the request of `units` and record them as answered.

    An answer that came back unusable (AnswerRejected: cut off, empty) was answered too: it is
    recorded and saved before the error stops the run, so that resuming moves on (a first
    request to recovery, a retry to the next one) instead of paying for the same request again.
    Any other error leaves the request unanswered (RetryState.unanswered).
    """
    try:
        answer = send()
    except AnswerRejected:
        state.answered(units)
        save()
        raise
    state.answered(units)
    return answer


def _checked(unit: dict, text: str) -> dict:
    return validate_translations(json.dumps({"translations": [{"id": unit["id"], "text": text}]}), [unit])


def _recover_unit(provider, unit, cancel, progress, state, save):
    """Retry `unit` until a translation passes the final check; raise RetryLimitExceeded once out of retries.

    Only an answer failing the checks moves on to the next retry. An error of the request itself
    stops the run: with no answer (a lost connection, a missing model name) the retry is sent again
    as it was when translation resumes (RetryState.unanswered); an unusable answer (AnswerRejected)
    counts as answered, and resuming goes on to the next retry (_received).
    """
    parts, tokens = _source_parts(unit)
    instruction = prompts.load("translation_recovery")
    if state.answered_level(unit) < 2:
        check_cancel(cancel)
        state.reserve(unit, save)
        progress(f"本文と数式番号を分けて再翻訳 p.{unit['page']} / {unit['id']}"
                 f"（追加1/{MAX_BLOCK_RETRIES}回）")
        payload = json.dumps({"source_parts": parts, "required_math_indices": list(range(len(tokens))),
                              "glossary": unit.get("glossary", []), **recovery_context(unit)}, ensure_ascii=False)
        answer = _received(state, save, [unit], lambda: provider.generate(instruction, payload, _parts_schema(len(tokens))))
        # A translation failing the final check falls through to the fixed-position retries.
        try:
            return _checked(unit, _assemble_parts(answer, tokens))
        except ValueError:
            pass
    while not state.exhausted(unit):
        if cancel.is_set():
            save()  # The answer just checked stays on record; the next retry's record would have carried it.
        check_cancel(cancel)
        state.reserve(unit, save)
        progress(f"数式の位置を固定して本文を翻訳 p.{unit['page']} / {unit['id']}"
                 f"（追加{state.attempts[unit['id']] - 1}/{MAX_BLOCK_RETRIES}回）")
        fragments, answer = _received(state, save, [unit], lambda: _locked_request(provider, unit, parts, cancel))
        try:
            return _checked(unit, _locked_translation(answer, fragments, parts, tokens))
        except ValueError:
            pass
    state.check(unit)


def translate_batch(provider, units, cancel, progress, accept, state=None, save=lambda: None):
    translate_batches(provider, [units], cancel, progress, accept, state, save)


def translate_batches(provider, batches, cancel, progress, accept, state=None, save=lambda: None,
                      concurrency=1, finished=lambda index: None, instruction=None):
    """Translate `batches`, keeping up to `concurrency` first requests in flight.

    Only each batch's first request runs on a worker thread. Retry records, recovery
    requests and all callbacks stay on the calling thread, so the retry budget is
    saved before every request just as in serial translation. `finished(index)` runs
    once a batch is done; with concurrency, batches may finish out of order.
    `instruction` is the translation prompt the caller keyed its cache with (TranslationKey).
    """
    state = state if state is not None else RetryState()
    # Read at the start of each run, so a prompt edited in the settings applies to the next translation.
    if instruction is None:
        instruction = prompts.load("translation")

    def recover(unit):
        check_cancel(cancel)
        # Skip only a paragraph out of retries; the rest of the paper goes on.
        try:
            state.check(unit)
        except RetryLimitExceeded as error:
            progress(str(error))
            return
        try:
            accept(_recover_unit(provider, unit, cancel, progress, state, save))
        except RetryLimitExceeded as error:
            # Saved so that the last retry's answer is on record; resuming would otherwise
            # take that retry as unanswered and send it again.
            save()
            progress(str(error))

    def start(units):
        """Recover blocks answered in an earlier run; return the rest, recorded as sent.

        Blocks whose first request went out but got no answer (RetryState.unanswered) are
        sent with the batch again instead of spending a retry.
        """
        check_cancel(cancel)
        previous = [unit for unit in units if state.answered_level(unit)]
        for unit in previous:
            recover(unit)
        fresh = [unit for unit in units if unit not in previous]
        if fresh:
            check_cancel(cancel)
            state.send_first(fresh, save)
        return fresh

    def request(fresh):
        return provider.generate(instruction, json.dumps(fresh, ensure_ascii=False), TRANSLATION_SCHEMA)

    def finish(fresh, answer):
        accepted = _valid_items(answer, fresh)
        if accepted:
            accept(accepted)
        else:
            # accept() saves the answered record otherwise; a cancel before the first retry's
            # record must not leave these blocks looking unanswered.
            save()
        for unit in fresh:
            if unit["id"] not in accepted:
                recover(unit)

    if concurrency <= 1:
        for index, units in enumerate(batches):
            fresh = start(units)
            if fresh:
                finish(fresh, _received(state, save, fresh, lambda: request(fresh)))
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
                finish(fresh, _received(state, save, fresh, future.result))
                finished(index)
    except BaseException:
        # Keep answers that were already on their way; after a cancel, only those already here,
        # without waiting for the rest. Blocks with an answer (also one that fails the checks or
        # is unusable) go to recovery when translation resumes; blocks whose request got no
        # answer stay unanswered and are sent with a batch again. One save records them all.
        answered = False
        for future, (index, fresh) in running.items():
            if cancel.is_set() and not future.done():
                continue
            try:
                answer = future.result()
            except AnswerRejected:
                state.answered(fresh)
                answered = True
                continue
            except Exception:
                continue
            state.answered(fresh)
            answered = True
            try:
                accepted = _valid_items(answer, fresh)
                if accepted:
                    accept(accepted)
            except Exception:
                continue
        if answered:
            try:
                save()
            except Exception:
                pass
        raise
    finally:
        pool.shutdown(wait=True)
