"""One-off CLI migration tool from legacy Papeer (v8/v9) to canonical shared-app storage (M4).

Never modifies or deletes the source legacy directory. All writes go through
SqliteEditRepository so every converted folder, PDF, notebook, ink stroke,
bookmark, Markdown note, HTML attachment, and link passes canonical validation.

Usage:
  uv run python tools/migrate_legacy_data.py inspect
  uv run python tools/migrate_legacy_data.py backup --backup-dir C:\\Backup\\papeer-2026
  uv run python tools/migrate_legacy_data.py targets --target-data-dir <dir>
  uv run python tools/migrate_legacy_data.py migrate --target-data-dir <dir> --title "研究ライブラリ"
  uv run python tools/migrate_legacy_data.py migrate --target-data-dir <dir> --library-id <uuid>
"""
from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
from uuid import uuid4

import pymupdf

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from papeer.core.bootstrap.canonical_bootstrap import assert_canonical_profile
from papeer.core.bootstrap.canonical_initialization_sqlite import (
    SqliteCanonicalInitialization,
    initialize_canonical_metadata,
)
from papeer.core.bootstrap.canonical_local_grant_sqlite import provision_local_grant
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_contracts import (
    EDIT_LIMITS,
    validate_canonicaldevicepeer,
)
from papeer.core.edit_model import EditGraph, canonical_json
from papeer.core.edit_repository import SqliteEditRepository, initialize_edit_schema
from papeer.core.edit_storage import edit_storage_root
from papeer.core.edits.dataset_control import assert_dataset_control, dataset_access
from papeer.core.edits.datasets import checkpoint_hash
from papeer.core.paths import device_directory, selected_data_directory

MAX_RESOURCE_BYTES = 128 * 1024 * 1024
MAX_LABEL_LENGTH = 40
MAX_HIGHLIGHT_QUADS = 2000
EPS = 1e-6
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
ISO_TIMESTAMP_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$")
SQLITE_TIMESTAMP_RE = re.compile(r"^([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?)$")
MEDIA_IMG_RE = re.compile(r"(!\[[^\]]*\]\()(?:\.?/)?media/([^)\s?#]+)((?:\s+\"[^\"]*\"|\s+'[^']*')?\))")
NAMED_HIGHLIGHT_COLORS: dict[str, str] = {
    "yellow": "#fde047",
    "green": "#86efac",
    "blue": "#93c5fd",
    "pink": "#f9a8d4",
    "purple": "#d8b4fe",
}
NOTEBOOK_SIZES: dict[str, tuple[float, float]] = {
    "A4": (210.0, 297.0),
    "B5": (182.0, 257.0),
    "A5": (148.0, 210.0),
    "Letter": (215.9, 279.4),
    "16:9": (180.0, 320.0),
}
VALID_TEMPLATES = {"blank", "ruled7", "ruled6", "ruled5", "grid5", "grid10", "dot5", "cornell"}
VALID_COLORS = {"white", "cream", "dark"}


def stable_id(library_id: str, kind: str, source: list[str]) -> str:
    """Deterministic UUIDv8 matching frontend/src/migrations/stableId.ts."""
    digest = list(edit_content_hash(["paper-desk-migration-v1", library_id, kind, list(source)])[:32])
    digest[12] = "8"
    digest[16] = "89ab"[int(digest[16], 16) & 3]
    text = "".join(digest)
    return "-".join([text[:8], text[8:12], text[12:16], text[16:20], text[20:]])


def clamp_title(text: str, fallback: str = "無題") -> str:
    cleaned = " ".join((text or "").split()).strip()
    if not cleaned:
        cleaned = fallback
    return cleaned[: EDIT_LIMITS["title"]]


