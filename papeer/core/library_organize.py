"""The AI's proposal for organizing papers into folders (preview only; Library.apply_moves applies it)."""
from __future__ import annotations

import json

from papeer.core import prompts
from papeer.core.collection_paths import in_collection, normalize_collection_name
from papeer.core.errors import Invalid, NotFound

MAX_PAPERS = 300  # One request holds every paper, so a bigger set must be narrowed by folder or selection.
TEXT_CHARS = 800  # The start of page 1 that tells the AI what a paper is about.
NAME_LIMIT = 80  # Characters of one folder name (the same limit as a tag's).
REASON_LIMIT = 300
MESSAGE_LIMIT = 500

_ORGANIZE_SCHEMA = {"type": "object", "properties": {
    "folders": {"type": "array", "items": {"type": "object", "properties": {
        "name": {"type": "string"}, "reason": {"type": "string"}},
        "required": ["name", "reason"], "additionalProperties": False}},
    "moves": {"type": "array", "items": {"type": "object", "properties": {
        "key": {"type": "string"}, "folder": {"type": "string"}},
        "required": ["key", "folder"], "additionalProperties": False}},
    "message": {"type": "string"}},
    "required": ["folders", "moves", "message"], "additionalProperties": False}

_UNUSABLE = "AIから有効なフォルダー整理の案を取得できませんでした。再試行してください。"


def organize_candidates(lib, source: str, paper_ids: list[str] | None = None, papers: list[dict] | None = None) -> list[dict]:
    """The papers an organization of folder `source` ("" for unfiled) covers: the ones directly in it, or
    `paper_ids` (from any folders). Invalid when there are none or more than MAX_PAPERS; NotFound for an
    unknown ID. `papers`: the library's papers when the caller has them already."""
    source = normalize_collection_name(source)
    papers = lib.papers() if papers is None else papers
    if paper_ids is None:
        chosen = [p for p in papers if normalize_collection_name(p["collection_name"]) == source]
    else:
        by_id = {p["id"]: p for p in papers}
        wanted = list(dict.fromkeys(paper_ids))
        if any(paper_id not in by_id for paper_id in wanted):
            raise NotFound("見つからない論文が選択に含まれています。")
        chosen = [by_id[paper_id] for paper_id in wanted]
    if not chosen:
        raise Invalid("整理する論文がありません。" if paper_ids is not None else
                      ("未分類に論文がありません。" if not source else "このフォルダーに直接入っている論文がありません。"))
    if len(chosen) > MAX_PAPERS:
        raise Invalid(f"整理できるのは{MAX_PAPERS}件までです（{len(chosen)}件あります）。フォルダーや選択で絞ってください。")
    return chosen


def _text(value) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def _level_key(path: str) -> tuple[str, str]:
    """(the parent's path, the folded last name): what a folder is matched by when only its case may differ."""
    parent, _, leaf = path.rpartition(" / ")
    return parent, leaf.casefold()


def _target(name: str, source: str, names: dict[tuple[str, str], str], known: set[str], existing: set[str]) -> str | None:
    """The normalized folder the AI's `name` stands for, or None when it cannot be one: not a name, an
    unusable segment, or neither an existing folder nor below `source`.

    Each level is matched from the top to the folders already known (`known`: the existing ones, then the new
    ones accepted so far; `names` finds one by its parent and its name ignoring case): an exact spelling
    first, so "control / RL" goes into an existing "Control" instead of making a second one. An accepted
    path registers its new levels, so spellings differing in case within one answer are one folder."""
    path = normalize_collection_name(name)
    parts = path.split(" / ")
    if not path or any(part in {".", ".."} or len(part) > NAME_LIMIT for part in parts):
        return None
    levels: list[str] = []
    for part in parts:
        candidate = f"{levels[-1]} / {part}" if levels else part
        levels.append(candidate if candidate in known else names.get(_level_key(candidate), candidate))
    resolved = levels[-1]
    if resolved not in existing and source and not in_collection(resolved, source):
        return None
    for level in levels:
        known.add(level)
        names.setdefault(_level_key(level), level)
    return resolved


