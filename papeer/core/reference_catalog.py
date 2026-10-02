"""DOI bibliography cache. API records are always reconciled with the current PDF."""
from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import json
from urllib.parse import quote, urlencode

from papeer.core.bibliography import clean_arxiv_id, clean_doi
from papeer.core import map_timing, scholarly_lookup
from papeer.providers import check_cancel

CACHE_KEY = "bibliography"
TTL = 7 * 24 * 3600


def read(lib, source: str, doi: str) -> dict:
    with lib.connection() as db:
        row = db.execute("SELECT data FROM paper_discovery WHERE source=? AND origin=?", (source, CACHE_KEY)).fetchone()
    value = json.loads(row[0]) if row else {}
    expected = semantic_identity(doi, lib.paper(source).get("arxiv_id", ""))
    saved = value.get("semantic_id", "DOI:" + value.get("doi", "") if value.get("doi") else "")
    return value if value.get("doi", "").casefold() == doi.casefold() and saved.casefold() == expected.casefold() else {}


def semantic_identity(doi: str, arxiv: str) -> str:
    arxiv = clean_arxiv_id(arxiv)
    if arxiv and (not doi or doi.casefold().startswith("10.48550/arxiv.")):
        return "ARXIV:" + arxiv
    return "DOI:" + doi if doi else ""


