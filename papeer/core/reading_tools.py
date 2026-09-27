"""Reading metadata, shared terminology and portable library snapshots."""
from __future__ import annotations

from datetime import datetime
from contextlib import closing
import json
import hashlib
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import tempfile
import threading
import uuid
import zipfile

from papeer.core import prompts
from papeer.core.paths import PaperFiles
from papeer import __version__
from papeer.core.storage import SCHEMA_VERSION, Library, NewerSchemaError, newer_papeer
from papeer.core.terminology import effective_glossary, apply_glossary, validate_revision
from papeer.core.fileio import atomic_output, atomic_write_json, is_temporary
from papeer.pdf.pdf_engine import translation_units

__all__ = ["effective_glossary", "validate_revision"]

DEFAULT_TEMPLATE = "\n\n".join("## " + heading for heading in (
    "何を解決する論文？", "新しい点", "主な結果", "前提・限界", "自分に使えそうな点", "疑問・次に調べること"))


def validate_terms(terms: list[dict]) -> list[dict[str, str]]:
    if not isinstance(terms, list) or any(not isinstance(item, dict) or
            not isinstance(item.get("source"), str) or not isinstance(item.get("target"), str) for item in terms):
        raise ValueError("辞書には原語（source）と訳語（target）の文字列の一覧が必要です。")
    result = []
    seen = set()
    for item in terms:
        source, target = item.get("source", "").strip(), item.get("target", "").strip()
        if not source or not target or max(len(source), len(target)) > 100 or source.casefold() in seen:
            raise ValueError("用語と訳語を入力し、重複をなくしてください（各100文字まで）。")
        seen.add(source.casefold())
        result.append({"source": source, "target": target})
    return result


def draft_glossary(lib, paper_id, provider, cancel, progress, existing):
    """Suggest terminology from all source pages without persisting unreviewed terms."""
    from papeer.providers import check_cancel, parse_json_answer

    text = "\n\n".join(text for _, text in lib.page_texts(paper_id))
    if not text.strip():
        raise ValueError("専門用語を抽出できる原文がありません。")
    known = {t["source"].casefold(): t for t in effective_glossary(lib, paper_id)}
    known.update({t["source"].casefold(): t for t in existing})
    result = []
    schema = {"type": "object", "properties": {"terms": {"type": "array", "items": {
        "type": "object", "properties": {"source": {"type": "string"}, "target": {"type": "string"}},
        "required": ["source", "target"], "additionalProperties": False}}},
        "required": ["terms"], "additionalProperties": False}
    # Overlap preserves phrases crossing chunk boundaries, while bounding each request.
    chunks = [text[i:i + 24000] for i in range(0, len(text), 23000)]
    for index, chunk in enumerate(chunks):
        check_cancel(cancel)
        progress(f"専門用語の翻訳対応表を作っています… {index + 1}/{len(chunks)}")
        answer = provider.generate(
            prompts.load("glossary_draft"),
            json.dumps({"source": chunk, "existing_terms": [t for key, t in known.items() if key in chunk.casefold()]}, ensure_ascii=False), schema)
        try:
            value = parse_json_answer(answer, schema)
        except ValueError:
            raise ValueError("AIから有効な翻訳対応表を取得できませんでした。再試行してください。") from None
        terms = value.get("terms")
        if not isinstance(terms, list) or any(not isinstance(t, dict) or
                not isinstance(t.get("source"), str) or not isinstance(t.get("target"), str) for t in terms):
            raise ValueError("AIから有効な翻訳対応表を取得できませんでした。再試行してください。")
        # Unlike a user's list, one duplicate or overlong suggestion only drops that term.
        for item in terms:
            term = {"source": item["source"].strip(), "target": item["target"].strip()}
            key = term["source"].casefold()
            if (term["source"] and term["target"] and max(len(term["source"]), len(term["target"])) <= 100
                    and key not in known and key in chunk.casefold()):
                result.append(term)
                known[key] = term
    check_cancel(cancel)
    return {"terms": result}


def translation_paragraphs(lib: Library, paper_id: str) -> list[dict]:
    folder = lib.folder(paper_id)
    document = lib.document(paper_id)
    units = translation_units(document)
    apply_glossary(units, effective_glossary(lib, paper_id))
    cache = PaperFiles.read_json(PaperFiles(folder).translation_cache, {})
    from papeer.translation.translation import page_fingerprint
    from papeer.layout.reading_flow import unit_pages
    done = {}
    for number, entry in cache.get("completed_pages", {}).items():
        page_units = [unit for unit in units if int(number) in unit_pages(unit)]
        if entry.get("source") == page_fingerprint(page_units):
            done.update(entry.get("translations", {}))
    return [dict(id=u["id"], page=u["page"], pages=sorted(unit_pages(u)), source=u["text"],
                 text=done[u["id"]]) for u in units if u["id"] in done]


