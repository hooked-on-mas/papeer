"""Gemini through the Antigravity CLI (agy), signed in with the user's Google account."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile

from papeer.providers.base import OptionField, ProviderBackend, ProviderSpec
from papeer.providers.common import AnswerRejected, CliBackend, cli_failure, hidden_window, json_lines, run_cli_process, to_int, wrap_document_prompt

_FALLBACK_MODELS = [
    ("gemini-3.8-flash-medium", "gemini-3.8-flash-medium (Gemini 3.8 Flash)"),
    ("gemini-3.8-flash-high", "gemini-3.8-flash-high (Gemini 3.8 Flash High)"),
    ("gemini-3.1-pro-high", "gemini-3.1-pro-high (Gemini 3.1 Pro High)"),
    ("gemini-3.8-flash-low", "gemini-3.8-flash-low (Gemini 3.8 Flash Low)"),
]
# agy accepts only these; the model name usually carries the effort already.
_EFFORTS = {"low", "medium", "high"}


def agy_result(events: list[dict]) -> dict | None:
    """The answer in agy's stream-json output: {"event": "result", "result": {status, response, usage}}."""
    for event in reversed(events):
        if event.get("event") == "result" and isinstance(event.get("result"), dict):
            return event["result"]
    return None


def agy_failure(output: str) -> str:
    """The error agy reported without a result event: an AGY_ERROR line or an event carrying "error"."""
    for line in reversed(output.splitlines()):
        if line.strip().startswith("AGY_ERROR:"):
            return line.strip()
    for event in reversed(json_lines(output)):
        payload = event.get(event["event"]) if isinstance(event.get("event"), str) else None
        error = event.get("error") or (payload.get("error") if isinstance(payload, dict) else None)
        if error:
            return str(error)
    return ""


class AntigravityProvider(CliBackend, ProviderBackend):
    spec = ProviderSpec(
        id="antigravity",
        label="Google Gemini (Antigravity CLI)",
        description="Antigravity CLI (agy) 経由で Gemini を使います",
        kind="cli",
        needs_login=True,
        login_service="Antigravity",
        fields=(OptionField("cli_path", "agy のパス", "空欄なら自動検出（agy.exe など）"),),
    )
    executable = "agy"
    windows_candidates = (
        "USERPROFILE/.gemini/bin/agy.exe",
        "LOCALAPPDATA/Programs/Antigravity/agy.exe",
    )
    missing_message = "Antigravity CLI (agy) が見つかりません。Antigravity CLI をインストールしてください。"
    tool_name = "Antigravity (agy)"
    login_args = ()  # Starting agy without a prompt opens its sign-in.
    status_args = ("models",)

    def _generate(self, instruction: str, data: str, schema: dict | None) -> str:
        with tempfile.TemporaryDirectory(prefix="papeer-agy-") as directory:
            root = Path(directory)
            prompt = wrap_document_prompt(instruction, data, schema, schema_in_prompt=True)
            # The prompt goes through stdin as one stream-json message: as a -p argument the whole
            # document would sit on the command line, which Windows cuts off at 32,767 characters.
            # "--print=" (attached and empty) keeps print mode without a command-line prompt.
            command = self.command() + ["--print=", "--input-format", "stream-json", "--output-format", "stream-json",
                                        "--disable-slash-commands", "--sandbox"]
            if self.settings.model.strip():
                command += ["--model", self.settings.model.strip()]
            if self.settings.reasoning_effort in _EFFORTS:
                command += ["--effort", self.settings.reasoning_effort]
            message = json.dumps({"event": "user", "message": {"content": prompt}}, ensure_ascii=False) + "\n"
            try:
                output, _ = run_cli_process(
                    command=command,
                    prompt_bytes=message.encode("utf-8"),
                    cancel=self.cancel,
                    timeout_seconds=self.settings.timeout_seconds,
                    tool_name=self.tool_name,
                    root=root,
                )
            except RuntimeError as exc:
                # Go's flag package on a version without stream-json input: "flag provided but not defined".
                if "provided but not defined" in str(exc):
                    raise RuntimeError(f"{self.tool_name}が古いため、本文を標準入力で渡せません。agy を更新してください。\n"
                                       + str(exc)[-1800:]) from exc
                raise
            result = agy_result(json_lines(output))
            if result is None:
                failure = agy_failure(output)
                if failure:
                    raise cli_failure(self.tool_name, failure)
                raise RuntimeError(f"{self.tool_name}の応答を読み取れませんでした。agy を更新してください。\n"
                                   + output[-1800:])
            if result.get("status") not in {None, "SUCCESS"} or not isinstance(result.get("response"), str):
                detail = result.get("error") or result.get("response") or result.get("status")
                # Sent again only for a status or error known to pass (UNAVAILABLE, DEADLINE_EXCEEDED, 503, ...).
                raise cli_failure(self.tool_name, str(detail), f"{result.get('status')}\n{detail}",
                                  known_temporary_only=True)
            usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
            self.usage.add(input_tokens=to_int(usage.get("input_tokens")),
                           cached_tokens=to_int(usage.get("cache_read_tokens")),
                           output_tokens=to_int(usage.get("output_tokens")),
                           reasoning_tokens=to_int(usage.get("thinking_tokens")))
            answer = result["response"].strip()
            if not answer:
                raise AnswerRejected(f"{self.tool_name}の回答が空でした。")
            return answer

    def list_models(self) -> list[tuple[str, str]]:
        models: list[tuple[str, str]] = []
        try:
            res = subprocess.run(self.command() + ["models"], capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", timeout=15, **hidden_window())
            if res.returncode == 0 and res.stdout:
                for line in res.stdout.splitlines():
                    line = line.strip()
                    if not line or line.startswith("Fetching"):
                        continue
                    m_id, _, m_desc = line.partition("\t")
                    m_id, m_desc = m_id.strip(), m_desc.strip()
                    models.append((m_id, f"{m_id} ({m_desc})" if m_desc else m_id))
        except Exception:
            pass
        return models or list(_FALLBACK_MODELS)

    def list_efforts(self, model: str = "") -> list[tuple[str, str]]:
        return []

    def check(self) -> str:
        result = self.run_status(timeout=30)
        if result.returncode:
            detail = (result.stderr or "").strip() or (result.stdout or "").strip()
            raise RuntimeError(f"{self.tool_name} の接続確認に失敗しました。\n" + detail)
        return f"{self.tool_name} の疎通を確認しました。"
