from datetime import datetime, timedelta, timezone
from email.message import Message
from email.utils import format_datetime
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

from papeer.core.config import Settings
from papeer.providers import AnswerRejected, Cancelled, ProviderBackend, ProviderSpec, create_provider, parse_json_answer
from papeer.providers.antigravity import AntigravityProvider
from papeer.providers.base import TRANSPORT_WAIT_LIMIT
from papeer.providers.claude_code import ClaudeCodeProvider
from papeer.providers.codex import CodexProvider, codex_limit_windows
from papeer.providers.common import TransientError, cli_failure, run_cli_process
from papeer.providers.openai_compat import MIN_RETRY_AFTER, OpenAICompatProvider, retry_after

POPEN = "papeer.providers.common.subprocess.Popen"
RUN = "papeer.providers.common.subprocess.run"


def cli(provider_cls):
    """Patch a CLI connection so it runs the mocked process instead of looking for the real CLI."""
    return patch.object(provider_cls, "command", return_value=["cli"])


def agy_stream(response: str, status: str = "SUCCESS") -> bytes:
    """What agy --output-format stream-json prints: an init event, then the result event."""
    lines = [{"event": "init", "init": {"tools": []}},
             {"event": "result", "result": {"status": status, "response": response}}]
    return "\n".join(json.dumps(line) for line in lines).encode("utf-8")


