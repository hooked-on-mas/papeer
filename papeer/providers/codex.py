"""ChatGPT through the Codex CLI, signed in with the user's ChatGPT account."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import tomllib

from papeer.providers.base import OptionField, ProviderBackend, ProviderSpec
from papeer.providers.common import (
    CliBackend, hidden_window, json_lines, kill_tree, process_kwargs, remember_limits, run_cli_process,
    to_int, window_label, wrap_document_prompt,
)

_FALLBACK_MODELS = [
    ("gpt-5.6-sol", "gpt-5.6-sol — 推奨"),
    ("gpt-5.6-terra", "gpt-5.6-terra — バランス"),
    ("gpt-6-astra", "gpt-6-astra"),
    ("o3-mini", "o3-mini"),
]

_EFFORTS = [
    ("", "既定値（接続先に任せる）"),
    ("low", "low — 少なめ"),
    ("medium", "medium — 標準"),
    ("high", "high — 多め"),
    ("xhigh", "xhigh — さらに多め"),
]


# Codex takes MCP server names of letters, digits, "_" and "-" only, and `-c mcp_servers.<name>.enabled=false`
# splits the dotted path on "." without accepting quoted keys, so no other name can be addressed anyway.
_MCP_SERVER_NAME = re.compile(r"[A-Za-z0-9_-]+")
# For a config.toml tomllib cannot read: the [mcp_servers.<name>] and [mcp_servers.<name>.env] headings,
# also with the name quoted ([mcp_servers."unreal-mcp"]). Accepted shortcut: a line inside a multi-line
# string that looks like such a heading is taken too. Naming a server that is not configured fails the
# run (no_mcp_overrides), which is still better than leaving servers on.
_MCP_SERVER_HEADING = re.compile(r'^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*"?([A-Za-z0-9_-]+)"?[ \t]*[\].]', re.MULTILINE)


def configured_mcp_servers() -> list[str]:
    """Names of the MCP servers in Codex's config.toml ($CODEX_HOME, default ~/.codex)."""
    home = os.environ.get("CODEX_HOME") or str(Path.home() / ".codex")
    try:
        raw = (Path(home) / "config.toml").read_bytes()
    except OSError:
        return []
    try:
        servers = tomllib.loads(raw.decode("utf-8")).get("mcp_servers")
    except ValueError:  # Also UnicodeDecodeError. Switching off what the headings name beats leaving all on.
        return list(dict.fromkeys(_MCP_SERVER_HEADING.findall(raw.decode("utf-8", "replace"))))
    return [name for name in servers if _MCP_SERVER_NAME.fullmatch(name)] if isinstance(servers, dict) else []


def no_mcp_overrides() -> list[str]:
    """-c options that keep MCP servers away from a codex exec reading an untrusted document.

    Overriding mcp_servers with an empty table does not work (-c merges tables), so each server in
    config.toml is disabled by name; naming a server that is not configured would fail the run.
    Plugins and apps (connectors) bring their own servers and are switched off as features;
    features.* via -c, unlike --disable, does not fail on a CLI that lacks the feature.
    """
    overrides = ["-c", "features.plugins=false", "-c", "features.apps=false"]
    for name in configured_mcp_servers():
        overrides += ["-c", f"mcp_servers.{name}.enabled=false"]
    return overrides


def codex_limit_windows(limits: dict) -> list[dict]:
    windows = []
    for name in ("primary", "secondary"):
        window = limits.get(name)
        if isinstance(window, dict) and isinstance(window.get("usedPercent"), (int, float)):
            windows.append({"label": window_label(to_int(window.get("windowDurationMins"))),
                            "used_percent": float(window["usedPercent"]), "resets_at": window.get("resetsAt")})
    return windows


