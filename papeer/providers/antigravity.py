"""Gemini through the Antigravity CLI (agy), signed in with the user's Google account."""
from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile

from papeer.providers.base import OptionField, ProviderBackend, ProviderSpec
from papeer.providers.common import CliBackend, hidden_window, json_lines, run_cli_process, to_int, wrap_document_prompt

_FALLBACK_MODELS = [
    ("gemini-3.8-flash-medium", "gemini-3.8-flash-medium (Gemini 3.8 Flash)"),
    ("gemini-3.8-flash-high", "gemini-3.8-flash-high (Gemini 3.8 Flash High)"),
    ("gemini-3.1-pro-high", "gemini-3.1-pro-high (Gemini 3.1 Pro High)"),
    ("gemini-3.8-flash-low", "gemini-3.8-flash-low (Gemini 3.8 Flash Low)"),
]
# agy accepts only these; the model name usually carries the effort already.
_EFFORTS = {"low", "medium", "high"}


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
            command = self.command() + ["-p", prompt, "--disable-slash-commands", "--sandbox", "--output-format", "json"]
            if self.settings.model.strip():
                command += ["--model", self.settings.model.strip()]
            if self.settings.reasoning_effort in _EFFORTS:
                command += ["--effort", self.settings.reasoning_effort]
            output, _ = run_cli_process(
                command=command,
                prompt_bytes=b"",
                cancel=self.cancel,
                timeout_seconds=self.settings.timeout_seconds,
                tool_name=self.tool_name,
                root=root,
            )
            result = next((e for e in json_lines(output) if "response" in e), None)
            if result is None:
                return output  # plain text from an older CLI
            if result.get("status") not in {None, "SUCCESS"} or not isinstance(result.get("response"), str):
                raise RuntimeError(f"{self.tool_name}接続に失敗しました。ログイン状態・利用枠を確認してください。\n"
                                   + str(result.get("response") or result.get("status"))[-1800:])
            usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
            self.usage.add(input_tokens=to_int(usage.get("input_tokens")),
                           cached_tokens=to_int(usage.get("cache_read_tokens")),
                           output_tokens=to_int(usage.get("output_tokens")),
                           reasoning_tokens=to_int(usage.get("thinking_tokens")))
            answer = result["response"].strip()
            if not answer:
                raise RuntimeError(f"{self.tool_name}の回答が空でした。")
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
