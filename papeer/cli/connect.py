"""Finding the sidecar to talk to, or starting a headless one.

The order (README of the CLI, plan stage 4b):

1. `--url` (and `--token`), or PAPEER_CLI_URL (and PAPEER_TOKEN): taken as given.
2. The discovery file of the library (papeer.core.instance), checked with the sidecar itself: GET
   /api/instance with the file's token must answer with the file's pid and this library's folder. A file
   that does not check out is a dead sidecar's (a killed one leaves it behind) and is ignored.
3. Unless --no-spawn: start `python -m sidecar` (the packaged papeer-sidecar next to the CLI) with
   PAPEER_LAUNCHER=cli and PAPEER_IDLE_EXIT, so that it leaves by itself once the commands stop coming,
   and wait for a discovery file that holds the token this process made up.

The sidecar is never matched by the pid Popen reports: on Windows the virtual environment's python.exe is
a launcher that runs the interpreter as a child, so the pid of the process that serves differs. The token
is what tells it is ours. A child that exits with code 4 lost the race for the library to another sidecar
(a window's, or another CLI's): the CLI goes back to looking for that one.

Standard library, papeer.core.instance and papeer.core.paths only.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
from typing import Any, Callable

from papeer.cli.client import CliError, ConnectionLost, Session, Target, Transport, UrllibTransport
from papeer.core import instance as discovery
from papeer.core.paths import app_env, data_directory, log_directory

EXIT_NO_SIDECAR = 3
# The exit code of a sidecar that found the library served by another (sidecar/instance.py).
EXIT_LIBRARY_IN_USE = 4
VERIFY_TIMEOUT = 2.0
# How long a freshly started sidecar may take to come up: the first start of a frozen build is slow.
SPAWN_TIMEOUT = 60.0
SPAWN_INTERVAL = 0.1
# After a child gave way to another sidecar: how long to look for it, and how many times to start again.
IN_USE_WAIT = 10.0
MAX_STARTS = 3
DEFAULT_IDLE = 10.0
# Variables a headless sidecar must not inherit: the window's watch on its own stdin pipe.
DROPPED_VARIABLES = ("PAPEER_WATCH_STDIN", "PAPERDESK_WATCH_STDIN", "PAPEER_DEV_NO_AUTH", "PAPERDESK_DEV_NO_AUTH")


@dataclass
class Options:
    url: str | None = None
    token: str | None = None
    data_dir: str | None = None
    no_spawn: bool = False
    idle: float = DEFAULT_IDLE


def same_path(left: object, right: object) -> bool:
    """Whether two spellings name one folder (resolved, and case-folded where the file system is)."""
    if not isinstance(left, (str, os.PathLike)) or not isinstance(right, (str, os.PathLike)):
        return False
    try:
        return os.path.normcase(str(Path(left).resolve())) == os.path.normcase(str(Path(right).resolve()))
    except OSError:
        return False


def sidecar_command() -> tuple[list[str], str | None]:
    """The command that runs a sidecar, and the folder to run it in."""
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable).with_name("papeer-sidecar.exe" if os.name == "nt" else "papeer-sidecar")
        return [str(exe)], str(exe.parent)
    # papeer/cli/connect.py -> the folder that holds the papeer and sidecar packages.
    return [sys.executable, "-m", "sidecar"], str(Path(__file__).resolve().parents[2])


def detach_options() -> dict[str, Any]:
    """Popen options that cut the child off from this command and its terminal.

    Windows: no console window, and a process group of its own (a Ctrl+C in this terminal does not reach
    it), the options the app's CLI runs use (papeer.providers.common.process_kwargs); the child gets a
    hidden console of its own, so closing this terminal does not end it either. Elsewhere: a session of its own.
    """
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


class Connector:
    """Finds (or starts) the sidecar of one library; also what a Session asks when its sidecar is gone."""

    def __init__(
        self,
        options: Options | None = None,
        *,
        transport_factory: Callable[[str, str | None], Transport] = UrllibTransport,
        popen: Callable[..., Any] = subprocess.Popen,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        notify: Callable[[str], None] | None = None,
    ) -> None:
        self.options = options or Options()
        self.transport_factory = transport_factory
        self.popen = popen
        self.clock = clock
        self.sleep = sleep
        self.notify = notify or (lambda _message: None)

    # --- Where ---

    @property
    def explicit_url(self) -> str | None:
        return self.options.url or app_env("CLI_URL") or None

    @property
    def explicit_token(self) -> str | None:
        return self.options.token if self.options.token is not None else (app_env("TOKEN") or None)

    @property
    def root(self) -> Path:
        """The library's folder: --data-dir, else PAPEER_DATA_DIR, else the platform's place."""
        if self.options.data_dir:
            return Path(self.options.data_dir).expanduser().resolve()
        return data_directory()

    # --- Checking a claim ---

    def _verify(self, info: discovery.InstanceInfo, attempts: int = 1) -> Target | None:
        """The Target for the discovery file's claim when the sidecar itself bears it out, else None."""
        if not discovery.holder_alive_hint(info):
            return None
        base = f"http://127.0.0.1:{info.port}"
        transport = self.transport_factory(base, info.token)
        for attempt in range(attempts):
            if attempt:
                self.sleep(0.5)
            try:
                reply = transport.request("GET", "/api/instance", timeout=VERIFY_TIMEOUT)
            except ConnectionLost:
                continue
            if reply.status != 200:
                return None  # 401 (another token), 503 sidecar_closing (leaving), anything else: not usable.
            try:
                data = reply.json()
            except ValueError:
                return None
            if (not isinstance(data, dict) or data.get("pid") != info.pid
                    or not same_path(data.get("data_dir"), info.data_dir) or not same_path(info.data_dir, self.root)):
                return None
            return Target(base_url=base, token=info.token, pid=info.pid, port=info.port,
                          launcher=str(data.get("launcher") or info.launcher), version=str(data.get("version") or ""),
                          data_dir=str(data["data_dir"]))
        return None

    def find(self, attempts: int = 2) -> Target | None:
        """The sidecar serving the library now (by its discovery file, checked), or None."""
        info = discovery.read_instance(self.root)
        return self._verify(info, attempts) if info is not None else None

    def alive(self, target: Target) -> bool:
        """Whether `target` is still the sidecar serving the library (patient: a busy sidecar is not a dead one)."""
        if self.explicit_url:
            return True  # No discovery file to ask: the connection error is what the caller gets.
        info = discovery.read_instance(self.root)
        if info is None or info.pid != target.pid or info.token != target.token:
            return False
        return self._verify(info, 3) is not None

    # --- Connecting ---

    def _session(self, target: Target) -> Session:
        return Session(self.transport_factory(target.base_url, target.token), target, self)

    def connect(self, patience: float = 0.0, spawn: bool = True) -> Session:
        """A session to the sidecar of the library. `patience`: seconds to look for one before starting
        another; `spawn` False (or --no-spawn): never start one (exit code 3 when none is running)."""
        url = self.explicit_url
        if url:
            return self._explicit(url)
        target = self.find()
        if target is None and patience > 0:
            target = self._wait_for_sidecar(patience)
        if target is None:
            if self.options.no_spawn or not spawn:
                raise CliError("Papeer が起動していません。", EXIT_NO_SIDECAR)
            target = self._start()
        return self._session(target)

    def _explicit(self, url: str) -> Session:
        base = url.rstrip("/")
        token = self.explicit_token
        transport = self.transport_factory(base, token)
        session = Session(transport, Target(base_url=base, token=token), self)
        try:
            data = session.request("GET", "/api/instance", timeout=VERIFY_TIMEOUT, reconnect=False)
        except ConnectionLost as error:
            raise CliError(f"{base} に接続できません（{error.reason}）。", EXIT_NO_SIDECAR) from None
        if isinstance(data, dict):
            pid, port = data.get("pid"), data.get("port")
            session.target = Target(
                base_url=base, token=token, pid=pid if isinstance(pid, int) else None,
                port=port if isinstance(port, int) else None,
                launcher=data.get("launcher") if isinstance(data.get("launcher"), str) else None,
                version=data.get("version") if isinstance(data.get("version"), str) else None,
                data_dir=data.get("data_dir") if isinstance(data.get("data_dir"), str) else None)
        return session

    def _wait_for_sidecar(self, seconds: float) -> Target | None:
        deadline = self.clock() + seconds
        while True:
            target = self.find(attempts=1)
            if target is not None or self.clock() >= deadline:
                return target
            self.sleep(0.25)

    # --- Starting one ---

    def _spawn(self, token: str) -> Any:
        command, cwd = sidecar_command()
        env = {name: value for name, value in os.environ.items() if name.upper() not in DROPPED_VARIABLES}
        env.update(PAPEER_PORT="0", PAPEER_TOKEN=token, PAPEER_LAUNCHER="cli",
                   PAPEER_IDLE_EXIT=f"{self.options.idle:g}")
        # Always the absolute folder this process resolved: the child runs in another working directory (the
        # repository, the exe's folder), where a relative PAPEER_DATA_DIR would be another library.
        env["PAPEER_DATA_DIR"] = str(self.root)
        try:
            return self.popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, **detach_options())
        except OSError as error:
            raise CliError(f"ヘッドレスの Papeer を起動できませんでした（{error}）。", EXIT_NO_SIDECAR) from None

    def _wait_ready(self, process: Any, token: str) -> Target | int:
        """The started sidecar once its discovery file holds `token` and it answers; or the child's exit code."""
        deadline = self.clock() + SPAWN_TIMEOUT
        while True:
            info = discovery.read_instance(self.root)
            if info is not None and info.token == token:
                target = self._verify(info)
                if target is not None:
                    return replace(target, spawned=True)
            code = process.poll()
            if code is not None:
                return int(code)
            if self.clock() >= deadline:
                try:
                    process.kill()
                except OSError:
                    pass
                raise CliError(f"ヘッドレスの Papeer が {SPAWN_TIMEOUT:.0f} 秒以内に起動しませんでした。"
                               f"ログ: {log_directory() / 'sidecar.log'}", EXIT_NO_SIDECAR)
            self.sleep(SPAWN_INTERVAL)

    def _start(self) -> Target:
        self.notify("ヘッドレスの Papeer を起動しています…")
        for _ in range(MAX_STARTS):
            token = secrets.token_hex(32)
            outcome = self._wait_ready(self._spawn(token), token)
            if isinstance(outcome, Target):
                return outcome
            if outcome != EXIT_LIBRARY_IN_USE:
                raise CliError(f"ヘッドレスの Papeer が起動できませんでした（終了コード {outcome}）。"
                               f"ログ: {log_directory() / 'sidecar.log'}", EXIT_NO_SIDECAR)
            # Another sidecar has the library (a window's that is starting, or one that started a moment
            # before this one): it is the one to talk to, once it listens.
            target = self._wait_for_sidecar(IN_USE_WAIT)
            if target is not None:
                return target
        raise CliError("ライブラリは別の Papeer が使用中ですが、接続できませんでした。", EXIT_NO_SIDECAR)

    # --- Asking a sidecar of ours to leave (`server stop`) ---

    def wait_gone(self, target: Target, seconds: float) -> bool:
        """Wait until the sidecar `target` no longer serves the library; whether it went in time."""
        deadline = self.clock() + seconds
        while True:
            info = discovery.read_instance(self.root)
            if info is None or info.pid != target.pid or not discovery.holder_alive_hint(info):
                return True
            if self.clock() >= deadline:
                return False
            self.sleep(0.2)
