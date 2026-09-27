"""Global terminology used by translations and checked in them, and validation of edited math tokens."""
from __future__ import annotations

from collections import Counter
from contextlib import closing
from functools import lru_cache
import json
from pathlib import Path
import re
import sqlite3
from typing import NamedTuple
import unicodedata

from papeer.core.errors import Conflict
from papeer.layout.math_layout import MATH_TOKEN


def global_glossary(root: Path) -> list[dict[str, str]]:
    """Migrate legacy dictionaries once, then use a single library-wide dictionary."""
    with closing(sqlite3.connect(root / "library.sqlite3", timeout=30)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS global_glossary (id INTEGER PRIMARY KEY CHECK(id=1), terms TEXT NOT NULL)")
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT terms FROM global_glossary WHERE id=1").fetchone()
        if row:
            return json.loads(row[0])
        merged = {}
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='collection_glossaries'").fetchone():
            for row in db.execute("SELECT terms FROM collection_glossaries ORDER BY name"):
                for term in json.loads(row[0]):
                    merged[term["source"].casefold()] = term
        # Keep legacy files intact, including alternate translations for conflicting terms.
        for path in sorted((root / "papers").glob("*/glossary.json")):
            for term in json.loads(path.read_text("utf-8")):
                merged[term["source"].casefold()] = term
        terms = list(merged.values())
        db.execute("INSERT INTO global_glossary VALUES(1,?)", (json.dumps(terms, ensure_ascii=False),))
        return terms


class GlossaryConflict(Conflict):
    """The dictionary was changed elsewhere since the caller read it (409)."""


def save_global_glossary(root: Path, terms: list[dict[str, str]], expected=None) -> None:
    global_glossary(root)
    with closing(sqlite3.connect(root / "library.sqlite3", timeout=30)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        current = json.loads(db.execute("SELECT terms FROM global_glossary WHERE id=1").fetchone()[0])
        if expected is not None and current != expected:
            raise GlossaryConflict("共通辞書が別の画面で変更されました。辞書を開き直してから変更を適用してください。")
        db.execute("UPDATE global_glossary SET terms=? WHERE id=1", (json.dumps(terms, ensure_ascii=False),))


def glossary_for_folder(folder: Path) -> list[dict[str, str]]:
    root = folder.parent.parent
    return global_glossary(root) if (root / "library.sqlite3").is_file() else []


def effective_glossary(lib, paper_id: str) -> list[dict[str, str]]:
    lib.paper(paper_id)
    return global_glossary(lib.root)


# Letters of scripts written with spaces between words, where a term starts and ends on a word
# boundary (RL is not found in "world"). Japanese has no spaces: a Japanese term is found anywhere.
_LETTER = "0-9A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff"
_WORD = _LETTER + "_"  # Letters joined by an underscore (state_space) are one word too.
_CJK = "\u3005\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff"
_KANJI_CHARS = "\u3005\u3400-\u4dbf\u4e00-\u9fff"
_KANJI = re.compile(f"[{_KANJI_CHARS}]")
_HIRAGANA = re.compile("[\u3041-\u3096]+")
# A rendering in pieces: each kanji, runs of hiragana, runs of anything else.
_KANA_RUNS = re.compile(f"[{_KANJI_CHARS}]|[\u3041-\u3096]+|[^{_KANJI_CHARS}\u3041-\u3096]+")
_OKURIGANA = "[\u3041-\u3096]{0,3}"
_CJK_SPACE = re.compile(f"(?<=[{_CJK}])\\s+(?=[{_CJK}])")
# A word broken at the end of a line ("predic-" / "tive"). Whether the hyphen is part of the word
# ("model-" / "based") cannot be told, so the text is searched both ways.
_LINE_END_HYPHEN = re.compile(f"(?<=[{_LETTER}])[-\u2010][ \\t]*\\n\\s*(?=[{_LETTER}])")
_CONSONANT_Y = re.compile(r"(?<=[b-df-hj-np-tv-z])y$")
# A soft hyphen only marks where a word may break: the word goes on after it (and its line break).
_SOFT_HYPHEN = re.compile("\u00ad\\s*")


def _normalized(text: str) -> str:
    """NFKC (ligatures, full-width letters), no soft hyphens, no spaces or line breaks inside Japanese."""
    return _CJK_SPACE.sub("", unicodedata.normalize("NFKC", _SOFT_HYPHEN.sub("", text)))


def _searchable(text: str) -> str:
    """A source text as terms are looked for in it: lines joined, spaces collapsed, and formula markers
    as NUL, which is neither a space nor a letter: no term is found in or across a formula."""
    text = _normalized(MATH_TOKEN.sub("\0", text))
    joined = " ".join(_LINE_END_HYPHEN.sub("", text).split())
    kept = " ".join(_LINE_END_HYPHEN.sub("-", text).split())
    # Nor does a match run from one reading into the other.
    return joined if joined == kept else joined + "\0" + kept


class _Matcher(NamedTuple):
    # Parts of every text the term matches, a quick test before the pattern: the term casefolded, its
    # words one space apart and without the plural ending (a searchable text has single spaces), and
    # its abbreviations as they are.
    phrase: str
    exact: tuple[str, ...]
    pattern: re.Pattern[str]

    def search(self, searchable: str, folded: str) -> bool:
        if not all(word in searchable for word in self.exact):
            return False
        start = folded.find(self.phrase)
        if start < 0 or len(folded) != len(searchable):  # Casefolding changed the offsets (ß).
            return start >= 0 and self.pattern.search(searchable) is not None
        # The pattern tried only where the phrase is (lookbehinds still see the text before).
        while start >= 0:
            if self.pattern.match(searchable, start):
                return True
            start = folded.find(self.phrase, start + 1)
        return False


def _abbreviation(word: str) -> bool:
    """RL, MPC, GPT-4: two or more capitals and no small letters. These match in capitals only."""
    return sum(c.isupper() for c in word) >= 2 and not any(c.islower() for c in word)


@lru_cache(maxsize=4096)
def _matcher(source: str) -> _Matcher | None:
    """How a glossary term is found in a source text (_searchable).

    Case is ignored except in abbreviations, words may be separated by any spacing, the last word
    may be plural (networks, processes, policies; LLMs but not RLS), and a term beginning or ending
    with a letter or digit is not found inside a longer word (state_space, or GPT-4.5 for GPT-4).
    """
    words = _normalized(source).split()
    if not words:
        return None
    parts, exact, phrase = [], [], []
    for index, word in enumerate(words):
        last = index == len(words) - 1
        if _abbreviation(word):
            # The plural s is small: RLs, not RLS (recursive least squares) nor GPS for GP.
            parts.append(f"(?-i:{re.escape(word)}" + ("s?" if last and word[-1].isalpha() else "") + ")")
            exact.append(word)
            phrase.append(word)
        elif last and word[-1].isascii() and word[-1].islower():
            stem = _CONSONANT_Y.sub("", word)
            parts.append(re.escape(stem) + ("(?:y|ies)" if stem != word else "(?:e?s)?"))
            phrase.append(stem)
        else:
            parts.append(re.escape(word))
            phrase.append(word)
    start = f"(?<![{_WORD}])" if re.match(f"[{_LETTER}]", words[0]) else ""
    end = f"(?![{_WORD}])" if re.search(f"[{_LETTER}]$", words[-1]) else ""
    if words[0][0].isdigit():
        start += r"(?<!\d[.,])"  # 5G is not in 2.5G,
    if words[-1][-1].isdigit():
        end += r"(?![.,]\d)"  # nor GPT-4 in GPT-4.5.
    return _Matcher(" ".join(phrase).casefold(), tuple(exact), re.compile(start + r"\s+".join(parts) + end, re.IGNORECASE))


def matching_terms(text: str, terms: list[dict]) -> list[dict]:
    """The glossary entries whose source term is in `text`, in the order of the glossary."""
    searchable = _searchable(text)
    folded = searchable.casefold()
    return [term for term in terms if (matcher := _matcher(term["source"])) and matcher.search(searchable, folded)]


def apply_glossary(units: list[dict], terms: list[dict]) -> None:
    """Give each unit the glossary entries found in its text (matching_terms).

    The entries are kept as the glossary has them, in its order: page_fingerprint hashes them, so a
    page whose set of terms is unchanged keeps its saved translation whatever the text order.
    """
    for unit in units:
        matches = matching_terms(unit["text"], terms)
        if matches:
            unit["glossary"] = matches


def _rendering(text: str) -> str:
    """A translation as renderings are looked for in it, without spelling differences that leave the
    word as it is: full or half width, case, spaces, and the middle dot or long vowel of katakana."""
    text = unicodedata.normalize("NFKC", MATH_TOKEN.sub(" ", text)).casefold()
    return re.sub("[\\s\u30fb\u30fc=\\-\u2010]", "", text)


@lru_cache(maxsize=4096)
def _rendering_pattern(target: str) -> re.Pattern[str] | None:
    """A rendering whose okurigana may differ: 割り当て also finds 割当, 取扱 also finds 取り扱い."""
    runs = _KANA_RUNS.findall(_rendering(target))
    if not runs:
        return None
    kanji = [bool(_KANJI.fullmatch(run)) for run in runs]
    parts = []
    for index, run in enumerate(runs):
        after_kanji = index > 0 and kanji[index - 1]
        before_kanji = index + 1 < len(runs) and kanji[index + 1]
        if kanji[index]:
            parts.append(re.escape(run) + (_OKURIGANA if before_kanji else ""))
        elif after_kanji and _HIRAGANA.fullmatch(run):
            # Kana between kanji may be written or not; kana after the last kanji need not follow.
            parts.append(_OKURIGANA if before_kanji else "")
        else:
            parts.append(re.escape(run))
    return re.compile("".join(parts))


def _renderings(target: str) -> list[str]:
    """Ways a rendering may be written: whole, without its part in parentheses (方策（ポリシー）), that
    part, and each of alternatives separated by / 、 , ; or |."""
    bare = re.sub(r"[(（][^)）]*[)）]", " ", target)
    inner = re.findall(r"[(（]([^)）]*)[)）]", target)
    return [target, bare, *inner, *(piece for text in [bare, *inner] for piece in re.split(r"[/／、,，;；|｜]", text))]


def missing_renderings(unit: dict, translation: str) -> list[dict]:
    """The glossary entries of a translated unit (apply_glossary) whose rendering its translation lacks.

    For the check after translation, which lists such paragraphs for review. Spelling differences
    (_rendering, _rendering_pattern) are not reported: the list is to be read, not to be long.
    """
    rendered = _rendering(translation)
    missing = []
    for term in unit.get("glossary", []):
        patterns = [pattern for pattern in map(_rendering_pattern, _renderings(term.get("target", ""))) if pattern]
        if patterns and not any(pattern.search(rendered) for pattern in patterns):
            missing.append(term)
    return missing


def glossary_warnings(units: list[dict], translations: dict[str, str]) -> list[dict]:
    """The translated units whose translation lacks a glossary rendering (missing_renderings), as the
    translation report lists them: page, unit id, the beginning of the source text and the terms."""
    warnings = []
    for unit in units:
        missing = missing_renderings(unit, translations[unit["id"]])
        if missing:
            excerpt = " ".join(MATH_TOKEN.sub(" ", unit["text"]).split())[:120]
            warnings.append({"page": unit["page"], "unit": unit["id"], "excerpt": excerpt,
                             "terms": [{"source": term["source"], "target": term["target"]} for term in missing]})
    return warnings


def kept_glossary_warnings(warnings: list, units: dict[str, dict]) -> list[dict]:
    """Earlier glossary_warnings of the units in `units` (by id, with their current glossary), which
    are not translated again: only the terms the current glossary still finds in them, as they are
    now written, stay (a term removed or given another rendering since then goes)."""
    kept = []
    for item in warnings if isinstance(warnings, list) else []:
        unit = units.get(item.get("unit")) if isinstance(item, dict) else None
        if unit is None:
            continue
        current = {(term["source"], term["target"]) for term in unit.get("glossary", [])}
        terms = [term for term in item.get("terms", [])
                 if isinstance(term, dict) and (term.get("source"), term.get("target")) in current]
        if terms:
            kept.append({**item, "terms": terms})
    return kept


def validate_revision(source: str, text: str) -> str:
    text = text.strip()
    if not text or len(text) > 50000:
        raise ValueError("訳文を入力してください（50000文字まで）。")
    if Counter(MATH_TOKEN.findall(source)) != Counter(MATH_TOKEN.findall(text)):
        raise ValueError("数式の目印は削除・追加・変更せずに残してください。")
    return text
