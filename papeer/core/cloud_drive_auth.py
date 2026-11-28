"""Google desktop OAuth: PKCE/loopback, with refresh credentials protected by Windows DPAPI.

Credentials live outside the library and never enter backups or uploads. No token is returned to UI.
"""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
from dataclasses import dataclass, field
import hashlib
import hmac
from contextlib import contextmanager, nullcontext
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
import webbrowser

from papeer.core.device_authority import device_writer, writer
from papeer.core.fileio import atomic_write_bytes
from papeer.core.paths import device_directory
from papeer.core.cloud_drive_config import desktop_oauth, setup_status

SCOPE = "https://www.googleapis.com/auth/drive.file"
TOKEN_URL = "https://oauth2.googleapis.com/token"
_AUTH_TIMEOUT = 180.0
_CALLBACK_TIMEOUT = 5.0
_lock = threading.RLock()
_credential_cache: tuple[Path, bytes, bytes] | None = None
_connect_start_lock = threading.Lock()
_generation = secrets.token_hex(32)
_completed_authorization_generation: str | None = None
_completed_authorization_handle: object | None = None
_lease_secret = secrets.token_bytes(32)
_changing = threading.Event()
_invalidation_listeners: set[Callable[[], None]] = set()
_listener_lock = threading.RLock()
_MESSAGES = {
    "access_denied": "Googleへの接続が許可されませんでした。もう一度接続してアクセスを許可してください。",
    "timeout": "Googleへの接続が時間切れになりました。もう一度接続してください。",
    "network_error": "Googleの認証サーバーへ接続できません。通信・プロキシ設定を確認して再試行してください。",
    "browser_error": "認証画面を開けませんでした。既定のブラウザーを確認して、もう一度開いてください。",
    "client_secret_required": "GoogleがこのOAuthクライアントのclient_secretを要求しました。配布版のGoogle接続設定の対応が必要です（利用者による入力は不要です）。",
    "invalid_client": "GoogleがアプリのOAuthクライアント設定を拒否しました（invalid_client）。配布設定を確認する必要があります。",
    "invalid_grant": "Googleの認証コードまたは更新トークンが無効です（invalid_grant）。もう一度接続してください。",
    "invalid_request": "Googleが認証要求を拒否しました（invalid_request）。アプリの接続設定を確認する必要があります。",
    "unauthorized_client": "このOAuthクライアントでは認証できません（unauthorized_client）。デスクトップ用の配布設定を確認する必要があります。",
    "redirect_uri_mismatch": "Googleのリダイレクト先設定が一致しません（redirect_uri_mismatch）。配布設定を確認する必要があります。",
    "admin_policy_enforced": "Googleアカウントの管理者ポリシーによって接続が制限されています。",
    "org_internal": "このGoogle接続は指定組織のアカウントに限定されています。",
    "deleted_client": "アプリのGoogle OAuthクライアントが削除されています。配布設定を確認する必要があります。",
    "missing_refresh_token": "自動アップロードに必要な更新トークンを取得できませんでした。もう一度接続してください。",
    "credential_store_error": "WindowsにGoogle接続の資格情報を保存できませんでした。もう一度接続してください。",
    "not_waiting": "現在、開き直せる認証画面はありません。もう一度Googleに接続してください。",
    "exchanging": "Googleの接続結果を確認中です。再試行する場合は、接続をキャンセルしてください。",
    "token_error": "Googleの認証応答を処理できませんでした。もう一度接続してください。",
    "authorization_error": "Googleの認可に失敗しました。もう一度接続してください。",
    "unexpected_error": "Google接続を完了できませんでした。もう一度接続してください。",
}


class _OAuthFailure(ValueError):
    """Only fixed, allowlisted messages can cross the background authentication boundary."""
    def __init__(self, code: str):
        self.code = code if code in _MESSAGES else "unexpected_error"
        super().__init__(_MESSAGES[self.code])


@dataclass(repr=False)
class _Attempt:
    handle: object = field(default_factory=object)
    auth_generation: str = ""
    worker: threading.Thread | None = None
    cancelled: threading.Event = field(default_factory=threading.Event)
    server: HTTPServer | None = None
    connection: socket.socket | None = None
    url: str = ""
    stage: str = "waiting"


