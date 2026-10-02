"""Local citation graph, derived from the saved PDF extractions. No network or AI calls.

Only reference-list text contributes edges. Exact identifiers, or a sufficiently long library
title present verbatim after normalisation, connect to library papers. Ambiguity stays external.
This is derived data: import, metadata edits, OCR, deletion and restore need no migration or sync.
"""
from __future__ import annotations

import json

from functools import lru_cache
from hashlib import sha256
from pathlib import Path
import re
import unicodedata
from urllib.parse import quote

from papeer.core.bibliography import clean_arxiv_id, clean_doi
from papeer.core.paths import PaperFiles
from papeer.core.shared_json import Signature, read_shared_json, signature
from papeer.core.storage import Library
from papeer.layout.reference_layout import reference_text_blocks

_NUMBER = re.compile(r"^\s*(?:\[([\w-]{1,20})\]|(\d{1,4})[.)])\s+")
_BARE_NUMBER = re.compile(r"^\s*(\d{1,3})\s+(?=[A-Z])")
_AUTHOR_START = re.compile(r"^(?:[A-Z][\w’'-]+,\s+[A-Z]|[A-Z]\.\s*[A-Z][\w’'-]+|[A-Z][\w’'-]+\s+[A-Z][\w’'-]+[,\s])")
_YEAR = re.compile(r"\b((?:18|19|20)\d{2})[a-z]?\b")
_DOI = re.compile(r"\b10\.\d{4,9}/[^\s\"<>{}]+", re.I)
_ARXIV = re.compile(r"(?:arxiv\s*:\s*|arxiv\.org/(?:abs|pdf)/|10\.48550/arxiv\.)(\d{4}\.\d{4,5}|[a-z][\w.-]*/\d{7})(?:v\d+)?", re.I)


def normalized(text: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).casefold()))


def _entry(text: str, page: int, label: str) -> dict:
    raw = " ".join(re.sub(r"(\w)-\n(?=[a-z])", r"\1", text).split())
    doi_match, arxiv_match = _DOI.search(raw), _ARXIV.search(raw)
    doi = clean_doi(doi_match[0]) if doi_match else ""
    arxiv = clean_arxiv_id(arxiv_match[1]) if arxiv_match else ""
    year = _YEAR.search(raw)
    quoted = re.search(r'[“「"]([^”」"]{8,})[”」"]', raw)
    # A display hint only. Matching uses the original entry, never this guessed title.
    title = quoted[1] if quoted else ""
    if not title:
        # Author-date styles put the title after (2020). Avoid treating a year at the end as a title.
        dated = re.search(r"\(?\b(?:18|19|20)\d{2}[a-z]?\)?[.,]\s+(.+)", raw)
        if dated:
            candidate = re.split(r"\.\s+", dated[1])[0].strip()
            if len(candidate) >= 15 and not candidate.lower().startswith(("doi", "http", "arxiv")):
                title = candidate
    if not title:
        # Numbered author/title/venue style: initials do not end the authors' sentence.
        sentences = re.split(r"(?<!\b[A-Z])\.\s+", raw)
        authors_only = re.fullmatch(r"(?:[A-Z]\.\s*)+[\w’'-]+(?:\s*(?:,|and|&)\s*(?:[A-Z]\.\s*)+[\w’'-]+)*", sentences[0])
        if len(sentences) >= 2 and authors_only:
            candidate = sentences[1].strip()
            if len(candidate) >= 15 and not _YEAR.search(candidate) and not candidate.lower().startswith(("doi", "http", "arxiv", "in ")):
                title = candidate
    return {"raw": raw, "label": label, "page": page, "title": title,
            "doi": doi, "arxiv_id": arxiv, "year": year[1] if year else ""}


def extract_references(document: dict) -> list[dict]:
    """Split numbered and author-date entries, keeping source text and source page.

    Unnumbered formats with no recognisable author boundary remain one text entry per PDF block.
    Their original text is always available; the UI explains that splitting may need checking.
    """
    blocks = reference_text_blocks(document)
    numbered = any(_NUMBER.match(line) for _, text in blocks for line in text.splitlines())
    bare = not numbered and sum(bool(_BARE_NUMBER.match(line)) for _, text in blocks for line in text.splitlines()) >= 2
    result: list[dict] = []
    lines: list[str] = []
    page, label = 1, ""

    def flush() -> None:
        if lines:
            result.append(_entry("\n".join(lines), page, label))
            lines.clear()

    for block_page, text in blocks:
        if not text:
            flush()
            continue
        for index, line in enumerate(text.splitlines()):
            match = _NUMBER.match(line) if numbered else _BARE_NUMBER.match(line) if bare else None
            author_start = not numbered and not bare and _AUTHOR_START.match(line)
            if match or author_start or (not numbered and not bare and index == 0):
                flush()
            if not lines:
                page, label = block_page, next((g for g in match.groups() if g), "") if match else ""
            lines.append(line[match.end():] if match else line)
    flush()
    return [entry for entry in result if len(entry["raw"]) >= 12]