def capture_popen(launched: list, stdout_bytes: bytes = b"answer"):
    """A Popen stand-in that records (command, stdin text, keyword arguments) and succeeds."""
    def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
        launched.append((command, stdin.read().decode("utf-8") if stdin else "", kwargs))
        if "--output-last-message" in command:
            Path(command[command.index("--output-last-message") + 1]).write_text("回答", "utf-8")
        if stdout:  # The login console has no captured output.
            stdout.write(stdout_bytes)
            stdout.flush()
        return Mock(poll=Mock(return_value=0), returncode=0)
    return mock_popen


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
        with cli(AntigravityProvider), patch(POPEN, side_effect=capture_popen(launched, agy_stream("Gemini Agy Output"))):
            settings = Settings(provider="antigravity", model="gemini-3.8-flash", reasoning_effort="high")
            provider = create_provider(settings, threading.Event())
            result = provider.generate("Translate this", '{"text": "hello"}', schema={"type": "object"})
            self.assertEqual(result, "Gemini Agy Output")
            command = launched[0][0]
            self.assertIn("--print=", command)
            self.assertEqual(command[command.index("--model") + 1], "gemini-3.8-flash")
            self.assertEqual(command[command.index("--effort") + 1], "high")
            self.assertIn("--sandbox", command)
            self.assertIn("--disable-slash-commands", command)

    def test_cli_failure_reports_clear_error(self):
        def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            stderr.write(b"You've hit your weekly limit")
            stderr.flush()
            return Mock(poll=Mock(return_value=1), returncode=1)

        with cli(ClaudeCodeProvider), patch(POPEN, side_effect=mock_popen) as popen:
            provider = create_provider(Settings(provider="claude"), threading.Event())
            with self.assertRaisesRegex(RuntimeError, "weekly limit"):
                provider.generate("Translate", "data")
        # Running it again cannot get past a plan limit.
        self.assertEqual(popen.call_count, 1)

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
        usage = {"input_tokens": 12, "output_tokens": 3, "thinking_tokens": 1, "cache_read_tokens": 4}
        lines = [{"event": "init", "init": {}}, {"event": "step_update", "step_update": {"state": "DONE"}},
                 {"event": "result", "result": {"status": "SUCCESS", "response": "訳文\n", "usage": usage}}]
        answers, usage = self.run_cli(AntigravityProvider, "antigravity", lines)
        self.assertEqual(answers, ["訳文", "訳文"])
        self.assertEqual((usage["input_tokens"], usage["cached_tokens"], usage["reasoning_tokens"]), (24, 8, 2))
        self.assertIsNone(usage["cost_usd"])

    @patch.object(AntigravityProvider, "transport_backoff", 0.0)  # "stalled" below is temporary and is sent again.
    def test_agy_error_result_is_reported(self):
        lines = [{"event": "result", "result": {"status": "ERROR", "response": "", "error": "Individual quota reached."}}]
        with self.assertRaisesRegex(RuntimeError, "quota reached"):
            self.run_cli(AntigravityProvider, "antigravity", lines)
        with self.assertRaisesRegex(RuntimeError, "応答を読み取れません.*agy を更新"):
            self.run_cli(AntigravityProvider, "antigravity", [{"event": "init", "init": {}}])
        # No result event, but an error event: its message, not the update hint.
        with self.assertRaisesRegex(RuntimeError, "利用枠を確認.*\n.*stalled for 5s"):
            self.run_cli(AntigravityProvider, "antigravity",
                         [{"event": "init", "init": {}}, {"event": "error", "error": {"message": "stalled for 5s"}}])

    def test_agy_without_stream_json_input_asks_for_an_update(self):
        def old_agy(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            stderr.write(b"flag provided but not defined: -input-format\nUsage of agy.exe:\n")
            stderr.flush()
            return Mock(poll=Mock(return_value=2), returncode=2)

        def agy_error_line(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            stdout.write(b'{"event":"init","init":{}}\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429)"}\n')
            stdout.flush()
            return Mock(poll=Mock(return_value=0), returncode=0)

        provider = AntigravityProvider(Settings(provider="antigravity"))
        with cli(AntigravityProvider), patch(POPEN, side_effect=old_agy):
            with self.assertRaisesRegex(RuntimeError, "(?s)古いため.*agy を更新してください.*input-format"):
                provider.generate("Translate", "data")
        with cli(AntigravityProvider), patch(POPEN, side_effect=agy_error_line):
            with self.assertRaisesRegex(RuntimeError, "利用枠を確認.*\nAGY_ERROR:.*RESOURCE_EXHAUSTED"):
                provider.generate("Translate", "data")

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


class CliSafetyTests(unittest.TestCase):
    """What an untrusted document can reach through a CLI: tools, MCP servers, the sidecar token, cmd.exe."""

    def test_claude_runs_without_tools_mcp_servers_or_project_settings(self):
        launched = []
        with cli(ClaudeCodeProvider), patch(POPEN, side_effect=capture_popen(launched)):
            create_provider(Settings(provider="claude"), threading.Event()).generate("Translate", "data")
        command = launched[0][0]
        self.assertEqual(command[command.index("--tools") + 1], "")
        self.assertIn("--strict-mcp-config", command)
        self.assertEqual(json.loads(command[command.index("--mcp-config") + 1]), {"mcpServers": {}})
        self.assertEqual(command[command.index("--setting-sources") + 1], "user")
        self.assertIn("--disable-slash-commands", command)

    def test_codex_disables_configured_mcp_servers_plugins_and_apps(self):
        with tempfile.TemporaryDirectory() as home:
            config = Path(home, "config.toml")
            config.write_text('model = "x"\n[mcp_servers.node_repl]\ncommand = "node"\n'
                              '[mcp_servers.unreal-mcp]\nurl = "http://127.0.0.1:8000/mcp"\nenabled = false\n'
                              '[mcp_servers."dotted.name"]\ncommand = "x"\n', "utf-8")
            launched = []
            with patch.dict(os.environ, {"CODEX_HOME": home}), cli(CodexProvider), \
                    patch(POPEN, side_effect=capture_popen(launched)):
                self.assertEqual(create_provider(Settings(), threading.Event()).generate("Translate", "data"), "回答")
                config.write_text("[mcp_servers\nbroken", "utf-8")
                create_provider(Settings(), threading.Event()).generate("Translate", "data")
                # tomllib rejects this (duplicate key), yet its headings still name the servers to switch off.
                config.write_text('[mcp_servers.node_repl]\ncommand = "a"\ncommand = "b"\n'
                                  '  [ mcp_servers.env-only.env ]\nX = "1"\n# [mcp_servers.commented]\n'
                                  '[mcp_servers.node_repl.env]\n[mcp_servers."unreal-mcp"]\n'
                                  '[mcp_servers."quoted".env]\n', "utf-8")
                create_provider(Settings(), threading.Event()).generate("Translate", "data")
        first, second, third = ([arg for arg in command if "=" in arg] for command, _, _ in launched)
        self.assertEqual([arg for arg in third if arg.startswith("mcp_servers.")],
                         ["mcp_servers.node_repl.enabled=false", "mcp_servers.env-only.enabled=false",
                          "mcp_servers.unreal-mcp.enabled=false", "mcp_servers.quoted.enabled=false"])
        for expected in ("features.plugins=false", "features.apps=false", "features.shell_tool=false",
                         "mcp_servers.node_repl.enabled=false", "mcp_servers.unreal-mcp.enabled=false"):
            self.assertIn(expected, first)
        # A name the dotted -c path cannot address is left out rather than creating a broken server entry.
        self.assertFalse(any("dotted" in arg for arg in first))
        # An unreadable config.toml still gets the feature switches and names no server.
        self.assertIn("features.plugins=false", second)
        self.assertFalse(any(arg.startswith("mcp_servers.") for arg in second))

    def test_agy_prompt_goes_through_stdin(self):
        document = "本文 " * 20000  # Longer than the 32,767 characters a Windows command line holds.
        launched = []
        with cli(AntigravityProvider), patch(POPEN, side_effect=capture_popen(launched, agy_stream("訳文"))):
            answer = create_provider(Settings(provider="antigravity", model=""), threading.Event()).generate(
                "Translate", document)
        self.assertEqual(answer, "訳文")
        command, stdin_text, _ = launched[0]
        self.assertLess(len(" ".join(command)), 1000)
        self.assertEqual(command[command.index("--input-format") + 1], "stream-json")
        self.assertEqual(command[command.index("--output-format") + 1], "stream-json")
        message = json.loads(stdin_text)
        self.assertEqual(message["event"], "user")
        self.assertIn(json.dumps(document, ensure_ascii=False), message["message"]["content"])

    def test_cli_processes_do_not_inherit_app_secrets(self):
        secrets = {"PAPEER_TOKEN": "sidecar-token", "PAPERDESK_TOKEN": "old-token", "PAPEER_API_KEY": "api-key",
                   "KEEP_THIS": "1"}
        launched = []
        with patch.dict(os.environ, secrets), cli(ClaudeCodeProvider), \
                patch(POPEN, side_effect=capture_popen(launched)), \
                patch(RUN, return_value=Mock(returncode=0, stdout="", stderr="")) as run:
            provider = create_provider(Settings(provider="claude"), threading.Event())
            provider.generate("Translate", "data")
            provider.login()
            provider.login_status()
        environments = [kwargs["env"] for _, _, kwargs in launched] + [run.call_args.kwargs["env"]]
        self.assertEqual(len(environments), 3)  # generate and login (Popen), login_status (run)
        for env in environments:
            self.assertEqual(env.get("KEEP_THIS"), "1")
            self.assertFalse([name for name in env if name.upper().startswith(("PAPEER_", "PAPERDESK_"))])

    def test_script_shims_run_their_js_entry_with_node_or_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            shim = folder / "claude.cmd"
            shim.write_text("@exit /b 9\n", "utf-8")
            provider = ClaudeCodeProvider(Settings(provider="claude", provider_options={"claude": {"cli_path": str(shim)}}))
            with patch("shutil.which", return_value="/bin/node"):
                with self.assertRaisesRegex(RuntimeError, "claude.cmd は cmd.exe を経由するため使いません"):
                    provider.command()  # No JS entry next to the shim: the shim itself is never run.
            entry = folder / "node_modules" / ClaudeCodeProvider.npm_entry
            entry.parent.mkdir(parents=True)
            entry.write_text("", "utf-8")
            with patch("shutil.which", return_value=None):
                with self.assertRaisesRegex(RuntimeError, "Node.js"):
                    provider.command()  # A JS entry but no node to run it.
            with patch("shutil.which", return_value="/bin/node"):
                self.assertEqual(provider.command(), ["/bin/node", str(entry)])
                (folder / "node.exe").write_bytes(b"")
                self.assertEqual(provider.command(), [str(folder / "node.exe"), str(entry)])  # As the shim prefers.
                (folder / "node.exe").unlink()
                # The known npm entry wins over whatever the shim names.
                other = folder / "node_modules/other.js"
                other.write_text("", "utf-8")
                shim.write_text('"%dp0%\\node_modules\\other.js" %*\r\n', "utf-8")
                self.assertEqual(provider.command(), ["/bin/node", str(entry)])
            for name in ("agy.cmd", "agy.bat", "agy.ps1", "AGY.CMD"):
                script = folder / name
                script.write_text("", "utf-8")
                agy = AntigravityProvider(Settings(provider="antigravity",
                                                   provider_options={"antigravity": {"cli_path": str(script)}}))
                with self.assertRaisesRegex(RuntimeError, r"agyの実行ファイル\(\.exe\)が必要.*pnpm・yarn"):
                    agy.command()

    def test_program_named_in_npm_and_pnpm_shims_runs_directly(self):
        """Without the known npm entry, the program on the shim's %* line runs (JS with node, .exe as it is)."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_folder = root / "pnpm"
            shim = bin_folder / "codex.cmd"
            target = bin_folder / "global/5/node_modules/@openai/codex/bin/codex.js"
            target.parent.mkdir(parents=True)
            target.write_text("", "utf-8")
            provider = CodexProvider(Settings(provider_options={"codex": {"cli_path": str(shim)}}))
            # What pnpm writes for a global install.
            shim.write_text('@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n  @SET "NODE_PATH=%~dp0\\global\\5\\node_modules"\r\n)\r\n'
                            '@IF EXIST "%~dp0\\node.exe" (\r\n'
                            '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
                            ') ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
                            '  node  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n)\r\n', "utf-8")
            with patch("shutil.which", return_value="/bin/node"):
                self.assertEqual(provider.command(), ["/bin/node", str(target.resolve())])
                # npm's own shim, pointing at a moved JS entry.
                moved = bin_folder / "node_modules/@openai/codex/cli.js"
                moved.parent.mkdir(parents=True)
                moved.write_text("", "utf-8")
                shim.write_text('@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n'
                                '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\cli.js" %*\r\n', "utf-8")
                self.assertEqual(provider.command(), ["/bin/node", str(moved.resolve())])
                native = bin_folder / "node_modules/@openai/codex/bin/codex.exe"
                native.parent.mkdir()
                native.write_bytes(b"")
                shim.write_text('"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.exe"   %*\r\n', "utf-8")
                self.assertEqual(provider.command(), [str(native.resolve())])
                # Refused: a name only on a line that does not run anything, a program outside the shim's
                # folder, and a program that does not exist.
                outside = root / "outside.js"
                outside.write_text("", "utf-8")
                for text in ('REM "%dp0%\\node_modules\\@openai\\codex\\cli.js"\r\nexit /b 1\r\n',
                             # Comment lines passing %* on do not run anything either.
                             'REM "%dp0%\\node_modules\\@openai\\codex\\cli.js" %*\r\nexit /b 1\r\n',
                             '  @rem "%dp0%\\node_modules\\@openai\\codex\\cli.js" %*\r\n',
                             ':: "%dp0%\\node_modules\\@openai\\codex\\cli.js" %*\r\n',
                             '"%dp0%\\..\\outside.js" %*\r\n',
                             '"%~dp0\\global\\5\\node_modules\\missing.js" %*\r\n'):
                    shim.write_text(text, "utf-8")
                    with self.assertRaisesRegex(RuntimeError, "codex.cmd は cmd.exe を経由するため使いません"):
                        provider.command()


class RecordingEvent(threading.Event):
    """A cancel event whose waits return at once and are recorded."""

    def __init__(self):
        super().__init__()
        self.waits = []

    def wait(self, timeout=None):
        self.waits.append(timeout)
        return self.is_set()


class FlakyProvider(ProviderBackend):
    spec = ProviderSpec(id="flaky", label="flaky", description="", kind="http")

    def __init__(self, *errors, cancel=None):
        super().__init__(Settings(), cancel if cancel is not None else RecordingEvent())
        self.errors = list(errors)
        self.sends = 0

    def _generate(self, instruction, data, schema):
        self.sends += 1
        if self.errors:
            raise self.errors.pop(0)
        return "answer"


class TransportRetryTests(unittest.TestCase):
    """ProviderBackend.generate sends a request again after temporary failures only, within bounds."""

    def test_temporary_failures_are_sent_again_with_growing_waits(self):
        provider = FlakyProvider(TransientError("offline"), TransientError("offline"))
        self.assertEqual(provider.generate("i", "d"), "answer")
        self.assertEqual(provider.sends, 3)
        self.assertEqual(provider.cancel.waits, [2.0, 4.0])
        self.assertEqual(provider.usage.calls, 1)

    def test_retries_are_bounded(self):
        provider = FlakyProvider(*[TransientError("offline")] * 5)
        with self.assertRaisesRegex(TransientError, "offline"):
            provider.generate("i", "d")
        self.assertEqual(provider.sends, 1 + ProviderBackend.transport_retries)

    def test_lasting_failures_are_not_sent_again(self):
        for error in (RuntimeError("未ログイン"), ValueError("モデル名"), Cancelled()):
            with self.subTest(error=error):
                provider = FlakyProvider(error)
                with self.assertRaises(type(error)):
                    provider.generate("i", "d")
                self.assertEqual(provider.sends, 1)

    def test_retry_after_is_honoured_within_the_total_limit(self):
        provider = FlakyProvider(TransientError("429", retry_after=7.0))
        self.assertEqual(provider.generate("i", "d"), "answer")
        self.assertEqual(provider.cancel.waits, [7.0])
        # A longer wait than the limit is reported at once instead of blocking the job.
        provider = FlakyProvider(TransientError("429", retry_after=TRANSPORT_WAIT_LIMIT + 1))
        with self.assertRaisesRegex(TransientError, "429"):
            provider.generate("i", "d")
        self.assertEqual((provider.sends, provider.cancel.waits), (1, []))
        provider = FlakyProvider(*[TransientError("429", retry_after=TRANSPORT_WAIT_LIMIT / 2 + 1)] * 3)
        with self.assertRaises(TransientError):
            provider.generate("i", "d")
        self.assertEqual(provider.sends, 2)

    def test_timeout_is_sent_again_only_once(self):
        provider = FlakyProvider(*[TransientError("timeout", timed_out=True)] * 3)
        with self.assertRaisesRegex(TransientError, "timeout"):
            provider.generate("i", "d")
        self.assertEqual(provider.sends, 2)

    def test_cancel_ends_the_wait_at_once(self):
        cancel = threading.Event()
        provider = FlakyProvider(TransientError("offline"), cancel=cancel)
        provider.transport_backoff = 60.0
        threading.Timer(0.1, cancel.set).start()
        started = time.monotonic()
        with self.assertRaises(Cancelled):
            provider.generate("i", "d")
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(provider.sends, 1)

    def test_cli_failures_that_retrying_cannot_fix_are_told_apart(self):
        lasting = [
            "You've hit your weekly limit", "Claude AI usage limit reached|1790000000", "You've hit your limit · resets 3pm",
            "Error: Not logged in · Please run /login", "Invalid API key · Please run /login",
            "unexpected status 401 Unauthorized", "Individual quota reached.",
            'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429)"}', "Credit balance is too low",
            "flag provided but not defined: -input-format", "error: unexpected argument '--foo' found",
            "The 'gpt-x' model is not supported when using Codex with a ChatGPT account.",
        ]
        temporary = [
            "", "stream disconnected before completion: error sending request", "API Error: 500 Internal server error",
            "API Error: 529 Overloaded", "stalled for 5s", "Connection reset by peer",
            # Claude Code's stream-json always carries a rate_limit_event and usage counts.
            '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}}\n'
            '{"type":"result","is_error":true,"result":"API Error: 503","usage":{"input_tokens":401}}',
        ]
        for detail in lasting:
            with self.subTest(detail=detail):
                error = cli_failure("CLI", detail)
                self.assertNotIsInstance(error, TransientError)
                self.assertIn(detail[-40:], str(error))
        for detail in temporary:
            with self.subTest(detail=detail):
                self.assertIsInstance(cli_failure("CLI", detail), TransientError)

    def test_cli_that_stops_for_no_lasting_reason_runs_again(self):
        runs = []

        def flaky(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            runs.append(command)
            if len(runs) == 1:
                stderr.write(b"stream disconnected before completion")
                stderr.flush()
                return Mock(poll=Mock(return_value=1), returncode=1)
            stdout.write(b"answer")
            stdout.flush()
            return Mock(poll=Mock(return_value=0), returncode=0)

        with cli(ClaudeCodeProvider), patch(POPEN, side_effect=flaky), \
                patch.object(ClaudeCodeProvider, "transport_backoff", 0.0):
            provider = create_provider(Settings(provider="claude"), threading.Event())
            self.assertEqual(provider.generate("Translate", "data"), "answer")
        self.assertEqual(len(runs), 2)

    def test_cli_timeout_is_temporary(self):
        process = Mock(poll=Mock(return_value=None), returncode=None)
        with patch(POPEN, return_value=process), patch("papeer.providers.common.kill_tree"), \
                tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(TransientError) as caught:
                run_cli_process(["cli"], b"", threading.Event(), 0, "CLI", Path(directory))
        self.assertTrue(caught.exception.timed_out)
        self.assertIn("タイムアウト", str(caught.exception))

    def test_api_timeouts_and_dropped_connections_are_sent_again(self):
        body = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": "訳文"}}]}).encode()
        for error in (TimeoutError("timed out"), ConnectionResetError("reset"), URLError(ConnectionRefusedError())):
            with self.subTest(error=error):
                provider = create_provider(Settings(provider="api", model="m"), RecordingEvent())
                with patch.object(OpenAICompatProvider, "_fetch", side_effect=[error, body]) as fetch:
                    self.assertEqual(provider.generate("i", "d"), "訳文")
                self.assertEqual(fetch.call_count, 2)

    def test_retry_after_seconds_and_dates(self):
        def error(value):
            headers = Message()
            if value is not None:
                headers["Retry-After"] = value
            return HTTPError("https://example.invalid", 429, "busy", headers, None)  # type: ignore[arg-type]

        self.assertEqual(retry_after(error("3")), 3.0)
        self.assertIsNone(retry_after(error(None)))
        self.assertIsNone(retry_after(error("soon")))
        later = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=30), usegmt=True)
        self.assertTrue(20 < (retry_after(error(later)) or 0) <= 30)
        # 0 or a date already past still waits a little rather than asking again at once.
        self.assertEqual(retry_after(error("0")), MIN_RETRY_AFTER)
        self.assertEqual(retry_after(error("Wed, 21 Oct 2015 07:28:00 GMT")), MIN_RETRY_AFTER)


class UnusableAnswerTests(unittest.TestCase):
    """Answers that came back unusable are AnswerRejected: not sent again, and not taken as unanswered."""

    def claude(self, *runs, provider_id="claude", cls=ClaudeCodeProvider):
        """Run generate() once over scripted CLI runs of (returncode, stdout lines, stderr); return (error, runs used)."""
        used = []

        def popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            code, lines, err = runs[min(len(used), len(runs) - 1)]
            used.append(command)
            stdout.write("\n".join(json.dumps(line) for line in lines).encode("utf-8"))
            stdout.flush()
            stderr.write(err.encode("utf-8"))
            stderr.flush()
            return Mock(poll=Mock(return_value=code), returncode=code)

        with cli(cls), patch(POPEN, side_effect=popen), patch.object(cls, "transport_backoff", 0.0):
            provider = create_provider(Settings(provider=provider_id), threading.Event())
            try:
                provider.generate("Translate", "data")
            except Exception as error:  # noqa: BLE001 - the test inspects the type
                return error, len(used)
        return None, len(used)

    def result(self, text, subtype="success", output_tokens=0, is_error=True):
        return {"type": "result", "subtype": subtype, "is_error": is_error, "result": text,
                "usage": {"input_tokens": 10, "output_tokens": output_tokens}}

    def test_claude_error_after_output_is_an_unusable_answer(self):
        for code in (0, 1):  # Reported with exit 0 or 1, the result event decides.
            with self.subTest(code=code):
                error, runs = self.claude((code, [self.result("API Error: 500", output_tokens=120)], ""))
                self.assertIsInstance(error, AnswerRejected)
                self.assertEqual(runs, 1)

    def test_claude_run_ended_by_its_own_limit_is_an_unusable_answer(self):
        error, runs = self.claude((1, [self.result("", subtype="error_max_turns")], ""))
        self.assertIsInstance(error, AnswerRejected)
        self.assertEqual(runs, 1)

    def test_claude_empty_answer_is_an_unusable_answer(self):
        error, runs = self.claude((0, [self.result("  ", is_error=False)], ""))
        self.assertIsInstance(error, AnswerRejected)
        self.assertEqual(runs, 1)

    def test_claude_errors_known_to_pass_are_sent_again(self):
        for text in ("API Error: 529 Overloaded", "API Error: 503 Service Unavailable", "Request failed: ECONNRESET"):
            with self.subTest(text=text):
                error, runs = self.claude((1, [self.result(text)], ""), (0, [self.result("訳文", is_error=False)], ""))
                self.assertIsNone(error)
                self.assertEqual(runs, 2)

    def test_claude_unknown_or_lasting_errors_are_not_sent_again(self):
        for text in ("Something unexpected happened", "Claude AI usage limit reached|1790000000",
                     "Invalid API key · Please run /login"):
            with self.subTest(text=text):
                error, runs = self.claude((1, [self.result(text, output_tokens=0)], ""))
                self.assertIs(type(error), RuntimeError)
                self.assertEqual(runs, 1)
        # A plan limit stays a lasting failure even after output (not an unusable answer to move on from).
        error, _ = self.claude((1, [self.result("You've hit your limit", output_tokens=5)], ""))
        self.assertIs(type(error), RuntimeError)

    def test_cli_exit_is_judged_by_stderr_and_stdout_together(self):
        # A warning on stderr must not hide the plan limit printed on stdout.
        error, runs = self.claude((1, [{"type": "system"}], "warning: something"),
                                  (0, [self.result("訳文", is_error=False)], ""))
        self.assertEqual((error, runs), (None, 2))  # Neither names a lasting failure: run again.
        detail = "You've hit your usage limit"
        error, runs = self.claude((1, [{"message": detail}], "warning: something"))
        self.assertIs(type(error), RuntimeError)
        self.assertEqual(runs, 1)
        self.assertIn("warning: something", str(error))

    def test_agy_error_status_is_sent_again_only_when_known_to_pass(self):
        def status(value, error):
            return [{"event": "result", "result": {"status": value, "response": "", "error": error}}]
        success = [{"event": "result", "result": {"status": "SUCCESS", "response": "訳文"}}]
        error, runs = self.claude((0, status("ERROR", "something odd"), ""), (0, success, ""),
                                  provider_id="antigravity", cls=AntigravityProvider)
        self.assertIs(type(error), RuntimeError)
        self.assertEqual(runs, 1)
        for value, message in (("UNAVAILABLE", "try later"), ("ERROR", "503 Service Unavailable"),
                               ("DEADLINE_EXCEEDED", "")):
            with self.subTest(status=value):
                error, runs = self.claude((0, status(value, message), ""), (0, success, ""),
                                          provider_id="antigravity", cls=AntigravityProvider)
                self.assertIsNone(error)
                self.assertEqual(runs, 2)
        error, runs = self.claude((0, [{"event": "result", "result": {"status": "SUCCESS", "response": " "}}], ""),
                                  provider_id="antigravity", cls=AntigravityProvider)
        self.assertIsInstance(error, AnswerRejected)
        self.assertEqual(runs, 1)

    def test_codex_without_answer_file_is_an_unusable_answer(self):
        runs = []

        def popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            runs.append(command)
            return Mock(poll=Mock(return_value=0), returncode=0)

        with cli(CodexProvider), patch(POPEN, side_effect=popen), patch.object(CodexProvider, "transport_backoff", 0.0):
            with self.assertRaisesRegex(AnswerRejected, "回答ファイル"):
                create_provider(Settings(), threading.Event()).generate("Translate", "data")
        self.assertEqual(len(runs), 1)

    def test_api_answer_cut_off_or_empty_is_an_unusable_answer(self):
        for choice in ({"finish_reason": "length", "message": {"content": "途中"}},
                       {"finish_reason": "stop", "message": {"content": "  "}}):
            with self.subTest(choice=choice):
                provider = create_provider(Settings(provider="api", model="m"), RecordingEvent())
                body = json.dumps({"choices": [choice]}).encode()
                with patch.object(OpenAICompatProvider, "_fetch", return_value=body) as fetch:
                    with self.assertRaises(AnswerRejected):
                        provider.generate("i", "d")
                self.assertEqual(fetch.call_count, 1)


if __name__ == "__main__":
    unittest.main()
