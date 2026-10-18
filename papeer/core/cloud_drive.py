"""Private Drive publication with a commit-last manifest and additive browser-ink import."""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import mimetypes
from pathlib import Path
import shutil
import sqlite3
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
import uuid

from papeer.core import cloud_drive_auth, drive_sync, cloud_annotations
from papeer.core.backup import DATABASE_FILES
from papeer.core.fileio import atomic_write_bytes, atomic_write_text, ensure_free_space, is_temporary
from papeer.core.paths import device_directory, library_key, PaperFiles
from papeer.core.storage import Library
from papeer.pdf.pdf_ink import annotated_pdf
from papeer.providers import check_cancel

API = "https://www.googleapis.com/drive/v3/files"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"


def _state_path(root: Path) -> Path:
    return device_directory() / (library_key(root) + ".cloud-drive.json")


def state(root: Path) -> dict:
    path = _state_path(root)
    return json.loads(path.read_text("utf-8")) if path.is_file() else {}


def save_state(root: Path, value: dict):
    path = _state_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(value, ensure_ascii=False))


def status(root: Path) -> dict:
    saved = state(root)
    return cloud_drive_auth.status() | {key: saved.get(key) for key in
                                       ("auto_upload", "last_upload", "error", "folder_id")}


class Drive:
    def request(self, url: str, *, method: str = "GET", data: bytes | None = None, headers: dict | None = None):
        request = Request(url, method=method, data=data,
                          headers={"Authorization": "Bearer " + cloud_drive_auth.access_token(), **(headers or {})})
        try:
            return urlopen(request, timeout=60)
        except (HTTPError, URLError, TimeoutError) as exc:
            code = exc.code if isinstance(exc, HTTPError) else "通信"
            raise ValueError(f"Google Driveへの転送に失敗しました（{code}）。接続・空き容量を確認して再試行してください。") from exc

    def json(self, url: str, *, method: str = "GET", value: dict | None = None) -> dict:
        with self.request(url, method=method, data=json.dumps(value).encode() if value is not None else None,
                          headers={"Content-Type": "application/json"}) as response:
            return json.load(response)

    def list(self, query: str) -> list[dict]:
        files, token = [], None
        while True:
            params = {"q": query + " and trashed = false", "fields": "nextPageToken,files(id,name,size,sha256Checksum)", "pageSize": "1000"}
            if token:
                params["pageToken"] = token
            result = self.json(API + "?" + urlencode(params))
            files.extend(result.get("files", []))
            token = result.get("nextPageToken")
            if not token:
                return files

    def upload(self, path: Path, metadata: dict, cancel, file_id: str | None = None) -> str:
        """Bounded-memory resumable upload. An interrupted attempt is retried on the next publish."""
        size = path.stat().st_size
        url = UPLOAD + ("/" + file_id if file_id else "") + "?uploadType=resumable&fields=id"
        with self.request(url, method="PATCH" if file_id else "POST", data=json.dumps(metadata).encode(),
                          headers={"Content-Type": "application/json", "X-Upload-Content-Length": str(size),
                                   "X-Upload-Content-Type": "application/octet-stream"}) as response:
            location = response.headers["Location"]
        # Never send the bearer token to a host supplied by an unexpected redirect/session response.
        parsed = urlparse(location)
        if parsed.scheme != "https" or parsed.hostname != "www.googleapis.com":
            raise ValueError("Google Driveのアップロード先が不正です。")
        with path.open("rb") as stream:
            offset = 0
            while True:
                check_cancel(cancel)
                chunk = stream.read(8 * 1024 * 1024)
                end = offset + len(chunk)
                headers = {"Content-Length": str(len(chunk)), "Content-Type": "application/octet-stream",
                           "Content-Range": f"bytes {offset}-{end - 1}/{size}" if size else "bytes */0"}
                # urllib regards 308 as HTTPError; it is the normal intermediate upload response.
                try:
                    request = Request(location, data=chunk, method="PUT", headers={
                        "Authorization": "Bearer " + cloud_drive_auth.access_token(), **headers})
                    with urlopen(request, timeout=60) as response:
                        return json.load(response)["id"]
                except HTTPError as exc:
                    if exc.code != 308:
                        raise ValueError(f"Google Driveへの転送に失敗しました（{exc.code}）。再試行してください。") from exc
                    acknowledged = exc.headers.get("Range", "")
                    if acknowledged != f"bytes=0-{end - 1}" or end >= size:
                        raise ValueError("Google Driveがファイル全体を受信できませんでした。再試行してください。") from exc
                except (URLError, TimeoutError) as exc:
                    raise ValueError("Google Driveへの通信が中断しました。再試行してください。") from exc
                offset = end


