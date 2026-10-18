"""Google desktop OAuth: PKCE/loopback, with refresh credentials protected by Windows DPAPI.

Credentials live outside the library and never enter backups or uploads. No token is returned to UI.
"""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import secrets
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
import webbrowser

from papeer.core.fileio import atomic_write_bytes
from papeer.core.paths import device_directory
from papeer.core.cloud_drive_config import desktop_oauth, setup_status

SCOPE = "https://www.googleapis.com/auth/drive.file"
TOKEN_URL = "https://oauth2.googleapis.com/token"
_lock = threading.RLock()
_pending = False
_error: str | None = None


def _path():
    return device_directory() / "google-drive-credentials.dpapi"


def _protect(data: bytes, *, decrypt: bool = False) -> bytes:
    if sys.platform != "win32":
        raise ValueError("Google Drive APIへの接続は現在Windows版に対応しています。")

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, target = Blob(len(data), buffer), Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise ValueError("Windowsの資格情報を保存・読み込みできません。接続し直してください。")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        free = ctypes.WinDLL("kernel32").LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(target.data)


def _load() -> dict:
    if not _path().is_file():
        raise ValueError("先にGoogle Driveへ接続してください。")
    return json.loads(_protect(_path().read_bytes(), decrypt=True))


def _save(value: dict):
    _path().parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(_path(), _protect(json.dumps(value).encode()))


def _token(values: dict) -> dict:
    request = Request(TOKEN_URL, data=urlencode(values).encode(),
                      headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urlopen(request, timeout=30) as response:
            result = json.load(response)
    except (HTTPError, URLError, TimeoutError) as exc:
        # Google's error bodies may contain secrets: never include them in jobs/logs.
        raise ValueError("Googleの認証に失敗しました。OAuth設定・通信を確認し、接続し直してください。") from exc
    result["expires_at"] = time.time() + result.get("expires_in", 3600)
    return result


def access_token() -> str:
    with _lock:
        saved = _load()
        if saved.get("expires_at", 0) < time.time() + 60:
            values = {"grant_type": "refresh_token", "refresh_token": saved["refresh_token"], "client_id": saved["client_id"]}
            if saved.get("client_secret"):
                values["client_secret"] = saved["client_secret"]
            saved.update(_token(values))
            _save(saved)
        return saved["access_token"]


def status() -> dict:
    with _lock:
        return {"connected": _path().is_file(), "connecting": _pending, "auth_error": _error,
                "supported": sys.platform == "win32", **setup_status()}


def disconnect():
    global _error
    with _lock:
        if _pending:
            raise ValueError("Googleの接続画面を完了するか、3分後に解除してください。")
        _path().unlink(missing_ok=True)
        _error = None


def connect() -> dict:
    """Open the system browser; finish asynchronously so the sidecar can continue answering."""
    global _pending, _error
    if sys.platform != "win32":
        raise ValueError("Google Drive APIへの接続は現在Windows版に対応しています。")
    config = desktop_oauth()
    if not config.configured:
        raise ValueError("このビルドではGoogle接続を利用できません。接続対応版に更新してください。")
    client_id, client_secret = config.client_id, config.client_secret
    with _lock:
        if _pending:
            raise ValueError("ブラウザーでのGoogle接続を完了してください。")
        _pending, _error = True, None
    try:
        state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
        answer: dict[str, str] = {}

        class Callback(BaseHTTPRequestHandler):
            def do_GET(self):
                query = parse_qs(urlparse(self.path).query)
                if urlparse(self.path).path != "/" or query.get("state") != [state]:
                    self.send_error(400)
                    return
                answer.update({key: value[0] for key, value in query.items()})
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write("Papeerに戻って接続結果を確認してください。このタブは閉じられます。".encode())

            def log_message(self, format: str, *args):
                pass  # Authorization codes must never appear in access logs.

        server = HTTPServer(("127.0.0.1", 0), Callback)
        server.timeout = 1
        redirect = f"http://127.0.0.1:{server.server_port}/"
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({
            "client_id": client_id, "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
            "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
            "access_type": "offline", "prompt": "consent"})

        def finish():
            global _pending, _error
            try:
                deadline = time.monotonic() + 180
                while not answer and time.monotonic() < deadline:
                    server.handle_request()
                if "code" not in answer:
                    raise ValueError("Google接続がキャンセルされたか、時間切れになりました。")
                values = {"grant_type": "authorization_code", "code": answer["code"],
                          "client_id": client_id, "redirect_uri": redirect, "code_verifier": verifier}
                if client_secret:
                    values["client_secret"] = client_secret
                token = _token(values)
                if not token.get("refresh_token"):
                    raise ValueError("自動アップロードの認証を取得できませんでした。接続し直してください。")
                with _lock:
                    credentials = token | {"client_id": client_id}
                    if client_secret:
                        credentials["client_secret"] = client_secret
                    _save(credentials)
            except Exception:  # noqa: BLE001 - background boundary; no credential-bearing exception is logged.
                with _lock:
                    _error = "Google接続を完了できませんでした。OAuth設定・通信を確認し、もう一度接続してください。"
            finally:
                server.server_close()
                with _lock:
                    _pending = False

        threading.Thread(target=finish, daemon=True, name="google-oauth").start()
        webbrowser.open(url)
    except Exception:
        with _lock:
            _pending = False
        raise
    return status()
