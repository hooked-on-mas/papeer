import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from paperdesk.core.config import Settings
from paperdesk.core.providers import (
    Provider,
    claude_command,
    codex_limit_windows,
    current_limits,
    gemini_command,
    parse_json_answer,
)


class ProvidersTests(unittest.TestCase):
    def test_parse_json_answer(self):
        self.assertEqual(parse_json_answer('{"a": 1}'), {"a": 1})
        self.assertEqual(parse_json_answer('```json\n{"a": 2}\n```'), {"a": 2})
        with self.assertRaises(ValueError):
            parse_json_answer("not a json")
        with self.assertRaises(ValueError):
            parse_json_answer('["list", "not", "dict"]')

    def test_settings_claude_and_gemini_paths_persistence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = Settings(
                provider="claude",
                claude_path="C:/custom/claude.exe",
                gemini_path="C:/custom/agy.exe",
            )
            settings.save(root)
            loaded = Settings.load(root)
            self.assertEqual(loaded.provider, "claude")
            self.assertEqual(loaded.claude_path, "C:/custom/claude.exe")
            self.assertEqual(loaded.gemini_path, "C:/custom/agy.exe")

    def test_claude_command_detection(self):
        self.assertEqual(claude_command("my-claude"), ["my-claude"])
        with patch("shutil.which", return_value="/usr/bin/claude"):
            self.assertEqual(claude_command(), [str(Path("/usr/bin/claude"))])
        with patch("shutil.which", return_value=None), patch("os.name", "posix"):
            with self.assertRaisesRegex(RuntimeError, "Claude Code CLIが見つかりません"):
                claude_command()

    def test_gemini_command_detection(self):
        self.assertEqual(gemini_command("my-gemini"), ["my-gemini"])
        with patch("shutil.which", return_value="/usr/bin/agy"):
            self.assertEqual(gemini_command(), [str(Path("/usr/bin/agy"))])
        with patch("shutil.which", return_value=None), patch("os.name", "posix"):
            with self.assertRaisesRegex(RuntimeError, "Gemini CLI"):
                gemini_command()

    def test_claude_provider_execution(self):
        launched = []
        def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            launched.append((command, stdin.read().decode("utf-8")))
            stdout.write(b"Claude Translation Output")
            stdout.flush()
            return Mock(poll=Mock(return_value=0), returncode=0)

        with patch("paperdesk.core.providers.claude_command", return_value=["claude"]), \
             patch("paperdesk.core.providers.subprocess.Popen", side_effect=mock_popen):
            settings = Settings(provider="claude", model="claude-3-7-sonnet")
            provider = Provider(settings, threading.Event())
            result = provider.generate("Translate this", '{"text": "hello"}', schema={"type": "object"})
            self.assertEqual(result, "Claude Translation Output")
            command, stdin_content = launched[0]
            self.assertIn("-p", command)
            self.assertIn("--tools", command)
            self.assertIn("--no-session-persistence", command)
            self.assertIn("--model", command)
            self.assertIn("claude-3-7-sonnet", command)
            self.assertIn("--json-schema", command)
            self.assertIn("Translate this", stdin_content)

    def test_gemini_agy_provider_execution(self):
        launched = []
        def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            launched.append(command)
            stdout.write(b"Gemini Agy Translation Output")
            stdout.flush()
            return Mock(poll=Mock(return_value=0), returncode=0)

        with patch("paperdesk.core.providers.gemini_command", return_value=["agy.exe"]), \
             patch("paperdesk.core.providers.subprocess.Popen", side_effect=mock_popen):
            settings = Settings(provider="gemini", model="gemini-3.8-flash", reasoning_effort="high")
            provider = Provider(settings, threading.Event())
            result = provider.generate("Translate this", '{"text": "hello"}', schema={"type": "object"})
            self.assertEqual(result, "Gemini Agy Translation Output")
            command = launched[0]
            self.assertIn("-p", command)
            self.assertIn("--model", command)
            self.assertIn("gemini-3.8-flash", command)
            self.assertIn("--effort", command)
            self.assertIn("high", command)
            self.assertIn("--sandbox", command)
            self.assertIn("--disable-slash-commands", command)

    def test_cli_failure_reports_clear_error(self):
        def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            stderr.write(b"You've hit your weekly limit")
            stderr.flush()
            return Mock(poll=Mock(return_value=1), returncode=1)

        with patch("paperdesk.core.providers.claude_command", return_value=["claude"]), \
             patch("paperdesk.core.providers.subprocess.Popen", side_effect=mock_popen):
            settings = Settings(provider="claude")
            provider = Provider(settings, threading.Event())
            with self.assertRaisesRegex(RuntimeError, "weekly limit"):
                provider.generate("Translate", "data")

    def test_query_available_models_gemini(self):
        fake_stdout = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n"
        mock_res = Mock(returncode=0, stdout=fake_stdout)
        with patch("paperdesk.core.providers.gemini_command", return_value=["agy.exe"]), \
             patch("paperdesk.core.providers.subprocess.run", return_value=mock_res):
            from paperdesk.core.providers import query_available_models
            models = query_available_models("gemini")
            self.assertEqual(len(models), 2)
            self.assertEqual(models[0][0], "gemini-3.8-flash-high")
            self.assertIn("Gemini 3.8 Flash (High)", models[0][1])

    def test_query_available_models_codex(self):
        fake_json = json.dumps({"models": [
            {"slug": "gpt-6-astra", "display_name": "GPT-6-Astra"},
            {"slug": "gpt-5.6-sol", "display_name": "GPT-5.6-Sol"}
        ]})
        mock_res = Mock(returncode=0, stdout=fake_json)
        with patch("paperdesk.core.providers.codex_command", return_value=["codex"]), \
             patch("paperdesk.core.providers.subprocess.run", return_value=mock_res):
            from paperdesk.core.providers import query_available_models
            models = query_available_models("codex")
            self.assertEqual(len(models), 2)
            self.assertEqual(models[0][0], "gpt-6-astra")
            self.assertIn("GPT-6-Astra", models[0][1])

    def test_query_available_models_fallback_on_error(self):
        with patch("paperdesk.core.providers.subprocess.run", side_effect=OSError("CLI not found")):
            from paperdesk.core.providers import query_available_models
            models = query_available_models("gemini")
            self.assertTrue(len(models) > 0)
            models_codex = query_available_models("codex")
            self.assertTrue(len(models_codex) > 0)

    def test_query_available_efforts(self):
        from paperdesk.core.providers import query_available_efforts
        efforts_gemini = query_available_efforts("gemini")
        self.assertEqual(0, len(efforts_gemini))
        efforts_codex = query_available_efforts("codex")
        self.assertIn("xhigh", [e[0] for e in efforts_codex])

    def run_cli(self, provider_name, stdout_lines, command_patch):
        def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            if "--output-last-message" in command:
                Path(command[command.index("--output-last-message") + 1]).write_text("訳文", "utf-8")
            stdout.write("\n".join(json.dumps(line) for line in stdout_lines).encode("utf-8"))
            stdout.flush()
            return Mock(poll=Mock(return_value=0), returncode=0)

        with patch(command_patch, return_value=["cli"]), \
             patch("paperdesk.core.providers.subprocess.Popen", side_effect=mock_popen):
            provider = Provider(Settings(provider=provider_name, model="m"), threading.Event())
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
        answers, usage = self.run_cli("claude", lines, "paperdesk.core.providers.claude_command")
        self.assertEqual(answers, ["訳文", "訳文"])
        self.assertEqual((usage["calls"], usage["input_tokens"], usage["cached_tokens"]), (2, 2220, 2000))
        self.assertEqual((usage["output_tokens"], usage["reasoning_tokens"], usage["cost_usd"]), (100, 40, 1.0))
        limits = current_limits(Settings(provider="claude"))
        self.assertEqual([(w["label"], w["used_percent"]) for w in limits["windows"]], [("5時間枠", 25.0), ("7日枠", 10.0)])

    def test_claude_error_result_is_reported(self):
        lines = [{"type": "result", "subtype": "success", "is_error": True, "result": "You've hit your limit"}]
        with self.assertRaisesRegex(RuntimeError, "hit your limit"):
            self.run_cli("claude", lines, "paperdesk.core.providers.claude_command")

    def test_codex_usage_from_json_events(self):
        lines = [{"type": "thread.started"},
                 {"type": "turn.completed", "usage": {"input_tokens": 300, "cached_input_tokens": 200,
                                                      "output_tokens": 7, "reasoning_output_tokens": 3}}]
        answers, usage = self.run_cli("codex", lines, "paperdesk.core.providers.codex_command")
        self.assertEqual(answers, ["訳文", "訳文"])
        self.assertEqual((usage["input_tokens"], usage["cached_tokens"], usage["output_tokens"]), (600, 400, 14))

    def test_agy_usage_from_json_output(self):
        lines = [{"status": "SUCCESS", "response": "訳文\n",
                  "usage": {"input_tokens": 12, "output_tokens": 3, "thinking_tokens": 1, "cache_read_tokens": 4}}]
        answers, usage = self.run_cli("gemini", lines, "paperdesk.core.providers.gemini_command")
        self.assertEqual(answers, ["訳文", "訳文"])
        self.assertEqual((usage["input_tokens"], usage["cached_tokens"], usage["reasoning_tokens"]), (24, 8, 2))
        self.assertIsNone(usage["cost_usd"])

    def test_codex_limit_windows(self):
        windows = codex_limit_windows({"primary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1},
                                       "secondary": {"usedPercent": 3, "windowDurationMins": 10080}})
        self.assertEqual([(w["label"], w["used_percent"]) for w in windows], [("5時間枠", 12.0), ("7日枠", 3.0)])


if __name__ == "__main__":
    unittest.main()
