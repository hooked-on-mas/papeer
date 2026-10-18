"""Reference lookup: Semantic Scholar first, Crossref fills gaps; no AI requests here."""
from __future__ import annotations

from difflib import SequenceMatcher
from functools import lru_cache
from html.parser import HTMLParser
import json
import os
import re
import threading
import time
import unicodedata
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from papeer.core.bibliography import clean_arxiv_id, clean_doi, clean_venue, first_author
from papeer.providers import check_cancel
from papeer.core import map_timing

FIELDS = ("title", "first_author", "publication_year", "venue", "doi", "arxiv_id", "abstract")
_SEMANTIC_FIELDS = "title,authors,year,venue,journal,externalIds,abstract,openAccessPdf,url"
_LOCKS = {name: threading.Lock() for name in ("api.semanticscholar.org", "api.crossref.org")}
_NEXT: dict[str, float] = {}
_COOLDOWN: dict[str, float] = {}
_CACHE: dict[tuple, tuple[float, dict | list]] = {}
_SEMANTIC_KEY: str | None = None


def semantic_api_key() -> str:
    return (_SEMANTIC_KEY if _SEMANTIC_KEY is not None else
            os.environ.get("PAPEER_SEMANTIC_SCHOLAR_API_KEY", os.environ.get("SEMANTIC_SCHOLAR_API_KEY", ""))).strip()


def set_semantic_api_key(value: str) -> None:
    global _SEMANTIC_KEY
    value = value.strip()
    if any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise ValueError("Semantic ScholarのAPIキーには空白や制御文字を含められません。")
    with _LOCKS["api.semanticscholar.org"]:
        _SEMANTIC_KEY = value
        _COOLDOWN.pop("api.semanticscholar.org", None)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _request(url: str, cancel: threading.Event) -> dict:
    result = _send(url, cancel)
    if not isinstance(result, dict):
        raise ValueError("書誌情報の応答を読み取れませんでした。")
    return result


def _post_request(url: str, cancel: threading.Event, body: dict) -> list:
    result = _send(url, cancel, body)
    if not isinstance(result, list):
        raise ValueError("書誌情報の一括取得の応答を読み取れませんでした。")
    return result


def _send(url: str, cancel: threading.Event, body: dict | None = None) -> dict | list:
    """Fixed hosts, bounded responses, cancellable throttling shared by all five jobs."""
    host = urlsplit(url).hostname
    if host not in _LOCKS:
        raise ValueError("書誌情報サービスの接続先が不正です。")
    lock = _LOCKS[host]
    provider = {"api.semanticscholar.org": "Semantic Scholar", "api.crossref.org": "Crossref"}[host]
    with map_timing.measure("api_lock:" + host, provider + "：同時処理の順番待ち"):
        while not lock.acquire(timeout=.1):
            check_cancel(cancel)
    try:
        check_cancel(cancel)
        now = time.monotonic()
        key = semantic_api_key() if host == "api.semanticscholar.org" else ""
        data = json.dumps(body, sort_keys=True).encode() if body is not None else None
        cache_key = (url, data, key)
        cached = _CACHE.get(cache_key)
        if cached and cached[0] > now:
            with map_timing.measure("api_cache:" + host, provider + "：応答キャッシュ再利用"): return cached[1]
        if _COOLDOWN.get(host, 0) > now:
            raise ValueError("書誌情報サービスの利用制限中のため、別の取得元で補完します。")
        with map_timing.measure("api_interval:" + host, provider + "：取得間隔の待機"):
            cancel.wait(max(0, _NEXT.get(host, 0) - now))
            check_cancel(cancel)
        _NEXT[host] = time.monotonic() + 1.1
        headers = {"User-Agent": "Papeer/ReferenceLookup", "Accept": "application/json"}
        if key: headers["x-api-key"] = key
        if data is not None: headers["Content-Type"] = "application/json"
        request = Request(url, data=data, headers=headers)
        try:
            with map_timing.measure("api_http:" + host, provider + "：通信・応答受信"):
                with build_opener(_NoRedirect()).open(request, timeout=12) as response:
                    payload = response.read(2_000_001)
        except HTTPError as error:
            if error.code == 404:
                return {}
            if error.code in (429, 503):
                retry = error.headers.get("Retry-After", "60")
                delay = min(300, max(30, float(retry))) if retry.isdecimal() else 60
                _COOLDOWN[host] = time.monotonic() + delay
            raise
        check_cancel(cancel)
        if len(payload) > 2_000_000:
            raise ValueError("書誌情報の検索結果が大きすぎます。")
        result = map_timing.call("api_parse:" + host, provider + "：応答データの読み取り", json.loads, payload)
        if not isinstance(result, (dict, list)):
            raise ValueError("書誌情報の応答を読み取れませんでした。")
        # Only successful responses are cached. Bound memory in a long-lived desktop session.
        if len(_CACHE) >= 256:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[cache_key] = (time.monotonic() + 900, result)
        return result
    finally:
        lock.release()


