"""How a failure reaches the frontend: one rule for every route and job (papeer/core/errors.py).

- AppError (Invalid 400, NotFound 404, Conflict 409): its status, its message as the detail, and its
  code when it has one ({"detail": ..., "code": "library_busy"}, frontend/src/lib/libraryBusy.ts).
- A ValueError the core raises for the user (user_value_error): 400 with its message, the core's older
  way of saying the input is wrong. That is a plain ValueError or one of the core's own subclasses
  (InsufficientSpaceError, NewerSchemaError, LibraryMissingError, RetryLimitExceeded, ...); the
  subclasses other libraries raise (json.JSONDecodeError, UnicodeDecodeError, pydantic's
  ValidationError) carry English text and the values that failed, and count as bugs.
- Anything else is a bug: the traceback goes to the log, and the screen gets a general message in
  Japanese with only the exception's type, never its repr (a KeyError would read 'abc').

A job reports the same messages as its error (job_error_message), except that the errors the AI
connections and file operations give (RuntimeError, OSError) keep their own text there: they tell the
user what failed (errorReports.ts judges the cause from it), as they always have.

The log is the logger "papeer.sidecar". A packaged sidecar's stderr goes nowhere (Tauri does not read
it), so main() also writes it to a file on this PC (log_to_file). It records the method and path of a
request, never its query string (media URLs carry the token there), nor any header or setting.
"""
from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import sqlite3
import sys

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from papeer.core.errors import AppError
from papeer.core.paths import log_directory
from papeer.providers import Cancelled

log = logging.getLogger("papeer.sidecar")

# About 1 MB a file: the current one and two older ones.
LOG_FILE_BYTES = 1_000_000
LOG_FILE_BACKUPS = 2


def log_to_file(folder: Path | None = None) -> logging.Handler | None:
    """Also write the log to sidecar.log in `folder` (log_directory() by default), and to stderr.

    Returns the file's handler, or None when the folder cannot be made (the sidecar starts anyway).
    """
    path = (folder or log_directory()) / "sidecar.log"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler: logging.Handler = RotatingFileHandler(path, maxBytes=LOG_FILE_BYTES, backupCount=LOG_FILE_BACKUPS,
                                                       encoding="utf-8", delay=True)
    except OSError as exc:
        print(f"警告: ログファイル（{path}）を用意できませんでした: {exc!r}", file=sys.stderr)
        return None
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(handler)
    # With a handler of its own the logger no longer falls back to printing on stderr: keep that too.
    if not any(type(h) is logging.StreamHandler for h in log.handlers):
        log.addHandler(logging.StreamHandler(sys.stderr))
    return handler


def unexpected_message(exc: BaseException) -> str:
    return f"予期しないエラーが発生しました（{type(exc).__name__}）。やり直しても直らない場合は、詳細をコピーして報告してください。"


def user_value_error(exc: BaseException) -> bool:
    """A ValueError whose message is for the user: a plain one, or a subclass papeer itself defines."""
    if not isinstance(exc, ValueError):
        return False
    return type(exc) is ValueError or isinstance(exc, AppError) or type(exc).__module__.split(".")[0] == "papeer"


def expected_response(exc: Exception) -> JSONResponse | None:
    """The answer to a failure the user is told about as it is; None for a bug."""
    if isinstance(exc, AppError):
        content = {"detail": exc.message}
        if exc.code:
            content["code"] = exc.code
        return JSONResponse(status_code=exc.status_code, content=content)
    if user_value_error(exc):
        return JSONResponse(status_code=400, content={"detail": str(exc)})
    return None


def error_response(exc: Exception, where: str = "") -> JSONResponse:
    response = expected_response(exc)
    if response is not None:
        return response
    log.error("想定外のエラー%s", f"（{where}）" if where else "", exc_info=exc)
    return JSONResponse(status_code=500, content={"detail": unexpected_message(exc)})


def job_error_message(exc: BaseException, kind: str) -> str:
    """What a failed job reports as its error; a bug's traceback is logged here."""
    if isinstance(exc, (AppError, RuntimeError, OSError, Cancelled)) or user_value_error(exc):
        return str(exc)
    if isinstance(exc, sqlite3.OperationalError):
        # Most often "database is locked" (another program holds library.sqlite3): worth trying again.
        log.error("データベースのエラー（処理: %s）", kind, exc_info=exc)
        return f"ライブラリのデータベースを読み書きできませんでした（{exc}）。しばらくしてからやり直してください。"
    log.error("想定外のエラー（処理: %s）", kind, exc_info=exc)
    return unexpected_message(exc)


class AnswerUnexpectedErrors:
    """Answer a bug in a route with error_response instead of a bare 500.

    AppError and ValueError are handed to their exception handler (sidecar/app.py), which answers a
    ValueError from elsewhere (json, pydantic) through error_response as a bug too; this catches the
    rest. An exception handler for Exception would run outside the CORS middleware, so the window could
    not read the answer (a fetch refused by CORS reads as the sidecar being unreachable). When the
    response has already begun (a file being streamed) nothing more can be sent, and the error goes on up.
    """

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracked(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracked)
        except Exception as exc:
            if started:
                raise
            await error_response(exc, where(scope))(scope, receive, send)


def where(scope: Scope) -> str:
    """The request as the log names it: method and path only (the query string may carry the token)."""
    return f"{scope.get('method', '')} {scope.get('path', '')}"
