import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from papeer.core.config import Settings
from papeer.providers import create_provider, parse_json_answer
from papeer.providers.antigravity import AntigravityProvider
from papeer.providers.claude_code import ClaudeCodeProvider
from papeer.providers.codex import CodexProvider, codex_limit_windows

POPEN = "papeer.providers.common.subprocess.Popen"
RUN = "papeer.providers.common.subprocess.run"


def cli(provider_cls):
    """Patch a CLI connection so it runs the mocked process instead of looking for the real CLI."""
    return patch.object(provider_cls, "command", return_value=["cli"])


class ProvidersTests(unittest.TestCase):
    def test_parse_json_answer(self):
        self.assertEqual(parse_json_answer('{"a": 1}'), {"a": 1})
        self.assertEqual(parse_json_answer('```json\n{"a": 2}\n```'), {"a": 2})
        with self.assertRaises(ValueError):
            parse_json_answer("not a json")
        with self.assertRaises(ValueError):
            parse_json_answer('["list", "not", "dict"]')

    def test_cli_paths_are_saved_per_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = Settings(provider="claude", provider_options={
                "claude": {"cli_path": "C:/custom/claude.exe"}, "antigravity": {"cli_path": "C:/custom/agy.exe"}})
            settings.save(root)
            loaded = Settings.load(root)
            self.assertEqual(loaded.provider, "claude")
            self.assertEqual(loaded.options("claude")["cli_path"], "C:/custom/claude.exe")
            self.assertEqual(loaded.options("antigravity")["cli_path"], "C:/custom/agy.exe")

    def test_claude_command_detection(self):
        provider = ClaudeCodeProvider(Settings(provider="claude", provider_options={"claude": {"cli_path": "my-claude"}}))
        self.assertEqual(provider.command(), ["my-claude"])
        provider = ClaudeCodeProvider(Settings(provider="claude"))
        with patch("shutil.which", return_value="/usr/bin/claude"):
            self.assertEqual(provider.command(), [str(Path("/usr/bin/claude"))])
        with patch("shutil.which", return_value=None), patch("os.name", "posix"):
            with self.assertRaisesRegex(RuntimeError, "Claude Code CLIが見つかりません"):
                provider.command()

    def test_antigravity_command_detection(self):
        provider = AntigravityProvider(Settings(provider="antigravity", provider_options={"antigravity": {"cli_path": "my-agy"}}))
        self.assertEqual(provider.command(), ["my-agy"])
        provider = AntigravityProvider(Settings(provider="antigravity"))
        with patch("shutil.which", return_value="/usr/bin/agy"):
            self.assertEqual(provider.command(), [str(Path("/usr/bin/agy"))])
        with patch("shutil.which", return_value=None), patch("os.name", "posix"):
            with self.assertRaisesRegex(RuntimeError, "Antigravity CLI"):
                provider.command()

    def test_claude_provider_execution(self):
        launched = []
        def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            launched.append((command, stdin.read().decode("utf-8")))
            stdout.write(b"Claude Translation Output")
            stdout.flush()
            return Mock(poll=Mock(return_value=0), returncode=0)

        with cli(ClaudeCodeProvider), patch(POPEN, side_effect=mock_popen):
            settings = Settings(provider="claude", model="claude-3-7-sonnet", reasoning_effort="high")
            provider = create_provider(settings, threading.Event())
            result = provider.generate("Translate this", '{"text": "hello"}', schema={"type": "object"})
            self.assertEqual(result, "Claude Translation Output")
            command, stdin_content = launched[0]
            self.assertIn("-p", command)
            self.assertIn("--tools", command)
            self.assertIn("--no-session-persistence", command)
            self.assertEqual(command[command.index("--model") + 1], "claude-3-7-sonnet")
            self.assertEqual(command[command.index("--effort") + 1], "high")
            self.assertIn("--json-schema", command)
            self.assertIn("Translate this", stdin_content)

    def test_antigravity_provider_execution(self):
        launched = []
        def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            launched.append(command)
            stdout.write(b"Gemini Agy Translation Output")
            stdout.flush()
            return Mock(poll=Mock(return_value=0), returncode=0)

        with cli(AntigravityProvider), patch(POPEN, side_effect=mock_popen):
            settings = Settings(provider="antigravity", model="gemini-3.8-flash", reasoning_effort="high")
            provider = create_provider(settings, threading.Event())
            result = provider.generate("Translate this", '{"text": "hello"}', schema={"type": "object"})
            self.assertEqual(result, "Gemini Agy Translation Output")
            command = launched[0]
            self.assertIn("-p", command)
            self.assertEqual(command[command.index("--model") + 1], "gemini-3.8-flash")
            self.assertEqual(command[command.index("--effort") + 1], "high")
            self.assertIn("--sandbox", command)
            self.assertIn("--disable-slash-commands", command)

    def test_cli_failure_reports_clear_error(self):
        def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            stderr.write(b"You've hit your weekly limit")
            stderr.flush()
            return Mock(poll=Mock(return_value=1), returncode=1)

        with cli(ClaudeCodeProvider), patch(POPEN, side_effect=mock_popen):
            provider = create_provider(Settings(provider="claude"), threading.Event())
            with self.assertRaisesRegex(RuntimeError, "weekly limit"):
                provider.generate("Translate", "data")

    def test_antigravity_models(self):
        fake_stdout = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n"
        with cli(AntigravityProvider), patch(RUN, return_value=Mock(returncode=0, stdout=fake_stdout)):
            models = AntigravityProvider(Settings(provider="antigravity")).list_models()
        self.assertEqual(len(models), 2)
        self.assertEqual(models[0][0], "gemini-3.8-flash-high")
        self.assertIn("Gemini 3.8 Flash (High)", models[0][1])

    def test_codex_models(self):
        fake_json = json.dumps({"models": [
            {"slug": "gpt-6-astra", "display_name": "GPT-6-Astra"},
            {"slug": "gpt-5.6-sol", "display_name": "GPT-5.6-Sol"}
        ]})
        with cli(CodexProvider), patch(RUN, return_value=Mock(returncode=0, stdout=fake_json)):
            models = CodexProvider(Settings()).list_models()
        self.assertEqual(len(models), 2)
        self.assertEqual(models[0][0], "gpt-6-astra")
        self.assertIn("GPT-6-Astra", models[0][1])

    def test_models_fall_back_when_the_cli_fails(self):
        with patch(RUN, side_effect=OSError("CLI not found")), \
             patch("papeer.providers.antigravity.subprocess.run", side_effect=OSError("CLI not found")), \
             patch("papeer.providers.codex.subprocess.run", side_effect=OSError("CLI not found")):
            self.assertTrue(AntigravityProvider(Settings(provider="antigravity")).list_models())
            self.assertTrue(CodexProvider(Settings()).list_models())

    def test_efforts(self):
        self.assertEqual(AntigravityProvider(Settings(provider="antigravity")).list_efforts(), [])
        self.assertIn("xhigh", [e[0] for e in CodexProvider(Settings()).list_efforts()])
        with patch("papeer.providers.claude_code._catalog_models", return_value=[]):
            self.assertIn("max", [e[0] for e in ClaudeCodeProvider(Settings(provider="claude")).list_efforts("opus")])

    def run_cli(self, provider_cls, provider_id, stdout_lines):
        def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            if "--output-last-message" in command:
                Path(command[command.index("--output-last-message") + 1]).write_text("訳文", "utf-8")
            stdout.write("\n".join(json.dumps(line) for line in stdout_lines).encode("utf-8"))
            stdout.flush()
            return Mock(poll=Mock(return_value=0), returncode=0)

        with cli(provider_cls), patch(POPEN, side_effect=mock_popen):
            provider = create_provider(Settings(provider=provider_id, model="m"), threading.Event())
            answers = [provider.generate("Translate", "text"), provider.generate("Translate", "text")]
        return answers, provider.usage_report()

    def test_claude_usage_and_plan_limits(self):
        lines = [
            {"type": "system", "subtype": "init"},
            {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "unifiedWindows": {
                "five_hour": {"utilization": 0.25, "resetsAt": 1790350200},
                "seven_day": {"utilization": 0.1, "resetsAt": 1790697600}}}},
            {"type": "result", "subtype": "success", "is_error": False, "result": "訳文", "total_cost_usd": 0.5,
             "usage": {"input_tokens": 10, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000,
                       "output_tokens": 50, "output_tokens_details": {"thinking_tokens": 20}}},
        ]
        answers, usage = self.run_cli(ClaudeCodeProvider, "claude", lines)
        self.assertEqual(answers, ["訳文", "訳文"])
        self.assertEqual((usage["calls"], usage["input_tokens"], usage["cached_tokens"]), (2, 2220, 2000))
        self.assertEqual((usage["output_tokens"], usage["reasoning_tokens"], usage["cost_usd"]), (100, 40, 1.0))
        limits = ClaudeCodeProvider(Settings(provider="claude")).limits()
        self.assertEqual([(w["label"], w["used_percent"]) for w in limits["windows"]], [("5時間枠", 25.0), ("7日枠", 10.0)])

    def test_claude_error_result_is_reported(self):
        lines = [{"type": "result", "subtype": "success", "is_error": True, "result": "You've hit your limit"}]
        with self.assertRaisesRegex(RuntimeError, "hit your limit"):
            self.run_cli(ClaudeCodeProvider, "claude", lines)

    def test_codex_usage_from_json_events(self):
        lines = [{"type": "thread.started"},
                 {"type": "turn.completed", "usage": {"input_tokens": 300, "cached_input_tokens": 200,
                                                      "output_tokens": 7, "reasoning_output_tokens": 3}}]
        answers, usage = self.run_cli(CodexProvider, "codex", lines)
        self.assertEqual(answers, ["訳文", "訳文"])
        self.assertEqual((usage["input_tokens"], usage["cached_tokens"], usage["output_tokens"]), (600, 400, 14))

    def test_agy_usage_from_json_output(self):
        lines = [{"status": "SUCCESS", "response": "訳文\n",
                  "usage": {"input_tokens": 12, "output_tokens": 3, "thinking_tokens": 1, "cache_read_tokens": 4}}]
        answers, usage = self.run_cli(AntigravityProvider, "antigravity", lines)
        self.assertEqual(answers, ["訳文", "訳文"])
        self.assertEqual((usage["input_tokens"], usage["cached_tokens"], usage["reasoning_tokens"]), (24, 8, 2))
        self.assertIsNone(usage["cost_usd"])

    def test_codex_limit_windows(self):
        windows = codex_limit_windows({"primary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1},
                                       "secondary": {"usedPercent": 3, "windowDurationMins": 10080}})
        self.assertEqual([(w["label"], w["used_percent"]) for w in windows], [("5時間枠", 12.0), ("7日枠", 3.0)])

    def test_cli_login_status_and_check(self):
        with cli(CodexProvider), patch(RUN, return_value=Mock(returncode=0, stdout="Logged in", stderr="")):
            provider = CodexProvider(Settings())
            self.assertTrue(provider.login_status())
            self.assertIn("Codex", provider.check())
        with cli(CodexProvider), patch(RUN, return_value=Mock(returncode=1, stdout="", stderr="Not logged in")):
            provider = CodexProvider(Settings())
            self.assertFalse(provider.login_status())
            with self.assertRaisesRegex(RuntimeError, "未ログイン"):
                provider.check()


if __name__ == "__main__":
    unittest.main()
