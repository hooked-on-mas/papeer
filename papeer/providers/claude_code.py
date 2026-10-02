"""Claude through the Claude Code CLI, signed in with the user's Claude account."""
from __future__ import annotations

import base64
import json
from pathlib import Path
import tempfile

from papeer.core.config import REASONING_EFFORTS
from papeer.providers.base import OptionField, ProviderBackend, ProviderSpec
from papeer.providers.common import (
    AnswerRejected, CliBackend, cli_exit_failure, cli_failure, cli_path_hint, json_lines, lasting_cli_failure, remember_limits,
    run_cli_process, to_int, wrap_document_prompt,
)

_ALIASES = [("sonnet", "sonnet (最新 Claude Sonnet)"), ("opus", "opus (Claude Opus)"), ("haiku", "haiku (Claude Haiku)")]
_FALLBACK_MODELS = _ALIASES + [("claude-sonnet-4-6", "claude-sonnet-4-6")]
# Values accepted by `claude --effort`.
_FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
# With --strict-mcp-config, the only MCP servers Claude Code loads: none.
_NO_MCP_SERVERS = json.dumps({"mcpServers": {}})
_WINDOWS = {"five_hour": "5時間枠", "seven_day": "7日枠", "seven_day_opus": "7日枠 (Opus)",
            "seven_day_sonnet": "7日枠 (Sonnet)"}


def claude_limit_windows(info: dict) -> list[dict]:
    """Windows from a Claude Code stream-json rate_limit_event; utilization is a 0-1 fraction."""
    windows = []
    for key, window in (info.get("unifiedWindows") or {}).items():
        if isinstance(window, dict) and isinstance(window.get("utilization"), (int, float)):
            windows.append({"label": _WINDOWS.get(key, key), "used_percent": window["utilization"] * 100,
                            "resets_at": window.get("resetsAt")})
    if not windows and isinstance(info.get("utilization"), (int, float)):
        key = info.get("rateLimitType", "")
        windows.append({"label": _WINDOWS.get(key, key or "利用枠"), "used_percent": info["utilization"] * 100,
                        "resets_at": info.get("resetsAt")})
    return windows


def claude_failure(result: dict, stderr: str = "") -> RuntimeError:
    """The error for a result event that reports a failure (is_error, or no answer text).

    A plan limit or a sign-in stays a lasting failure. Output the model had already written
    (usage.output_tokens) or a run ended by one of its own limits (subtype error_max_turns,
    error_max_budget_usd, ...) is a paid answer that cannot be used: AnswerRejected. Otherwise
    only an API error or dropped connection known to pass (API Error 5xx/529, overloaded,
    ECONNRESET, ...) is sent again.
    """
    text = result["result"] if isinstance(result.get("result"), str) else ""
    subtype = str(result.get("subtype") or "")
    detail = text or subtype
    evidence = "\n".join((stderr, text, subtype))
    usage = result["usage"] if isinstance(result.get("usage"), dict) else {}
    if not lasting_cli_failure(evidence) and (subtype.startswith("error_max_") or to_int(usage.get("output_tokens")) > 0):
        return AnswerRejected("Claude Codeの回答を使えませんでした。\n" + detail[-1800:])
    return cli_failure("Claude Code", detail, evidence, known_temporary_only=True)


def claude_exit_failure(stderr: str, stdout: str, returncode: int) -> RuntimeError:
    """The error for a nonzero exit: judged by its result event when it printed one (claude_failure),
    else by what it printed about the failure (cli_exit_failure: not its status or assistant events)."""
    result = next((e for e in reversed(json_lines(stdout)) if e.get("type") == "result"), None)
    if result is None:
        return cli_exit_failure("Claude Code", stderr, stdout, returncode)
    return claude_failure(result, stderr)