def snapshot(lib: Library, target: Path, cancel) -> dict:
    """Caller holds the sidecar snapshot guard. Retain all library data and a browser-readable DB view."""
    files = []
    for path in lib.root.rglob("*"):
        check_cancel(cancel)
        if path.is_symlink() or path.is_junction():
            raise ValueError("ライブラリにリンクがあります。実体のファイルを保存してからアップロードしてください。")
        if path.is_file() and path.name not in DATABASE_FILES and not is_temporary(path):
            files.append(path)
    ensure_free_space({target: sum(p.stat().st_size for p in files) * 2 +
                       (lib.root / "library.sqlite3").stat().st_size * 2})
    for path in files:
        check_cancel(cancel)
        dest = target / path.relative_to(lib.root)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, dest)
    with lib.connection() as source, closing(sqlite3.connect(target / "library.sqlite3")) as db:
        source.backup(db)
        db.row_factory = sqlite3.Row
        tables = {}
        for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
            name = row[0]
            quoted = '"' + name.replace('"', '""') + '"'
            tables[name] = [dict(record) for record in db.execute("SELECT * FROM " + quoted)]
    # SQLite remains the lossless copy, including any binary columns; JSON is for browsing.
    atomic_write_text(target / "library-data.json", json.dumps(tables, ensure_ascii=False,
        default=lambda value: {"binary_hex": value.hex()}))
    papers = tables.get("papers", [])
    operations = [json.loads(row["operation"]) for row in tables.get("web_annotation_ops", [])]
    web_origins = {op["stroke"]["id"]: op["source_sha256"] for op in operations if op["action"] == "add"}
    browser_ink = {"version": 1, "pages": {}, "applied": [op["id"] for op in operations]}
    for paper in papers:
        check_cancel(cancel)
        paper_id = paper["id"]
        fileset = PaperFiles(lib.folder(paper_id))
        for side, source_pdf in (("original", fileset.original_pdf), ("translated", fileset.translated_pdf)):
            if not source_pdf.is_file():
                continue
            strokes, highlights = lib.ink_by_page(paper_id, side), lib.highlights_by_page(paper_id, side)
            if web_origins:
                with source_pdf.open("rb") as stream:
                    source_sha = hashlib.file_digest(stream, "sha256").hexdigest()
                # Even previously imported Web strokes must not drift onto a regenerated PDF.
                # Keep the PC database and ledger intact; only this browser snapshot is filtered.
                strokes = {page: [s for s in items if web_origins.get(s["id"], source_sha) == source_sha]
                           for page, items in strokes.items()}
            for page in strokes.keys() | highlights.keys():
                browser_ink["pages"][f"{paper_id}/{side}/{page}"] = {
                    "strokes": strokes.get(page, []), "highlights": highlights.get(page, [])}
            if strokes or highlights:
                dest = target / "web" / paper_id / f"{side}-annotated.pdf"
                dest.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_bytes(dest, annotated_pdf(source_pdf, strokes, highlights, stable_id=True))
    # The editable browser reader uses the original PDF with the same vector strokes as the PC.
    # Baked PDFs remain available as downloads and for older browser releases.
    atomic_write_text(target / "web-annotations.json", json.dumps(browser_ink, ensure_ascii=False))
    return {"version": 1, "items": papers, "attachments": tables.get("attachments", [])}


