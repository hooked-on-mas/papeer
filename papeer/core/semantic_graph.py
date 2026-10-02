"""Bounded Semantic Scholar graph queries; no OpenAlex or model requests."""
from __future__ import annotations

import re
from urllib.parse import quote, urlencode

from papeer.core import scholarly_lookup as scholarly
from papeer.providers import check_cancel

BASE = "https://api.semanticscholar.org/graph/v1/paper/"
FIELDS = "title,authors,year,externalIds,abstract,citationCount,referenceCount"
GRAPH_FIELDS = FIELDS + ",references.paperId"
MAX_REFERENCES = 1000
MAX_CITING = 200


def work_id(value: str) -> str:
    value = value.rsplit("/", 1)[-1]
    return value if re.fullmatch(r"[0-9a-f]{40}", value) else ""


def work_url(value: str) -> str:
    identity = work_id(value)
    return "https://www.semanticscholar.org/paper/" + identity if identity else ""


def normalize(work: dict) -> dict:
    identity = work_url(str(work.get("paperId") or ""))
    if not identity or not work.get("title"): return {}
    record = scholarly._semantic(work)
    refs = list(dict.fromkeys(url for r in (work.get("references") or [])
                            if isinstance(r, dict) and (url := work_url(str(r.get("paperId") or "")))))
    return dict(id=identity, paper_id=None, title=record["title"], year=record["publication_year"], url=identity,
                doi=record["doi"], arxiv_id=record["arxiv_id"], first_author=record["first_author"],
                abstract=record["abstract"], external_citations=work.get("citationCount"),
                referenced_works=refs[:MAX_REFERENCES], related_works=[], provider="Semantic Scholar",
                references_loaded="references" in work,
                references_truncated="references" in work and (work.get("referenceCount") or 0) > min(len(refs), MAX_REFERENCES))


def resolve(known: dict, cancel) -> dict | None:
    identity = work_id(known.get("external_id", "")) or work_id(known.get("id", ""))
    identifier = identity or ("ARXIV:" + known["arxiv_id"] if known.get("arxiv_id") and
        (not known.get("doi") or known["doi"].casefold().startswith("10.48550/arxiv.")) else
        "DOI:" + known["doi"] if known.get("doi") else "ARXIV:" + known["arxiv_id"] if known.get("arxiv_id") else "")
    if identifier:
        result = scholarly._request(BASE + quote(identifier, safe=":") + "?" + urlencode({"fields": GRAPH_FIELDS}), cancel)
        candidates = [normalize(result)]
    else:
        result = scholarly._request(BASE + "search?" + urlencode({"query": known["title"], "limit": 5, "fields": FIELDS}), cancel)
        candidates = [normalize(w) for w in scholarly.response_list(result, "data", "論文検索結果") if isinstance(w, dict)]
    matches = []
    for candidate in candidates:
        if not candidate: continue
        conflict = any(known.get(k) and candidate.get(k) and known[k].casefold() != candidate[k].casefold()
                       for k in ("doi", "arxiv_id"))
        exact = identity == work_id(candidate["id"]) or any(known.get(k) and
            known[k].casefold() == candidate.get(k, "").casefold() for k in ("doi", "arxiv_id"))
        title = scholarly.titles_match(known["title"], candidate["title"])
        year = not known.get("year") or not candidate["year"] or known["year"] == candidate["year"]
        author = not known.get("first_author") or not candidate["first_author"] or (
            known["first_author"].casefold().split()[-1] == candidate["first_author"].casefold().split()[-1])
        if not conflict and (exact or title and year and author): matches.append(candidate)
    if len(matches) != 1: return None
    node = matches[0]
    if not identifier:
        node = next((n for batch in works([node["id"]], cancel) for n in batch), node)
    return node


def works(ids: list[str], cancel):
    yield from _batch(list(dict.fromkeys(filter(None, (work_id(i) for i in ids)))), cancel)


def works_by_doi(dois: list[str], cancel):
    yield from _batch(list(dict.fromkeys("DOI:" + doi for doi in dois if doi)), cancel)


def _batch(ids, cancel):
    # Small batches bound nested reference lists and the response size.
    for start in range(0, len(ids), 10):
        check_cancel(cancel)
        result = scholarly._post_request(BASE + "batch?" + urlencode({"fields": GRAPH_FIELDS}), cancel,
                                         {"ids": ids[start:start + 10]})
        batch = []
        for identifier, work in zip(ids[start:start + 10], result):
            if not isinstance(work, dict): continue
            node = normalize(work)
            if not node: continue
            if identifier.startswith("DOI:"):
                if node["doi"].casefold() != identifier[4:].casefold(): continue
            elif work_id(node["id"]) != identifier: continue
            batch.append(node)
        yield batch


def recommendations(identity: str, cancel):
    identity = work_id(identity)
    if not identity: return
    result = scholarly._request("https://api.semanticscholar.org/recommendations/v1/papers/forpaper/" + identity +
        "?" + urlencode({"fields": FIELDS, "limit": 20}), cancel)
    rows = scholarly.response_list(result, "recommendedPapers", "関連論文の推薦")
    yield [node for w in rows if isinstance(w, dict) and (node := normalize(w))]


def citing(ids: list[str], cancel):
    # The citation endpoint has no documented date/citation-count sort. Report a
    # bounded API sample, never claim that it is the newest or most cited sample.
    for identity in dict.fromkeys(filter(None, (work_id(i) for i in ids))):
        offset = 0
        while offset < MAX_CITING:
            check_cancel(cancel)
            result = scholarly._request(BASE + identity + "/citations?" + urlencode({
                "fields": FIELDS, "offset": offset, "limit": min(100, MAX_CITING - offset)}), cancel)
            rows = scholarly.response_list(result, "data", "被引用論文")
            batch = []
            for row in rows:
                if not isinstance(row, dict): continue
                node = normalize(scholarly._mapping(row.get("citingPaper")))
                if node:
                    # This endpoint itself is evidence for this precise edge.
                    node["referenced_works"] = [work_url(identity)]
                    node["references_loaded"] = False
                    batch.append(node)
            yield batch
            next_offset = result.get("next")
            if not isinstance(next_offset, int) or next_offset <= offset: break
            offset = next_offset
