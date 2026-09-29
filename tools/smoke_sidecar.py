"""Smoke-test the packaged sidecar exe before it goes into an installer (`just smoke-sidecar`).

Starts dist/sidecar/papeer-sidecar.exe (the onedir bundle `just build-sidecar` makes from sidecar.spec)
the way Tauri does, with a random token and a free port, but in a throwaway environment: the data folder,
LOCALAPPDATA and TEMP all point into a new temporary folder, so the user's library and device settings are
never read or written, and it shows exactly that nothing is unpacked into %TEMP% (a PyInstaller onefile
exe would make a _MEI* folder there, and leave it behind when killed). Then:

1. /health answers; `version` is this checkout's MAJOR.MINOR.PATCH and `code_version` matches its
   extraction, layout and PDF drawing code (papeer.core.code_version.RENDER_SOURCES). An exe built
   before the version or that code changed fails here (rebuild it); a change to any other code does
   not show in either value and is not noticed here (`just check-sidecar` compares the whole bundle).
2. Authentication: routes refuse a missing or wrong token (401) and accept the right one, in the
   Authorization header and in the `token` query parameter.
3. The bundled prompts are the ones in papeer/core/prompts, and settings can be saved.
4. The sample PDF (tests/fixtures/sample.pdf) is imported and its text extracted and searchable.
5. It is translated through a stand-in OpenAI-compatible server that this script runs on 127.0.0.1
   (never a real AI, nothing leaves the PC), so translated.pdf is typeset with the bundled Japanese
   fonts: the check reads the fonts and text of that PDF. The instructions it receives must have
   the shared prompt sections (papeer/core/prompts/_*.txt) in place of their markers.
6. /shutdown: the process ends by itself with exit code 0, and no _MEI* folder was made at any point.

Each step prints OK; the first failure prints what went wrong and the end of the sidecar's log,
and the exit code is 1. The sidecar is stopped (killed if need be) and the temporary folder removed
in every case, unless --keep asks to keep it for a look. `--source` runs the same checks against
`python -m sidecar` from this checkout instead of the exe (no _MEI* checks), to try the script itself.
`--exe` names another launcher, such as the one in a folder an installer was unpacked to.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterator
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.append(str(ROOT))

from papeer import __version__  # noqa: E402
from papeer.core.code_version import SIDECAR_DIR, SIDECAR_EXE, source_version  # noqa: E402
from tools.bump_version import SEMVER  # noqa: E402 (the release version rule: MAJOR.MINOR.PATCH)

# PyInstaller's output (sidecar.spec COLLECT); tools/place_sidecar.py copies the folder to SIDECAR_DIR once this passes.
DEFAULT_EXE = ROOT / "dist" / SIDECAR_DIR.name / SIDECAR_EXE.name
SAMPLE_PDF = ROOT / "tests" / "fixtures" / "sample.pdf"
PROMPT_DIR = ROOT / "papeer" / "core" / "prompts"

# Antivirus scanning can make the first launch of a new build slow. /shutdown itself waits up to 25 s
# for jobs and requests (routes/system.py).
HEALTH_TIMEOUT = 120.0
JOB_TIMEOUT = 300.0
EXIT_TIMEOUT = 45.0

# papeer.layout.math_layout.MATH_TOKEN (tests/test_smoke_sidecar.py keeps the two the same).
MATH_TOKEN = re.compile(r"\[\[PD_MATH_[A-Za-z0-9_]+\]\]")
# What OpenAICompatProvider appends to the instruction of a structured (JSON) request.
SCHEMA_MARKER = "Return JSON only, matching this schema"
# A shared prompt section left unreplaced (papeer.core.prompts._SHARED).
SHARED_MARKER = re.compile(r"\{\{[a-z_]+\}\}")
STUB_TEXT = "スモークテストの訳文です。適応制御の追従誤差を検証した。"
STUB_MODEL = "papeer-smoke-stub"

# Launch variables that must not reach the sidecar: another token, data folder or no-auth flag
# (PAPEER_*/PAPERDESK_*) and real API keys (the stand-in server needs none).
INHERITED_PREFIXES = ("PAPEER_", "PAPERDESK_")
API_KEY_VARIABLES = frozenset({"OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"})


class SmokeFailure(Exception):
    """A check failed; the message says what was expected."""


# --- Pure helpers (tests/test_smoke_sidecar.py) ---

def is_semver(value: Any) -> bool:
    return isinstance(value, str) and SEMVER.fullmatch(value) is not None


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def sidecar_environment(base: dict[str, str], *, data_dir: Path, local_appdata: Path, temp_dir: Path,
                        token: str, port: int) -> dict[str, str]:
    """The sidecar's environment: the caller's, minus Papeer variables and API keys, plus the smoke folders."""
    env = {name: value for name, value in base.items()
           if not name.upper().startswith(INHERITED_PREFIXES) and name.upper() not in API_KEY_VARIABLES}
    env.update({
        "PAPEER_DATA_DIR": str(data_dir),
        # Device settings (PapeerSync) and anything else under LOCALAPPDATA stay in the smoke folder.
        "LOCALAPPDATA": str(local_appdata),
        # A onefile bootloader would unpack into %TEMP% (GetTempPath reads TMP first): a folder of our
        # own shows that the onedir sidecar makes no _MEI* folder.
        "TEMP": str(temp_dir),
        "TMP": str(temp_dir),
        "PAPEER_TOKEN": token,
        "PAPEER_PORT": str(port),
        # The stand-in AI server is on 127.0.0.1: never send its requests through a system proxy.
        "NO_PROXY": "127.0.0.1,localhost",
    })
    return env


def mei_folders(temp_dir: Path) -> list[Path]:
    """PyInstaller onefile extraction folders in temp_dir (the onedir sidecar makes none)."""
    if not temp_dir.is_dir():
        return []
    return sorted(path for path in temp_dir.glob("_MEI*") if path.is_dir())


def check_health(body: Any, expected_version: str, expected_code: str) -> None:
    if not isinstance(body, dict) or body.get("status") != "ok":
        raise SmokeFailure(f"/health の応答が不正です: {body!r}")
    version = body.get("version")
    if not is_semver(version):
        raise SmokeFailure(f"/health の version が MAJOR.MINOR.PATCH ではありません: {version!r}")
    if version != expected_version:
        raise SmokeFailure(f"/health の version {version} がソースの版 {expected_version} と違います。"
                           "`just build-sidecar` で作り直してください。")
    code = body.get("code_version")
    if code != expected_code:
        raise SmokeFailure(f"/health の code_version がソースと一致しません（exe: {code}, ソース: {expected_code}）。"
                           "exe が古い可能性があります。`just build-sidecar` で作り直してください。")


def job_outcome(job: Any, job_id: str) -> dict[str, Any] | None:
    """The finished job from GET /api/jobs/{job_id}, None while it runs; SmokeFailure when it failed or was cancelled."""
    if not isinstance(job, dict) or job.get("job_id") != job_id:
        raise SmokeFailure(f"ジョブ {job_id} の応答が不正です: {job!r}")
    if job.get("running"):
        return None
    if job.get("status") != "succeeded":
        raise SmokeFailure(f"ジョブ {job.get('kind')} が {job.get('status')} で終わりました: {job.get('error')}")
    return job


def stub_answer(instruction: str, data: str) -> str:
    """The stand-in AI's reply, shaped like tests/test_workflow.py's FakeProvider."""
    if SCHEMA_MARKER not in instruction:
        return STUB_TEXT
    payload = json.loads(data)
    if isinstance(payload, dict) and "source_parts" in payload:
        # Formula-marker recovery: keep every math part, replace the prose.
        parts = [part if part.get("kind") == "math" else {"kind": "text", "text": STUB_TEXT}
                 for part in payload["source_parts"]]
        return json.dumps({"parts": parts}, ensure_ascii=False)
    # The first request of a batch sends {"blocks": [...]}, the fallback {"texts": [...]}.
    units = (payload.get("blocks", payload.get("texts", payload)) if isinstance(payload, dict) else payload)
    if not isinstance(units, list):
        return json.dumps({"translations": []})
    return json.dumps({"translations": [
        {"id": unit["id"], "text": " ".join([STUB_TEXT, *MATH_TOKEN.findall(unit.get("text", ""))])}
        for unit in units]}, ensure_ascii=False)


def expected_prompts(folder: Path = PROMPT_DIR) -> dict[str, str]:
    """The built-in prompts as papeer.core.prompts.defaults() returns them.

    Files starting with "_" are sections shared by several prompts, not prompts; that they are
    bundled shows in the translation requests (StubAI.unexpanded).
    """
    return {path.stem: path.read_text("utf-8").strip() for path in sorted(folder.glob("*.txt"))
            if not path.stem.startswith("_")}


def pdf_fonts_and_text(data: bytes) -> tuple[set[str], str]:
    import pymupdf

    with pymupdf.open(stream=data, filetype="pdf") as pdf:
        fonts = {font[3] for page in pdf for font in page.get_fonts()}
        text = "".join(str(page.get_text()) for page in pdf)
    return fonts, text


def check_translated_pdf(data: bytes) -> None:
    if not data.startswith(b"%PDF"):
        raise SmokeFailure("translated.pdf が PDF ではありません。")
    fonts, text = pdf_fonts_and_text(data)
    if not any("PapeerSerif" in name for name in fonts):
        raise SmokeFailure(f"translated.pdf に同梱の日本語フォント（PapeerSerif）が埋め込まれていません: {sorted(fonts)}")
    if STUB_TEXT[:8] not in text.replace("\n", ""):
        raise SmokeFailure("translated.pdf に訳文がありません。")


def log_tail(path: Path, lines: int = 40) -> str:
    if not path.is_file():
        return ""
    data = path.read_bytes()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("mbcs" if os.name == "nt" else "latin-1", errors="replace")
    return "\n".join(text.splitlines()[-lines:])


# --- The stand-in OpenAI-compatible server ---

class StubAI:
    """/v1/chat/completions on 127.0.0.1 that answers every request with stub_answer.

    `unexpanded` counts instructions still holding a {{name}} marker of a shared prompt section
    (papeer.core.prompts.expand), which happens when the section's file is not bundled.
    """

    def __init__(self) -> None:
        self.requests = 0
        self.unexpanded = 0
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler's naming)
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                if not self.path.endswith("/chat/completions"):
                    self.send_error(404)
                    return
                try:
                    messages = json.loads(body)["messages"]
                    content = stub_answer(messages[0]["content"], messages[-1]["content"])
                except (ValueError, KeyError, IndexError, TypeError) as exc:
                    self.send_error(400, str(exc))
                    return
                stub.requests += 1
                if SHARED_MARKER.search(messages[0]["content"]):
                    stub.unexpanded += 1
                reply = json.dumps({"choices": [{"message": {"role": "assistant", "content": content},
                                                 "finish_reason": "stop"}],
                                    "usage": {"prompt_tokens": 1, "completion_tokens": 1}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, name="stub-ai", daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def __enter__(self) -> "StubAI":
        self.thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()


# --- Talking to the sidecar ---

@dataclass
class Reply:
    status: int
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body)


class Client:
    def __init__(self, port: int, token: str) -> None:
        self.base = f"http://127.0.0.1:{port}"
        self.token = token
        # 127.0.0.1 only: a proxy from the environment or the Windows settings must not get in between.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method: str, path: str, *, token: str | None = None, body: Any = None,
                query: dict[str, str] | None = None, timeout: float = 30.0) -> Reply:
        url = self.base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if data is not None else {}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        try:
            with self.opener.open(urllib.request.Request(url, data=data, headers=headers, method=method),
                                  timeout=timeout) as response:
                return Reply(response.status, response.read())
        except urllib.error.HTTPError as error:
            return Reply(error.code, error.read())

    def call(self, method: str, path: str, **kwargs: Any) -> Any:
        """An authenticated request that must succeed; its JSON body."""
        reply = self.request(method, path, token=self.token, **kwargs)
        if reply.status != 200:
            raise SmokeFailure(f"{method} {path} が HTTP {reply.status} を返しました: "
                               f"{reply.body[:500].decode('utf-8', 'replace')}")
        return reply.json()


class Smoke:
    def __init__(self, command: list[str], cwd: Path, root: Path, frozen: bool, out: Any) -> None:
        self.command = command
        self.cwd = cwd
        self.frozen = frozen
        self.out = out
        self.data_dir = root / "data"
        self.local_appdata = root / "localappdata"
        self.temp_dir = root / "temp"
        self.log_path = root / "sidecar.log"
        self.input_dir = root / "input"
        for folder in (self.data_dir, self.local_appdata, self.temp_dir, self.input_dir):
            folder.mkdir(parents=True)
        self.token = secrets.token_urlsafe(32)
        self.port = free_port()
        self.client = Client(self.port, self.token)
        self.process: subprocess.Popen | None = None
        self._log_file: Any = None

    @contextmanager
    def step(self, name: str) -> Iterator[None]:
        started = time.monotonic()
        try:
            yield
        except SmokeFailure as exc:
            raise SmokeFailure(f"{name}: {exc}") from None
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise SmokeFailure(f"{name}: {type(exc).__name__}: {exc}") from exc
        print(f"OK  {name} ({time.monotonic() - started:.1f} 秒)", file=self.out, flush=True)

    def alive(self) -> None:
        if self.process is not None and self.process.poll() is not None:
            raise SmokeFailure(f"sidecar が終了しました（終了コード {self.process.returncode}）。")

    def start(self) -> None:
        env = sidecar_environment(dict(os.environ), data_dir=self.data_dir, local_appdata=self.local_appdata,
                                  temp_dir=self.temp_dir, token=self.token, port=self.port)
        self._log_file = self.log_path.open("wb")
        self.process = subprocess.Popen(self.command, cwd=self.cwd, env=env, stdin=subprocess.DEVNULL,
                                        stdout=self._log_file, stderr=subprocess.STDOUT)

    def wait_for_health(self) -> Any:
        deadline = time.monotonic() + HEALTH_TIMEOUT
        while True:
            self.alive()
            try:
                reply = self.client.request("GET", "/health", timeout=5)
                if reply.status == 200:
                    return reply.json()
            except (urllib.error.URLError, ConnectionError, TimeoutError, socket.timeout):
                pass
            if time.monotonic() > deadline:
                raise SmokeFailure(f"{HEALTH_TIMEOUT:.0f} 秒待っても /health が応答しません。")
            time.sleep(0.25)

    def wait_for_job(self, job_id: str) -> dict[str, Any]:
        # The sidecar keeps the last finished jobs (FINISHED_JOBS_KEPT in sidecar/jobs.py).
        deadline = time.monotonic() + JOB_TIMEOUT
        while True:
            self.alive()
            job = job_outcome(self.client.call("GET", f"/api/jobs/{job_id}"), job_id)
            if job is not None:
                return job
            if time.monotonic() > deadline:
                raise SmokeFailure(f"ジョブ {job_id} が {JOB_TIMEOUT:.0f} 秒で終わりません。")
            time.sleep(0.25)

    def run(self) -> None:
        with StubAI() as stub:
            with self.step("起動と /health"):
                self.start()
                check_health(self.wait_for_health(), __version__, source_version(ROOT))
                self.check_nothing_unpacked()
            with self.step("認証（トークンなし・誤り 401、正しいトークン 200）"):
                self.check_authentication()
            with self.step("同梱のプロンプトと設定の保存"):
                self.check_prompts_and_settings(stub)
            with self.step("サンプル PDF の取り込みとテキスト抽出"):
                paper_id = self.check_import()
            with self.step("翻訳（ローカルの代役 API）と同梱フォントでの PDF 作成"):
                self.check_translation(paper_id, stub)
            with self.step("/shutdown で終了"):
                self.check_shutdown()
            with self.step("ログにエラーがないこと"):
                if "Traceback" in log_tail(self.log_path, lines=100_000):
                    raise SmokeFailure("sidecar のログに Traceback があります。")

    def check_authentication(self) -> None:
        cases = [
            ("GET", "/api/settings", None, None, 401),
            ("GET", "/api/settings", "not-the-token", None, 401),
            ("GET", "/api/settings", None, {"token": "not-the-token"}, 401),
            ("POST", "/shutdown", None, None, 401),
            ("GET", "/api/settings", self.token, None, 200),
            ("GET", "/api/jobs", None, {"token": self.token}, 200),
        ]
        for method, path, token, query, expected in cases:
            reply = self.client.request(method, path, token=token, query=query)
            if reply.status != expected:
                how = "正しいトークン" if self.token in (token, (query or {}).get("token")) else "トークンなし・誤り"
                raise SmokeFailure(f"{method} {path}（{how}）が HTTP {reply.status} を返しました（期待: {expected}）。")

    def check_prompts_and_settings(self, stub: StubAI) -> None:
        expected = expected_prompts()
        for path in ("/api/prompts/defaults", "/api/prompts"):
            if self.client.call("GET", path) != expected:
                raise SmokeFailure(f"{path} が papeer/core/prompts の内容と一致しません。")
        self.client.call("PUT", "/api/settings", body={
            "provider": "api", "model": STUB_MODEL, "translation_concurrency": 1,
            "provider_options": {"api": {"base_url": stub.base_url, "model": STUB_MODEL}}})
        settings = self.client.call("GET", "/api/settings")
        if settings.get("provider") != "api" or settings["provider_options"]["api"].get("base_url") != stub.base_url:
            raise SmokeFailure(f"保存した設定が読み戻せません: {settings!r}")
        # The API URL is this PC's setting (LOCALAPPDATA\\PapeerSync), the rest the library's.
        if not (self.data_dir / "settings.json").is_file() or not (self.local_appdata / "PapeerSync").is_dir():
            raise SmokeFailure("設定が一時データフォルダー・一時 LOCALAPPDATA に保存されていません。")

    def check_import(self) -> str:
        source = self.input_dir / "smoke-sample.pdf"
        shutil.copy2(SAMPLE_PDF, source)
        started = self.client.call("POST", "/api/papers/import", body={"paths": [str(source)]})
        job = self.wait_for_job(started["job_id"])
        paper_ids = job["result"]["paper_ids"]
        if len(paper_ids) != 1:
            raise SmokeFailure(f"取り込み結果が不正です: {job['result']!r}")
        paper_id = paper_ids[0]
        paper = self.client.call("GET", f"/api/papers/{paper_id}")
        if paper.get("pages") != 2:
            raise SmokeFailure(f"ページ数が 2 ではありません: {paper.get('pages')!r}")
        found = self.client.call("GET", f"/api/papers/{paper_id}/search", query={"q": "adaptive controller"})
        if not found.get("total"):
            raise SmokeFailure("抽出したテキストから \"adaptive controller\" が見つかりません。")
        return paper_id

    def check_translation(self, paper_id: str, stub: StubAI) -> None:
        started = self.client.call("POST", f"/api/papers/{paper_id}/translate", body={})
        self.wait_for_job(started["job_id"])
        if not stub.requests:
            raise SmokeFailure("代役 API に翻訳のリクエストが届いていません。")
        if stub.unexpanded:
            raise SmokeFailure("翻訳の指示に共通部分の目印（{{...}}）が残っています。"
                               "papeer/core/prompts/_*.txt が同梱されていない可能性があります。")
        reply = self.client.request("GET", f"/api/papers/{paper_id}/files/translated.pdf", token=self.token)
        if reply.status != 200:
            raise SmokeFailure(f"translated.pdf を取得できません（HTTP {reply.status}）。")
        check_translated_pdf(reply.body)

    def check_shutdown(self) -> None:
        assert self.process is not None
        body = self.client.call("POST", "/shutdown")
        if body.get("status") != "shutting down" or not body.get("stopped"):
            raise SmokeFailure(f"/shutdown の応答が不正です: {body!r}")
        try:
            code = self.process.wait(EXIT_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise SmokeFailure(f"/shutdown の後 {EXIT_TIMEOUT:.0f} 秒たってもプロセスが終了しません。") from None
        if code != 0:
            raise SmokeFailure(f"終了コードが 0 ではありません: {code}")
        self.check_nothing_unpacked()

    def check_nothing_unpacked(self) -> None:
        """The onedir sidecar runs from its folder; a _MEI* folder means a onefile exe (see sidecar.spec)."""
        found = mei_folders(self.temp_dir) if self.frozen else []
        if found:
            raise SmokeFailure("一時フォルダーに展開フォルダーが作られました（onefile の exe では？ sidecar.spec は onedir）: "
                               + ", ".join(path.name for path in found))

    def stop(self) -> None:
        """Make sure the sidecar (and any process it started) is gone."""
        if self.process is not None and self.process.poll() is None:
            if os.name == "nt":
                # /T also ends the processes the sidecar started.
                subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            else:
                self.process.kill()
            try:
                self.process.wait(15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(15)
            print("sidecar を強制終了しました。", file=self.out)
        if self._log_file is not None:
            self._log_file.close()


def remove_tree(path: Path) -> bool:
    """Delete a folder; False if it is still there after a few seconds of retrying."""
    # A process that was just killed can hold its files for a moment.
    for attempt in range(10):
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            return True
        if attempt < 9:
            time.sleep(0.5)
    return False


def run_smoke(command: list[str], *, cwd: Path | None, frozen: bool, keep: bool = False, out: Any = None) -> int:
    """Run every check against `command`; 0 when all pass, 1 (after saying why) when one fails."""
    out = sys.stdout if out is None else out
    root = Path(tempfile.mkdtemp(prefix="papeer-smoke-"))
    smoke: Smoke | None = None
    try:
        # Inside the try: a failure while preparing the folders must not leave `root` behind either.
        smoke = Smoke(command, cwd or root, root, frozen, out)
        smoke.run()
    except SmokeFailure as exc:
        assert smoke is not None  # only smoke.run() raises SmokeFailure
        print(f"\nスモークテスト失敗: {exc}", file=out)
        smoke.stop()  # also closes the log file
        tail = log_tail(smoke.log_path)
        if tail:
            print("--- sidecar のログ（末尾） ---\n" + tail, file=out)
        return 1
    finally:
        if smoke is not None:
            smoke.stop()
        if keep:
            print(f"一時フォルダーを残しました: {root}", file=out)
        elif not remove_tree(root):
            print(f"一時フォルダーを消せませんでした: {root}", file=out)
    print("スモークテストに成功しました。", file=out)
    return 0


def main(argv: list[str] | None = None, out: Any = None) -> int:
    out = sys.stdout if out is None else out
    parser = argparse.ArgumentParser(description="配布用 sidecar exe のスモークテスト（README「ビルド」）")
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--exe", type=Path, default=DEFAULT_EXE,
                        help=f"試す sidecar（onedir のフォルダーの中の exe。既定: {DEFAULT_EXE.relative_to(ROOT)}）")
    target.add_argument("--source", action="store_true", help="exe ではなくこのチェックアウトの python -m sidecar を試す")
    parser.add_argument("--keep", action="store_true", help="一時フォルダー（データ・ログ）を消さずに残す")
    args = parser.parse_args(argv)

    if args.source:
        print("対象: python -m sidecar（ソース）", file=out)
        return run_smoke([sys.executable, "-m", "sidecar"], cwd=ROOT, frozen=False, keep=args.keep, out=out)
    exe = args.exe.resolve()
    if not exe.is_file():
        print(f"スモークテスト失敗: {exe} がありません。先に `just build-sidecar` を実行してください。", file=out)
        return 1
    print(f"対象: {exe}", file=out)
    return run_smoke([str(exe)], cwd=None, frozen=True, keep=args.keep, out=out)


if __name__ == "__main__":
    raise SystemExit(main())