def clamp_unit(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _copy_sqlite_snapshot(source_dir: Path, tmp_dir: Path) -> Path:
    src_db = source_dir / "library.sqlite3"
    if not src_db.is_file():
        raise FileNotFoundError(f"legacy library.sqlite3 not found: {src_db}")
    dst_db = tmp_dir / "library.sqlite3"
    shutil.copy2(src_db, dst_db)
    for suffix in ("-wal", "-shm", "-journal"):
        side = source_dir / f"library.sqlite3{suffix}"
        if side.is_file():
            shutil.copy2(side, tmp_dir / f"library.sqlite3{suffix}")
    return dst_db


@contextmanager
def _open_temp_sqlite_readonly(db_path: Path):
    """Open disposable working copy allowing WAL recovery, while forbidding any writes via query_only."""
    with closing(sqlite3.connect(db_path)) as con:
        con.execute("PRAGMA query_only = ON")
        con.row_factory = sqlite3.Row
        yield con


def _normalize_timestamp(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if ISO_TIMESTAMP_RE.fullmatch(text):
        return text
    match = SQLITE_TIMESTAMP_RE.fullmatch(text)
    if match:
        return f"{match.group(1)}T{match.group(2)}Z"
    return None


def _normalize_bookmark_color(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if HEX_COLOR_RE.fullmatch(text):
        return text
    return NAMED_HIGHLIGHT_COLORS.get(text.lower())


def _table_names(con: sqlite3.Connection) -> set[str]:
    return {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}


def _table_columns(con: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in con.execute(f'PRAGMA table_info("{table}")').fetchall()}


def _parse_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in parsed:
        if isinstance(item, str):
            tag = item.strip()[:80]
            if tag and tag not in seen:
                seen.add(tag)
                result.append(tag)
    return result


def _read_legacy_note_text(source_dir: Path, paper_id: str, paper_row: dict, note_state_map: dict[str, str]) -> str:
    if paper_id in note_state_map and note_state_map[paper_id].strip():
        return note_state_map[paper_id]
    note_md = source_dir / "papers" / paper_id / "note.md"
    if note_md.is_file():
        text = note_md.read_text(encoding="utf-8", errors="replace")
        if text.strip():
            return text
    legacy_col = paper_row.get("note")
    if isinstance(legacy_col, str) and legacy_col.strip():
        return legacy_col
    return ""


def inspect_legacy_source(source_dir: Path) -> dict:
    """Read-only summary of a legacy PC data directory."""
    with tempfile.TemporaryDirectory(prefix="papeer-m4-inspect-") as tmp:
        db_path = _copy_sqlite_snapshot(source_dir, Path(tmp))
        with _open_temp_sqlite_readonly(db_path) as con:
            tables = _table_names(con)
            user_version = con.execute("PRAGMA user_version").fetchone()[0]
            papers = [dict(row) for row in con.execute("SELECT * FROM papers").fetchall()]
            pdf_count = sum(1 for p in papers if (p.get("kind") or "pdf") == "pdf")
            nb_count = sum(1 for p in papers if p.get("kind") == "notebook")
            md_paper_count = sum(1 for p in papers if p.get("kind") == "markdown")
            collections = [row[0] for row in con.execute("SELECT name FROM collections").fetchall()] if "collections" in tables else []
            links = con.execute("SELECT COUNT(*) FROM item_links").fetchone()[0] if "item_links" in tables else 0
            ink_rows = con.execute("SELECT side, COUNT(*) FROM pdf_ink GROUP BY side").fetchall() if "pdf_ink" in tables else []
            ink_by_side = {row[0]: row[1] for row in ink_rows}
            translated_ink_papers = (
                {row[0] for row in con.execute("SELECT DISTINCT paper_id FROM pdf_ink WHERE side='translated'").fetchall()}
                if "pdf_ink" in tables else set()
            )
            bm_rows = con.execute("SELECT side, COUNT(*) FROM bookmarks GROUP BY side").fetchall() if "bookmarks" in tables else []
            bm_by_side = {row[0]: row[1] for row in bm_rows}
            if "bookmarks" in tables:
                translated_ink_papers.update(
                    row[0] for row in con.execute("SELECT DISTINCT paper_id FROM bookmarks WHERE side='translated'").fetchall()
                )
            att_rows = (
                [dict(row) for row in con.execute("SELECT id, owner_id, format, source FROM attachments").fetchall()]
                if "attachments" in tables else []
            )
            note_state_map: dict[str, str] = {}
            if "note_state" in tables:
                ns_cols = _table_columns(con, "note_state")
                if {"paper_id", "content"}.issubset(ns_cols):
                    for row in con.execute("SELECT paper_id, content FROM note_state").fetchall():
                        if isinstance(row[1], str):
                            note_state_map[row[0]] = row[1]
            inline_notes = sum(
                1 for p in papers
                if (p.get("kind") or "pdf") != "markdown" and _read_legacy_note_text(source_dir, p["id"], p, note_state_map)
            )

    papers_dir = source_dir / "papers"
    orig_pdfs = list(papers_dir.glob("*/original.pdf")) if papers_dir.is_dir() else []
    trans_pdfs = list(papers_dir.glob("*/translated.pdf")) if papers_dir.is_dir() else []
    orig_bytes = sum(p.stat().st_size for p in orig_pdfs)
    trans_bytes = sum(p.stat().st_size for p in trans_pdfs)
    ink_only_trans_bytes = sum(
        (papers_dir / pid / "translated.pdf").stat().st_size
        for pid in translated_ink_papers
        if (papers_dir / pid / "translated.pdf").is_file()
    )
    oversized = [
        str(p.relative_to(source_dir))
        for p in [*orig_pdfs, *trans_pdfs]
        if p.stat().st_size > MAX_RESOURCE_BYTES
    ]

    md_attachments = sum(1 for a in att_rows if a.get("format") == "md")
    html_attachments = sum(1 for a in att_rows if a.get("format") == "html")
    other_attachments = len(att_rows) - md_attachments - html_attachments

    referenced_pngs = 0
    referenced_png_bytes = 0
    total_pngs = 0
    total_png_bytes = 0
    if papers_dir.is_dir():
        for paper_dir in papers_dir.iterdir():
            if not paper_dir.is_dir():
                continue
            media = paper_dir / "media"
            if not media.is_dir():
                continue
            md_texts = ""
            note_md = paper_dir / "note.md"
            if note_md.is_file():
                md_texts += note_md.read_text(encoding="utf-8", errors="ignore")
            att_dir = paper_dir / "attachments"
            if att_dir.is_dir():
                for f in att_dir.glob("*.md"):
                    md_texts += f.read_text(encoding="utf-8", errors="ignore")
            for png in media.glob("*.png"):
                sz = png.stat().st_size
                total_pngs += 1
                total_png_bytes += sz
                if png.name in md_texts:
                    referenced_pngs += 1
                    referenced_png_bytes += sz

    return {
        "sourceDir": str(source_dir),
        "schemaVersion": user_version,
        "papers": {"total": len(papers), "pdf": pdf_count, "notebook": nb_count, "markdown": md_paper_count},
        "collections": len(collections),
        "links": links,
        "pdfInkBySide": ink_by_side,
        "bookmarksBySide": bm_by_side,
        "inlineNotesOnItems": inline_notes,
        "attachments": {"markdown": md_attachments, "html": html_attachments, "other": other_attachments},
        "sizesMiB": {
            "originalPdfs": round(orig_bytes / (1024 * 1024), 2),
            "translatedPdfsAll": round(trans_bytes / (1024 * 1024), 2),
            "translatedPdfsInkOnly": round(ink_only_trans_bytes / (1024 * 1024), 2),
            "referencedMediaPngs": round(referenced_png_bytes / (1024 * 1024), 2),
            "unreferencedMediaPngs": round((total_png_bytes - referenced_png_bytes) / (1024 * 1024), 2),
        },
        "mediaPngCounts": {"referenced": referenced_pngs, "total": total_pngs},
        "oversizedResources": oversized,
    }


def backup_legacy_folders(source_dir: Path, backup_dir: Path, include_device_dir: bool = True) -> dict:
    """Copy full legacy data directory (+ PapeerSync device dir) and verify byte/file totals."""
    if not source_dir.is_dir():
        raise FileNotFoundError(f"source directory not found: {source_dir}")
    resolved_src = source_dir.resolve()
    resolved_dst = backup_dir.resolve()
    if resolved_dst == resolved_src or resolved_dst.is_relative_to(resolved_src):
        raise ValueError(f"backup directory cannot be inside source directory: {backup_dir}")
    dev_dir = device_directory()
    if include_device_dir and dev_dir.is_dir():
        resolved_dev = dev_dir.resolve()
        if resolved_dst == resolved_dev or resolved_dst.is_relative_to(resolved_dev):
            raise ValueError(f"backup directory cannot be inside device directory: {backup_dir}")
    if backup_dir.exists() and any(backup_dir.iterdir()):
        raise FileExistsError(f"backup directory must be empty or non-existent: {backup_dir}")
    backup_dir.mkdir(parents=True, exist_ok=True)

    def copy_tree_verified(src: Path, dst: Path) -> dict:
        shutil.copytree(src, dst)
        src_files = [p for p in src.rglob("*") if p.is_file()]
        dst_files = [p for p in dst.rglob("*") if p.is_file()]
        src_bytes = sum(p.stat().st_size for p in src_files)
        dst_bytes = sum(p.stat().st_size for p in dst_files)
        if len(src_files) != len(dst_files) or src_bytes != dst_bytes:
            raise RuntimeError(
                f"backup verification mismatch for {src}: "
                f"src=({len(src_files)} files, {src_bytes} B) vs dst=({len(dst_files)} files, {dst_bytes} B)"
            )
        return {"source": str(src), "destination": str(dst), "files": len(dst_files), "bytes": dst_bytes}

    manifest: dict = {"data": copy_tree_verified(source_dir, backup_dir / source_dir.name)}
    if include_device_dir and dev_dir.is_dir() and dev_dir.resolve() != resolved_src:
        dev_name = dev_dir.name if dev_dir.name != source_dir.name else f"{dev_dir.name}-device"
        manifest["device"] = copy_tree_verified(dev_dir, backup_dir / dev_name)
    (backup_dir / "backup-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


class _DirectSqliteAuthority:
    """Direct file-backed transaction authority for one-off CLI migration (host sidecar must be stopped)."""

    def __init__(self, db_path: Path, account_id: str | None = None):
        self.db_path = db_path
        self.account_id = account_id or ""

    def assert_current(self) -> None:
        return None

    @contextmanager
    def transaction(self, _operation: str, _scope: dict | None = None):
        with closing(sqlite3.connect(self.db_path, timeout=30)) as db:
            try:
                db.execute("BEGIN IMMEDIATE")
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise


def list_target_libraries(target_data_dir: Path) -> list[dict]:
    db_path = edit_storage_root(target_data_dir) / "content.sqlite3"
    if not db_path.is_file():
        return []
    with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as db:
        tables = _table_names(db)
        if "canonical_profiles" not in tables:
            return []
        rows = db.execute("SELECT account, library, payload FROM canonical_profiles ORDER BY library").fetchall()
        results = []
        for account, library, payload in rows:
            profile = json.loads(payload)
            key = canonical_json([account, library])
            ctl = db.execute(
                "SELECT active_epoch, frozen FROM edit_dataset_controls WHERE identity=?", (key,)
            ).fetchone()
            remote = profile.get("remote")
            results.append({
                "libraryId": library,
                "accountId": account,
                "title": profile.get("title", ""),
                "storage": "google-drive" if remote else "local",
                "folderId": remote.get("folderId") if isinstance(remote, dict) else None,
                "activeEpoch": ctl[0] if ctl else None,
                "frozen": bool(ctl[1]) if ctl else False,
            })
        return results


def _open_or_create_target_scope(target_data_dir: Path, *, title: str | None, library_id: str | None) -> tuple[Path, dict]:
    db_path = edit_storage_root(target_data_dir) / "content.sqlite3"
    if library_id:
        if not db_path.is_file():
            raise FileNotFoundError(f"canonical content.sqlite3 not found: {db_path}")
        with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as db:
            rows = db.execute(
                "SELECT account, library, payload FROM canonical_profiles WHERE library=?", (library_id,)
            ).fetchall()
            if not rows:
                raise ValueError(f"target libraryId not found in {db_path}: {library_id}")
            if len(rows) > 1:
                raise ValueError(f"multiple accounts own libraryId={library_id}; disambiguation required")
            account, library, payload = rows[0]
            profile = json.loads(payload)
            assert_canonical_profile(profile)
            peer_row = db.execute("SELECT payload FROM canonical_peers WHERE account=?", (account,)).fetchone()
            if not peer_row:
                raise ValueError("canonical_peers missing for target account")
            validate_canonicaldevicepeer(json.loads(peer_row[0]))
            key = canonical_json([account, library])
            ctl_row = db.execute(
                "SELECT payload FROM edit_dataset_controls WHERE identity=?", (key,)
            ).fetchone()
            if not ctl_row:
                raise ValueError("edit_dataset_controls missing for target library")
            control = json.loads(ctl_row[0])
            assert_dataset_control(control, {"accountId": account, "libraryId": library})
            access = dataset_access(control)
            if not control["active"] or access["frozen"]:
                raise ValueError("target library dataset is frozen or inactive")
            return db_path, deepcopy(control["active"]["scope"])

    if not title or not title.strip():
        raise ValueError("either --title (new local library) or --library-id (existing library) is required")
    clean_title = clamp_title(title)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    grant = provision_local_grant(db_path)
    namespace = grant["namespaceId"]
    authority = _DirectSqliteAuthority(db_path, namespace)
    with authority.transaction("bootstrap-provision") as db:
        initialize_edit_schema(db)
        initialize_canonical_metadata(db)
    init = SqliteCanonicalInitialization()
    peer = init.get_or_create_peer(authority, str(uuid4()))
    new_lib_id = str(uuid4())
    epoch = str(uuid4())
    request_id = str(uuid4())
    manifest_id = str(uuid4())
    checkpoint_obj_id = str(uuid4())
    root_version = str(uuid4())
    profile_rev = str(uuid4())
    scope = {"accountId": namespace, "libraryId": new_lib_id, "epoch": epoch}
    root = {"kind": "library", "id": new_lib_id, "version": root_version, "items": [], "folders": [], "links": [], "deletions": []}
    checkpoint = {"version": 1, "libraryId": new_lib_id, "roots": [root], "edits": []}
    manifest = {
        "version": 1,
        "id": manifest_id,
        "scope": scope,
        "checkpointSha256": checkpoint_hash(checkpoint),
        "resources": [],
    }
    control = {
        "version": 1,
        "id": request_id,
        "identity": {"accountId": namespace, "libraryId": new_lib_id},
        "active": manifest,
        "epochs": [epoch],
        "transition": {
            "id": request_id,
            "mode": "initialize",
            "phase": "activated",
            "source": None,
            "publication": {
                "manifest": manifest,
                "checkpoint": checkpoint,
                "checkpointObjectId": checkpoint_obj_id,
            },
        },
    }
    profile = {
        "version": 1,
        "revision": profile_rev,
        "identity": {"accountId": namespace, "libraryId": new_lib_id},
        "title": clean_title,
        "remote": None,
    }
    request = {"expectedPeerId": peer["peerId"], "profile": profile, "control": control}
    init.prepare(authority, request)
    result = init.execute(authority, request_id)
    if result.get("status") != "accepted":
        raise RuntimeError(f"failed to initialize new local library: {result}")
    init.acknowledge(authority, request_id)
    return db_path, scope


def _convert_legacy_stroke(stroke: dict, page_w: float, page_h: float, ann_id: str) -> dict | None:
    if not isinstance(stroke, dict):
        return None
    color = stroke.get("color")
    width = stroke.get("width")
    raw_points = stroke.get("points")
    kind = stroke.get("kind") or "pen"
    if (
        not isinstance(color, str)
        or not HEX_COLOR_RE.fullmatch(color)
        or not isinstance(width, (int, float))
        or not math.isfinite(width)
        or not (0 < width <= 0.08)
        or not isinstance(raw_points, list)
        or not raw_points
        or len(raw_points) > EDIT_LIMITS["pathPoints"]
    ):
        return None

    points: list[dict[str, float]] = []
    for pt in raw_points:
        if not isinstance(pt, list) or len(pt) != 2:
            return None
        x, y = pt
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not (math.isfinite(x) and math.isfinite(y)):
            return None
        points.append({"x": clamp_unit(x) * page_w, "y": clamp_unit(y) * page_h})

    transform = {"x": 0.0, "y": 0.0, "rotationRad": 0.0, "scaleX": 1.0, "scaleY": 1.0}
    style = {
        "color": color,
        "widthPt": float(width) * page_w,
        "opacity": 0.3 if kind == "highlighter" else 1.0,
        "highlighter": kind == "highlighter",
    }

    def dist(a: dict[str, float], b: dict[str, float]) -> float:
        return math.hypot(a["x"] - b["x"], a["y"] - b["y"])

    def same_pt(a: dict[str, float], b: dict[str, float]) -> bool:
        return dist(a, b) <= EPS

    geometry: dict
    if kind in ("pen", "highlighter"):
        geometry = {"kind": "path", "points": points}
    elif kind == "line" and len(points) == 2 and dist(points[0], points[1]) > 0:
        geometry = {"kind": "line", "start": points[0], "end": points[1]}
    elif kind == "arrow" and len(points) == 5 and same_pt(points[1], points[3]) and dist(points[0], points[1]) > 0:
        actual = dist(points[1], points[2])
        pref = float(stroke.get("arrowHeadLength") or max(0.025, actual / page_w)) * page_w
        geometry = {
            "kind": "arrow",
            "start": points[0],
            "end": points[1],
            "head": "end",
            "headLengthPt": actual,
            "preferredHeadLengthPt": max(pref, actual),
        }
    elif kind in ("rectangle", "text") and len(points) in (4, 5):
        a, b, c, d = points[0], points[1], points[2], points[3]
        ux, uy = b["x"] - a["x"], b["y"] - a["y"]
        vx, vy = d["x"] - a["x"], d["y"] - a["y"]
        bw, bh = math.hypot(ux, uy), math.hypot(vx, vy)
        if bw > 0 and bh > 0 and ux * vy - uy * vx > 0:
            transform = {"x": a["x"], "y": a["y"], "rotationRad": math.atan2(uy, ux), "scaleX": 1.0, "scaleY": 1.0}
            if kind == "rectangle":
                geometry = {"kind": "rect", "widthPt": bw, "heightPt": bh}
            else:
                text = str(stroke.get("text") or "").strip()[: EDIT_LIMITS["text"]]
                if not text:
                    return None
                lines = text.split("\n")
                size = bh / (len(lines) * 1.3)
                units = max(1.0, *(sum(0.6 if ord(ch) <= 0xFF else 1.0 for ch in line) for line in lines))
                gw = units * size
                geometry = {"kind": "text", "widthPt": gw, "heightPt": bh, "text": text, "fontSizePt": size, "fontFamily": "sans-serif"}
                transform["scaleX"] = bw / gw
        else:
            geometry = {"kind": "path", "points": points}
    elif kind == "ellipse" and len(points) == 65 and same_pt(points[0], points[64]):
        cx = (points[0]["x"] + points[32]["x"]) / 2.0
        cy = (points[0]["y"] + points[32]["y"]) / 2.0
        ux, uy = points[0]["x"] - cx, points[0]["y"] - cy
        vx, vy = points[16]["x"] - cx, points[16]["y"] - cy
        rx, ry = math.hypot(ux, uy), math.hypot(vx, vy)
        if rx > 0 and ry > 0 and ux * vy - uy * vx > 0:
            geometry = {"kind": "ellipse", "widthPt": rx * 2.0, "heightPt": ry * 2.0}
            transform = {"x": cx - ux - vx, "y": cy - uy - vy, "rotationRad": math.atan2(uy, ux), "scaleX": 1.0, "scaleY": 1.0}
        else:
            geometry = {"kind": "path", "points": points}
    else:
        # Preserve any unusual shape as a lossless polyline path rather than dropping user strokes.
        geometry = {"kind": "path", "points": points}

    return {"kind": "ink", "id": ann_id, "geometry": geometry, "transform": transform, "style": style}


def _convert_legacy_bookmark(bm: dict, page_w: float, page_h: float, bg_rev: str, ann_id: str) -> dict | None:
    kind = bm.get("kind") or "note"
    label = str(bm.get("label") or "")[:MAX_LABEL_LENGTH]
    created_at = _normalize_timestamp(bm.get("created_at"))
    color = _normalize_bookmark_color(bm.get("color"))
    ax = clamp_unit(bm.get("anchor_x") if isinstance(bm.get("anchor_x"), (int, float)) else 0.5) * page_w
    ay = clamp_unit(bm.get("anchor_y") if isinstance(bm.get("anchor_y"), (int, float)) else 0.5) * page_h
    text = str(bm.get("note") or "")[: EDIT_LIMITS["text"]]
    quote = str(bm.get("quote") or "")[: EDIT_LIMITS["text"]]
    metadata = {"label": label, "createdAt": created_at}

    if kind == "highlight":
        raw_rects = bm.get("rects")
        rects: list = []
        if isinstance(raw_rects, str) and raw_rects:
            try:
                parsed = json.loads(raw_rects)
                if isinstance(parsed, list):
                    rects = parsed
            except (ValueError, TypeError):
                rects = []
        elif isinstance(raw_rects, list):
            rects = raw_rects
        quads = []
        for rect in rects:
            if len(quads) >= MAX_HIGHLIGHT_QUADS:
                break
            rx = ry = rw = rh = None
            if isinstance(rect, (list, tuple)) and len(rect) == 4 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in rect):
                rx, ry, rw, rh = rect
            elif isinstance(rect, dict) and all(k in rect and isinstance(rect[k], (int, float)) and math.isfinite(rect[k]) for k in ("x", "y", "w", "h")):
                rx, ry, rw, rh = rect["x"], rect["y"], rect["w"], rect["h"]
            if rx is None or ry is None or rw is None or rh is None:
                continue
            x0 = clamp_unit(rx) * page_w
            y0 = clamp_unit(ry) * page_h
            x1 = clamp_unit(rx + rw) * page_w
            y1 = clamp_unit(ry + rh) * page_h
            if x1 > x0 and y1 > y0 and abs((x1 - x0) * (y1 - y0)) >= 1e-9:
                quads.append([{"x": x0, "y": y0}, {"x": x1, "y": y0}, {"x": x1, "y": y1}, {"x": x0, "y": y1}])
        if quads:
            return {
                "kind": "highlight",
                "id": ann_id,
                "backgroundRevision": bg_rev,
                "range": {"kind": "unindexed"},
                "quote": quote,
                "text": text,
                "anchor": {"x": ax, "y": ay},
                "quads": quads,
                "color": color or "#fde047",
                "metadata": metadata,
            }
    sticky: dict = {
        "kind": "sticky",
        "id": ann_id,
        "text": text or quote or label or "メモ",
        "anchor": {"x": ax, "y": ay},
        "color": color,
        "metadata": metadata,
    }
    if quote:
        sticky["quote"] = quote
    return sticky


def _pdf_pages_info(pdf_bytes: bytes) -> list[dict[str, float]] | None:
    try:
        with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
            if doc.needs_pass:
                return None
            return [{"widthPt": float(page.rect.width), "heightPt": float(page.rect.height)} for page in doc]
    except (pymupdf.FileDataError, RuntimeError, ValueError):
        return None


def _build_pdf_pages(
    *,
    library_id: str,
    paper_id: str,
    side: str,
    resource_id: str,
    resource_sha: str,
    page_dims: list[dict[str, float]],
    bg_rev: str,
    ink_by_page: dict[int, list[dict]],
    bm_by_page: dict[int, list[dict]],
    warnings: list[str],
) -> tuple[list[dict], int, int]:
    pages = []
    ink_converted = 0
    bm_converted = 0
    for idx, dims in enumerate(page_dims):
        page_num = idx + 1
        page_w, page_h = dims["widthPt"], dims["heightPt"]
        annotations: list[dict] = []
        seen_ann_ids: set[str] = set()
        total_points = 0
        for s_idx, stroke in enumerate(ink_by_page.get(page_num, [])):
            sid = stroke.get("id") if isinstance(stroke, dict) and isinstance(stroke.get("id"), str) else f"row:{s_idx}"
            ann_id = stable_id(library_id, "ink", [paper_id, side, str(page_num), sid])
            if ann_id in seen_ann_ids:
                ann_id = stable_id(library_id, "ink", [paper_id, side, str(page_num), sid, f"dup:{s_idx}"])
            conv = _convert_legacy_stroke(stroke, page_w, page_h, ann_id)
            if conv is None:
                warnings.append(f"skipped malformed stroke on paper={paper_id} side={side} page={page_num} idx={s_idx}")
                continue
            pts = len(conv["geometry"]["points"]) if conv["geometry"]["kind"] == "path" else 0
            if len(annotations) >= EDIT_LIMITS["objects"] or total_points + pts > EDIT_LIMITS["pagePoints"]:
                warnings.append(f"page annotation limit reached on paper={paper_id} side={side} page={page_num}")
                break
            total_points += pts
            seen_ann_ids.add(ann_id)
            annotations.append(conv)
            ink_converted += 1
        for b_idx, bm in enumerate(bm_by_page.get(page_num, [])):
            bid = str(bm.get("id") or f"bm:{b_idx}")
            ann_id = stable_id(library_id, "bookmark", [paper_id, side, str(page_num), bid])
            if ann_id in seen_ann_ids:
                ann_id = stable_id(library_id, "bookmark", [paper_id, side, str(page_num), bid, f"dup:{b_idx}"])
            conv = _convert_legacy_bookmark(bm, page_w, page_h, bg_rev, ann_id)
            if conv is None or len(annotations) >= EDIT_LIMITS["objects"]:
                continue
            seen_ann_ids.add(ann_id)
            annotations.append(conv)
            bm_converted += 1
        pages.append({
            "id": stable_id(library_id, f"pdf-{side}-page", [paper_id, str(page_num)]),
            "backgroundRevision": bg_rev,
            "lifecycleVersion": bg_rev,
            "annotationVersion": bg_rev,
            "widthPt": page_w,
            "heightPt": page_h,
            "background": {
                "kind": "pdf",
                "resourceId": resource_id,
                "sourceRevision": resource_sha,
                "pdfPage": page_num,
            },
            "annotations": annotations,
        })
    return pages, ink_converted, bm_converted


def _rewrite_markdown_media(
    markdown: str,
    paper_dir: Path,
    library_id: str,
    paper_id: str,
    repo: SqliteEditRepository,
    warnings: list[str],
) -> tuple[str, list[dict[str, str]]]:
    image_resources: dict[str, str] = {}

    def replace_match(match: re.Match[str]) -> str:
        prefix, name, suffix = match.group(1), match.group(2), match.group(3)
        if "/" in name or "\\" in name or ".." in name:
            return match.group(0)
        img_path = paper_dir / "media" / name
        if not img_path.is_file():
            warnings.append(f"missing markdown media {paper_id}/media/{name}")
            return match.group(0)
        raw = img_path.read_bytes()
        if not raw or len(raw) > MAX_RESOURCE_BYTES:
            warnings.append(f"empty or oversized markdown media {paper_id}/media/{name}")
            return match.group(0)
        lower = name.lower()
        media_type = (
            "image/png" if lower.endswith(".png")
            else "image/jpeg" if lower.endswith((".jpg", ".jpeg"))
            else "image/webp" if lower.endswith(".webp")
            else None
        )
        if media_type is None:
            return match.group(0)
        digest = sha256_hex(raw)
        res_id = stable_id(library_id, "resource", ["markdown-image", paper_id, name, digest])
        meta = {"id": res_id, "sha256": digest, "mediaType": media_type, "byteLength": len(raw)}
        repo.store_resource(res_id, digest, media_type, raw, meta)
        image_resources[res_id] = digest
        return f"{prefix}papeer://resource/{res_id}?sha256={digest}{suffix}"

    rewritten = MEDIA_IMG_RE.sub(replace_match, markdown)
    refs = [{"resourceId": rid, "sha256": sha} for rid, sha in sorted(image_resources.items())]
    return rewritten, refs


@dataclass
class MigrationSummary:
    target_db: str
    library_id: str
    account_id: str
    epoch: str
    folders_created: int = 0
    pdfs_migrated: int = 0
    translations_attached: int = 0
    notebooks_migrated: int = 0
    markdown_migrated: int = 0
    attachments_migrated: int = 0
    links_migrated: int = 0
    ink_strokes_migrated: int = 0
    bookmarks_migrated: int = 0
    skipped_already_present: int = 0
    warnings: list[str] = field(default_factory=list)


def migrate_legacy_library(
    source_dir: Path,
    target_data_dir: Path,
    *,
    title: str | None = None,
    library_id: str | None = None,
    translations: str = "ink-only",
) -> MigrationSummary:
    if translations not in ("ink-only", "all", "none"):
        raise ValueError(f"unsupported translations mode: {translations}")

    db_path, scope = _open_or_create_target_scope(target_data_dir, title=title, library_id=library_id)
    target_lib_id = scope["libraryId"]
    is_remote_target = any(
        t["libraryId"] == target_lib_id and t["storage"] == "google-drive"
        for t in list_target_libraries(target_data_dir)
    )
    authority = _DirectSqliteAuthority(db_path, scope["accountId"])
    repo = SqliteEditRepository(authority, scope)
    summary = MigrationSummary(
        target_db=str(db_path),
        library_id=target_lib_id,
        account_id=scope["accountId"],
        epoch=scope["epoch"],
    )

    view = repo.read(target_lib_id)
    if len(view["heads"]) != 1:
        raise RuntimeError(f"target library has {len(view['heads'])} heads (resolve conflicts before migrating)")
    head = view["heads"][0]
    lib_snap = EditGraph(view["checkpoint"]).states[head]
    existing_folder_ids = {f["id"] for f in lib_snap["folders"]}
    existing_item_ids = {it["id"] for it in lib_snap["items"]}
    existing_links = {(lk["pdfId"], lk["noteId"]) for lk in lib_snap["links"]}
    records_to_apply: list[dict] = []

    def queue_batch(batch: dict, publication: dict | None = None) -> None:
        nonlocal head
        record: dict = {"batch": batch}
        if publication is not None:
            record["publication"] = publication
        records_to_apply.append(record)
        head = batch["id"]

    with tempfile.TemporaryDirectory(prefix="papeer-m4-migrate-") as tmp:
        legacy_db = _copy_sqlite_snapshot(source_dir, Path(tmp))
        with _open_temp_sqlite_readonly(legacy_db) as con:
            tables = _table_names(con)
            papers = [
                dict(r)
                for r in con.execute(
                    "SELECT * FROM papers ORDER BY CASE WHEN parent_id IS NULL OR parent_id = '' THEN 0 ELSE 1 END, created_at, id"
                ).fetchall()
            ]
            collections = (
                [r[0] for r in con.execute("SELECT name FROM collections ORDER BY name").fetchall()]
                if "collections" in tables else []
            )
            links = (
                [dict(r) for r in con.execute("SELECT a, b FROM item_links").fetchall()]
                if "item_links" in tables else []
            )
            attachments = (
                [dict(r) for r in con.execute("SELECT * FROM attachments ORDER BY owner_id, position, created_at, id").fetchall()]
                if "attachments" in tables else []
            )
            ink_map: dict[tuple[str, str], dict[int, list[dict]]] = {}
            if "pdf_ink" in tables:
                for row in con.execute("SELECT paper_id, side, page, strokes FROM pdf_ink").fetchall():
                    try:
                        parsed = json.loads(row["strokes"])
                    except (ValueError, TypeError):
                        continue
                    if isinstance(parsed, list):
                        ink_map.setdefault((row["paper_id"], row["side"]), {})[int(row["page"])] = parsed
            bm_map: dict[tuple[str, str], dict[int, list[dict]]] = {}
            if "bookmarks" in tables:
                for row in con.execute("SELECT * FROM bookmarks ORDER BY created_at, id").fetchall():
                    d = dict(row)
                    bm_map.setdefault((d["paper_id"], d.get("side") or "original"), {}).setdefault(int(d["page"]), []).append(d)
            note_state_map: dict[str, str] = {}
            if "note_state" in tables and {"paper_id", "content"}.issubset(_table_columns(con, "note_state")):
                for row in con.execute("SELECT paper_id, content FROM note_state").fetchall():
                    if isinstance(row["content"], str):
                        note_state_map[row["paper_id"]] = row["content"]

    # 1. Folders from collections + papers.collection_name (nested "/" paths supported)
    folder_paths: set[str] = set()
    for name in collections:
        if isinstance(name, str) and name.strip():
            parts = [seg.strip() for seg in name.strip("/").split("/") if seg.strip()]
            for i in range(len(parts)):
                folder_paths.add("/".join(parts[: i + 1]))
    for p in papers:
        cname = p.get("collection_name")
        if isinstance(cname, str) and cname.strip():
            parts = [seg.strip() for seg in cname.strip("/").split("/") if seg.strip()]
            for i in range(len(parts)):
                folder_paths.add("/".join(parts[: i + 1]))

    folder_id_by_path: dict[str, str] = {
        path: stable_id(target_lib_id, "folder", [path]) for path in sorted(folder_paths)
    }
    folder_changes = []
    for pos, path in enumerate(sorted(folder_paths)):
        fid = folder_id_by_path[path]
        if fid in existing_folder_ids:
            continue
        parts = path.split("/")
        parent_id = folder_id_by_path["/".join(parts[:-1])] if len(parts) > 1 else None
        folder_changes.append({
            "type": "put-folder",
            "folder": {
                "id": fid,
                "title": clamp_title(parts[-1], "フォルダー"),
                "parentId": parent_id,
                "position": pos,
            },
        })
    if folder_changes:
        batch = {
            "kind": "library",
            "id": stable_id(target_lib_id, "migrate-folders-batch", sorted(folder_paths)),
            "libraryId": target_lib_id,
            "targetId": target_lib_id,
            "parents": [head],
            "changes": folder_changes,
        }
        queue_batch(batch)
        summary.folders_created = len(folder_changes)

    # 2. Papers (PDFs, Notebooks, standalone Markdown)
    canonical_id_by_legacy: dict[str, str] = {}
    canonical_kind_by_legacy: dict[str, str] = {}
    is_owned_by_legacy: dict[str, bool] = {}
    papers_root = source_dir / "papers"

    for pos, paper in enumerate(papers):
        pid = paper["id"]
        kind = paper.get("kind") or "pdf"
        raw_cname = paper.get("collection_name")
        norm_cname = "/".join(seg.strip() for seg in raw_cname.strip("/").split("/") if seg.strip()) if isinstance(raw_cname, str) and raw_cname.strip() else ""
        folder_id = folder_id_by_path.get(norm_cname)
        tags = _parse_tags(paper.get("tags"))
        is_read = paper.get("read_status") in ("read", "読了")
        metadata: dict[str, str] = {"legacyId": pid}
        for col, key in (
            ("first_author", "firstAuthor"),
            ("publication_year", "publicationYear"),
            ("doi", "doi"),
            ("arxiv_id", "arxivId"),
            ("venue", "venue"),
            ("created_at", "createdAt"),
        ):
            val = paper.get(col)
            if val is not None and str(val).strip():
                metadata[key] = str(val).strip()[:500]
        paper_dir = papers_root / pid

        if kind == "pdf":
            item_id = stable_id(target_lib_id, "pdf-document", [pid])
            if item_id in existing_item_ids:
                canonical_id_by_legacy[pid] = item_id
                canonical_kind_by_legacy[pid] = "pdf"
                is_owned_by_legacy[pid] = False
                summary.skipped_already_present += 1
                continue
            orig_path = paper_dir / "original.pdf"
            if not orig_path.is_file():
                summary.warnings.append(f"missing original.pdf for paper={pid}; skipped")
                continue
            pdf_bytes = orig_path.read_bytes()
            if len(pdf_bytes) > MAX_RESOURCE_BYTES:
                summary.warnings.append(f"original.pdf > 128 MiB for paper={pid}; skipped")
                continue
            orig_sha = sha256_hex(pdf_bytes)
            orig_dims = _pdf_pages_info(pdf_bytes)
            if orig_dims is None:
                summary.warnings.append(f"corrupt or password-protected original.pdf for paper={pid}; skipped")
                continue
            if not orig_dims or len(orig_dims) > EDIT_LIMITS["pages"]:
                summary.warnings.append(f"pdf page count {len(orig_dims)} unsupported for paper={pid}; skipped")
                continue
            orig_res_id = stable_id(target_lib_id, "resource", ["pdf-original", pid, orig_sha])
            orig_meta = {
                "id": orig_res_id,
                "sha256": orig_sha,
                "mediaType": "application/pdf",
                "byteLength": len(pdf_bytes),
                "pdfPages": orig_dims,
            }
            repo.store_resource(orig_res_id, orig_sha, "application/pdf", pdf_bytes, orig_meta)
            doc_rev = stable_id(target_lib_id, "pdf-revision", [pid, orig_sha])
            orig_pages, ink_n, bm_n = _build_pdf_pages(
                library_id=target_lib_id,
                paper_id=pid,
                side="original",
                resource_id=orig_res_id,
                resource_sha=orig_sha,
                page_dims=orig_dims,
                bg_rev=doc_rev,
                ink_by_page=ink_map.get((pid, "original"), {}),
                bm_by_page=bm_map.get((pid, "original"), {}),
                warnings=summary.warnings,
            )
            summary.ink_strokes_migrated += ink_n
            summary.bookmarks_migrated += bm_n

            doc_snapshot: dict = {
                "kind": "document",
                "id": item_id,
                "version": doc_rev,
                "pages": orig_pages,
                "deletedPages": [],
            }
            trans_path = paper_dir / "translated.pdf"
            has_trans_ann = bool(ink_map.get((pid, "translated")) or bm_map.get((pid, "translated")))
            want_trans = trans_path.is_file() and (
                translations == "all" or (translations == "ink-only" and has_trans_ann)
            )
            if want_trans:
                t_bytes = trans_path.read_bytes()
                if len(t_bytes) <= MAX_RESOURCE_BYTES:
                    t_sha = sha256_hex(t_bytes)
                    t_dims = _pdf_pages_info(t_bytes)
                    if t_dims and len(t_dims) <= EDIT_LIMITS["pages"]:
                        t_res_id = stable_id(target_lib_id, "resource", ["pdf-translated", pid, t_sha])
                        t_meta = {
                            "id": t_res_id,
                            "sha256": t_sha,
                            "mediaType": "application/pdf",
                            "byteLength": len(t_bytes),
                            "pdfPages": t_dims,
                        }
                        repo.store_resource(t_res_id, t_sha, "application/pdf", t_bytes, t_meta)
                        t_rev = stable_id(target_lib_id, "pdf-translated-revision", [pid, t_sha])
                        t_pages, t_ink, t_bm = _build_pdf_pages(
                            library_id=target_lib_id,
                            paper_id=pid,
                            side="translated",
                            resource_id=t_res_id,
                            resource_sha=t_sha,
                            page_dims=t_dims,
                            bg_rev=t_rev,
                            ink_by_page=ink_map.get((pid, "translated"), {}),
                            bm_by_page=bm_map.get((pid, "translated"), {}),
                            warnings=summary.warnings,
                        )
                        summary.ink_strokes_migrated += t_ink
                        summary.bookmarks_migrated += t_bm
                        bindings = []
                        for idx, opage in enumerate(orig_pages):
                            cand_idx = min(idx, len(t_pages) - 1)
                            tpage = t_pages[cand_idx]
                            bindings.append({
                                "original": {"pageId": opage["id"], "backgroundRevision": opage["backgroundRevision"]},
                                "candidates": [{"pageId": tpage["id"], "backgroundRevision": tpage["backgroundRevision"]}],
                            })
                        doc_snapshot["translation"] = {"revision": t_rev, "pages": t_pages, "bindings": bindings}
                        summary.translations_attached += 1
                else:
                    summary.warnings.append(f"translated.pdf > 128 MiB for paper={pid}; omitted translation")

            item = {
                "id": item_id,
                "kind": "pdf",
                "title": clamp_title(paper.get("title") or paper.get("original_name") or pid, "PDF"),
                "ownerId": None,
                "folderId": folder_id,
                "position": pos,
                "tags": tags,
                "read": is_read,
                "resourceId": orig_res_id,
                "metadata": metadata,
            }
            pub = {
                "libraryBatch": {
                    "kind": "library",
                    "id": stable_id(target_lib_id, "publish-pdf", [pid]),
                    "libraryId": target_lib_id,
                    "targetId": target_lib_id,
                    "parents": [head],
                    "changes": [{"type": "put-item", "item": item}],
                },
                "content": doc_snapshot,
            }
            queue_batch(pub["libraryBatch"], pub)
            existing_item_ids.add(item_id)
            canonical_id_by_legacy[pid] = item_id
            canonical_kind_by_legacy[pid] = "pdf"
            is_owned_by_legacy[pid] = False
            summary.pdfs_migrated += 1

        elif kind == "notebook":
            item_id = stable_id(target_lib_id, "notebook-document", [pid])
            parent_legacy = paper.get("parent_id")
            owner_id = canonical_id_by_legacy.get(parent_legacy) if parent_legacy else None
            if item_id in existing_item_ids:
                canonical_id_by_legacy[pid] = item_id
                canonical_kind_by_legacy[pid] = "notebook"
                is_owned_by_legacy[pid] = owner_id is not None
                summary.skipped_already_present += 1
                continue
            nb_path = paper_dir / "notebook.json"
            if not nb_path.is_file():
                summary.warnings.append(f"missing notebook.json for notebook={pid}; skipped")
                continue
            nb_raw = nb_path.read_bytes()
            nb_data = json.loads(nb_raw.decode("utf-8"))
            nb_pages = nb_data.get("pages") or []
            if not nb_pages or len(nb_pages) > EDIT_LIMITS["pages"]:
                summary.warnings.append(f"notebook page count {len(nb_pages)} unsupported for notebook={pid}; skipped")
                continue
            nb_rev = stable_id(target_lib_id, "notebook-revision", [pid, sha256_hex(nb_raw)])
            pages_out = []
            nb_ink = ink_map.get((pid, "original"), {})
            nb_bm = bm_map.get((pid, "original"), {})
            for idx, pg in enumerate(nb_pages):
                page_num = idx + 1
                size_name = pg.get("size", "A4")
                orient = pg.get("orientation", "portrait")
                w_mm = float(pg.get("width_mm") or NOTEBOOK_SIZES.get(size_name, (210.0, 297.0))[0 if orient == "portrait" else 1])
                h_mm = float(pg.get("height_mm") or NOTEBOOK_SIZES.get(size_name, (210.0, 297.0))[1 if orient == "portrait" else 0])
                page_w = w_mm * 72.0 / 25.4
                page_h = h_mm * 72.0 / 25.4
                template = pg.get("template") if pg.get("template") in VALID_TEMPLATES else "blank"
                color = pg.get("color") if pg.get("color") in VALID_COLORS else "white"
                annotations = []
                seen_ann_ids: set[str] = set()
                total_points = 0
                for s_idx, stroke in enumerate(nb_ink.get(page_num, [])):
                    sid = stroke.get("id") if isinstance(stroke, dict) and isinstance(stroke.get("id"), str) else f"row:{s_idx}"
                    ann_id = stable_id(target_lib_id, "ink", [pid, "original", str(page_num), sid])
                    if ann_id in seen_ann_ids:
                        ann_id = stable_id(target_lib_id, "ink", [pid, "original", str(page_num), sid, f"dup:{s_idx}"])
                    conv = _convert_legacy_stroke(stroke, page_w, page_h, ann_id)
                    if conv is None:
                        continue
                    pts = len(conv["geometry"]["points"]) if conv["geometry"]["kind"] == "path" else 0
                    if len(annotations) >= EDIT_LIMITS["objects"] or total_points + pts > EDIT_LIMITS["pagePoints"]:
                        summary.warnings.append(f"notebook annotation limit reached on notebook={pid} page={page_num}")
                        break
                    total_points += pts
                    seen_ann_ids.add(ann_id)
                    annotations.append(conv)
                    summary.ink_strokes_migrated += 1
                for b_idx, bm in enumerate(nb_bm.get(page_num, [])):
                    bid = str(bm.get("id") or f"bm:{b_idx}")
                    ann_id = stable_id(target_lib_id, "bookmark", [pid, "original", str(page_num), bid])
                    if ann_id in seen_ann_ids:
                        ann_id = stable_id(target_lib_id, "bookmark", [pid, "original", str(page_num), bid, f"dup:{b_idx}"])
                    conv = _convert_legacy_bookmark(bm, page_w, page_h, nb_rev, ann_id)
                    if conv is not None and len(annotations) < EDIT_LIMITS["objects"]:
                        seen_ann_ids.add(ann_id)
                        annotations.append(conv)
                        summary.bookmarks_migrated += 1
                pg_id_src = str(pg.get("id") or page_num)
                pages_out.append({
                    "id": stable_id(target_lib_id, "notebook-page", [pid, pg_id_src]),
                    "backgroundRevision": nb_rev,
                    "lifecycleVersion": nb_rev,
                    "annotationVersion": nb_rev,
                    "widthPt": page_w,
                    "heightPt": page_h,
                    "background": {"kind": "paper", "spec": {"template": template, "color": color}},
                    "annotations": annotations,
                })
            nb_snapshot = {
                "kind": "document",
                "id": item_id,
                "version": nb_rev,
                "pages": pages_out,
                "deletedPages": [],
            }
            item = {
                "id": item_id,
                "kind": "notebook",
                "title": clamp_title(paper.get("title") or "ノート", "ノート"),
                "ownerId": owner_id,
                "folderId": None if owner_id else folder_id,
                "position": pos,
                "tags": tags,
                "read": is_read,
                "metadata": metadata,
            }
            pub = {
                "libraryBatch": {
                    "kind": "library",
                    "id": stable_id(target_lib_id, "publish-notebook", [pid]),
                    "libraryId": target_lib_id,
                    "targetId": target_lib_id,
                    "parents": [head],
                    "changes": [{"type": "put-item", "item": item}],
                },
                "content": nb_snapshot,
            }
            queue_batch(pub["libraryBatch"], pub)
            existing_item_ids.add(item_id)
            canonical_id_by_legacy[pid] = item_id
            canonical_kind_by_legacy[pid] = "notebook"
            is_owned_by_legacy[pid] = owner_id is not None
            summary.notebooks_migrated += 1

        elif kind == "markdown":
            item_id = stable_id(target_lib_id, "markdown-note", [pid])
            parent_legacy = paper.get("parent_id")
            owner_id = canonical_id_by_legacy.get(parent_legacy) if parent_legacy else None
            if item_id in existing_item_ids:
                canonical_id_by_legacy[pid] = item_id
                canonical_kind_by_legacy[pid] = "markdown"
                is_owned_by_legacy[pid] = owner_id is not None
                summary.skipped_already_present += 1
                continue
            raw_md = _read_legacy_note_text(source_dir, pid, paper, note_state_map)
            rewritten, img_refs = _rewrite_markdown_media(raw_md, paper_dir, target_lib_id, pid, repo, summary.warnings)
            md_rev = stable_id(target_lib_id, "markdown-revision", [pid, sha256_hex(rewritten.encode("utf-8"))])
            md_snapshot = {
                "kind": "markdown",
                "id": item_id,
                "version": md_rev,
                "content": rewritten,
                "appendIds": [],
                "imageResources": img_refs,
            }
            parent_legacy = paper.get("parent_id")
            owner_id = canonical_id_by_legacy.get(parent_legacy) if parent_legacy else None
            item = {
                "id": item_id,
                "kind": "markdown",
                "title": clamp_title(paper.get("title") or "メモ", "メモ"),
                "ownerId": owner_id,
                "folderId": None if owner_id else folder_id,
                "position": pos,
                "tags": tags,
                "read": is_read,
                "metadata": metadata,
            }
            pub = {
                "libraryBatch": {
                    "kind": "library",
                    "id": stable_id(target_lib_id, "publish-markdown", [pid]),
                    "libraryId": target_lib_id,
                    "targetId": target_lib_id,
                    "parents": [head],
                    "changes": [{"type": "put-item", "item": item}],
                },
                "content": md_snapshot,
            }
            queue_batch(pub["libraryBatch"], pub)
            existing_item_ids.add(item_id)
            canonical_id_by_legacy[pid] = item_id
            canonical_kind_by_legacy[pid] = "markdown"
            is_owned_by_legacy[pid] = owner_id is not None
            summary.markdown_migrated += 1

        # Inline note on PDF/notebook (v8 papers.note or note.md or v9 note_state)
        if kind in ("pdf", "notebook"):
            inline_md = _read_legacy_note_text(source_dir, pid, paper, note_state_map)
            owner_id = canonical_id_by_legacy.get(pid)
            if inline_md.strip() and owner_id:
                note_item_id = stable_id(target_lib_id, "inline-note", [pid])
                if note_item_id in existing_item_ids:
                    summary.skipped_already_present += 1
                else:
                    rewritten, img_refs = _rewrite_markdown_media(inline_md, paper_dir, target_lib_id, pid, repo, summary.warnings)
                    md_rev = stable_id(target_lib_id, "inline-note-revision", [pid, sha256_hex(rewritten.encode("utf-8"))])
                    pub = {
                        "libraryBatch": {
                            "kind": "library",
                            "id": stable_id(target_lib_id, "publish-inline-note", [pid]),
                            "libraryId": target_lib_id,
                            "targetId": target_lib_id,
                            "parents": [head],
                            "changes": [{
                                "type": "put-item",
                                "item": {
                                    "id": note_item_id,
                                    "kind": "markdown",
                                    "title": "ノート",
                                    "ownerId": owner_id,
                                    "folderId": None,
                                    "position": 0,
                                    "tags": [],
                                    "read": False,
                                    "metadata": {"legacyNoteOwner": pid},
                                },
                            }],
                        },
                        "content": {
                            "kind": "markdown",
                            "id": note_item_id,
                            "version": md_rev,
                            "content": rewritten,
                            "appendIds": [],
                            "imageResources": img_refs,
                        },
                    }
                    queue_batch(pub["libraryBatch"], pub)
                    existing_item_ids.add(note_item_id)
                    summary.markdown_migrated += 1

    # 3. Attachments (md -> editable canonical Markdown child; html -> canonical attachment resource)
    for idx, att in enumerate(attachments):
        att_id = att["id"]
        owner_legacy = att["owner_id"]
        fmt = (att.get("format") or "").lower()
        owner_id = canonical_id_by_legacy.get(owner_legacy)
        if not owner_id:
            summary.warnings.append(f"attachment {att_id} has unknown owner {owner_legacy}; skipped")
            continue
        att_file = papers_root / owner_legacy / "attachments" / f"{att_id}.{fmt}"
        if not att_file.is_file():
            summary.warnings.append(f"missing attachment file {att_file.name}; skipped")
            continue
        att_title = clamp_title(att.get("title") or att_file.stem, "添付資料")
        att_pos = int(att["position"]) if isinstance(att.get("position"), int) and att["position"] >= 0 else idx + 1

        if fmt == "md":
            item_id = stable_id(target_lib_id, "attachment-markdown", [owner_legacy, att_id])
            if item_id in existing_item_ids:
                summary.skipped_already_present += 1
                continue
            raw_md = att_file.read_text(encoding="utf-8", errors="replace")
            rewritten, img_refs = _rewrite_markdown_media(raw_md, papers_root / owner_legacy, target_lib_id, owner_legacy, repo, summary.warnings)
            md_rev = stable_id(target_lib_id, "attachment-markdown-rev", [att_id, sha256_hex(rewritten.encode("utf-8"))])
            pub = {
                "libraryBatch": {
                    "kind": "library",
                    "id": stable_id(target_lib_id, "publish-att-md", [owner_legacy, att_id]),
                    "libraryId": target_lib_id,
                    "targetId": target_lib_id,
                    "parents": [head],
                    "changes": [{
                        "type": "put-item",
                        "item": {
                            "id": item_id,
                            "kind": "markdown",
                            "title": att_title,
                            "ownerId": owner_id,
                            "folderId": None,
                            "position": att_pos,
                            "tags": [],
                            "read": False,
                            "metadata": {"legacyAttachmentId": att_id, "legacySource": str(att.get("source") or "")},
                        },
                    }],
                },
                "content": {
                    "kind": "markdown",
                    "id": item_id,
                    "version": md_rev,
                    "content": rewritten,
                    "appendIds": [],
                    "imageResources": img_refs,
                },
            }
            queue_batch(pub["libraryBatch"], pub)
            existing_item_ids.add(item_id)
            summary.markdown_migrated += 1

        elif fmt == "html":
            item_id = stable_id(target_lib_id, "attachment-html", [owner_legacy, att_id])
            if item_id in existing_item_ids:
                summary.skipped_already_present += 1
                continue
            raw_html = att_file.read_bytes()
            if not raw_html or len(raw_html) > MAX_RESOURCE_BYTES:
                summary.warnings.append(f"empty or oversized html attachment {att_id}; skipped")
                continue
            digest = sha256_hex(raw_html)
            res_id = stable_id(target_lib_id, "resource", ["attachment-html", owner_legacy, att_id, digest])
            meta = {"id": res_id, "sha256": digest, "mediaType": "text/html", "byteLength": len(raw_html)}
            repo.store_resource(res_id, digest, "text/html", raw_html, meta)
            pub = {
                "libraryBatch": {
                    "kind": "library",
                    "id": stable_id(target_lib_id, "publish-att-html", [owner_legacy, att_id]),
                    "libraryId": target_lib_id,
                    "targetId": target_lib_id,
                    "parents": [head],
                    "changes": [{
                        "type": "put-item",
                        "item": {
                            "id": item_id,
                            "kind": "attachment",
                            "title": att_title,
                            "ownerId": owner_id,
                            "folderId": None,
                            "position": att_pos,
                            "tags": [],
                            "read": False,
                            "resourceId": res_id,
                            "metadata": {"legacyAttachmentId": att_id, "legacySource": str(att.get("source") or "")},
                        },
                    }],
                },
            }
            queue_batch(pub["libraryBatch"], pub)
            existing_item_ids.add(item_id)
            summary.attachments_migrated += 1
        else:
            summary.warnings.append(f"unsupported attachment format '{fmt}' for {att_id}; skipped")

    # 4. Item links (pdfId <-> noteId, both un-owned)
    link_changes = []
    for lk in links:
        a, b = lk["a"], lk["b"]
        ka, kb = canonical_kind_by_legacy.get(a), canonical_kind_by_legacy.get(b)
        ca, cb = canonical_id_by_legacy.get(a), canonical_id_by_legacy.get(b)
        if not ca or not cb:
            continue
        if is_owned_by_legacy.get(a) or is_owned_by_legacy.get(b):
            summary.warnings.append(f"skipped item_link involving owned item ({a}, {b})")
            continue
        if ka == "pdf" and kb in ("notebook", "markdown"):
            pair = (ca, cb)
        elif kb == "pdf" and ka in ("notebook", "markdown"):
            pair = (cb, ca)
        else:
            summary.warnings.append(f"skipped non-(pdf, note) item_link ({a}, {b})")
            continue
        if pair not in existing_links:
            existing_links.add(pair)
            link_changes.append({"type": "add-link", "link": {"pdfId": pair[0], "noteId": pair[1]}})
    if link_changes:
        batch = {
            "kind": "library",
            "id": stable_id(target_lib_id, "migrate-links-batch", [f"{c['link']['pdfId']}:{c['link']['noteId']}" for c in link_changes]),
            "libraryId": target_lib_id,
            "targetId": target_lib_id,
            "parents": [head],
            "changes": link_changes,
        }
        queue_batch(batch)
        summary.links_migrated = len(link_changes)

    # 5. Apply all queued canonical batches in ONE O(N) transaction
    if records_to_apply:
        pre_existing_batch_ids: set[str] = set()
        if is_remote_target:
            with authority.transaction("read-existing-batches", scope) as db:
                pre_existing_batch_ids = {
                    row[0] for row in db.execute("SELECT id FROM edit_batches WHERE scope=?", (repo.namespace,)).fetchall()
                }
        repo.receive_records(records_to_apply)
        if is_remote_target:
            new_ids = [r["batch"]["id"] for r in records_to_apply if r["batch"]["id"] not in pre_existing_batch_ids]
            if new_ids:
                with authority.transaction("mark-pending-upload", scope) as db:
                    for bid in new_ids:
                        row = db.execute(
                            "SELECT receipt FROM edit_batches WHERE scope=? AND id=?", (repo.namespace, bid)
                        ).fetchone()
                        if row:
                            receipt = json.loads(row[0])
                            receipt["upload"] = "pending"
                            db.execute(
                                "UPDATE edit_batches SET receipt=? WHERE scope=? AND id=?",
                                (canonical_json(receipt), repo.namespace, bid),
                            )

    # 6. Final integrity verification through canonical read
    verified = repo.read(target_lib_id)
    if verified["rejected"]:
        raise RuntimeError(f"post-migration verification found rejected batches: {verified['rejected']}")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="One-off M4 legacy Papeer data migration tool.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_inspect = sub.add_parser("inspect", help="Read-only summary of legacy PC library folder")
    p_inspect.add_argument("--source", type=Path, default=None, help="Legacy data dir (defaults to selected_data_directory)")

    p_backup = sub.add_parser("backup", help="Full verified backup of legacy data dir and PapeerSync device dir")
    p_backup.add_argument("--source", type=Path, default=None, help="Legacy data dir")
    p_backup.add_argument("--backup-dir", type=Path, required=True, help="Destination empty/new backup folder")
    p_backup.add_argument("--no-device-dir", action="store_true", help="Skip backing up PapeerSync device dir")

    p_targets = sub.add_parser("targets", help="List existing canonical libraries in target data dir")
    p_targets.add_argument("--target-data-dir", type=Path, default=None, help="Target app data dir (defaults to selected_data_directory)")

    p_migrate = sub.add_parser("migrate", help="Convert legacy PC data into a canonical local or Google Drive library")
    p_migrate.add_argument("--source", type=Path, default=None, help="Legacy data dir (read-only)")
    p_migrate.add_argument("--target-data-dir", type=Path, required=True, help="Target app data dir (canonical SQLite lives in sibling .<name>-shared-app)")
    group = p_migrate.add_mutually_exclusive_group(required=True)
    group.add_argument("--title", type=str, help="Create a new canonical local library with this title")
    group.add_argument("--library-id", type=str, help="Import into an existing canonical local or Google Drive library UUID")
    p_migrate.add_argument(
        "--translations",
        choices=("ink-only", "all", "none"),
        default="ink-only",
        help="Include translated.pdf pages: ink-only (default), all, or none",
    )

    args = parser.parse_args(argv)
    if args.command == "inspect":
        src = args.source or selected_data_directory()
        print(json.dumps(inspect_legacy_source(src), ensure_ascii=False, indent=2))
        return 0
    if args.command == "backup":
        src = args.source or selected_data_directory()
        print(json.dumps(backup_legacy_folders(src, args.backup_dir, not args.no_device_dir), ensure_ascii=False, indent=2))
        return 0
    if args.command == "targets":
        dst = args.target_data_dir or selected_data_directory()
        print(json.dumps(list_target_libraries(dst), ensure_ascii=False, indent=2))
        return 0
    if args.command == "migrate":
        src = args.source or selected_data_directory()
        res = migrate_legacy_library(
            src,
            args.target_data_dir,
            title=args.title,
            library_id=args.library_id,
            translations=args.translations,
        )
        print(json.dumps(res.__dict__, ensure_ascii=False, indent=2))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