_attempt: _Attempt | None = None
_error: str | None = None
_error_code: str | None = None


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
    global _credential_cache
    try:
        path = _path()
        if not path.is_file():
            raise ValueError("先にGoogle Driveへ接続してください。")
        encrypted = path.read_bytes()
        cached = _credential_cache
        if cached is not None and cached[0] == path and cached[1] == encrypted:
            plain = cached[2]
        else:
            _credential_cache = None
            plain = _protect(encrypted, decrypt=True)
        value = json.loads(plain)
        _credential_cache = (path, encrypted, plain)
        return value
    except Exception:  # noqa: BLE001 - invalidate decoded bytes and preserve every original read/decrypt/JSON failure.
        _credential_cache = None
        raise

@device_writer
def _save(value: dict):
    global _credential_cache
    _credential_cache = None
    _path().parent.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(_path(), _protect(json.dumps(value).encode()))


def _token(values: dict, request_group=None) -> dict:
    request = Request(TOKEN_URL, data=urlencode(values).encode(),
                      headers={"Content-Type": "application/x-www-form-urlencoded"})
    with request_group.request() if request_group is not None else nullcontext(None) as ticket:
        opener = urlopen
        if ticket is not None:
            # TOKEN_URL is fixed above; redirects are refused and default verified
            # TLS remains in use. This import is delayed to avoid module cycles.
            from papeer.core.providers.drive.transport import _open
            opener = _open; setattr(request, '_papeer_request_ticket', ticket)
        try:
            with opener(request, timeout=min(30, ticket.remaining()) if ticket is not None else 30) as response:
                result = json.load(response)
        except HTTPError as exc:
            # Never return/log the body, description, request, or chained exception: only fixed messages.
            code = "token_error"
            try:
                body = json.loads(exc.read(16384))
                error = body.get("error") if isinstance(body, dict) else None
                if isinstance(error, str) and error in _MESSAGES:
                    code = error
                description = body.get("error_description", "") if isinstance(body, dict) else ""
                if (error == "invalid_request" and isinstance(description, str) and "client_secret" in description.lower()
                        and any(word in description.lower() for word in ("missing", "required", "not specified", "not provided"))):
                    code = "client_secret_required"
            except (ValueError, OSError):
                pass  # A malformed error body still maps to the fixed generic token error.
            finally:
                exc.close()
            raise _OAuthFailure(code) from None
        except (URLError, TimeoutError, OSError):
            raise _OAuthFailure("network_error") from None
        except ValueError:
            raise _OAuthFailure("token_error") from None
        if not isinstance(result, dict) or not isinstance(result.get("access_token"), str) or not result["access_token"]:
            raise _OAuthFailure("token_error")
        if not isinstance(result.get("expires_in", 3600), (int, float)):
            raise _OAuthFailure("token_error")
        result["expires_at"] = time.time() + result.get("expires_in", 3600)
        return result


def local_preparation_ready() -> bool:
    """Negative local-mode gate, not a global/external writer certificate.

    Do not wait on an in-flight credential/network guard from the counted start
    handler. A held guard is an unknown/busy mode and refuses before reservation.
    The coordinator checks again after drain while device authority is retained.
    """
    if not _lock.acquire(blocking=False):
        return False
    try:
        return _attempt is None and not _changing.is_set()
    finally:
        _lock.release()


def generation():
    with _lock:
        return _generation


@contextmanager
def transfer_guard(expected):
    # Drain the bounded request/body/chunk before changing credentials.
    with _lock:
        if expected != _generation or _attempt is not None or _changing.is_set():
            raise ValueError("drive-auth-changed")
        yield
        if expected != _generation or _changing.is_set():
            raise ValueError("drive-auth-changed")



def transfer_current_hint(expected):
    """Nonblocking UI health hint ONLY; never a substitute for transfer_guard.

    A concurrently changing snapshot can return a transient hint. Admission and
    every actual read/write still recheck under the authoritative credential lock.
    """
    return expected == _generation and _attempt is None and not _changing.is_set()