def library_search(lib: Library, query: str, limit: int = 200) -> dict:
    term = query.strip().casefold()
    if not term:
        return {"results": [], "limited": False}
    if len(term) > 200:
        raise ValueError("検索語は200文字までです。")
    results = []
    def add(paper, side, page, text):
        offset = text.casefold().find(term)
        if offset >= 0:
            results.append({"paper_id": paper["id"], "title": paper["title"], "side": side, "page": page,
                            "snippet": text[max(0, offset - 45):offset + len(term) + 90].replace("\n", " ")})
    for paper in lib.papers():
        add(paper, "metadata", None, " ".join([paper["title"], paper["first_author"], paper["publication_year"],
                                              paper["original_name"], paper["collection_name"], *paper["tags"]]))
        add(paper, "note", None, paper["note"])
        for number, text in lib.page_texts(paper["id"]):
            add(paper, "original", number, text)
        for page, _, text in PaperFiles(lib.folder(paper["id"])).translation_sections():
            add(paper, "translated", page, text)
        if len(results) >= limit:
            return {"results": results[:limit], "limited": True}
    return {"results": results, "limited": False}


def _stop_if_cancelled(cancel: threading.Event | None) -> None:
    if cancel is not None:
        from papeer.providers import check_cancel
        check_cancel(cancel)


def create_backup(lib: Library, destination: Path, cancel: threading.Event | None = None) -> None:
    """Write the whole library to a ZIP; a cancelled backup leaves no file behind (Cancelled is raised)."""
    destination = destination.resolve()
    if destination.is_relative_to(lib.root.resolve()):
        raise ValueError("バックアップはデータ保存フォルダーの外に保存してください。")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with atomic_output(destination) as temporary, tempfile.TemporaryDirectory() as directory:
        snapshot = Path(directory) / "library.sqlite3"
        with lib.connection() as source, closing(sqlite3.connect(snapshot)) as target:
            source.backup(target)
            schema_version = target.execute("PRAGMA user_version").fetchone()[0]
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(snapshot, "library.sqlite3")
            # "version" is the archive layout; schema_version lets an older Papeer refuse a newer library.
            archive.writestr("papeer-backup.json", json.dumps(
                {"version": 1, "schema_version": schema_version, "app_version": __version__}))
            for path in lib.root.rglob("*"):
                _stop_if_cancelled(cancel)
                # Half-written files left by a forced exit must not travel with the backup or sync.
                if (path.is_file() and not is_temporary(path)
                        and path.name not in {"library.sqlite3", "library.sqlite3-wal", "library.sqlite3-shm"}):
                    archive.write(path, path.relative_to(lib.root).as_posix())


# The library's settings (settings.json: connection, model, effort, ...) and the user's prompt texts.
# A restore may keep the current ones instead of taking those in the backup.
SETTINGS_ENTRIES = ("settings.json", "prompts")