def _catalog_models() -> list[dict]:
    """Models from the newest catalog Claude Code keeps in ~/.claude."""
    files = sorted(Path.home().glob(".claude/cache/model-catalog/*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return []
    data = json.loads(files[0].read_text("utf-8"))
    return data.get("catalog", {}).get("config", {}).get("models", [])


class ClaudeCodeProvider(CliBackend, ProviderBackend):
    spec = ProviderSpec(
        id="claude",
        label="Claude Code CLI",
        description="Claude Code のログイン状態と利用枠を使います",
        kind="cli",
        needs_login=True,
        login_service="Claude",
        web_search=True,
        fields=(OptionField("cli_path", "Claude Code のパス", cli_path_hint("claude.cmd", "~/.local/bin/claude")),),
    )
    executable = "claude"
    windows_candidates = (
        "USERPROFILE/.local/bin/claude.exe",
        "LOCALAPPDATA/Programs/Claude/claude.exe",
        "APPDATA/npm/claude.cmd",
    )
    # The older install to the home folder (`claude migrate-installer` moved it to ~/.local/bin).
    posix_candidates = (".claude/local/claude",)
    npm_entry = "@anthropic-ai/claude-code/bin/claude.js"
    missing_message = "Claude Code CLIが見つかりません。READMEの接続準備を行ってください。"
    tool_name = "Claude Code"
    login_args = ("auth", "login")
    status_args = ("auth", "status")

    def _generate(self, instruction: str, data: str, schema: dict | None) -> str:
        return self._run(wrap_document_prompt(instruction, data).encode("utf-8"), schema)

    def search_web(self, instruction: str, data: str, schema: dict | None = None) -> str:
        return self._send(lambda: self._run(wrap_document_prompt(instruction, data).encode("utf-8"),
                                          schema, web_search=True))

    def image_support(self) -> str | None:
        return None

    def _generate_images(self, instruction: str, images: list[bytes], schema: dict | None) -> str:
        """The images go in one user message of stream-json input (base64 image blocks, as Claude Code's
        SDK sends them), so no tool that reads files is needed: tools stay off."""
        content = [{"type": "text", "text": wrap_document_prompt(instruction, "The document data is the images below.")}]
        content += [{"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                 "data": base64.b64encode(image).decode("ascii")}} for image in images]
        message = {"type": "user", "message": {"role": "user", "content": content}}
        return self._run((json.dumps(message) + "\n").encode("utf-8"), schema, stream_input=True)

    def _run(self, prompt: bytes, schema: dict | None, stream_input: bool = False, *, web_search: bool = False) -> str:
        with tempfile.TemporaryDirectory(prefix="papeer-claude-") as directory:
            root = Path(directory)
            command = self.command() + [
                "-p",
                # Only explicit research exposes web tools; file/shell tools stay unavailable.
                # MCP servers (--tools only covers the built-in set), project/local settings and skills stay off.
                "--tools", "WebSearch,WebFetch" if web_search else "",
                "--strict-mcp-config", "--mcp-config", _NO_MCP_SERVERS,
                "--setting-sources", "user",
                "--disable-slash-commands",
                "--no-session-persistence",
                # stream-json (which needs --verbose) is the only format that also reports plan usage.
                "--output-format", "stream-json", "--verbose",
            ]
            if web_search:
                command += ["--allowedTools", "WebSearch,WebFetch", "--permission-mode", "dontAsk"]
            if stream_input:
                command += ["--input-format", "stream-json"]
            if self.settings.model.strip():
                command += ["--model", self.settings.model.strip()]
            if self.settings.reasoning_effort:
                command += ["--effort", self.settings.reasoning_effort]
            if schema is not None:
                command += ["--json-schema", json.dumps(schema)]
            output, _ = run_cli_process(
                command=command,
                prompt_bytes=prompt,
                cancel=self.cancel,
                timeout_seconds=self.settings.timeout_seconds,
                tool_name=self.tool_name,
                root=root,
                failure=claude_exit_failure,
            )
            events = json_lines(output)
            result = next((e for e in reversed(events) if e.get("type") == "result"), None)
            for event in events:
                if event.get("type") == "rate_limit_event" and isinstance(event.get("rate_limit_info"), dict):
                    remember_limits(self.spec.id, claude_limit_windows(event["rate_limit_info"]))
            if result is None:
                return output  # an older CLI that printed plain text
            structured = result.get("structured_output") if schema is not None else None
            if result.get("is_error") or (not isinstance(structured, (dict, list))
                                          and not isinstance(result.get("result"), str)):
                raise claude_failure(result)
            usage = result["usage"] if isinstance(result.get("usage"), dict) else {}
            cache_read = to_int(usage.get("cache_read_input_tokens"))
            self.usage.add(
                input_tokens=to_int(usage.get("input_tokens")) + to_int(usage.get("cache_creation_input_tokens")) + cache_read,
                cached_tokens=cache_read,
                output_tokens=to_int(usage.get("output_tokens")),
                reasoning_tokens=to_int((usage.get("output_tokens_details") or {}).get("thinking_tokens")),
                cost_usd=result.get("total_cost_usd"))
            answer = json.dumps(structured, ensure_ascii=False) if isinstance(structured, (dict, list)) else result["result"].strip()
            if not answer:
                raise AnswerRejected("Claude Codeの回答が空でした。")
            return answer

    def list_models(self) -> list[tuple[str, str]]:
        models: list[tuple[str, str]] = []
        try:
            catalog = _catalog_models()
            if catalog:
                models = list(_ALIASES)
                seen = {alias for alias, _ in _ALIASES}
                for m in catalog:
                    m_id = m.get("id")
                    if m_id and m_id not in seen:
                        models.append((m_id, f"{m_id} ({m.get('name') or m_id})"))
                        seen.add(m_id)
        except Exception:  # noqa: BLE001, S110 - the list is only a help: without it, the usual models.
            pass
        return models or list(_FALLBACK_MODELS)

    def list_efforts(self, model: str = "") -> list[tuple[str, str]]:
        options: list[tuple[str, str]] = []
        try:
            for m in _catalog_models():
                if m.get("id") == model or m.get("short_name", "").lower() == model.lower():
                    options = [(o["id"], o["id"]) for o in m.get("thinking", {}).get("effort_options", [])
                               if o.get("id") in REASONING_EFFORTS]
                    break
        except Exception:  # noqa: BLE001, S110 - the list is only a help: without it, the usual efforts.
            pass
        return [("", "既定値（モデル・CLIに任せる）")] + (options or [(e, e) for e in _FALLBACK_EFFORTS])