def completed_authorization_generation():
    """Host-only successful PKCE completion observation; never a token or admission capability."""
    with _lock:
        return _completed_authorization_generation


def subscribe_invalidation(listener: Callable[[], None]):
    """Host-only lifetime notifications; no credential or account metadata crosses this seam."""
    with _listener_lock:
        _invalidation_listeners.add(listener)
    def unsubscribe():
        with _listener_lock:
            _invalidation_listeners.discard(listener)
    return unsubscribe


def _notify_invalidation():
    with _listener_lock:
        listeners = tuple(_invalidation_listeners)
    for listener in listeners:
        try:
            listener()
        except Exception:  # noqa: BLE001, S110 - one observer must not prevent other host operations aborting.
            pass


@contextmanager
def _change_credentials():
    global _generation, _completed_authorization_generation, _completed_authorization_handle
    # Invalidate before waiting, so the current response cannot be accepted and
    # an uploader cannot start another chunk while the change waits to drain.
    _changing.set()
    _notify_invalidation()
    try:
        with writer(), _lock:
            _generation = secrets.token_hex(32)
            _completed_authorization_generation = None
            _completed_authorization_handle = None
            yield
    finally:
        _changing.clear()


def _lease_signature(account, expected):
    return hmac.new(_lease_secret, json.dumps([account, expected]).encode(), hashlib.sha256).hexdigest()


def transfer_lease(account, expected):
    with transfer_guard(expected):
        return expected + "." + _lease_signature(account, expected)


def lease_generation(account, lease):
    expected, _, signature = lease.partition(".")
    with transfer_guard(expected):
        if not hmac.compare_digest(signature, _lease_signature(account, expected)):
            raise ValueError("drive-auth-lease")
    return expected


def access_token() -> str:
    # The existing provider path already separates network from the guarded
    # credential commit and rechecks generation; share that same implementation.
    return capture_provider_access_token(generation())



def capture_provider_access_token(expected, request_group=None):
    """Host-private credential snapshot. Never hold the commit lock over HTTP.

    Refresh response is saved only under the original generation after checking
    the cancellation group. Legacy access_token/transfer_guard remain unchanged.
    """
    if request_group is not None: request_group.check()
    with transfer_guard(expected):
        saved = _load()
        if saved.get('expires_at', 0) >= time.time() + 60:
            token = saved['access_token']
        else: token = None
    if token is not None:
        if request_group is not None: request_group.check()
        return token
    values = {'grant_type': 'refresh_token', 'refresh_token': saved['refresh_token'], 'client_id': saved['client_id']}
    if saved.get('client_secret'): values['client_secret'] = saved['client_secret']
    try:
        renewed = _token(values, request_group=request_group) if request_group is not None else _token(values)
    except Exception:  # noqa: BLE001 - preserve own cancellation instead of misclassifying it as credential loss.
        if request_group is not None: request_group.check()
        raise
    with writer(), transfer_guard(expected):
        if request_group is not None: request_group.check()
        current = _load()
        # Another same-generation refresh can already have installed a fresher
        # token; it is authoritative, never overwrite its refreshed payload.
        if current != saved: return current['access_token']
        current.update(renewed); _save(current)
        if request_group is not None: request_group.check()
        return current['access_token']

def status() -> dict:
    with _lock:
        return {"connected": _path().is_file(), "connecting": _attempt is not None, "auth_error": _error,
                "auth_error_code": _error_code, "auth_stage": _attempt.stage if _attempt else None,
                "can_reopen": bool(_attempt and _attempt.stage == "waiting" and _attempt.url),
                "supported": sys.platform == "win32", **setup_status()}


def disconnect():
    global _error, _error_code, _credential_cache
    with _change_credentials():
        _credential_cache = None
        if _attempt:
            raise ValueError("先にGoogleへの接続をキャンセルしてください。")
        _path().unlink(missing_ok=True)
        _error, _error_code = None, None


