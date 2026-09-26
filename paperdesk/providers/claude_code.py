"""Claude through the Claude Code CLI, signed in with the user's Claude account."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile

from paperdesk.providers.base import OptionField, ProviderBackend, ProviderSpec
from paperdesk.providers.common import (
    CliBackend, json_lines, remember_limits, run_cli_process, to_int, wrap_document_prompt,
)

_ALIASES = [("sonnet", "sonnet (最新 Claude Sonnet)"), ("opus", "opus (Claude Opus)"), ("haiku", "haiku (Claude Haiku)")]
_FALLBACK_MODELS = _ALIASES + [("claude-sonnet-4-6", "claude-sonnet-4-6")]
# Values accepted by `claude --effort`.
_FALLBACK_EFFORTS = ["low", "medium", "high", "xhigh", "max"]
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
        fields=(OptionField("cli_path", "Claude Code のパス", "空欄なら自動検出（claude.cmd など）"),),
    )
    executable = "claude"
    windows_candidates = (
        "USERPROFILE/.local/bin/claude.exe",
        "LOCALAPPDATA/Programs/Claude/claude.exe",
        "APPDATA/npm/claude.cmd",
    )
    npm_entry = "@anthropic-ai/claude-code/bin/claude.js"
    missing_message = "Claude Code CLIが見つかりません。READMEの接続準備を行ってください。"
    tool_name = "Claude Code"
    login_args = ("auth", "login")
    status_args = ("auth", "status")

    def _generate(self, instruction: str, data: str, schema: dict | None) -> str:
        with tempfile.TemporaryDirectory(prefix="paperdesk-claude-") as directory:
            root = Path(directory)
            command = self.command() + [
                "-p",
                "--tools", "",
                "--no-session-persistence",
                # stream-json (which needs --verbose) is the only format that also reports plan usage.
                "--output-format", "stream-json", "--verbose",
            ]
            if self.settings.model.strip():
                command += ["--model", self.settings.model.strip()]
            if self.settings.reasoning_effort:
                command += ["--effort", self.settings.reasoning_effort]
            if schema is not None:
                command += ["--json-schema", json.dumps(schema)]
            output, _ = run_cli_process(
                command=command,
                prompt_bytes=wrap_document_prompt(instruction, data).encode("utf-8"),
                cancel=self.cancel,
                timeout_seconds=self.settings.timeout_seconds,
                tool_name=self.tool_name,
                root=root,
            )
            events = json_lines(output)
            result = next((e for e in reversed(events) if e.get("type") == "result"), None)
            for event in events:
                if event.get("type") == "rate_limit_event" and isinstance(event.get("rate_limit_info"), dict):
                    remember_limits(self.spec.id, claude_limit_windows(event["rate_limit_info"]))
            if result is None:
                return output  # an older CLI that printed plain text
            if result.get("is_error") or not isinstance(result.get("result"), str):
                detail = result.get("result") if isinstance(result.get("result"), str) else result.get("subtype", "")
                raise RuntimeError("Claude Code接続に失敗しました。ログイン状態・利用枠を確認してください。\n" + str(detail)[-1800:])
            usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
            cache_read = to_int(usage.get("cache_read_input_tokens"))
            self.usage.add(
                input_tokens=to_int(usage.get("input_tokens")) + to_int(usage.get("cache_creation_input_tokens")) + cache_read,
                cached_tokens=cache_read,
                output_tokens=to_int(usage.get("output_tokens")),
                reasoning_tokens=to_int((usage.get("output_tokens_details") or {}).get("thinking_tokens")),
                cost_usd=result.get("total_cost_usd"))
            answer = result["result"].strip()
            if not answer:
                raise RuntimeError("Claude Codeの回答が空でした。")
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
        except Exception:
            pass
        return models or list(_FALLBACK_MODELS)

    def list_efforts(self, model: str = "") -> list[tuple[str, str]]:
        options: list[tuple[str, str]] = []
        try:
            for m in _catalog_models():
                if m.get("id") == model or m.get("short_name", "").lower() == model.lower():
                    options = [(o["id"], o["id"]) for o in m.get("thinking", {}).get("effort_options", []) if o.get("id")]
                    break
        except Exception:
            pass
        return [("", "既定値（モデル・CLIに任せる）")] + (options or [(e, e) for e in _FALLBACK_EFFORTS])
