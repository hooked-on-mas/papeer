"""The HTTP client: a transport (swapped for a fake in tests), the repo's error body, and a session.

A Transport sends one request and returns its status and body; it raises ConnectionLost when nothing
answered. A Session adds what the commands need on top: the answer decoded, a failure as ApiError, and
(when it has a connector) a new connection when the sidecar it talked to has gone, once, for a request that
can safely be sent again (the sidecar leaves when idle, which may happen while the user reads a prompt).

Standard library only (see papeer/cli/__init__.py).
"""
from __future__ import annotations

from dataclasses import dataclass
import http.client
import json
from typing import Any, Mapping, Protocol
import urllib.error
import urllib.parse
import urllib.request

# The `code` of the 503 a sidecar that is leaving answers with (sidecar/instance.py CLOSING_CODE).
CLOSING_CODE = "sidecar_closing"
DEFAULT_TIMEOUT = 30.0
# Cap on what is read of an answer: the biggest is the library list.
MAX_BODY = 64 * 1024 * 1024


class CliError(Exception):
    """A failure to tell the user in one line, with the exit code of the command."""

    def __init__(self, message: str, exit_code: int = 1, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code
        self.code = code


class ConnectionLost(CliError):
    """Nothing answered: refused, reset, timed out, or not HTTP at all."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"sidecar に接続できません（{reason}）。")
        self.reason = reason


class ApiError(CliError):
    """The sidecar answered with a failure ({"detail": ..., "code": ...}, sidecar/errors.py)."""

    def __init__(self, status: int, detail: str, code: str | None = None) -> None:
        super().__init__(detail, 1, code)
        self.status = status
        self.detail = detail


def error_from_reply(status: int, body: bytes) -> ApiError:
    """The ApiError for a failed answer: the repo's {"detail", "code"} body, FastAPI's 422 list, or plain text."""
    detail = f"HTTP {status}"
    code: str | None = None
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        text = body.decode("utf-8", "replace").strip()
        return ApiError(status, f"{detail}: {text[:200]}" if text else detail)
    if isinstance(data, dict):
        value = data.get("detail")
        if isinstance(value, str) and value:
            detail = value
        elif isinstance(value, list):
            parts = []
            for item in value:
                if isinstance(item, dict) and isinstance(item.get("msg"), str):
                    where = ".".join(str(part) for part in item.get("loc", []) if part != "body")
                    parts.append(f"{where}: {item['msg']}" if where else item["msg"])
            if parts:
                detail = "入力が正しくありません（" + "; ".join(parts) + "）"
        raw_code = data.get("code")
        if isinstance(raw_code, str):
            code = raw_code
    return ApiError(status, detail, code)


@dataclass
class Reply:
    status: int
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8")) if self.body else None


class Transport(Protocol):
    def request(self, method: str, path: str, *, body: Any = None, query: Mapping[str, str] | None = None,
                timeout: float = DEFAULT_TIMEOUT) -> Reply:
        """Send one request; ConnectionLost when nothing answered. An HTTP failure is a Reply, not an error."""
        ...


class UrllibTransport:
    """The real transport: urllib to one sidecar, never through a proxy (the token must not go to one)."""

    def __init__(self, base_url: str, token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method: str, path: str, *, body: Any = None, query: Mapping[str, str] | None = None,
                timeout: float = DEFAULT_TIMEOUT) -> Reply:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                return Reply(response.status, response.read(MAX_BODY))
        except urllib.error.HTTPError as error:  # Before OSError: it is one.
            with error:
                return Reply(error.code, error.read(MAX_BODY))
        except (OSError, http.client.HTTPException) as error:
            reason = getattr(error, "reason", None) or error
            raise ConnectionLost(str(reason) or type(error).__name__) from None


@dataclass(frozen=True)
class Target:
    """Which sidecar a session talks to (what its /api/instance said, or what the user gave)."""
    base_url: str
    token: str | None = None
    pid: int | None = None
    port: int | None = None
    launcher: str | None = None  # "app" | "dev" | "cli"
    version: str | None = None
    data_dir: str | None = None
    spawned: bool = False  # Started by this very command.


class Reconnector(Protocol):
    """What a session asks to find the sidecar again (papeer/cli/connect.py Connector)."""

    def alive(self, target: Target) -> bool:
        """Whether the sidecar `target` describes is still the one serving the library."""
        ...

    def connect(self, patience: float = 0.0) -> "Session":
        """A session to whichever sidecar serves the library now (starting one unless told not to);
        `patience` seconds of looking for another's before starting one."""
        ...


class Session:
    """A connection to one sidecar, with JSON in and out."""

    def __init__(self, transport: Transport, target: Target | None = None, connector: Reconnector | None = None) -> None:
        self.transport = transport
        self.target = target or Target(base_url="")
        self.connector = connector

    # --- Requests ---

    def _once(self, method: str, path: str, body: Any, query: Mapping[str, str] | None, timeout: float) -> Any:
        reply = self.transport.request(method, path, body=body, query=query, timeout=timeout)
        if reply.status >= 400:
            raise error_from_reply(reply.status, reply.body)
        try:
            return reply.json()
        except ValueError:
            raise ApiError(reply.status, "sidecar の応答を読めませんでした。") from None

    def request(self, method: str, path: str, *, body: Any = None, query: Mapping[str, str] | None = None,
                timeout: float = DEFAULT_TIMEOUT, reconnect: bool = True) -> Any:
        """The decoded answer. When the sidecar has gone (nothing answers and it no longer checks out, or
        it answered 503 sidecar_closing) and `reconnect`: connect again and send the request once more.

        A request that reached a sidecar that then died may have been done; every command's request is
        safe to send twice (an import skips what is in the library, a move is checked against `expected`).
        """
        try:
            return self._once(method, path, body, query, timeout)
        except ConnectionLost:
            if not reconnect or self.connector is None or not self.gone() or not self.reconnect():
                raise
        except ApiError as error:
            if error.code != CLOSING_CODE or not reconnect or self.connector is None or not self.reconnect():
                raise
        return self._once(method, path, body, query, timeout)

    def get(self, path: str, **kwargs: Any) -> Any:
        return self.request("GET", path, **kwargs)

    def post(self, path: str, body: Any = None, **kwargs: Any) -> Any:
        return self.request("POST", path, body=body if body is not None else {}, **kwargs)

    def patch(self, path: str, body: Any = None, **kwargs: Any) -> Any:
        return self.request("PATCH", path, body=body, **kwargs)

    def delete(self, path: str, **kwargs: Any) -> Any:
        return self.request("DELETE", path, **kwargs)

    # --- The sidecar going away ---

    def gone(self) -> bool:
        """Whether the sidecar of this session is certainly gone (or another one serves the library now).

        False when that cannot be told (a `--url` session has no discovery file to ask).
        """
        return self.connector is not None and not self.connector.alive(self.target)

    def reconnect(self, patience: float = 0.0) -> bool:
        """Take the connection of whichever sidecar serves the library now; False when there is none."""
        if self.connector is None:
            return False
        try:
            fresh = self.connector.connect(patience)
        except CliError:
            return False
        self.transport, self.target = fresh.transport, fresh.target
        return True
