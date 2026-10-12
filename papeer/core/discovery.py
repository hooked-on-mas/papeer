"""A paper map merges local evidence with cached external metadata, never inventing citations."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import logging
import math
import re
import sqlite3
import unicodedata

from papeer.core import citations, map_timing, semantic_graph, scholarly_lookup, web_research
from papeer.providers import Cancelled, check_cancel

TTL = 7 * 24 * 3600
CACHE_VERSION = 4
MAX_DIRECT = 1000
MAX_EXPANDED = 100
MAX_SHARED = 500
STOP = set("a an the of in on for to and or with by from using based study analysis approach method paper this that as is are be we our".split())


def external_provider(node: dict) -> str:
    return node.get("provider") or ("Semantic Scholar" if semantic_graph.work_id(node.get("external_id") or node["id"])
                                    else "OpenAlex" if "openalex.org/" in (node.get("external_id") or node["id"]) else "")


def read_cache(lib, source: str, origin: str) -> dict:
    with lib.connection() as db:
        row = db.execute("SELECT data FROM paper_discovery WHERE source=? AND origin=?", (source, origin)).fetchone()
    return json.loads(row[0]) if row else {"nodes": [], "checked_at": "", "warnings": []}


@map_timing.timed("cache_write", "探索結果の保存")
def write_cache(lib, source: str, origin: str, data: dict):
    with lib.connection() as db:
        db.execute("INSERT INTO paper_discovery VALUES(?,?,?) ON CONFLICT(source,origin) DO UPDATE SET data=excluded.data",
                   (source, origin, json.dumps(data, ensure_ascii=False)))


def fresh(cache: dict) -> bool:
    try:
        return (datetime.now(timezone.utc) - datetime.fromisoformat(cache["checked_at"])).total_seconds() < TTL
    except (KeyError, ValueError, TypeError):
        return False


def identity(node: dict) -> str:
    return (node.get("doi") or node.get("arxiv_id") or citations.normalized(node["title"])).casefold()


def stale(cache: dict, node: dict) -> bool:
    return not fresh(cache) or cache.get("version") != CACHE_VERSION or cache.get("origin_identity") != identity(node)


class IdentityIndex:
    """Build-local identity index. Updating a node replaces its old identifiers and title."""
    def __init__(self, nodes):
        self.nodes: dict[str, dict] = {}
        self.identifiers: dict[tuple[str, str], set[str]] = defaultdict(set)
        self.lengths: dict[int, set[str]] = defaultdict(set)
        for node in nodes: self.update(node)

    @staticmethod
    def identifiers_for(node):
        return [(field, node[field].casefold() if field in {"doi", "arxiv_id"} else node[field])
                for field in ("id", "external_id", "doi", "arxiv_id") if node.get(field)]

    def update(self, node):
        key = node["id"]
        previous = self.nodes.get(key)
        if previous is not None:
            for identifier in self.identifiers_for(previous): self.identifiers[identifier].discard(key)
            self.lengths[len(scholarly_lookup._normal(previous["title"]))].discard(key)
        self.nodes[key] = dict(node)
        for identifier in self.identifiers_for(node): self.identifiers[identifier].add(key)
        self.lengths[len(scholarly_lookup._normal(node["title"]))].add(key)

    def match(self, known):
        def compatible(node):
            return not any(known.get(k) and node.get(k) and known[k].casefold() != node[k].casefold()
                           for k in ("doi", "arxiv_id"))

        exact = set()
        for field, value in self.identifiers_for(known):
            # The original matcher compares the known ID to both node IDs, but
            # does not use the known external_id as another equality condition.
            if field == "external_id": continue
            exact.update(self.identifiers.get((field, value), ()))
            if field == "id": exact.update(self.identifiers.get(("external_id", value), ()))
        exact = {key for key in exact if compatible(self.nodes[key])}
        if exact: return next(iter(exact)) if len(exact) == 1 else None
        if len(citations.normalized(known["title"])) < 20: return None
        length = len(scholarly_lookup._normal(known["title"]))
        titles = set()
        # 2 * min(m, n) / (m + n) >= .95 requires 19/21*m <= n <= 21/19*m.
        # Integer arithmetic includes both threshold boundaries without rounding loss.
        for size in range((19 * length + 20) // 21, 21 * length // 19 + 1):
            for key in self.lengths.get(size, ()):
                node = self.nodes[key]
                if not compatible(node): continue
                if known.get("year") and node.get("year") and known["year"] != node["year"]: continue
                if known.get("first_author") and node.get("first_author") and (
                        known["first_author"].casefold().split()[-1] != node["first_author"].casefold().split()[-1]): continue
                if scholarly_lookup.titles_match(known["title"], node["title"]):
                    titles.add(key)
                    if len(titles) > 1: return None
        return next(iter(titles)) if titles else None


@map_timing.timed("identity_merge", "候補の重複・登録済みPDFとの照合")
def matching(known: dict, nodes: list[dict] | IdentityIndex) -> str | None:
    index = nodes if isinstance(nodes, IdentityIndex) else IdentityIndex(nodes)
    return index.match(known)


def tokens(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).casefold()
    latin = [w for w in re.findall(r"[a-z][a-z0-9-]{2,}", text) if w not in STOP]
    for run in re.findall(r"[\u3040-\u30ff\u3400-\u9fff]+", text):
        latin.extend(run[i:i + 2] for i in range(len(run) - 1))
    return latin


@map_timing.timed("vocabulary", "タイトル・抄録の語句による類似度")
def text_scores(nodes: list[dict], origin: str, *, minimum=.12, min_shared=2) -> dict[str, float]:
    # Titles carry the topic even when a long abstract also describes general methods.
    documents = {n["id"]: Counter(tokens((n["title"] + " ") * 4 + n.get("abstract", ""))) for n in nodes}
    df = Counter(t for counts in documents.values() for t in counts)
    vectors = {key: {t: (1 + math.log(c)) * (1 + math.log((1 + len(nodes)) / (1 + df[t])))
                     for t, c in counts.items()} for key, counts in documents.items()}
    norm = {key: math.sqrt(sum(v * v for v in values.values())) for key, values in vectors.items()}
    seed = vectors.get(origin, {})
    scores = {}
    for key, vector in vectors.items():
        shared = seed.keys() & vector.keys()
        if key != origin and len(shared) >= min_shared and norm.get(origin) and norm[key]:
            score = sum(seed[t] * vector[t] for t in shared) / (norm[origin] * norm[key])
            if score >= minimum:
                scores[key] = score
    return scores


@map_timing.timed("map_build", "候補の統合・引用関係・順位の構築")
def build(lib, source: str, origin: str = "", cache: dict | None = None) -> dict:
    lib.paper(source)
    origin = origin or source
    cache = read_cache(lib, source, origin) if cache is None else cache
    origin = cache.get("origin_aliases", {}).get(origin, origin)
    graph = citations.citation_graph(lib)
    papers = {p["id"]: p for p in lib.papers()}  # PDF papers: the map's nodes of the library.
    nodes = {n["id"]: {**n, "doi": "", "arxiv_id": "", "first_author": "", "abstract": ""} for n in graph["nodes"]}
    for key, paper in papers.items():
        if key in nodes:
            nodes[key].update({k: paper.get(k, "") for k in ("doi", "arxiv_id", "first_author")})
    for ref in graph["references"]:
        node = nodes[ref["target"]]
        for field in ("doi", "arxiv_id", "first_author", "abstract"):
            node[field] = node.get(field) or ref[field]
    # Saved abstracts are available even when the network is disabled.
    with lib.connection() as db:
        records = [json.loads(row[0]) for row in db.execute("SELECT data FROM reference_research")]
        snapshots = [json.loads(row[0]) for row in db.execute("SELECT data FROM paper_discovery WHERE source=?", (source,))]
    for record in records:
        if origin not in nodes and record.get("paper_id") in nodes and record.get("key") == web_research.reference_key("map:" + origin):
            origin = record["paper_id"]
        key = record.get("paper_id")
        if key in nodes and record.get("abstract"):
            nodes[key]["abstract"] = record["abstract"]
    # Other maps supply identity when following an external node, but not unrelated edges.
    if origin not in nodes:
        candidate = next((n for snap in snapshots for n in snap.get("nodes", []) if n["id"] == origin), None)
        if candidate:
            nodes[origin] = dict(candidate)
    external = cache.get("nodes", [])
    aliases: dict[str, str] = {}
    index = IdentityIndex(nodes.values())
    imported = {record["key"]: record["paper_id"] for record in reversed(records)
                if record.get("paper_id") in papers and record.get("key")}
    for ext in external:
        linked = imported.get(web_research.reference_key("map:" + ext["id"]))
        registered = ext.get("paper_id")
        if not linked and registered in papers and not any(ext.get(k) and nodes[registered].get(k) and ext[k].casefold() != nodes[registered][k].casefold() for k in ("doi", "arxiv_id")):
            linked = registered
        key = linked or matching(ext, index) or ext["id"]
        aliases[ext["id"]] = key
        existing = nodes.get(key, {})
        nodes[key] = {**ext, **existing, "external_id": ext["id"],
                      "title": existing["title"] if existing.get("paper_id") else ext["title"],
                      "abstract": existing.get("abstract") or ext.get("abstract", ""),
                      "external_citations": ext.get("external_citations")}
        for field in ("doi", "arxiv_id", "first_author", "year"):
            nodes[key][field] = existing.get(field) or ext.get(field, "")
        index.update(nodes[key])
    origin = aliases.get(origin, origin)
    if origin not in nodes:
        raise ValueError("探索の起点が見つかりません。元の論文に戻ってください。")
    evidence = defaultdict(set)
    for ref in graph["references"]:
        evidence[(ref["source"], ref["target"])].update(p["provider"] for p in ref.get("provenance", []))
    edges = {(e["source"], e["target"]): {**e, "kind": "citation", "provenance": " · ".join(sorted(evidence[(e["source"], e["target"])])) or "library"} for e in graph["edges"]}
    uncertain = {ref["target"] for ref in graph["references"] if ref["source"] == origin and ref.get("citation_status") == "unverified"}
    for ext in external:
        a = aliases[ext["id"]]
        for ref in ext.get("referenced_works", []):
            b = aliases.get(ref, ref)
            if b in nodes and a != b and not (a == origin and b in uncertain and external_provider(ext) == "Semantic Scholar"):
                edges.setdefault((a, b), {"source": a, "target": b, "kind": "citation", "provenance": external_provider(ext)})
    outgoing, incoming = defaultdict(set), defaultdict(set)
    for a, b in edges:
        if a != b:
            outgoing[a].add(b); incoming[b].add(a)
    citation_scores = {}
    reasons = defaultdict(list)
    # A -> {B, C} -> D is evidence for D, not an invented A -> D citation.
    second_hop = {key: len(incoming[key] & outgoing[origin]) for key in nodes if key != origin}
    for key in nodes:
        if key == origin:
            continue
        shared = len(outgoing[key] & outgoing[origin])
        co = len(incoming[key] & incoming[origin])
        if shared or co:
            citation_scores[key] = max(shared / math.sqrt(max(1, len(outgoing[key]) * len(outgoing[origin]))),
                                       co / math.sqrt(max(1, len(incoming[key]) * len(incoming[origin]))))
            if shared: reasons[key].append(f"共通の参考文献が{shared}件")
            if co: reasons[key].append(f"一緒に引用された論文が{co}件")
        if second_hop.get(key, 0) >= 2:
            citation_scores[key] = max(citation_scores.get(key, 0), second_hop[key])
            reasons[key].append(f"直接の参考文献のうち{second_hop[key]}件が引用")
    # External candidates need the same topic comparison as library papers.
    relevance = text_scores(list(nodes.values()), origin, minimum=0, min_shared=1)
    origin_words = set(tokens(nodes[origin]["title"] + " " + nodes[origin].get("abstract", "")))
    texts = {key: score for key, score in relevance.items() if score >= .12 and
             len(origin_words & set(tokens(nodes[key]["title"] + " " + nodes[key].get("abstract", "")))) >= 2}
    for key in texts: reasons[key].append("タイトル・抄録の語句が近い")
    seed_ext = next((n for n in external if aliases[n["id"]] == origin), {})
    recommendations = list(dict.fromkeys(aliases.get(i, i) for i in seed_ext.get("related_works", [])
                                        if aliases.get(i, i) in nodes and aliases.get(i, i) != origin))
    recommendation_provider = external_provider(seed_ext) if seed_ext else ""
    for key in recommendations: reasons[key].append(recommendation_provider + "の関連論文")
    rank = defaultdict(float)
    for key in uncertain:
        reasons[key].append("Semantic Scholarの参考文献候補（PDF・Crossrefで未確認）")
        rank[key] += .001
    for ranking in (sorted(citation_scores, key=lambda k: (-second_hop.get(k, 0), -citation_scores[k], k)),
                    sorted(texts, key=lambda k: (-texts[k], k)), recommendations):
        for i, key in enumerate(ranking): rank[key] += 1 / (61 + i)
    # Shared generic foundations alone must not outrank papers about the origin's topic.
    # True A -> {B,C} -> D support remains useful even for an older method paper.
    for key in citation_scores:
        support = second_hop.get(key, 0)
        if support >= 2: rank[key] += .12 * support / (support + 2)
    for key, score in relevance.items():
        if key in rank or key in outgoing[origin] or key in incoming[origin]: rank[key] += score
    close = sorted(rank, key=lambda k: (-rank[k], k))
    neighborhood = {origin, *outgoing[origin], *close[:20]}
    prior = {key: len(incoming[key] & neighborhood) for key in nodes if key != origin}
    following = {key: len(outgoing[key] & neighborhood) for key in nodes if key != origin}
    # One node can have several roles; citation always wins when drawing its edge to the origin.
    result_nodes = []
    local_counts = Counter(e["target"] for e in { (e["source"], e["target"]): e for e in graph["edges"] }.values())
    origin_references = {}
    for ref in graph["references"]:
        if ref["source"] == origin: origin_references.setdefault(ref["target"], ref)
    for key, node in nodes.items():
        node["paper_id"] = node.get("paper_id") if node.get("paper_id") in papers else None
        roles = []
        if key in outgoing[origin]: roles.append("references"); reasons[key].insert(0, "直接引用")
        if key in incoming[origin]: roles.append("incoming"); reasons[key].append("この論文を引用")
        if key in rank: roles.append("related")
        if prior.get(key, 0) >= 2:
            roles.append("prior"); reasons[key].append(f"周辺の{prior[key]}論文から引用")
        if following.get(key, 0) >= 2:
            roles.append("following"); reasons[key].append(f"周辺の{following[key]}論文を引用")
        ref = origin_references.get(key)
        result_nodes.append({**node, "roles": roles, "reasons": reasons[key], "score": rank[key],
                             "prior_count": prior.get(key, 0), "following_count": following.get(key, 0),
                             "local_citations": local_counts[key], "reference_id": ref["id"] if ref else None,
                             "research_key": ref["research_key"] if ref else web_research.reference_key("map:" + key),
                             "provenance": list(dict.fromkeys(([external_provider(node)] if node.get("external_id") else []) +
                                ([p["provider"] for p in ref.get("provenance", [])] if ref else []) + (["library"] if node.get("paper_id") else []))),
                             "acquired_at": node.get("acquired_at") or cache.get("checked_at", "")})
    result_edges = list(edges.values())
    reachable = {origin, *outgoing[origin], *incoming[origin]}
    for key in list(reachable):
        reachable.update(outgoing[key]); reachable.update(incoming[key])
    for key in close:
        if key not in reachable:
            result_edges.append({"source": origin, "target": key, "kind": "candidate" if key in uncertain else "recommendation" if key in recommendations else "similarity",
                                 "provenance": "Semantic Scholar（未照合）" if key in uncertain else recommendation_provider if key in recommendations else "タイトル・抄録"})
    return dict(origin=origin, nodes=result_nodes, edges=result_edges, checked_at=cache.get("checked_at", ""),
                stale=stale(cache, papers.get(origin) or nodes[origin]), warnings=cache.get("warnings", []) + [w["message"] for w in graph["warnings"]],
                coverage=cache.get("coverage", "ライブラリ内で確認できた関係"),
                references=[r for r in graph["references"] if r["source"] == origin], timing=cache.get("timing"))


def discover(lib, source, origin, cancel, progress, enabled=lambda: True, force=False):
    """Persist the elapsed breakdown even for canceled or partially completed runs."""
    lib.paper(source)
    origin = origin or source
    result = None
    status = "failed"
    with map_timing.session() as trace:
        try:
            result = _discover(lib, source, origin, cancel, progress, enabled, force)
            status = "partial" if result["warnings"] else "completed"
        except Cancelled:
            status = "canceled"
            raise
        finally:
            report = trace.snapshot(status)
            # Diagnostic persistence is outside the reported elapsed time and must
            # never replace the job's original exception (including cancellation).
            try:
                saved = read_cache(lib, source, origin)
                saved["timing"] = report
                with map_timing.paused(): write_cache(lib, source, origin, saved)
            except (OSError, ValueError, sqlite3.Error):
                logging.getLogger("papeer.sidecar").exception("論文マップの計測結果を保存できませんでした")
            logger = logging.getLogger("papeer.sidecar.map_timing")
            logger.setLevel(logging.INFO)
            logger.info("paper_map_timing %s", json.dumps(dict(source=source, origin=origin, **report), ensure_ascii=False))
    if result is not None: result["timing"] = report
    return result


def _discover(lib, source, origin, cancel, progress, enabled=lambda: True, force=False):
    from papeer.core.reference_catalog import refresh
    check_cancel(cancel)
    if not enabled():
        cancel.set(); check_cancel(cancel)
    if origin in {p["id"] for p in lib.papers()}:
        refresh(lib, origin, cancel, progress, force=force)
    cache = read_cache(lib, source, origin)
    current = build(lib, source, origin, cache)
    known = next(n for n in current["nodes"] if n["id"] == current["origin"])
    if known.get("paper_id"):
        # Metadata edited on the PDF must outrank an older external identity, including title-only origins.
        paper = lib.paper(known["paper_id"])
        known = {**known, **{k: paper.get(k, "") for k in ("doi", "arxiv_id", "title", "first_author")},
                 "year": paper.get("publication_year", ""), "external_id": ""}
    collected = {n["id"]: n for n in cache.get("nodes", [])}
    cache = {**cache, "warnings": [], "checked_at": "", "origin_identity": identity(known), "version": CACHE_VERSION}
    revision = 0
    ranked_revision = 0
    seed_id = ""

    def ranking():
        nonlocal current, ranked_revision
        if ranked_revision != revision:
            current = build(lib, source, origin, cache)
            ranked_revision = revision
        return current

    def check():
        check_cancel(cancel)
        if not enabled():
            cancel.set(); check_cancel(cancel)

    def keep(batch):
        nonlocal revision
        check()
        stamp = datetime.now(timezone.utc).isoformat()
        batch = [{**n, "acquired_at": stamp} for n in batch]
        for node in batch:
            previous = collected.get(node["id"], {})
            if not node.get("references_loaded"):
                node["referenced_works"] = list(dict.fromkeys(previous.get("referenced_works", []) + node.get("referenced_works", [])))
            if node["id"] != seed_id:
                node["related_works"] = previous.get("related_works", node.get("related_works", []))
            if node.get("references_truncated"):
                warning = "Semantic Scholarの参考文献情報に取得上限・欠落があります。引用関係は取得できた範囲で表示します。"
                if warning not in cache["warnings"]: cache["warnings"].append(warning)
            collected[node["id"]] = {**previous, **node}
        if batch: revision += 1
        cache["nodes"] = list(collected.values())
        cache["timing"] = map_timing.snapshot()
        cache["coverage"] = "Semantic Scholarで探索。直接引用は最大1000件。直接の参考文献最大100件の取得済み引用先から共通引用先を最大500件取得。DOIなしの照合は最大20件。テーマ推薦は補助20件。被引用探索は起点を含む最大100論文、各論文のAPI応答順で最大200件。新しい順・被引用順の網羅的な取得ではありません。"
        write_cache(lib, source, origin, cache)
        progress(f"論文マップの候補を取得しています（{len(collected)}件）")

    try:
        check()
        seed = map_timing.call("origin_resolve", "起点の論文をSemantic Scholarで特定", semantic_graph.resolve, known, cancel)
        if not seed:
            cache["warnings"] = ["外部サービスで起点の論文を一意に特定できませんでした。"]
        else:
            seed_id = seed["id"]
            # Keep legacy results visible until identity resolution succeeds; new
            # graphs use one provider's IDs and counts, without mixing datasets.
            collected = {key: node for key, node in collected.items() if external_provider(node) == "Semantic Scholar"}
            if not known.get("paper_id") and origin != seed["id"]:
                cache.setdefault("origin_aliases", {})[origin] = seed["id"]
            seed["paper_id"] = known.get("paper_id")
            keep([seed])
            # Fetch the actual first hop before recommendations. Its metadata supplies
            # the second-hop citation lists, so no recursive full-network crawl is needed.
            for batch in map_timing.batches("direct_fetch", "直接の参考文献の取得", semantic_graph.works(seed["referenced_works"][:MAX_DIRECT], cancel)): keep(batch)
            if len(seed["referenced_works"]) > MAX_DIRECT:
                cache["warnings"].append("直接の参考文献の取得を1000件で区切りました。")
            ranked = ranking()
            direct = [n for n in ranked["nodes"] if "references" in n["roles"]]
            unresolved = [n for n in direct if not n.get("external_id")]
            # Crossref and PDF bibliographies can supply missing graph identities.
            available = max(0, MAX_DIRECT - sum(key in collected for key in set(seed["referenced_works"])))
            extra_dois = [n["doi"] for n in unresolved if n.get("doi")]
            for batch in map_timing.batches("direct_doi", "不足する参考文献をDOIで照合", semantic_graph.works_by_doi(extra_dois[:available], cancel)): keep(batch)
            if len(extra_dois) > available:
                cache["warnings"].append("DOIによる参考文献の追加照合は、直接引用の取得上限までを対象にしました。")
            topic = text_scores([known, *unresolved], known["id"], minimum=0, min_shared=1)
            title_only = sorted((n for n in unresolved if not n.get("doi")),
                                key=lambda n: (-topic.get(n["id"], 0), not bool(n.get("first_author")), n["id"]))
            for candidate in title_only[:20]:
                check()
                ext = map_timing.call("direct_title", "DOIのない参考文献をタイトルで照合", semantic_graph.resolve, candidate, cancel)
                if ext: keep([ext])
            if len(title_only) > 20:
                cache["warnings"].append("DOIのない参考文献の外部照合を20件で区切りました。")
            ranked = ranking()
            direct_ids = [n["external_id"] for n in ranked["nodes"] if "references" in n["roles"] and n.get("external_id")]
            direct_works = [collected[key] for key in dict.fromkeys(direct_ids) if key in collected]
            if len(direct_works) > MAX_EXPANDED:
                cache["warnings"].append("参考文献のさらに先の引用情報は、直接の参考文献100件までを対象にしました。")
            counts = Counter(ref for n in direct_works[:MAX_EXPANDED] for ref in set(n["referenced_works"]) if ref != seed["id"])
            shared = [key for key, count in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0])) if count >= 2 and key not in collected]
            for batch in map_timing.batches("shared_fetch", "共通の引用先の取得", semantic_graph.works(shared[:MAX_SHARED], cancel)): keep(batch)
            if len(shared) > MAX_SHARED:
                cache["warnings"].append("共通の引用先の取得を500件で区切りました。")
            try:
                for batch in map_timing.batches("recommendations", "補助のテーマ推薦の取得", semantic_graph.recommendations(seed["id"], cancel)):
                    seed["related_works"] = [n["id"] for n in batch]
                    if batch: keep([seed, *batch])
            except (OSError, ValueError) as error:
                cache["warnings"].append(f"関連論文の推薦を取得できませんでした：{error}")
            ranked = ranking()
            nearby = sorted((n for n in ranked["nodes"] if "related" in n["roles"]), key=lambda n: (-n["score"], n["id"]))[:20]
            seeds = [seed, *direct_works[:MAX_EXPANDED]]
            for candidate in nearby:
                check()
                ext = collected.get(candidate.get("external_id", candidate["id"]))
                if not ext:
                    ext = map_timing.call("nearby_resolve", "周辺候補の追加照合", semantic_graph.resolve, candidate, cancel)
                    if ext:
                        ext["paper_id"] = candidate.get("paper_id")
                        keep([ext])
                if ext: seeds.append(ext)
            # Recommendations contain metadata only. Hydrate their outgoing
            # references before counting shared ancestors and later developments.
            missing_refs = [n["id"] for n in seeds if n["id"] in seed["related_works"]]
            for batch in map_timing.batches("nearby_references", "周辺候補の引用先を取得", semantic_graph.works(missing_refs, cancel)): keep(batch)
            seeds = [collected.get(n["id"], n) for n in seeds]
            ids = list(dict.fromkeys(n["id"] for n in seeds))[:100]
            prior = Counter(ref for n in {n["id"]: n for n in seeds}.values() for ref in set(n["referenced_works"]))
            # The supplementary neighbourhood shares the same bounded ancestor
            # budget; don't refetch the first hop or evade the shared-work cap.
            wanted = [key for key, count in prior.most_common() if count >= 2 and key not in collected]
            remaining = max(0, MAX_SHARED - min(MAX_SHARED, len(shared)))
            for batch in map_timing.batches("prior_fetch", "先行研究の補足取得", semantic_graph.works(wanted[:remaining], cancel)): keep(batch)
            if len(wanted) > remaining: cache["warnings"].append("周辺の論文群からの共通引用先も含め、取得を500件で区切りました。")
            # Query the origin first, then each neighbour. Repeated citing papers
            # accumulate only edges evidenced by the individual citation endpoints.
            for batch in map_timing.batches("origin_incoming", "起点を引用する論文の取得", semantic_graph.citing([seed["id"]], cancel)): keep(batch)
            for batch in map_timing.batches("following_fetch", "被引用・後続研究の取得", semantic_graph.citing([i for i in ids if i != seed["id"]], cancel)): keep(batch)
            check()
            cache["checked_at"] = datetime.now(timezone.utc).isoformat()
    except (OSError, ValueError) as error:
        cache["warnings"].append(f"外部情報を一部取得できませんでした：{error}")
    check()
    cache["nodes"] = list(collected.values())
    # The final response is built once. Computing its origin identity does not
    # change nodes, edges or rankings, so it must not trigger another full build.
    resolved = build(lib, source, origin, cache)
    if cache.get("checked_at"):
        node = next(n for n in resolved["nodes"] if n["id"] == resolved["origin"])
        origin_node = lib.paper(node["paper_id"]) if node.get("paper_id") else node
        cache["origin_identity"] = identity(origin_node)
        resolved["stale"] = stale(cache, origin_node)
    write_cache(lib, source, origin, cache)
    return resolved


def prepare_record(lib, source: str, origin: str, node_id: str) -> dict:
    """Selected discovery candidates can use the existing import flow without a fake bibliography row."""
    result = build(lib, source, origin)
    node = next((n for n in result["nodes"] if n["id"] == node_id), None)
    if not node:
        raise ValueError("文献が見つかりません。")
    key = web_research.reference_key("map:" + node_id)
    existing = next((r for r in web_research.records(lib, source) if r["key"] == key), None)
    if existing:
        if node.get("paper_id"): existing["paper_id"] = node["paper_id"]
        web_research.save_record(lib, source, existing)
        return existing
    record = web_research.normalized_record({**node, "publication_year": node["year"],
        "basis": "abstract" if node.get("abstract") else "metadata",
        "sources": [{"title": external_provider(node), "url": node.get("external_id") or node["url"]}]
        if external_provider(node) else []}, node["title"], key)
    record["paper_id"] = node.get("paper_id")
    web_research.save_record(lib, source, record)
    return record
