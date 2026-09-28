"""Failures the user is told about as they are: their message is Japanese text for the screen.

The core raises them where it knows what went wrong; the sidecar answers each with its status code and
the message as the detail (sidecar/errors.py), and a job that fails on one reports the message as its
error. The core's older convention stays valid too: a plain ValueError carries a message for the user
and is answered with 400. Any other exception is a bug, answered with a general message (the traceback
goes to the log).

Invalid and NotFound are also a ValueError and a KeyError, so code that catches those keeps working;
unlike a plain KeyError, str() of a NotFound is its message rather than its repr ('論文が見つかりません。'
in quotes).
"""
from __future__ import annotations


class AppError(Exception):
    """A failure with a message for the user; `code` is a machine-readable reason the frontend may check."""

    status_code = 400

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code

    @property
    def message(self) -> str:
        return str(self.args[0]) if self.args else ""

    def __str__(self) -> str:
        return self.message


class Invalid(AppError, ValueError):
    """The request cannot be carried out as given (400)."""

    status_code = 400


class NotFound(AppError, KeyError):
    """What the request names does not exist (404)."""

    status_code = 404


class Conflict(AppError):
    """The request collides with the library's current state or a running job (409)."""

    status_code = 409