@map_timing.timed("bibliography_refresh", "DOIからの参考文献の取得")
def refresh(lib, source: str, cancel, progress, force=False):
    paper = lib.paper(source)
    doi = clean_doi(paper.get("doi", ""))
    arxiv = clean_arxiv_id(paper.get("arxiv_id", ""))
    identifier = semantic_identity(doi, arxiv)
    if not identifier:
        with map_timing.measure("no_doi", "DOI・arXiv ID未保存のためAPI参考文献の取得を省略"): return
    cache = read(lib, source, doi)
    stamp = cache.get("checked_at", "")
    try:
        fresh = bool(stamp) and (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds() < TTL
    except (ValueError, TypeError):
        fresh = False
    if not force and fresh:
        with map_timing.measure("cache_reuse", "保存済み参考文献を再利用"): return
    cache.update(doi=doi, semantic_id=identifier, checked_at="", warnings=[])

    def save():
        check_cancel(cancel)
        with lib.connection() as db:
            db.execute("INSERT INTO paper_discovery VALUES(?,?,?) ON CONFLICT(source,origin) DO UPDATE SET data=excluded.data",
                       (source, CACHE_KEY, json.dumps(cache, ensure_ascii=False)))

    providers = ("Semantic Scholar", "Crossref") if doi and not doi.casefold().startswith("10.48550/arxiv.") else ("Semantic Scholar",)
    for provider in providers:
        check_cancel(cancel)
        progress(f"論文の識別子から参考文献を取得しています（{provider}）")
        entries = []
        try:
            if provider == "Semantic Scholar":
                _semantic_references(doi, cancel, entries, cache["warnings"], arxiv=arxiv)
            else:
                _crossref_references(doi, cancel, entries)
            cache[provider] = entries
            cache.setdefault("fetched_at", {})[provider] = datetime.now(timezone.utc).isoformat()
        except (OSError, ValueError, TypeError, AttributeError) as error:
            # Retain the previous successful provider and any newly fetched pages on partial failure.
            if entries:
                previous = cache.get(provider, [])
                cache[provider] = previous + [e for e in entries if e not in previous]
            cache["warnings"].append(f"{provider}の参考文献を一部取得できませんでした：{error}")
        save()
    if not cache["warnings"]:
        cache["checked_at"] = datetime.now(timezone.utc).isoformat()
    save()


@map_timing.timed("semantic_references", "Semantic Scholarの参考文献取得")
def _semantic_references(doi, cancel, entries, warnings, *, arxiv=""):
    identifier = semantic_identity(doi, arxiv)
    base = "https://api.semanticscholar.org/graph/v1/paper/" + quote(identifier, safe=":") + "/references"
    offset = 0
    while offset < 2000:
        check_cancel(cancel)
        data = scholarly_lookup._request(base + "?" + urlencode({"fields": scholarly_lookup._SEMANTIC_FIELDS,
            "offset": offset, "limit": 100}), cancel)
        rows = scholarly_lookup.response_list(data, "data", "参考文献")
        for row in rows:
            if not isinstance(row, dict): continue
            record = scholarly_lookup._semantic(scholarly_lookup._mapping(row.get("citedPaper")))
            if record["title"] or record["doi"] or record["arxiv_id"]: entries.append(record)
        next_offset = data.get("next")
        if not isinstance(next_offset, int) or next_offset <= offset: break
        offset = next_offset
    else:
        warnings.append("Semantic Scholarの参考文献を2000件で区切りました。")


@map_timing.timed("crossref_references", "Crossrefの参考文献取得")
def _crossref_references(doi, cancel, entries):
    data = scholarly_lookup._request("https://api.crossref.org/works/" + quote(doi, safe=""), cancel)
    if "message" not in data:
        raise ValueError("このDOIの書誌情報を確認できませんでした。")
    for row in scholarly_lookup._mapping(data.get("message")).get("reference") or []:
        if not isinstance(row, dict): continue
        entry = {"title": str(row.get("article-title") or ""), "doi": clean_doi(row.get("DOI", "")),
                 "arxiv_id": "", "first_author": str(row.get("author") or ""),
                 "publication_year": str(row.get("year") or ""), "raw": str(row.get("unstructured") or "")}
        if entry["title"] or entry["doi"] or entry["raw"]: entries.append(entry)


def same(a: dict, b: dict) -> bool:
    from papeer.core.citations import normalized
    if any(a.get(k) and b.get(k) and a[k].casefold() != b[k].casefold() for k in ("doi", "arxiv_id")):
        return False
    if any(a.get(k) and b.get(k) and a[k].casefold() == b[k].casefold() for k in ("doi", "arxiv_id")):
        return True
    if a.get("year") and b.get("year") and a["year"] != b["year"]:
        return False
    if a.get("first_author") and b.get("first_author") and a["first_author"].casefold() != b["first_author"].casefold():
        return False
    if a["title"] and b["title"]:
        return len(normalized(a["title"])) >= 20 and scholarly_lookup.titles_match(a["title"], b["title"])
    title = normalized(a["title"] or b["title"])
    raw = normalized(b["raw"] if a["title"] else a["raw"])
    return (len(title) >= 20 and f" {title} " in f" {raw} ") or normalized(a["raw"]) == normalized(b["raw"])


@map_timing.timed("bibliography_merge", "APIとPDFの参考文献を照合・統合")
def merged(lib, source: str, doi: str, pdf: list[dict]) -> tuple[list[dict], list[str]]:
    cache = read(lib, source, doi)
    result = []
    rejected = 0
    for provider in ("Semantic Scholar", "Crossref", "PDF"):
        incoming = pdf if provider == "PDF" else cache.get(provider, [])
        for index, item in enumerate(incoming):
            entry = {"raw": item.get("raw") or ". ".join(str(item.get(k, "")) for k in
                     ("first_author", "publication_year", "title", "doi") if item.get(k)),
                     "title": item.get("title", ""), "doi": item.get("doi", ""), "arxiv_id": item.get("arxiv_id", ""),
                     "year": item.get("year", item.get("publication_year", "")), "first_author": item.get("first_author", ""),
                     "abstract": item.get("abstract", ""),
                     "label": item.get("label", ""), "page": item.get("page"), "provenance": [],
                     "reference_suffix": str(index) if provider == "PDF" else "api:" + sha256(
                         (item.get("doi") or item.get("arxiv_id") or item.get("raw") or item.get("title", "")).casefold().encode()).hexdigest()[:24]}
            if provider == "Semantic Scholar":
                # The service sometimes returns prose or misidentified corporate names
                # as cited papers. An opaque service paper ID is not citation evidence.
                confirmed = any(same(entry, {**p, "first_author": p.get("first_author", "")}) for p in pdf)
                identified = bool(entry["doi"] or entry["arxiv_id"])
                if not confirmed and (not identified and not (entry["year"] and entry["first_author"]) or
                                      pdf and not entry["year"] and not entry["arxiv_id"]):
                    rejected += 1
                    continue
            entry["provenance"] = [{"provider": provider, "page": entry["page"], "label": entry["label"],
                                    "checked_at": "" if provider == "PDF" else cache.get("fetched_at", {}).get(provider, cache.get("checked_at", ""))}]
            candidates = [r for r in result if same(entry, r)]
            if len(candidates) != 1:
                result.append(entry)
                continue
            found = candidates[0]
            found["provenance"].extend(entry["provenance"])
            for field in ("title", "doi", "arxiv_id", "year", "first_author", "abstract"):
                found[field] = found[field] or entry[field]
            if provider == "PDF":
                # Keep original text, numbering, page and research key compatible with saved lookups.
                if not found.get("page"):
                    found.update({field: entry[field] for field in ("raw", "label", "page", "reference_suffix")})
    warnings = list(cache.get("warnings", []))
    for entry in result:
        providers = {p["provider"] for p in entry["provenance"]}
        # Keep API-exclusive candidates, but do not assert a citation when the
        # available PDF and Crossref cannot corroborate Semantic Scholar alone.
        entry["citation_status"] = "unverified" if pdf and providers == {"Semantic Scholar"} else "confirmed"
    if rejected:
        warnings.append(f"Semantic Scholarの書誌情報が不十分な候補{rejected}件は、PDFの参考文献と照合できないため除外しました。")
    return result, warnings