def _stop(attempt: _Attempt):
    for connection in (attempt.connection, attempt.server.socket if attempt.server else None):
        if connection:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass  # Interrupt accept/read if still open; the worker owns final cleanup.
    if attempt.server:
        attempt.server.server_close()


def cancel() -> dict:
    """Invalidate first; an old token response can never complete a cancelled/new attempt."""
    global _attempt, _error, _error_code
    with _lock:
        previous, _attempt = _attempt, None
        if previous:
            previous.cancelled.set()
            previous.url = ""
        _error, _error_code = None, None
    if previous:
        _stop(previous)
    return status()



def cancel_attempt(expected_handle: object) -> bool:
    """Host-private cancellation, linearized against current attempt identity.

    A stale handle does not mutate generation, errors, completion or credentials.
    Starting the attempt already invalidated/drained prior credential operations.
    """
    global _attempt, _error, _error_code
    observed = _attempt
    if observed is None or observed.handle is not expected_handle: return False
    with _lock:
        current = _attempt
        if current is None or current.handle is not expected_handle:
            return False
        _attempt = None
        current.cancelled.set(); current.url = ""
        _error, _error_code = None, None
    _stop(current)
    return True


def authorization_completed(expected_handle: object) -> bool:
    """Opaque host observation; never expose the handle through API/status."""
    with _lock:
        return (expected_handle is not None and _completed_authorization_handle is expected_handle
                and _completed_authorization_generation == _generation and _attempt is None)

def _open_browser(url: str):
    try:
        if webbrowser.open(url) is False:
            raise _OAuthFailure("browser_error")
    except Exception:  # noqa: BLE001 - OS/browser exceptions must not expose the authorization URL.
        raise _OAuthFailure("browser_error") from None


def reopen() -> dict:
    global _error, _error_code
    with _lock:
        current = _attempt
        if not current:
            raise _OAuthFailure("not_waiting")
        if current.stage != "waiting" or not current.url:
            raise _OAuthFailure("exchanging")
        url = current.url
    try:
        _open_browser(url)
    except _OAuthFailure as exc:
        with _lock:
            if _attempt is current:
                _error, _error_code = str(exc), exc.code
        raise
    with _lock:
        if _attempt is current:
            _error, _error_code = None, None
    return status()


