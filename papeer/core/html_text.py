"""The readable text of HTML documents (attachments of format html), for the library search and the chat.

A document is arbitrary HTML the user added, so its text is read statically: the file is parsed as
markup and nothing in it is run, fetched or followed. What a reader would not see is left out (the
head, scripts, styles, templates, <noscript>, comments, elements that are hidden by the `hidden`
attribute, aria-hidden="true" or an inline display:none / visibility:hidden), with the spacing of
headings, paragraphs, lists and tables kept and the entities decoded. The file itself is never changed.

The complete source is handed to the standard parser at once: a large embedded image or quoted
attribute must not be cut into visible text, and script/style/comment contents are handled by the
parser itself. Parsing memory is proportional to source size; only MAX_TEXT readable characters are
retained. The file itself is never modified.

The extraction is cached in memory under the library, the document and the SHA-256 of the file's
bytes, so a document that was changed, replaced by a restore or removed is never answered stale. The
cache is bounded (entries and characters); a miss only costs one parse.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import hashlib
from html.parser import HTMLParser
from pathlib import Path
import re
import threading

from papeer.core.item_relations import LISTED_ITEMS
from papeer.core.paths import PaperFiles
from papeer.core.storage import Library

MAX_TEXT = 400_000  # Characters kept of one document (the file itself is read to its end).
CHUNK = 3000  # Characters of one piece of a document handed to the chat.
CACHE_ENTRIES = 512
CACHE_CHARS = 16_000_000

# Elements whose content is never part of the text.
SKIPPED = frozenset({"head", "script", "style", "template", "noscript", "title", "iframe", "object"})
VOID = frozenset("area base br col embed hr img input link meta param source track wbr".split())
# Elements that end the line / the paragraph around them.
LINE = frozenset("div section article header footer main aside nav li dt dd tr caption figcaption details summary "
                 "form fieldset address thead tbody tfoot center".split())
PARAGRAPH = frozenset("p h1 h2 h3 h4 h5 h6 ul ol dl table blockquote pre figure hr".split())
CELL = frozenset({"td", "th"})
# An element that is opened closes these when one of them is the innermost open element (omitted end tags).
_BLOCKS = LINE | PARAGRAPH
IMPLIED_END = {**{tag: {"p"} for tag in _BLOCKS}, "li": {"li", "p"}, "dt": {"dt", "dd", "p"}, "dd": {"dt", "dd", "p"},
               "tr": {"tr", "td", "th", "p"}, "td": {"td", "th", "p"}, "th": {"td", "th", "p"}, "option": {"option"}}
_HIDDEN_STYLE = re.compile(r"(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!\s*important\s*)?(?:;|$)", re.I)
_BREAKS = re.compile(r"[ \t\f\r\v\xa0]*\n[ \t\f\r\v\xa0]*")
_SPACES = re.compile(r"[ \t\f\r\v\xa0]{2,}")
_WHITESPACE = re.compile(r"\s+")
_TERM = re.compile(r"[a-zA-Z0-9_-]{2,}|[぀-ヿ㐀-鿿]{2,}")
_KANA = re.compile(r"[぀-ゟ]+")


def _hidden(attributes) -> bool:
    for name, value in attributes:
        value = (value or "").strip().lower()
        name = (name or "").lower()
        if (name == "hidden" and value != "until-found") or (name == "aria-hidden" and value == "true"):
            return True
        if name == "style" and _HIDDEN_STYLE.search(value):
            return True
    return False


class _Reader(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.size = 0
        # The open elements: (tag, whether it hides what it holds, whether it is a <pre> that is read as written).
        self.stack: list[tuple[str, bool, bool]] = []
        self.hidden = 0
        self.pre = 0
        self.pending = 0  # The line breaks (1) or the blank line (2) to write before the next text.

    def _put(self, text: str) -> None:
        if self.size >= MAX_TEXT:
            return
        if text.strip():
            if self.pending:  # A break is written once, when text follows it (the longer one of those asked).
                self.parts.append("\n" * self.pending)
                self.pending = 0
            text = text[:MAX_TEXT - self.size]
            self.parts.append(text)
            self.size += len(text)
        elif not self.pending and (not self.parts or self.parts[-1] != " "):  # A run of spaces is one.
            self.parts.append(" ")

    def _break(self, paragraph: bool = False) -> None:
        if not self.hidden:
            self.pending = max(self.pending, 2 if paragraph else 1)

    def _pop(self) -> None:
        _, hides, literal = self.stack.pop()
        self.hidden -= hides
        self.pre -= literal

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        closes = IMPLIED_END.get(tag, ())
        while self.stack and self.stack[-1][0] in closes:
            self._pop()
        if tag in VOID:
            if tag in ("br", "hr"):
                self._break(tag == "hr")
            return
        if tag in _BLOCKS:
            self._break(tag in PARAGRAPH)
        hides = tag in SKIPPED or _hidden(attrs)
        literal = tag == "pre" and not hides and not self.hidden
        self.stack.append((tag, hides, literal))
        self.hidden += hides
        self.pre += literal
        if tag in CELL:
            self._break_cell()

    def _break_cell(self) -> None:
        if not self.hidden:
            self._put(" ")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in VOID:
            if tag == "br":
                self._break()
            return
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                while len(self.stack) > index:
                    self._pop()
                if tag in _BLOCKS:
                    self._break(tag in PARAGRAPH)
                elif tag in CELL:
                    self._break_cell()
                return

    def handle_data(self, data):
        if not self.hidden:
            self._put(data if self.pre else _WHITESPACE.sub(" ", data))


def extract(source: str) -> str:
    """Readable static text, with markup semantics handled by the standard HTML parser."""
    reader = _Reader()
    try:
        reader.feed(source)
        # HTMLParser.close() treats an unfinished tag as literal text. A truncated img attribute is
        # markup, never document evidence; discard only that unfinished markup at the actual EOF.
        if reader.cdata_elem is None and reader.rawdata.startswith("<"):
            reader.rawdata = ""
        reader.close()
    except Exception:  # noqa: BLE001 - Keep the readable portion of malformed input without executing it.
        reader.rawdata = ""
    text = "".join(reader.parts)
    text = _BREAKS.sub("\n", text)
    text = _SPACES.sub(" ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:MAX_TEXT]


# --- The files' text, cached ---

_cache: OrderedDict[tuple[str, str], tuple[str, str]] = OrderedDict()
_cached_chars = 0
_lock = threading.Lock()


def _remember(key: tuple[str, str], digest: str, text: str) -> None:
    global _cached_chars
    with _lock:
        previous = _cache.pop(key, None)
        if previous is not None:
            _cached_chars -= len(previous[1])
        _cache[key] = (digest, text)
        _cached_chars += len(text)
        while _cache and (len(_cache) > CACHE_ENTRIES or _cached_chars > CACHE_CHARS):
            _, (_, dropped) = _cache.popitem(last=False)
            _cached_chars -= len(dropped)


def clear_cache() -> None:
    global _cached_chars
    with _lock:
        _cache.clear()
        _cached_chars = 0


def _digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _parse(path: Path) -> tuple[str, str]:
    """The SHA-256 of the file and its text, from one read of the whole file (so the two belong together)."""
    raw = path.read_bytes()
    return hashlib.sha256(raw).hexdigest(), extract(raw.decode("utf-8-sig", errors="replace"))


def file_text(lib: Library, owner_id: str, attachment_id: str) -> str | None:
    """The text of the document's file as it is now; None when the file is missing or cannot be read."""
    try:
        path = PaperFiles(lib.folder(owner_id)).attachment(attachment_id, "html")
        digest = _digest(path)
    except (OSError, ValueError, KeyError):
        return None
    key = (str(lib.root), attachment_id)
    with _lock:
        cached = _cache.get(key)
        if cached is not None and cached[0] == digest:
            _cache.move_to_end(key)
            return cached[1]
    try:
        digest, text = _parse(path)  # The digest of what was parsed, should the file have changed since.
    except OSError:
        return None
    _remember(key, digest, text)
    return text