class CodexProvider(CliBackend, ProviderBackend):
    spec = ProviderSpec(
        id="codex",
        label="ChatGPT / Codex CLI",
        description="Codex CLI のログインで ChatGPT の利用枠を使います",
        kind="cli",
        needs_login=True,
        login_service="ChatGPT",
        fields=(OptionField("cli_path", "Codex のパス", "空欄なら自動検出（codex.cmd など）"),),
    )
    executable = "codex"
    windows_candidates = ("APPDATA/npm/codex.cmd",)
    npm_entry = "@openai/codex/bin/codex.js"
    missing_message = "Codex CLIが見つかりません。READMEの接続準備を行ってください。"
    tool_name = "Codex"
    login_args = ("login",)
    status_args = ("login", "status")

    def _generate(self, instruction: str, data: str, schema: dict | None) -> str:
        with tempfile.TemporaryDirectory(prefix="papeer-") as directory:
            root = Path(directory)
            output = root / "answer.txt"
            command = self.command() + [
                "--ask-for-approval", "never", "exec", "--skip-git-repo-check",
                "--ephemeral", "--sandbox", "read-only",
                "-c", "features.shell_tool=false", "-c", "features.unified_exec=false",
                "-c", "web_search=\"disabled\"",
                *no_mcp_overrides(),
                "--output-last-message", str(output),
                "--json",
            ]
            if self.settings.model.strip():
                command += ["--model", self.settings.model.strip()]
            if self.settings.reasoning_effort:
                command += ["-c", "model_reasoning_effort=" + json.dumps(self.settings.reasoning_effort)]
            if schema is not None:
                schema_path = root / "schema.json"
                schema_path.write_text(json.dumps(schema), "utf-8")
                command += ["--output-schema", str(schema_path)]
            command.append("-")
            answer, events = run_cli_process(
                command=command,
                prompt_bytes=wrap_document_prompt(instruction, data).encode("utf-8"),
                cancel=self.cancel,
                timeout_seconds=self.settings.timeout_seconds,
                tool_name=self.tool_name,
                root=root,
                output_file=output,
            )
            for event in json_lines(events):
                usage = event.get("usage")
                if event.get("type") == "turn.completed" and isinstance(usage, dict):
                    self.usage.add(input_tokens=to_int(usage.get("input_tokens")),
                                   cached_tokens=to_int(usage.get("cached_input_tokens")),
                                   output_tokens=to_int(usage.get("output_tokens")),
                                   reasoning_tokens=to_int(usage.get("reasoning_output_tokens")))
            return answer

    def list_models(self) -> list[tuple[str, str]]:
        models: list[tuple[str, str]] = []
        try:
            res = subprocess.run(self.command() + ["debug", "models"], capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", timeout=15, **hidden_window())
            if res.returncode == 0 and res.stdout:
                for item in json.loads(res.stdout).get("models", []):
                    slug = item.get("slug")
                    if slug:
                        name = item.get("display_name") or slug
                        models.append((slug, f"{slug} — {name}" if name != slug else slug))
        except Exception:
            pass
        return models or list(_FALLBACK_MODELS)

    def list_efforts(self, model: str = "") -> list[tuple[str, str]]:
        return list(_EFFORTS)

    def limits(self) -> dict | None:
        """Codex reports plan usage only when asked, through its app-server."""
        remember_limits(self.spec.id, self.query_limits())
        return super().limits()

    def query_limits(self, timeout: float = 20) -> list[dict]:
        """Ask Codex's app-server for the plan usage that its /status screen shows."""
        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "papeer", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read"},
        ]
        with tempfile.TemporaryDirectory(prefix="papeer-codex-") as directory:
            process = subprocess.Popen(self.command() + ["app-server"], cwd=directory,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       **process_kwargs())
            answer: dict = {}

            def read() -> None:
                assert process.stdout is not None
                for line in process.stdout:
                    try:
                        message = json.loads(line)
                    except ValueError:
                        continue
                    if isinstance(message, dict) and message.get("id") == 2:
                        answer.update(message)
                        return

            try:
                assert process.stdin is not None
                process.stdin.write("".join(json.dumps(r) + "\n" for r in requests).encode())
                process.stdin.flush()
                reader = threading.Thread(target=read, daemon=True)
                reader.start()
                reader.join(timeout)
            finally:
                kill_tree(process)
        result = answer.get("result")
        if not isinstance(result, dict) or not isinstance(result.get("rateLimits"), dict):
            raise RuntimeError("Codexの利用状況を取得できませんでした。")
        return codex_limit_windows(result["rateLimits"])