def publish(lib: Library, cancel, progress, *, force: bool = False) -> dict:
    saved = state(lib.root)
    try:
        drive = Drive()
        if cloud_drive_auth.status()["connecting"]:
            raise ValueError("Googleへの接続を完了してからアップロードしてください。")
        if saved.get("manifest_id"):
            progress("Webの書き込みを取り込んでいます…")
            cloud_annotations.import_operations(lib, drive, saved["manifest_id"], cancel)
        fingerprint = drive_sync.fingerprint(lib, cancel)
        # Navigation alone does not trigger another upload. Verify the previous manifest still exists.
        if not force and saved.get("web_ink_version") == 1 and saved.get("fingerprint") == fingerprint and saved.get("manifest_id"):
            drive.json(API + "/" + saved["manifest_id"] + "?fields=id")
            saved["error"] = None
            save_state(lib.root, saved)
            return {"uploaded": 0, "files": saved.get("files", 0)}
        # Each Windows library owns its own folder; other PCs cannot silently replace its manifest.
        if not saved.get("folder_id"):
            saved["folder_id"] = drive.json(API, method="POST", value={"name": "Papeer Library",
                "mimeType": "application/vnd.google-apps.folder"})["id"]
            save_state(lib.root, saved)
        folder = saved["folder_id"]
        existing = {item["name"]: item for item in drive.list(f"'{folder}' in parents")}
        with tempfile.TemporaryDirectory(prefix="papeer-cloud-") as directory:
            target = Path(directory)
            progress("Web閲覧用のデータを準備しています…")
            manifest = snapshot(lib, target, cancel)
            paths = sorted(path for path in target.rglob("*") if path.is_file())
            entries = {}
            uploaded = 0
            for index, path in enumerate(paths):
                check_cancel(cancel)
                progress(f"Google Driveへアップロード {index + 1}/{len(paths)}")
                with path.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                name = "blob-" + digest
                remote = existing.get(name)
                if (remote is None or int(remote.get("size", -1)) != path.stat().st_size
                        or remote.get("sha256Checksum") != digest):
                    file_id = drive.upload(path, {"name": name, "parents": [folder]}, cancel)
                    existing[name] = {"id": file_id, "size": path.stat().st_size, "sha256Checksum": digest}
                    uploaded += 1
                else:
                    file_id = remote["id"]
                entries[path.relative_to(target).as_posix()] = {"id": file_id, "sha256": digest,
                    "size": path.stat().st_size, "mime": mimetypes.guess_type(path.name)[0] or "application/octet-stream"}
            check_cancel(cancel)
            timestamp = datetime.now(timezone.utc).isoformat()
            manifest.update({"files": entries, "updated_at": timestamp, "revision": uuid.uuid4().hex, "folder_id": folder})
            manifest_path = target / "manifest.json"
            atomic_write_text(manifest_path, json.dumps(manifest, ensure_ascii=False))
            previous = existing.get("papeer-library.json")
            metadata = {"name": "papeer-library.json", "properties": {"papeer": "library-v1"}}
            if not previous:
                metadata["parents"] = [folder]
            manifest_id = drive.upload(manifest_path, metadata, cancel, previous["id"] if previous else None)
        saved.update({"last_upload": timestamp, "error": None, "fingerprint": fingerprint,
                      "manifest_id": manifest_id, "files": len(entries), "web_ink_version": 1})
        save_state(lib.root, saved)
        return {"uploaded": uploaded, "files": len(entries)}
    except Exception:  # Preserve the old published manifest; surface the original safe job error.
        saved["error"] = "アップロードが完了していません。前回のWeb閲覧データはそのままです。再試行してください。"
        save_state(lib.root, saved)
        raise