@dataclass(frozen=True)
class HtmlSource:
    """A document that has text: whose it is, its own name, and the text."""
    owner_id: str
    owner_title: str
    attachment_id: str
    title: str
    text: str


def sources(lib: Library, owner_ids: set[str] | None = None) -> list[HtmlSource]:
    """The text of the HTML documents of the library's items (those that stand on their own: a notebook
    held by another item holds none), of `owner_ids` only when given. A document whose file is missing,
    unreadable or without text is left out. In the owner's order of the library (newest first), then the
    owner's own order of its documents."""
    with lib.connection() as db:
        rows = [dict(row) for row in db.execute(
            f"SELECT a.id,a.owner_id,a.title,p.title AS owner_title FROM attachments a "
            f"JOIN papers p ON p.id=a.owner_id WHERE a.format='html' AND {LISTED_ITEMS} "
            f"ORDER BY p.rowid DESC,a.position,a.created_at,a.id")]
    found = []
    for row in rows:
        if owner_ids is not None and row["owner_id"] not in owner_ids:
            continue
        text = file_text(lib, row["owner_id"], row["id"])
        if text:
            found.append(HtmlSource(row["owner_id"], row["owner_title"] or "", row["id"], row["title"] or "", text))
    return found


# --- Pieces for the chat ---

def split(text: str, size: int = CHUNK) -> list[str]:
    """`text` in pieces of about `size` characters, cut at the line ends where it can be."""
    pieces: list[str] = []
    current = ""
    for line in text.split("\n"):
        while len(line) > size:  # A line with no break of its own is cut where it stands.
            if current:
                pieces.append(current)
                current = ""
            pieces.append(line[:size])
            line = line[size:]
        if current and len(current) + len(line) + 1 > size:
            pieces.append(current)
            current = ""
        current = f"{current}\n{line}" if current else line
    if current.strip():
        pieces.append(current)
    return [piece for piece in (p.strip("\n") for p in pieces) if piece.strip()]


def question_terms(question: str) -> list[str]:
    """What to look for in a document for `question`: the words of it, and the pairs of letters of a long
    Japanese run (the run itself is seldom written the same way in a document), kana-only pairs aside."""
    terms: dict[str, None] = {}
    for word in _TERM.findall(question.lower()):
        terms[word] = None
        if len(word) > 3 and re.fullmatch(r"[぀-ヿ㐀-鿿]+", word):
            for start in range(len(word) - 1):
                pair = word[start:start + 2]
                if not _KANA.fullmatch(pair):
                    terms[pair] = None
    return list(terms)


def score(text: str, terms: list[str]) -> int:
    """How well `text` fits `terms`: the number of occurrences, a longer term counting for more."""
    folded = text.lower()
    return sum(folded.count(term) * len(term) for term in terms)


def markdown_label(text: str, limit: int = 80) -> str:
    """`text` as the label of a Markdown link: nothing that would make it a link, an image, math or markup."""
    return " ".join(re.sub(r"[][()!*_`<>\\$~|#&{}\"]", "", text).split())[:limit]
