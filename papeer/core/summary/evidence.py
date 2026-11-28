"""Give the model source handles; copy literal evidence in code, not through the model."""
from __future__ import annotations

import hashlib
from copy import deepcopy


def evidence_schema(schema: dict) -> dict:
    """Require handles on the wire (Codex strict JSON), accept legacy quotes on read."""
    result = deepcopy(schema)
    def visit(value):
        if isinstance(value, dict):
            if "evidence_id" in value.get("properties", {}):
                value["required"] = list(dict.fromkeys([*value.get("required", []), "evidence_id"]))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(result)
    return result


def indexed_sources(sources: list[dict]) -> list[dict]:
    indexed = []
    for source in sources:
        if "evidence_spans" in source:
            indexed.append(source)
            continue
        text = source["text"]
        spans = []
        # Overlap keeps most sentences/conditions inside a selectable excerpt.
        # Hashes keep handles stable when a page appears in neighboring contexts.
        for offset in range(0, len(text), 400):
            excerpt = text[offset:offset + 600]
            if len(excerpt.strip()) < 12:
                continue
            identity = f"p{source['page']}q" + hashlib.sha256(excerpt.encode()).hexdigest()[:32]
            spans.append({"id": identity, "text": excerpt})
        indexed.append(dict(source, evidence_spans=spans))
    return indexed


def resolve_evidence(item: dict, sources: list[dict]) -> str:
    identity = item.get("evidence_id", "")
    if not identity:
        return item["evidence"]  # Compatibility with stored reviews and literal-quote providers.
    candidates = {span["text"] for source in indexed_sources(sources) if source["page"] == item["page"]
                  for span in source["evidence_spans"] if span["id"] == identity}
    if len(candidates) != 1:
        raise ValueError(f"PDF p.{item['page']}の根拠IDを確認できません: {identity}。"
                         "そのページのevidence_spansからidを正確にコピーし、evidenceは空文字にしてください。")
    return next(iter(candidates))