def restore_backup(lib: Library, source: Path, cancel: threading.Event | None = None, *,
                   import_settings: bool = True) -> Path:
    """Replace the library with a validated backup and return where the old one was moved.

    With import_settings=False the current settings.json and prompts are kept instead of the backup's.
    Options tied to this PC (cli_path, base_url) are never taken from a backup either way; see config.Settings.load.
    `cancel` is honoured only until the folders are swapped: a cancelled restore leaves the library as it was.
    """
    root = lib.root.resolve()
    staging = root.with_name(root.name + "-restore-" + uuid.uuid4().hex)
    previous = root.with_name(root.name + "-before-restore-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6])
    staging.mkdir()
    try:
        with zipfile.ZipFile(source) as archive:
            total = 0
            names = set()
            for item in archive.infolist():
                _stop_if_cancelled(cancel)
                name = item.filename
                path = PurePosixPath(name)
                normalized = "/".join(path.parts).casefold()
                total += item.file_size
                if (path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name
                        or not path.parts or (item.external_attr >> 16) & 0o170000 == 0o120000
                        or total > 20 * 1024**3 or normalized in names
                        or any(part.endswith((".", " ")) or part.split(".")[0].upper() in
                               {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}
                               for part in path.parts)):
                    raise ValueError("バックアップに不正なパスまたは大きすぎるデータが含まれます。")
                names.add(normalized)
                target = staging.joinpath(*path.parts)
                if not target.resolve().is_relative_to(staging.resolve()):
                    raise ValueError("バックアップのパスが不正です。")
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as stream, target.open("wb") as output:
                        shutil.copyfileobj(stream, output)
        manifest_path = staging / "papeer-backup.json"
        if not manifest_path.is_file():
            manifest_path = staging / "paperdesk-backup.json"
        if not manifest_path.is_file() or not (staging / "library.sqlite3").is_file():
            raise ValueError("Papeerのバックアップを選択してください。")
        manifest = json.loads(manifest_path.read_text("utf-8"))
        if manifest.get("version") != 1 or not (staging / "library.sqlite3").is_file():
            raise ValueError("Papeerのバックアップを選択してください。")
        with closing(sqlite3.connect(staging / "library.sqlite3")) as db:
            # Backups made before schema versioning have neither field and are at user_version 0.
            schema_version = manifest.get("schema_version", 0)
            if not isinstance(schema_version, int) or isinstance(schema_version, bool):
                raise ValueError("Papeerのバックアップを選択してください。")
            if max(schema_version, db.execute("PRAGMA user_version").fetchone()[0]) > SCHEMA_VERSION:
                made_by = newer_papeer(manifest.get("app_version") if schema_version > SCHEMA_VERSION else None)
                # Neutral wording: sync validates a pulled revision through this path as well.
                raise NewerSchemaError(f"このデータは{made_by}で作成されたため読み込めません。"
                                       "Papeerを最新版に更新してから、もう一度お試しください。")
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or db.execute("PRAGMA foreign_key_check").fetchall():
                raise ValueError("バックアップのデータベースが破損しています。")
            for paper_id, digest in db.execute("SELECT id,sha256 FROM papers"):
                _stop_if_cancelled(cancel)
                if not re.fullmatch(r"[0-9a-f]{32}", paper_id) or not (PaperFiles(staging / "papers" / paper_id).original_pdf).is_file():
                    raise ValueError("バックアップの論文ファイルが不足しています。")
                with (PaperFiles(staging / "papers" / paper_id).original_pdf).open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                        raise ValueError("バックアップの原文PDFが破損しています。")
        manifest_path.unlink()
        if not import_settings:
            _keep_current_settings(root, staging)
        # The last point to stop; once the folders are swapped the restore runs to the end.
        _stop_if_cancelled(cancel)
        root.rename(previous)
        try:
            staging.rename(root)
        except Exception:
            previous.rename(root)
            raise
        return previous
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def _keep_current_settings(root: Path, staging: Path) -> None:
    """Put the library's current settings and prompts in the restored copy in place of the backup's."""
    for name in SETTINGS_ENTRIES:
        restored, current = staging / name, root / name
        if restored.is_dir():
            shutil.rmtree(restored)
        else:
            restored.unlink(missing_ok=True)
        if current.is_dir():
            shutil.copytree(current, restored)
        elif current.is_file():
            shutil.copy2(current, restored)


REVISION_SCHEMA = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"],
                   "additionalProperties": False}


def draft_revision(lib: Library, paper_id: str, paragraph: dict, instruction: str, provider, cancel) -> str:
    """A revised translation of one paragraph following the user's instruction; not saved."""
    from papeer.providers import check_cancel, parse_json_answer

    answer = provider.generate(
        prompts.load("revision_draft") + " " + instruction,
        json.dumps({"source": paragraph["source"], "current": paragraph["text"],
                    "glossary": effective_glossary(lib, paper_id)}, ensure_ascii=False),
        REVISION_SCHEMA)
    value = parse_json_answer(answer, REVISION_SCHEMA)
    if not isinstance(value.get("text"), str):
        raise ValueError("AIから修正案を取得できませんでした。再試行してください。")
    text = validate_revision(paragraph["source"], value["text"])
    check_cancel(cancel)
    return text


def revision_history(folder: Path) -> list[dict]:
    return PaperFiles.read_json(PaperFiles(folder).translation_revisions, [])


def save_revision_history(folder: Path, unit_id: str, before: str, after: str) -> None:
    path = PaperFiles(folder).translation_revisions
    history = PaperFiles.read_json(path, [])
    history.append({"id": uuid.uuid4().hex, "unit_id": unit_id, "before": before, "after": after,
                    "created_at": datetime.now().isoformat(timespec="seconds")})
    atomic_write_json(path, history[-500:])