@lru_cache(maxsize=256)
def _cached_references(path: Path, stamp: Signature) -> list[dict]:
    return extract_references(read_shared_json(path))


def _match(entry: dict, papers: list[dict], titles: dict[str, str], identifiers: dict[tuple[str, str], set[str]]) -> tuple[str | None, str]:
    doi, arxiv = entry["doi"].casefold(), entry["arxiv_id"].casefold()
    identified = identifiers.get(("doi", doi), set()) | identifiers.get(("arxiv_id", arxiv), set())
    if identified:
        return (next(iter(identified)), "identifier") if len(identified) == 1 else (None, "unresolved")
    raw = f" {normalized(entry['raw'])} "
    candidates = []
    for paper in papers:
        title = titles[paper["id"]]
        if len(title) < 20 or f" {title} " not in raw:
            continue
        # An explicit conflicting identifier/year is stronger than a title resemblance.
        if doi and paper.get("doi") and doi != paper["doi"]:
            continue
        if arxiv and paper.get("arxiv_id") and arxiv != paper["arxiv_id"]:
            continue
        if entry["year"] and paper.get("publication_year") and entry["year"] != str(paper["publication_year"]):
            continue
        candidates.append(paper["id"])
    return (candidates[0], "title") if len(candidates) == 1 else (None, "unresolved")


def citation_graph(lib: Library) -> dict:
    from papeer.core.web_research import reference_key

    papers = [{**p, "doi": clean_doi(p.get("doi", "")).casefold(),
               "arxiv_id": clean_arxiv_id(p.get("arxiv_id", "") or p.get("doi", "")).casefold()} for p in lib.papers()]
    identifiers: dict[tuple[str, str], set[str]] = {}
    for paper in papers:
        for kind in ("doi", "arxiv_id"):
            if paper[kind]:
                identifiers.setdefault((kind, paper[kind]), set()).add(paper["id"])
    titles = {p["id"]: normalized(p["title"]) for p in papers}
    nodes = {p["id"]: {"id": p["id"], "paper_id": p["id"], "title": p["title"],
                        "year": p.get("publication_year", ""), "url": ""} for p in papers}
    references, edges, warnings = [], {}, []
    for paper in papers:
        source = paper["id"]
        with lib.connection() as db:
            saved = {row["key"]: json.loads(row["data"]).get("paper_id") for row in
                     db.execute("SELECT key,data FROM reference_research WHERE source=?", (source,))}
        try:
            path = PaperFiles(lib.folder(source)).document_json
            entries = _cached_references(path, signature(path))
        except (OSError, ValueError, KeyError, TypeError):
            warnings.append({"paper_id": source, "message": "保存済みの本文を読み取れませんでした。"})
            continue
        for index, entry in enumerate(entries):
            target, match = _match(entry, papers, titles, identifiers)
            research_key = reference_key(entry["raw"])
            linked = saved.get(research_key)
            if linked in nodes and nodes[linked]["paper_id"]:
                target, match = linked, "manual"
            url = ("https://doi.org/" + quote(entry["doi"], safe="/") if entry["doi"] else
                   "https://arxiv.org/abs/" + quote(entry["arxiv_id"], safe="/") if entry["arxiv_id"] else
                   "https://scholar.google.com/scholar?q=" + quote(entry["title"] or entry["raw"]))
            if target is None:
                # Only identifiers or identical original text merge unknown papers. Guessed titles do not.
                identity = ("arxiv:" + entry["arxiv_id"].casefold() if entry["arxiv_id"] else
                            "doi:" + entry["doi"].casefold() if entry["doi"] else normalized(entry["raw"]))
                target = "ref:" + sha256(identity.encode()).hexdigest()[:24]
                nodes.setdefault(target, {"id": target, "paper_id": None, "title": entry["title"] or entry["raw"],
                                          "year": entry["year"], "url": url})
            ref_id = f"{source}:{index}"
            references.append({**entry, "id": ref_id, "source": source, "target": target, "match": match, "url": url,
                               "research_key": research_key})
            # A self-citation still appears in the list, but a self-loop adds no navigation to the graph.
            if source != target:
                edges.setdefault((source, target), {"source": source, "target": target})
    return {"nodes": list(nodes.values()), "edges": list(edges.values()), "references": references, "warnings": warnings}