def _connect_attempt(capture: Callable[[object], bool] | None = None) -> tuple[dict, object]:
    """Open the system browser; finish asynchronously so the sidecar can continue answering."""
    global _attempt, _error, _error_code
    if sys.platform != "win32":
        raise ValueError("Google Drive APIへの接続は現在Windows版に対応しています。")
    config = desktop_oauth()
    if not config.configured:
        raise ValueError("このビルドではGoogle接続を利用できません。接続対応版に更新してください。")
    client_id, client_secret = config.client_id, config.client_secret
    with _connect_start_lock:
        with _lock:
            if _attempt:
                raise ValueError("ブラウザーでのGoogle接続を完了してください。")
        with _change_credentials():
            current = _Attempt(auth_generation=_generation)
            _attempt, _error, _error_code = current, None, None
            try:
                permitted = capture is None or capture(current.handle)
            except Exception:  # noqa: BLE001 - fixed host callback failure must not strand an auth attempt.
                current.cancelled.set(); _attempt = None
                raise _OAuthFailure('unexpected_error') from None
            if not permitted:
                current.cancelled.set(); _attempt = None
                return status(), current.handle
    try:
        state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
        answer: dict[str, str] = {}
        deadline = time.monotonic() + _AUTH_TIMEOUT

        class Callback(BaseHTTPRequestHandler):
            def handle(self):
                try:
                    super().handle()
                except OSError:
                    pass  # Closing/cancelling a browser request is normal, including Windows resets.

            def setup(self):
                self._expired = threading.Event()
                request_timeout = min(_CALLBACK_TIMEOUT, max(0.001, deadline - time.monotonic()))
                super().setup()
                self.connection.settimeout(request_timeout)
                with _lock:
                    current.connection = self.connection

                def expire():
                    self._expired.set()
                    try:
                        self.connection.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass  # The browser may already have closed the connection.

                # A socket timeout alone restarts with every byte. Bound the entire request too,
                # so partial/slow headers cannot hold handle_request() past the OAuth deadline.
                self._expiry = threading.Timer(request_timeout, expire)
                self._expiry.daemon = True
                self._expiry.start()
                if current.cancelled.is_set():
                    expire()

            def finish(self):
                try:
                    super().finish()
                except OSError:
                    pass  # A cancelled/disconnected browser may not accept the final buffered write.
                finally:
                    self._expiry.cancel()
                    with _lock:
                        if current.connection is self.connection:
                            current.connection = None

            def do_GET(self):
                if current.cancelled.is_set() or self._expired.is_set() or time.monotonic() >= deadline:
                    self.close_connection = True
                    return
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
        current.server = server
        server.timeout = 1
        redirect = f"http://127.0.0.1:{server.server_port}/"
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({
            "client_id": client_id, "redirect_uri": redirect, "response_type": "code", "scope": SCOPE,
            "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
            "access_type": "offline", "prompt": "consent"})
        with _lock:
            if current.cancelled.is_set():
                server.server_close()
                return status(), current.handle
            current.url = url

        def finish():
            global _attempt, _error, _error_code, _completed_authorization_generation, _completed_authorization_handle
            try:
                while not current.cancelled.is_set() and not answer and time.monotonic() < deadline:
                    server.timeout = min(1, max(0, deadline - time.monotonic()))
                    server.handle_request()
                if current.cancelled.is_set():
                    return
                if answer.get("error"):
                    code = answer["error"]
                    raise _OAuthFailure(code if code in _MESSAGES else "authorization_error")
                if "code" not in answer or time.monotonic() >= deadline:
                    raise _OAuthFailure("timeout")
                with _lock:
                    if _attempt is not current or current.cancelled.is_set() or current.auth_generation != _generation or _changing.is_set():
                        return
                    current.stage, current.url = "exchanging", ""
                values = {"grant_type": "authorization_code", "code": answer["code"],
                          "client_id": client_id, "redirect_uri": redirect, "code_verifier": verifier}
                if client_secret:
                    values["client_secret"] = client_secret
                token = _token(values)
                if not token.get("refresh_token"):
                    raise _OAuthFailure("missing_refresh_token")
                with writer(), _lock:
                    if _attempt is not current or current.cancelled.is_set() or current.auth_generation != _generation or _changing.is_set():
                        return
                    credentials = token | {"client_id": client_id}
                    if client_secret:
                        credentials["client_secret"] = client_secret
                    try:
                        _save(credentials)
                        if _attempt is not current or current.cancelled.is_set() or current.auth_generation != _generation or _changing.is_set():
                            return
                        _completed_authorization_generation = _generation
                        _completed_authorization_handle = current.handle
                    except (OSError, ValueError):
                        raise _OAuthFailure("credential_store_error") from None
            except Exception as exc:  # noqa: BLE001 - background boundary; only fixed messages leave it.
                with _lock:
                    if _attempt is current:
                        code = exc.code if isinstance(exc, _OAuthFailure) else "unexpected_error"
                        _error, _error_code = _MESSAGES[code], code
            finally:
                server.server_close()
                with _lock:
                    if _attempt is current:
                        _attempt = None

        current.worker = threading.Thread(target=finish, daemon=True, name="google-oauth")
        current.worker.start()
        _open_browser(url)
    except Exception as exc:  # noqa: BLE001 - cancel resources and expose only the fixed failure message.
        failure = exc if isinstance(exc, _OAuthFailure) else _OAuthFailure("unexpected_error")
        with _lock:
            if _attempt is current:
                _attempt = None
                current.cancelled.set()
                _error, _error_code = str(failure), failure.code
        _stop(current)
        raise failure from None
    return status(), current.handle


def connect() -> dict:
    """Legacy API retains its credential-free status response."""
    return _connect_attempt()[0]


def connect_with_attempt(capture: Callable[[object], bool] | None = None) -> tuple[dict, object]:
    """Fixed Native host only: captures the same atomically-created attempt."""
    return _connect_attempt(capture)
