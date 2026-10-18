"""What the CLI prints: results on stdout, everything else (progress, notes, errors, prompts) on stderr.

With --json stdout holds one JSON document and nothing else, so a script can read it whatever else
happens. Progress is a single line redrawn in place on a terminal, and a line per change of message
otherwise (a log file, a pipe).
"""
from __future__ import annotations

import json
import shutil
import sys
from typing import IO, Any, Callable, Sequence
import unicodedata

BAR_WIDTH = 10


def display_width(text: str) -> int:
    """Columns `text` takes on a terminal: East Asian wide and fullwidth characters take two."""
    return sum(0 if unicodedata.combining(ch) else 2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def truncate(text: str, width: int) -> str:
    """`text` cut to at most `width` columns, with an ellipsis when it was cut."""
    if display_width(text) <= width:
        return text
    out, used = [], 0
    for ch in text:
        step = display_width(ch)
        if used + step > width - 1:
            break
        out.append(ch)
        used += step
    return "".join(out) + "…"


def pad(text: str, width: int) -> str:
    return text + " " * max(0, width - display_width(text))


def table(rows: Sequence[Sequence[str]], headers: Sequence[str] | None = None, gap: str = "  ") -> str:
    """Rows as aligned columns (the last one is left unpadded); `headers` as a first row."""
    lines = [list(map(str, headers))] if headers else []
    lines += [[str(cell) for cell in row] for row in rows]
    if not lines:
        return ""
    count = max(len(line) for line in lines)
    widths = [max((display_width(line[i]) for line in lines if i < len(line)), default=0) for i in range(count)]
    return "\n".join(
        gap.join(pad(cell, widths[i]) if i < len(line) - 1 else cell for i, cell in enumerate(line)).rstrip()
        for line in lines)


def page_ranges(pages: Sequence[int]) -> str:
    """[1, 2, 3, 5] as "1-3,5"."""
    parts: list[str] = []
    ordered = sorted(set(pages))
    index = 0
    while index < len(ordered):
        end = index
        while end + 1 < len(ordered) and ordered[end + 1] == ordered[end] + 1:
            end += 1
        parts.append(str(ordered[index]) if end == index else f"{ordered[index]}-{ordered[end]}")
        index = end + 1
    return ",".join(parts)


class Output:
    def __init__(self, stdout: IO[str] | None = None, stderr: IO[str] | None = None, stdin: IO[str] | None = None, *,
                 json_mode: bool = False, quiet: bool = False,
                 progress_tty: bool | None = None, interactive: bool | None = None) -> None:
        self.stdout = stdout if stdout is not None else sys.stdout
        self.stderr = stderr if stderr is not None else sys.stderr
        self.stdin = stdin if stdin is not None else sys.stdin
        self.json_mode = json_mode
        self.quiet = quiet
        self._progress_tty = progress_tty
        self._interactive = interactive
        self._line_width = 0  # Columns of the progress line now drawn (0: none).
        self._last_message: str | None = None

    @classmethod
    def for_process(cls) -> "Output":
        """The real streams; not a terminal -> UTF-8 (Windows pipes would be the ANSI code page: cp932)."""
        for stream in (sys.stdout, sys.stderr):
            reconfigure = getattr(stream, "reconfigure", None)
            if stream is not None and not _isatty(stream) and callable(reconfigure):
                try:
                    reconfigure(encoding="utf-8", errors="replace")
                except (OSError, ValueError):
                    pass
        return cls()

    # --- Properties of the streams ---

    @property
    def progress_is_tty(self) -> bool:
        return self._progress_tty if self._progress_tty is not None else _isatty(self.stderr)

    @property
    def stdout_is_tty(self) -> bool:
        return _isatty(self.stdout)

    @property
    def can_prompt(self) -> bool:
        """Whether a question can be asked: a person at a terminal, and stdout not taken by JSON."""
        if self.json_mode:
            return False
        if self._interactive is not None:
            return self._interactive
        return _isatty(self.stdin) and _isatty(self.stderr)

    # --- Results ---

    def emit(self, data: Any, text: str | Callable[[], str] = "") -> None:
        """The command's result: `data` as JSON with --json, otherwise `text`."""
        self.finish_progress()
        if self.json_mode:
            self.stdout.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        else:
            body = text() if callable(text) else text
            if body:
                self.stdout.write(body + "\n")
        self.stdout.flush()

    def text(self, body: str) -> None:
        """Human text on stdout (never with --json)."""
        if self.json_mode or not body:
            return
        self.finish_progress()
        self.stdout.write(body + "\n")
        self.stdout.flush()

    # --- Notes, warnings, errors, questions (stderr) ---

    def info(self, message: str) -> None:
        if self.quiet:
            return
        self.finish_progress()
        self.stderr.write(message + "\n")
        self.stderr.flush()

    def warn(self, message: str) -> None:
        """A warning: shown unless --quiet."""
        self.info("警告: " + message)

    def error(self, message: str, code: str | None = None) -> None:
        self.finish_progress()
        suffix = f"（code: {code}）" if code else ""
        self.stderr.write(f"エラー: {message}{suffix}\n")
        self.stderr.flush()

    def ask(self, question: str) -> str:
        self.finish_progress()
        self.stderr.write(question)
        self.stderr.flush()
        try:
            return self.stdin.readline().strip()
        except (OSError, ValueError):
            return ""

    def confirm(self, question: str) -> bool:
        return self.ask(question).lower() in ("y", "yes")

    # --- Progress ---

    def progress(self, message: str, done: int | None = None, total: int | None = None) -> None:
        if self.quiet:
            return
        if not self.progress_is_tty:
            if message != self._last_message:
                self._last_message = message
                self.stderr.write(message + "\n")
                self.stderr.flush()
            return
        if done is not None and total:
            filled = min(BAR_WIDTH, max(0, round(BAR_WIDTH * done / total)))
            line = f"[{'#' * filled}{'-' * (BAR_WIDTH - filled)}] {done}/{total} {message}"
        else:
            line = f"[{'.' * BAR_WIDTH}] {message}"
        columns = shutil.get_terminal_size((80, 24)).columns
        line = truncate(line, max(20, columns - 1))
        width = display_width(line)
        self.stderr.write("\r" + pad(line, self._line_width))
        self.stderr.flush()
        self._line_width = width

    def finish_progress(self) -> None:
        """Clear the redrawn line (before anything else is written)."""
        if self._line_width:
            self.stderr.write("\r" + " " * self._line_width + "\r")
            self.stderr.flush()
            self._line_width = 0


def _isatty(stream: object) -> bool:
    try:
        return bool(stream.isatty())  # type: ignore[attr-defined]
    except (AttributeError, ValueError, OSError):
        return False