def _text(value: object, limit=1000) -> str:
    return " ".join(value.split())[:limit] if isinstance(value, str) else ""


@lru_cache(maxsize=8192)
def _normal(value: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", value).casefold() if c.isalnum())


class _AbstractText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data):
        self.parts.append(data)


def _abstract(value: object) -> str:
    parser = _AbstractText()
    parser.feed(_text(value, 18000))
    return re.sub(r"\s+([.,;:])", r"\1", " ".join(" ".join(parser.parts).split()))


def _url(value: object) -> str:
    from papeer.core.web_research import public_url
    return public_url(value)


def _mapping(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def response_list(data: dict, field: str, description: str) -> list:
    """A missing/null required list is an incomplete response, never a confirmed empty catalogue."""
    rows = data.get(field)
    if not isinstance(rows, list):
        raise ValueError(f"{description}の一覧がサービスの応答にありません。保存済みの情報を使用します。")
    return rows


def _semantic(item: dict) -> dict:
    ids = _mapping(item.get("externalIds"))
    authors = [a for a in (item.get("authors") or []) if isinstance(a, dict)]
    journal = _mapping(item.get("journal"))
    pdf = _mapping(item.get("openAccessPdf"))
    url = _url(item.get("url"))
    if not url and re.fullmatch(r"[0-9a-f]{40}", str(item.get("paperId", ""))):
        url = "https://www.semanticscholar.org/paper/" + item["paperId"]
    return {"title": _text(item.get("title")),
            "first_author": first_author(_text(authors[0].get("name"))) if authors else "",
            "publication_year": str(item.get("year") or ""),
            "venue": clean_venue(_text(item.get("venue")) or _text(journal.get("name"))),
            "doi": clean_doi(_text(ids.get("DOI"))), "arxiv_id": clean_arxiv_id(_text(ids.get("ArXiv"))),
            "abstract": _abstract(item.get("abstract")),
            "sources": [{"title": "Semantic Scholar", "url": url}] if url else [],
            "pdfs": [{"title": "Semantic Scholarの公開PDF", "url": _url(pdf["url"]), "version": "版は原文で確認"}]
            if _url(pdf.get("url")) else []}


def _crossref(item: dict) -> dict:
    from papeer.core.paper_metadata import _crossref_record
    record = _crossref_record(item)
    doi = record["doi"]
    url = "https://doi.org/" + quote(doi, safe="/") if doi else _url(item.get("URL"))
    pdfs = [{"title": "CrossrefのPDFリンク", "url": _url(link.get("URL")), "version": "版は原文で確認"}
            for link in (item.get("link") or []) if isinstance(link, dict)
            and link.get("content-type") == "application/pdf" and _url(link.get("URL"))]
    return {**record, "abstract": _abstract(item.get("abstract")),
            "sources": [{"title": "Crossref", "url": url}] if url else [], "pdfs": pdfs}


def titles_match(title: str, other: str) -> bool:
    title, other = _normal(title), _normal(other)
    if not title or not other: return False
    if title == other: return True
    if len(title) < 20: return False
    matcher = SequenceMatcher(None, title, other)
    # Both bounds can only reject pairs whose original ratio is below the threshold.
    # Keep the same ordered SequenceMatcher and autojunk rules for the final decision.
    return matcher.real_quick_ratio() >= .95 and matcher.quick_ratio() >= .95 and matcher.ratio() >= .95


def _matches(known: dict, candidate: dict) -> bool:
    """An exact identifier or strong title match; conflicts and ambiguity are never guessed away."""
    identifier = False
    for field in ("doi", "arxiv_id"):
        expected, actual = str(known.get(field) or "").casefold(), candidate[field].casefold()
        if expected and actual:
            if expected != actual:
                return False
            identifier = True
    if identifier:
        return True
    title, other = _normal(known.get("title", "")), _normal(candidate["title"])
    if not other or len(other) < 15:
        return False
    if title:
        if not titles_match(title, other):
            return False
    elif len(other) < 20 or other not in _normal(known.get("raw", "")):
        return False
    year = str(known.get("publication_year") or known.get("year") or "")
    if year and candidate["publication_year"] and year != candidate["publication_year"]:
        return False
    raw = known.get("raw", "")
    if raw and candidate["first_author"]:
        # Author names should appear before the guessed title, not elsewhere in a citation.
        prefix = raw.split('"')[0].split("“")[0]
        surname = _normal(candidate["first_author"].split()[-1])
        if surname and surname not in _normal(prefix):
            return False
    return True


def _choose(known: dict, items: list[dict]) -> dict | None:
    matches = [item for item in items if item["sources"] and _matches(known, item)]
    exact = [item for item in matches if _normal(known.get("title", "")) == _normal(item["title"])]
    if exact:
        matches = exact
    distinct = {(item["doi"].casefold() or item["arxiv_id"] or item["sources"][0]["url"]): item for item in matches}
    return next(iter(distinct.values())) if len(distinct) == 1 else None


def _lookup_semantic(known: dict, cancel: threading.Event) -> dict | None:
    base = "https://api.semanticscholar.org/graph/v1/paper/"
    identifier = "DOI:" + known["doi"] if known.get("doi") else "ARXIV:" + known["arxiv_id"] if known.get("arxiv_id") else ""
    if identifier:
        url = base + quote(identifier, safe=":") + "?" + urlencode({"fields": _SEMANTIC_FIELDS})
        result = _request(url, cancel)
        items = [result] if result.get("title") else []
    else:
        query = known.get("title") or known.get("raw", "")
        if not query:
            return None
        url = base + "search?" + urlencode({"query": query, "limit": 3, "fields": _SEMANTIC_FIELDS})
        items = _request(url, cancel).get("data", [])
    if not isinstance(items, list):
        raise ValueError("Semantic Scholarの検索結果を読み取れませんでした。")
    return _choose(known, [_semantic(item) for item in items if isinstance(item, dict)])


def _lookup_crossref(known: dict, cancel: threading.Event) -> dict | None:
    base = "https://api.crossref.org/works"
    if known.get("doi"):
        url = base + "/" + quote(known["doi"], safe="")
    else:
        query = known.get("raw") or known.get("title", "")
        if not query:
            return None
        url = base + "?" + urlencode({"query.bibliographic": query, "rows": 5})
    message = _request(url, cancel).get("message", {})
    if not isinstance(message, dict):
        raise ValueError("Crossrefの検索結果を読み取れませんでした。")
    items = [message] if known.get("doi") else message.get("items", [])
    if not isinstance(items, list):
        raise ValueError("Crossrefの検索結果を読み取れませんでした。")
    return _choose(known, [_crossref(item) for item in items if isinstance(item, dict)])


def missing_fields(record: dict) -> list[str]:
    missing = [field for field in ("title", "first_author", "publication_year", "venue", "abstract", "pdfs") if not record.get(field)]
    if not record.get("doi") and not record.get("arxiv_id"):
        missing.append("doi")
    return missing


def lookup(known: dict, cancel: threading.Event) -> dict:
    result: dict = {**dict.fromkeys(FIELDS, ""), "sources": [], "pdfs": [], "warnings": []}
    for name, fetch in (("Semantic Scholar", _lookup_semantic), ("Crossref", _lookup_crossref)):
        check_cancel(cancel)
        if result["sources"] and not missing_fields(result):
            break
        identity = {**known, **{field: result[field] for field in FIELDS if result[field]}}
        try:
            found = fetch(identity, cancel)
        except (OSError, ValueError) as error:
            result["warnings"].append(f"{name}の情報を取得できませんでした：{error}")
            continue
        if found:
            for field in FIELDS:
                if not result[field] and found[field]:
                    result[field] = found[field]
            result["sources"].extend(found["sources"])
            result["pdfs"].extend(found["pdfs"])
    check_cancel(cancel)
    return result