def propose_organization(lib, provider, cancel, progress, *, source: str, instruction: str = "",
                         paper_ids: list[str] | None = None, feedback: str = "", previous: dict | None = None) -> dict:
    """Have the AI propose folders for the papers of `source` (or of `paper_ids`) and which paper goes where.

    Nothing is written. A paper the AI leaves out, or puts where it already is, stays. A target must be an
    existing folder or below `source` (the base under which new folders are made); anything else, an
    unknown key, and a repeated key (the last answer wins) are dropped. `feedback` and `previous` (an earlier
    proposal as this returns it) ask for a revised proposal. Returns {"source", "instruction", "folders":
    [{"name", "reason", "new"}], "moves": [{"paper_id", "title", "from", "to"}], "expected": {paper_id: its
    folder now} for every moved paper, "message"}.
    """
    from papeer.providers import check_cancel, parse_json_answer

    source = normalize_collection_name(source)
    papers = lib.papers()
    candidates = organize_candidates(lib, source, paper_ids, papers)
    check_cancel(cancel)
    progress("論文の内容を読み込んでいます…")
    keys = {f"P{number}": paper for number, paper in enumerate(candidates, 1)}
    key_of = {paper["id"]: key for key, paper in keys.items()}
    current = {paper["id"]: normalize_collection_name(paper["collection_name"]) for paper in candidates}
    entries = []
    for key, paper in keys.items():
        entry = {"key": key, "title": paper["title"], "current_folder": current[paper["id"]],
                 "text": _text(lib.page_text(paper["id"], 1))[:TEXT_CHARS]}
        if paper.get("first_author"):
            entry["author"] = paper["first_author"]
        if paper.get("publication_year"):
            entry["year"] = paper["publication_year"]
        entries.append(entry)
    counts: dict[str, int] = {}
    for paper in papers:
        name = normalize_collection_name(paper["collection_name"])
        counts[name] = counts.get(name, 0) + 1
    existing = {name for name in lib.collections() if name}
    names: dict[tuple[str, str], str] = {}
    for name in sorted(existing):  # Names that differ only in case: the first in order is the one used.
        names.setdefault(_level_key(name), name)
    known = set(existing)
    request: dict = {"base_folder": source, "papers": entries,
                     "existing_folders": [{"name": name, "papers": counts.get(name, 0)} for name in sorted(existing, key=str.casefold)]}
    if instruction.strip():
        request["instruction"] = instruction.strip()
    if previous:
        titles = {paper["id"]: paper["title"] for paper in candidates}
        request["previous_proposal"] = {
            "folders": [{"name": folder.get("name", ""), "reason": folder.get("reason", "")} for folder in previous.get("folders", [])],
            "moves": [{"key": key_of[move["paper_id"]], "title": titles[move["paper_id"]], "folder": move.get("to", "")}
                      for move in previous.get("moves", []) if move.get("paper_id") in key_of],
            "message": previous.get("message", "")}
    if feedback.strip():
        request["feedback"] = feedback.strip()
    progress("フォルダー分けの案を作っています…")
    answer = provider.generate(prompts.load("library_organize"), json.dumps(request, ensure_ascii=False), _ORGANIZE_SCHEMA)
    try:
        value = parse_json_answer(answer, _ORGANIZE_SCHEMA)
    except ValueError:
        raise ValueError(_UNUSABLE) from None
    folders, moves = value.get("folders"), value.get("moves")
    if (not isinstance(folders, list) or not isinstance(moves, list)
            or any(not isinstance(f, dict) or not isinstance(f.get("name"), str) or not isinstance(f.get("reason", ""), str) for f in folders)
            or any(not isinstance(m, dict) or not isinstance(m.get("key"), str) or not isinstance(m.get("folder"), str) for m in moves)):
        raise ValueError(_UNUSABLE)
    check_cancel(cancel)
    targets: dict[str, str] = {}
    for move in moves:
        key = move["key"].strip()
        target = _target(move["folder"], source, names, known, existing)
        if key in keys and target is not None:
            targets[keys[key]["id"]] = target  # A key given twice: the last answer.
    result_moves = [{"paper_id": paper["id"], "title": paper["title"], "from": current[paper["id"]], "to": targets[paper["id"]]}
                    for paper in candidates if paper["id"] in targets and targets[paper["id"]] != current[paper["id"]]]
    reasons: dict[str, str] = {}
    for folder in folders:
        name = _target(folder["name"], source, names, known, existing)
        if name is not None:
            reasons[name] = _text(folder.get("reason", ""))[:REASON_LIMIT]
    used = list(dict.fromkeys(move["to"] for move in result_moves))
    ordered = [name for name in reasons if name in used] + [name for name in used if name not in reasons]
    return {"source": source, "instruction": instruction.strip(),
            "folders": [{"name": name, "reason": reasons.get(name, ""), "new": name not in existing} for name in ordered],
            "moves": result_moves, "expected": {move["paper_id"]: move["from"] for move in result_moves},
            "message": _text(value.get("message", ""))[:MESSAGE_LIMIT]}
