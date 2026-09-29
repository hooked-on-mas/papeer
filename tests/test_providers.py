from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from email.message import Message
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

from papeer.core.config import Settings
from papeer.providers import AnswerRejected, Cancelled, ProviderBackend, ProviderSpec, create_provider, parse_json_answer
from papeer.providers.antigravity import AntigravityProvider
from papeer.providers.base import TRANSPORT_WAIT_LIMIT
from papeer.providers.claude_code import ClaudeCodeProvider
from papeer.providers.codex import CodexProvider, codex_limit_windows
from papeer.providers import common
from papeer.providers.common import TransientError, cli_failure, matches_schema, run_cli_process
from papeer.providers.openai_compat import (MIN_RETRY_AFTER, STRUCTURED_TEMPERATURE, OpenAICompatProvider,
                                            forget_refused_options, retry_after)
from papeer.translation.translation import TRANSLATION_SCHEMA, _parts_schema

POPEN = "papeer.providers.common.subprocess.Popen"
RUN = "papeer.providers.common.subprocess.run"


def cli(provider_cls):
    """Patch a CLI connection so it runs the mocked process instead of looking for the real CLI."""
    return patch.object(provider_cls, "command", return_value=["cli"])


def node_on_path(node: str | None):
    """Patch shutil.which to find `node` (or no node) and every other program as it does."""
    real = shutil.which
    return patch("shutil.which", side_effect=lambda name, *args, **kwargs: node if name == "node" else real(name, *args, **kwargs))


def nothing_installed_on_posix():
    """Play macOS or Linux with no CLI in any known install folder."""
    stack = ExitStack()
    stack.enter_context(patch("papeer.providers.common._windows", return_value=False))
    stack.enter_context(patch("papeer.providers.common.unix_candidates", return_value=[]))
    return stack


def agy_stream(response: str, status: str = "SUCCESS") -> bytes:
    """What agy --output-format stream-json prints: an init event, then the result event."""
    lines = [{"event": "init", "init": {"tools": []}},
             {"event": "result", "result": {"status": status, "response": response}}]
    return "\n".join(json.dumps(line) for line in lines).encode("utf-8")


def capture_popen(launched: list, stdout_bytes: bytes = b"answer"):
    """A Popen stand-in that records (command, stdin text, keyword arguments) and succeeds."""
    def mock_popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
        # A file for a CLI run; subprocess.DEVNULL (an int) for the sign-in on macOS and Linux.
        launched.append((command, stdin.read().decode("utf-8") if hasattr(stdin, "read") else "", kwargs))
        if "--output-last-message" in command:
            Path(command[command.index("--output-last-message") + 1]).write_text("回答", "utf-8")
        if hasattr(stdout, "write"):  # The sign-in has no captured output.
            stdout.write(stdout_bytes)
            stdout.flush()
        return Mock(poll=Mock(return_value=0), returncode=0)
    return mock_popen


class ProvidersTests(unittest.TestCase):
    def test_parse_json_answer(self):
        self.assertEqual(parse_json_answer('{"a": 1}'), {"a": 1})
        self.assertEqual(parse_json_answer('```json\n{"a": 2}\n```'), {"a": 2})
        self.assertEqual(parse_json_answer('```JSON\n{"a": 3}'), {"a": 3})
        with self.assertRaises(ValueError):
            parse_json_answer("not a json")
        with self.assertRaises(ValueError):
            parse_json_answer('["list", "not", "dict"]')

    def test_json_answer_with_words_around_it_must_follow_the_schema(self):
        answer = {"translations": [{"id": "p1b0", "text": "訳文 {x} と }"}]}
        body = json.dumps(answer, ensure_ascii=False)
        for text in (f"Here is the translation:\n{body}\nDone.", f"訳しました。\n```json\n{body}\n```\n以上です。"):
            with self.subTest(text=text):
                self.assertEqual(parse_json_answer(text, TRANSLATION_SCHEMA), answer)
        refused = (
            "Here: " + body[:-2],  # Cut off.
            f"{body}\n{body}",  # Two answers: the outermost braces do not hold one object.
            "Note {see below}: " + body,  # Braces in the words around it.
            "Here: " + json.dumps({"translations": [{"id": "p1b0"}]}),  # Parses, but not in the requested shape.
            "Here: " + json.dumps({"translations": [], "note": "extra"}),
            "Here: [1, 2]",
        )
        for text in refused:
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_json_answer(text, TRANSLATION_SCHEMA)
        # A bare object is taken as before; the caller checks its content.
        self.assertEqual(parse_json_answer('{"translations": [], "note": "extra"}', TRANSLATION_SCHEMA),
                         {"translations": [], "note": "extra"})

    def test_matches_schema(self):
        self.assertTrue(matches_schema({"translations": [{"id": "a", "text": "b"}]}, TRANSLATION_SCHEMA))
        self.assertFalse(matches_schema({"translations": [{"id": "a", "text": 1}]}, TRANSLATION_SCHEMA))
        self.assertFalse(matches_schema({"translations": [{"id": "a", "text": "b", "x": 1}]}, TRANSLATION_SCHEMA))
        parts = _parts_schema(2)
        self.assertTrue(matches_schema({"parts": [{"kind": "text", "text": "a"}, {"kind": "math", "index": 1}]}, parts))
        for bad in ({"kind": "math", "index": 2}, {"kind": "math", "index": True}, {"kind": "math", "index": 1.0},
                    {"kind": "math", "text": "a"}, {"kind": "text", "index": 0}):
            with self.subTest(part=bad):
                self.assertFalse(matches_schema({"parts": [bad]}, parts))

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
        with patch("shutil.which", return_value="/opt/bin/my-claude") as which:
            self.assertEqual(provider.command(), [str(Path("/opt/bin/my-claude"))])  # A bare name, from PATH.
        which.assert_called_once_with("my-claude")
        provider = ClaudeCodeProvider(Settings(provider="claude"))
        with patch("shutil.which", return_value="/usr/bin/claude"):
            self.assertEqual(provider.command(), [str(Path("/usr/bin/claude"))])
        with patch("shutil.which", return_value=None), nothing_installed_on_posix():
            with self.assertRaisesRegex(RuntimeError, "Claude Code CLIが見つかりません"):
                provider.command()

    def test_configured_cli_path_that_names_no_file_is_reported_as_a_setting(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "node_modules" / CodexProvider.npm_entry).parent.mkdir(parents=True)
            (folder / "node_modules" / CodexProvider.npm_entry).write_text("", "utf-8")
            for cls, configured in ((ClaudeCodeProvider, str(folder / "claude.exe")),
                                    # A missing shim is missing, not refused for cmd.exe (even with the npm entry beside it).
                                    (CodexProvider, str(folder / "codex.cmd")),
                                    (CodexProvider, str(folder)),  # A folder, not a program.
                                    (AntigravityProvider, "agy-not-on-path")):
                with self.subTest(configured=configured):
                    provider = cls(Settings(provider=cls.spec.id, provider_options={cls.spec.id: {"cli_path": configured}}))
                    with patch("shutil.which", return_value=None), patch(POPEN) as popen, patch(RUN) as run:
                        message = f"{cls.tool_name} の実行ファイルが見つかりません（{configured}）。設定の接続先で、パスを確かめてください。"
                        with self.assertRaises(RuntimeError) as raised:
                            provider.command()
                        self.assertEqual(str(raised.exception), message)
                        with self.assertRaisesRegex(RuntimeError, "の実行ファイルが見つかりません"):
                            provider.check()
                        self.assertFalse(provider.login_status())
                    popen.assert_not_called()
                    run.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "PATHEXT: Windows finds a program without its extension")
    def test_configured_cli_path_is_found_as_windows_finds_a_program(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            exe = folder / "claude.exe"
            exe.write_bytes(b"")
            npm = folder / "npm"
            entry = npm / "node_modules" / CodexProvider.npm_entry
            entry.parent.mkdir(parents=True)
            entry.write_text("", "utf-8")
            (npm / "codex").write_text("#!/bin/sh\nexec node ...\n", "utf-8")  # npm's sh script, no extension.
            (npm / "codex.cmd").write_text("@exit /b 9\n", "utf-8")
            (npm / "node.exe").write_bytes(b"")
            with patch.dict(os.environ, {"PATH": str(folder), "PAPEER_TEST_HOME": str(folder)}):
                for cls, configured, command in (
                        (ClaudeCodeProvider, str(folder / "claude"), [exe]),  # No extension.
                        (ClaudeCodeProvider, "claude", [exe]),  # A bare name, on PATH.
                        (ClaudeCodeProvider, f"  {exe}  ", [exe]),
                        (ClaudeCodeProvider, f'"{exe}"', [exe]),
                        (ClaudeCodeProvider, "%PAPEER_TEST_HOME%\\claude.exe", [exe]),
                        (CodexProvider, str(npm / "codex.cmd"), [npm / "node.exe", entry]),
                        (CodexProvider, str(npm / "codex"), [npm / "node.exe", entry]),  # What `where codex` lists first.
                ):
                    with self.subTest(configured=configured):
                        provider = cls(Settings(provider=cls.spec.id, provider_options={cls.spec.id: {"cli_path": configured}}))
                        self.assertEqual([Path(part) for part in provider.command()], command)

    def test_antigravity_command_detection(self):
        provider = AntigravityProvider(Settings(provider="antigravity", provider_options={"antigravity": {"cli_path": "my-agy"}}))
        with patch("shutil.which", return_value="/opt/bin/my-agy"):
            self.assertEqual(provider.command(), [str(Path("/opt/bin/my-agy"))])
        provider = AntigravityProvider(Settings(provider="antigravity"))
        with patch("shutil.which", return_value="/usr/bin/agy"):
            self.assertEqual(provider.command(), [str(Path("/usr/bin/agy"))])
        with patch("shutil.which", return_value=None), nothing_installed_on_posix():
            with self.assertRaisesRegex(RuntimeError, "Antigravity CLI"):
                provider.command()

    def test_cli_installed_where_macos_and_linux_installers_put_it_is_found_off_path(self):
        # An app started from the Finder has launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin) only.
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)

            def install(relative: str) -> Path:
                path = home / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("#!/bin/sh\n", "utf-8")
                path.chmod(0o755)
                return path

            real_folders = common.unix_bin_folders

            def found(cls) -> list[str]:
                # Only the install folders under the home folder: not whatever /usr/local/bin holds here.
                with patch("shutil.which", return_value=None), \
                        patch("papeer.providers.common._windows", return_value=False), \
                        patch("papeer.providers.common.Path.home", return_value=home), \
                        patch("papeer.providers.common.unix_bin_folders",
                              side_effect=lambda home: [folder for folder in real_folders(home)
                                                        if folder.is_relative_to(home)]):
                    return cls(Settings(provider=cls.spec.id)).command()

            # The newest Node.js first, by version and not by name ("v10" < "v18" < "v22" < "v8" as text).
            for version in ("v8.17.0", "v10.24.1", "v18.20.4", "v22.1.0"):
                install(f".nvm/versions/node/{version}/bin/codex")
            self.assertEqual(found(CodexProvider), [str(home / ".nvm/versions/node/v22.1.0/bin/codex")])
            nvm = [folder.parent.name for folder in real_folders(home) if ".nvm" in folder.parts]
            self.assertEqual(nvm, ["v22.1.0", "v18.20.4", "v10.24.1", "v8.17.0"])
            for version in ("v8.17.0", "v22.1.0", "v18.20.4", "v10.24.1"):
                (home / f".local/share/fnm/node-versions/{version}/installation/bin").mkdir(parents=True)
            fnm = [folder.parent.parent.name for folder in real_folders(home) if "fnm" in folder.parts]
            self.assertEqual(fnm, ["v22.1.0", "v18.20.4", "v10.24.1", "v8.17.0"])
            shutil.rmtree(home / ".nvm")
            legacy = install(".claude/local/claude")
            self.assertEqual(found(ClaudeCodeProvider), [str(legacy)])
            native = install(".local/bin/claude")  # The Claude Code installer.
            self.assertEqual(found(ClaudeCodeProvider), [str(legacy)])  # Its own candidates first.
            legacy.unlink()
            self.assertEqual(found(ClaudeCodeProvider), [str(native)])
            agy = install(".gemini/bin/agy")
            self.assertEqual(found(AntigravityProvider), [str(agy)])

    def test_cli_path_on_macos_and_linux_holds_its_folders_and_the_install_folders(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / ".volta/bin").mkdir(parents=True)
            cli = home / ".nvm/versions/node/v22.0.0/bin/claude"
            cli.parent.mkdir(parents=True)
            usr_bin, bin_ = str(Path("/usr/bin").absolute()), str(Path("/bin").absolute())
            current = os.pathsep.join([usr_bin, bin_, usr_bin, "relative/bin", ""])
            # Without node beside it, the CLI's folder comes after PATH: a CLI in /usr/bin must not put
            # /usr/bin before the nvm or pyenv folders of PATH.
            folders = common.cli_search_path([str(cli), "-p"], current, home).split(os.pathsep)
            self.assertEqual(folders[:2], [usr_bin, bin_])
            self.assertLess(folders.index(bin_), folders.index(str(cli.parent)))
            # With node beside it, the CLI's folder first: `#!/usr/bin/env node` finds the node it was installed with.
            node = cli.parent / "node"
            node.write_text("#!/bin/sh\n", "utf-8")
            node.chmod(0o755)
            folders = common.cli_search_path([str(cli), "-p"], current, home).split(os.pathsep)
            self.assertEqual(folders[0], str(cli.parent))
            self.assertIn(os.path.dirname(os.path.realpath(cli)), folders)
            # PATH as it was, then the install folders that exist (and not those that do not); only
            # absolute folders, each once.
            self.assertLess(folders.index(bin_), folders.index(str(home / ".volta/bin")))
            self.assertNotIn(str(home / ".bun/bin"), folders)
            self.assertNotIn("relative/bin", folders)
            self.assertTrue(all(os.path.isabs(folder) for folder in folders))
            self.assertEqual(len(folders), len(set(folders)))
            with patch("papeer.providers.common._windows", return_value=False), \
                    patch("papeer.providers.common.Path.home", return_value=home), \
                    patch.dict(os.environ, {"PATH": "/usr/bin", "PAPEER_TOKEN": "secret"}):
                env = common.child_env([str(cli)])
            self.assertEqual(env["PATH"].split(os.pathsep)[0], str(cli.parent))
            self.assertNotIn("PAPEER_TOKEN", env)
        with patch("papeer.providers.common._windows", return_value=True), patch.dict(os.environ, {"PATH": "C:\\bin"}):
            self.assertEqual(common.child_env(["C:\\tools\\claude.exe"])["PATH"], "C:\\bin")  # Windows: as it is.

    def test_running_clis_are_known_until_they_end(self):
        seen = []

        def popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            process = Mock(poll=Mock(return_value=0), returncode=0, pid=1)
            seen.append(process)
            stdout.write(b"answer")
            stdout.flush()
            return process

        with patch(POPEN, side_effect=popen), patch("papeer.providers.common.kill_tree"), \
                patch("papeer.providers.common.track_cli", side_effect=common.track_cli) as track:
            run_cli_process(["cli"], b"", threading.Event(), 30, "CLI", Path(tempfile.gettempdir()))
        track.assert_called_once_with(seen[0])
        self.assertNotIn(seen[0], common._running_clis)  # Forgotten once it has ended.

    def test_ending_the_running_clis_sends_sigterm_then_sigkill_to_each_group(self):
        running = Mock(poll=Mock(return_value=None), pid=41)
        ended = Mock(poll=Mock(return_value=0), pid=42)
        signals = []
        # POSIX's signals, on any host.
        posix_signals = Mock(SIGTERM=15, SIGKILL=9)
        with patch("papeer.providers.common.sys.platform", "linux"), \
                patch("papeer.providers.common.signal", posix_signals), \
                patch("papeer.providers.common._signal_group",
                      side_effect=lambda process, signum: signals.append((process.pid, signum))), \
                patch("papeer.providers.common._group_alive", return_value=True):
            common.track_cli(running)
            common.track_cli(ended)
            try:
                self.assertEqual(common.end_running_clis(grace=0.1), 1)
            finally:
                common.untrack_cli(running)
                common.untrack_cli(ended)
        self.assertEqual(signals, [(41, 15), (41, 9)])

    def test_ending_the_running_clis_does_not_kill_a_group_that_has_ended(self):
        running = Mock(poll=Mock(return_value=None), pid=41)
        signals = []
        posix_signals = Mock(SIGTERM=15, SIGKILL=9)
        with patch("papeer.providers.common.sys.platform", "linux"),                 patch("papeer.providers.common.signal", posix_signals),                 patch("papeer.providers.common._signal_group",
                      side_effect=lambda process, signum: signals.append((process.pid, signum))),                 patch("papeer.providers.common._group_alive", return_value=False):
            common.track_cli(running)
            try:
                self.assertEqual(common.end_running_clis(grace=0.1), 1)
            finally:
                common.untrack_cli(running)
        self.assertEqual(signals, [(41, 15)])  # No SIGKILL: its pid may belong to another process by now.

    def test_a_cli_is_forgotten_even_when_ending_it_fails(self):
        process = Mock(poll=Mock(return_value=0), returncode=0, pid=1)

        def popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
            stdout.write(b"answer")
            stdout.flush()
            return process

        with patch(POPEN, side_effect=popen),                 patch("papeer.providers.common.kill_tree", side_effect=RuntimeError("taskkill timed out")):
            with self.assertRaises(RuntimeError):
                run_cli_process(["cli"], b"", threading.Event(), 30, "CLI", Path(tempfile.gettempdir()))
        self.assertNotIn(process, common._running_clis)

    def test_the_running_lock_can_be_taken_again_by_a_signal_handler(self):
        self.assertIsInstance(common._running_lock, type(threading.RLock()))

    @unittest.skipIf(os.name == "nt", "process groups: macOS and Linux")
    def test_ending_the_running_clis_reaches_what_they_started(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "child"
            process = subprocess.Popen(["sh", "-c", f"trap '' TERM; sleep 60 & echo $! > {pid_file}; wait"],
                                       **common.process_kwargs())
            common.track_cli(process)
            try:
                deadline = time.monotonic() + 10
                while not pid_file.is_file() or not pid_file.read_text().strip():
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.05)
                child = int(pid_file.read_text())
                self.assertEqual(common.end_running_clis(grace=0.5), 1)
                process.wait(10)
                while True:
                    try:
                        os.kill(child, 0)
                    except ProcessLookupError:
                        break
                    self.assertLess(time.monotonic(), deadline + 10, "the CLI's own process is still running")
                    time.sleep(0.05)
            finally:
                common.untrack_cli(process)

    def test_sign_in_on_macos_and_linux_runs_out_of_the_sidecars_process_group(self):
        # Ending the sidecar's group (the app exits) must not end the sign-in, as on Windows.
        with cli(CodexProvider), patch("papeer.providers.common.sys.platform", "linux"), \
                patch("papeer.providers.common.terminal_command", side_effect=lambda script: ["term", "sh", script]), \
                patch(POPEN) as popen:
            message = CodexProvider(Settings()).login()
        command, kwargs = popen.call_args.args[0], popen.call_args.kwargs
        script = Path(command[-1])
        try:
            self.assertEqual(command[:2], ["term", "sh"])
            self.assertIn("\ncli login\n", script.read_text("utf-8"))
            self.assertIn("開いた端末", message)
        finally:
            script.unlink(missing_ok=True)
        self.assertIs(kwargs["start_new_session"], True)
        self.assertEqual(kwargs["stdin"], __import__("subprocess").DEVNULL)

    def test_sign_in_without_a_terminal_shows_the_command_to_run(self):
        with cli(ClaudeCodeProvider), patch("papeer.providers.common.sys.platform", "linux"), \
                patch("papeer.providers.common.terminal_command", return_value=None), patch(POPEN) as popen:
            message = ClaudeCodeProvider(Settings()).login()
        popen.assert_not_called()
        self.assertIn("端末を開けませんでした", message)
        self.assertTrue(message.endswith("\ncli auth login"), message)

    def test_the_sign_in_script_runs_the_cli_with_its_path_and_waits_before_closing(self):
        script = common.login_script(["/opt/my tools/claude", "auth", "login"], "/opt/my tools:/usr/bin")
        lines = script.splitlines()
        self.assertEqual(lines[:4], ["#!/bin/sh", 'rm -f -- "$0"', "export PATH='/opt/my tools:/usr/bin'",
                                     "'/opt/my tools/claude' auth login"])
        self.assertEqual(lines[-1], "read -r _")

    def test_the_sign_in_opens_terminal_on_macos_and_the_first_terminal_found_on_linux(self):
        self.assertEqual(common.terminal_command("/tmp/s.command", "darwin", lambda name: None),
                         ["open", "-a", "Terminal", "/tmp/s.command"])
        installed = {"xterm": "/usr/bin/xterm", "gnome-terminal": "/usr/bin/gnome-terminal"}
        self.assertEqual(common.terminal_command("/tmp/s.command", "linux", installed.get),
                         ["/usr/bin/gnome-terminal", "--", "sh", "/tmp/s.command"])
        self.assertEqual(common.terminal_command("/tmp/s.command", "linux", {"xterm": "/usr/bin/xterm"}.get),
                         ["/usr/bin/xterm", "-e", "sh", "/tmp/s.command"])
        self.assertIsNone(common.terminal_command("/tmp/s.command", "linux", lambda name: None))

    def test_an_npm_cli_on_macos_and_linux_runs_with_the_node_beside_it(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            bin_ = home / ".nvm/versions/node/v22.1.0/bin"
            bin_.mkdir(parents=True)
            script = bin_ / "codex"
            script.write_text("#!/usr/bin/env node\nconsole.log(1)\n", "utf-8")
            node = bin_ / "node"
            node.write_text("#!/bin/sh\n", "utf-8")
            for path in (script, node):
                path.chmod(0o755)
            with patch.dict(os.environ, {"PATH": ""}):
                self.assertEqual(common.node_script_command(script, "Codex", home), [str(node), str(script)])
                # Options on the first line go to node.
                script.write_text("#!/usr/bin/env -S node --no-warnings\n", "utf-8")
                self.assertEqual(common.node_script_command(script, "Codex", home),
                                 [str(node), "--no-warnings", str(script)])
                # Not a script for node: run as it is.
                script.write_text("#!/bin/sh\n", "utf-8")
                self.assertEqual(common.node_script_command(script, "Codex", home), [str(script)])
                script.write_text("#!/usr/bin/env nodejs\n", "utf-8")
                self.assertEqual(common.node_script_command(script, "Codex", home), [str(script)])
                # No node anywhere: said before anything is started.
                script.write_text("#!/usr/bin/env node\n", "utf-8")
                node.unlink()
                with patch("papeer.providers.common.unix_bin_folders", return_value=[]):
                    with self.assertRaisesRegex(RuntimeError, "Codex は Node.js で動くため node が必要ですが、見つかりません"):
                        common.node_script_command(script, "Codex", home)
                    # Else the first node on the CLI's PATH.
                    other = home / "other"
                    other.mkdir()
                    (other / "node").write_text("#!/bin/sh\n", "utf-8")
                    (other / "node").chmod(0o755)
                    with patch.dict(os.environ, {"PATH": str(other)}):
                        self.assertEqual(common.node_script_command(script, "Codex", home),
                                         [str(other / "node"), str(script)])

    def test_find_cli_on_macos_and_linux_starts_an_npm_script_with_node(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            script = folder / "claude"
            script.write_text("#!/usr/bin/env node\n", "utf-8")
            (folder / "node").write_text("#!/bin/sh\n", "utf-8")
            for path in (script, folder / "node"):
                path.chmod(0o755)
            provider = ClaudeCodeProvider(Settings(provider="claude", provider_options={"claude": {"cli_path": str(script)}}))
            with patch("papeer.providers.common._windows", return_value=False):
                self.assertEqual(provider.command(), [str(folder / "node"), str(script)])

    @unittest.skipIf(os.name == "nt", "process groups: macOS and Linux")
    def test_stopping_a_cli_ends_the_processes_it_started(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "child"
            # A CLI that ignores SIGTERM and has started a process of its own, which ignores it as well.
            process = subprocess.Popen(["sh", "-c", f"trap '' TERM; sleep 60 & echo $! > {pid_file}; wait"],
                                       **common.process_kwargs())
            deadline = time.monotonic() + 10
            while not pid_file.is_file() or not pid_file.read_text().strip():
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.05)
            child = int(pid_file.read_text())
            with patch.object(process, "wait", side_effect=[subprocess.TimeoutExpired("sh", 5), 0]):
                common.kill_tree(process)  # SIGTERM is ignored: after the wait, SIGKILL to the whole group.
            process.wait(10)
            while True:
                try:
                    os.kill(child, 0)
                except ProcessLookupError:
                    break
                self.assertLess(time.monotonic(), deadline + 10, "the CLI's own process is still running")
                time.sleep(0.05)
            common.kill_tree(process)  # Already gone: nothing to do, no error.

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

    @unittest.skipUnless(os.name == "nt", "Windows job objects")
    def test_cli_sign_in_console_starts_outside_the_apps_job(self):
        # The app's job ends the sidecar's processes as the app exits; the sign-in console and its browser
        # may stay. A job that does not let processes leave refuses the flag: the console starts inside it.
        import subprocess
        leave = subprocess.CREATE_NEW_CONSOLE | subprocess.CREATE_BREAKAWAY_FROM_JOB
        for refused in (False, True):
            with self.subTest(refused=refused):
                flags = []

                def popen(command, env=None, creationflags=0):
                    flags.append(creationflags)
                    if refused and creationflags & subprocess.CREATE_BREAKAWAY_FROM_JOB:
                        raise PermissionError(13, "Access is denied")
                    return Mock()

                with cli(CodexProvider), patch(POPEN, side_effect=popen):
                    CodexProvider(Settings()).login()
                self.assertEqual(flags, [leave, subprocess.CREATE_NEW_CONSOLE] if refused else [leave])


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
        # On macOS and Linux the sign-in starts a terminal; the one it would find is played here.
        with patch.dict(os.environ, secrets), cli(ClaudeCodeProvider), \
                patch("papeer.providers.common.terminal_command", side_effect=lambda script: ["term", script]), \
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
            with node_on_path("/bin/node"):
                with self.assertRaisesRegex(RuntimeError, "claude.cmd は cmd.exe を経由するため使いません"):
                    provider.command()  # No JS entry next to the shim: the shim itself is never run.
            entry = folder / "node_modules" / ClaudeCodeProvider.npm_entry
            entry.parent.mkdir(parents=True)
            entry.write_text("", "utf-8")
            with node_on_path(None):
                with self.assertRaisesRegex(RuntimeError, "Node.js"):
                    provider.command()  # A JS entry but no node to run it.
            with node_on_path("/bin/node"):
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
            with node_on_path("/bin/node"):
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

    def test_retry_after_holds_back_the_other_requests_of_the_connection(self):
        # Parallel translation: a request starting while another waits out a Retry-After waits
        # for the rest of it too, instead of meeting the same rate limit and using up its sends.
        provider = FlakyProvider(TransientError("429", retry_after=30.0))
        self.assertEqual(provider.generate("i", "d"), "answer")
        self.assertEqual(provider.generate("i", "d"), "answer")
        first, rest = provider.cancel.waits
        self.assertEqual(first, 30.0)
        self.assertAlmostEqual(rest, 30.0, delta=5)  # RecordingEvent does not wait: the pause is still ahead.
        self.assertEqual(provider.sends, 3)
        # Waits the service did not ask for (backoff) are the request's own.
        provider = FlakyProvider(TransientError("offline"))
        provider.generate("i", "d")
        provider.generate("i", "d")
        self.assertEqual(provider.cancel.waits, [2.0])

    def test_waiting_for_another_request_does_not_count_toward_the_limits(self):
        provider = FlakyProvider(TransientError("429", retry_after=TRANSPORT_WAIT_LIMIT - 1))
        provider.generate("i", "d")
        # The next request waits out the pause, then still gets its own sends after a Retry-After.
        provider.errors = [TransientError("429", retry_after=TRANSPORT_WAIT_LIMIT - 1)]
        self.assertEqual(provider.generate("i", "d"), "answer")
        self.assertEqual(provider.sends, 4)

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
        self.assertTrue(caught.exception.after_sending)  # The CLI had the request: past its deadline, not unsent.
        self.assertIn("タイムアウト", str(caught.exception))

    def test_cli_answer_that_came_as_the_job_was_cancelled_is_kept(self):
        # The CLI ended by itself as the cancel came: its answer is paid for and goes to the caller, which
        # records it before it stops (translation would otherwise send the same request again on resuming).
        cancel = threading.Event()
        cancel.set()

        def ended(returncode):
            def popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
                stdout.write(b"answer")
                stdout.flush()
                return Mock(poll=Mock(return_value=returncode), returncode=returncode)
            return popen

        with tempfile.TemporaryDirectory() as directory:
            with patch(POPEN, side_effect=ended(0)):
                self.assertEqual(run_cli_process(["cli"], b"", cancel, 60, "CLI", Path(directory)),
                                 ("answer", "answer"))
            # A run that failed brings no answer: it ends as cancelled, as before.
            with patch(POPEN, side_effect=ended(1)), self.assertRaises(Cancelled):
                run_cli_process(["cli"], b"", cancel, 60, "CLI", Path(directory))

    def test_api_answer_that_came_as_the_job_was_cancelled_is_kept(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(handler):
                handler.rfile.read(int(handler.headers["Content-Length"]))
                requests.append(1)
                body = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": "訳文"}}]}).encode()
                handler.send_response(200)
                handler.send_header("Content-Type", "application/json")
                handler.send_header("Content-Length", str(len(body)))
                handler.end_headers()
                handler.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        cancel = threading.Event()
        settings = Settings(provider="api", model="m",
                            provider_options={"api": {"base_url": f"http://127.0.0.1:{server.server_port}/v1"}})
        provider = create_provider(settings, cancel)
        # The cancel comes once the response has been read, before the request's thread hands it over.
        with patch.object(OpenAICompatProvider, "_remember_limits", side_effect=lambda headers: cancel.set()):
            started = time.monotonic()
            self.assertEqual(provider.generate("i", "d"), "訳文")
        self.assertTrue(cancel.is_set())
        self.assertLess(time.monotonic() - started, 0.45)  # Handed over at once, not at the next half-second check.
        # A request not sent yet is not sent once the job is cancelled.
        with self.assertRaises(Cancelled):
            provider._fetch(Request(f"http://127.0.0.1:{server.server_port}/v1/chat/completions", data=b"{}"))
        self.assertEqual(len(requests), 1)

    def test_api_timeouts_and_dropped_connections_are_sent_again(self):
        body = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": "訳文"}}]}).encode()
        for error in (TimeoutError("timed out"), ConnectionResetError("reset"), URLError(ConnectionRefusedError())):
            with self.subTest(error=error):
                provider = create_provider(Settings(provider="api", model="m"), RecordingEvent())
                with patch.object(OpenAICompatProvider, "_fetch", side_effect=[error, body]) as fetch:
                    self.assertEqual(provider.generate("i", "d"), "訳文")
                self.assertEqual(fetch.call_count, 2)

    def test_api_timeout_tells_whether_the_server_had_the_request(self):
        # urllib wraps a timeout while connecting or sending in URLError; one waiting for the response is bare.
        for error, after_sending in ((URLError(TimeoutError("timed out")), False), (TimeoutError("timed out"), True)):
            with self.subTest(error=error):
                provider = create_provider(Settings(provider="api", model="m"), RecordingEvent())
                with patch.object(OpenAICompatProvider, "_fetch", side_effect=[error, error]) as fetch:
                    with self.assertRaises(TransientError) as caught:
                        provider.generate("i", "d")
                self.assertEqual(fetch.call_count, 2)  # Any timeout is sent again only once.
                self.assertTrue(caught.exception.timed_out)
                self.assertEqual(caught.exception.after_sending, after_sending)

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


def http_error(status: int, body: str = "") -> HTTPError:
    return HTTPError("https://example.invalid", status, "error", Message(), io.BytesIO(body.encode()))  # type: ignore[arg-type]


API_ANSWER = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": '{"text": "訳文"}'}}]}).encode()
SCHEMA = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}


class StructuredOutputTests(unittest.TestCase):
    """Requests with a schema ask the server for that shape and a low temperature, stepping down on refusals."""

    def setUp(self):
        forget_refused_options()
        self.addCleanup(forget_refused_options)

    def send(self, replies, schema=SCHEMA, **settings):
        """generate() once against scripted replies (an HTTPError or a body); return (answer or error, payloads sent)."""
        payloads, replies = [], list(replies)

        def fetch(request):
            payloads.append(json.loads(request.data))
            reply = replies.pop(0) if replies else API_ANSWER
            if isinstance(reply, Exception):
                raise reply
            return reply

        values = {"provider": "api", "model": "gpt-4.1-mini", **settings}
        provider = create_provider(Settings(**values), RecordingEvent())
        with patch.object(OpenAICompatProvider, "_fetch", side_effect=fetch):
            try:
                result = provider.generate("Translate", "data", schema)
            except Exception as error:  # noqa: BLE001 - the test inspects it
                result = error
        return result, payloads

    def test_schema_requests_ask_for_the_schema_and_a_low_temperature(self):
        answer, payloads = self.send([])
        self.assertEqual(answer, '{"text": "訳文"}')
        self.assertEqual(payloads[0]["response_format"],
                         {"type": "json_schema", "json_schema": {"name": "answer", "schema": SCHEMA, "strict": True}})
        self.assertEqual(payloads[0]["temperature"], STRUCTURED_TEMPERATURE)
        # The prompt still names the schema, for servers that ignore response_format.
        self.assertIn(json.dumps(SCHEMA), payloads[0]["messages"][0]["content"])

    def test_chat_and_summaries_keep_the_server_defaults(self):
        _, payloads = self.send([], schema=None)
        self.assertNotIn("response_format", payloads[0])
        self.assertNotIn("temperature", payloads[0])

    def test_reasoning_models_get_no_temperature(self):
        for model in ("o1", "o3-mini", "o4-mini-2025-04-16", "openai/o3", "gpt-5", "gpt-5-mini", "gpt-5.1", "openai/gpt-5"):
            with self.subTest(model=model):
                _, payloads = self.send([], model=model)
                self.assertNotIn("temperature", payloads[0])
                self.assertEqual(payloads[0]["response_format"]["type"], "json_schema")
        _, payloads = self.send([], reasoning_effort="low")
        self.assertNotIn("temperature", payloads[0])
        for model in ("gpt-4o", "gpt-4.1-mini", "llama3.1:8b", "qwen2.5:14b", "olmo2"):
            with self.subTest(model=model):
                _, payloads = self.send([], model=model)
                self.assertEqual(payloads[0]["temperature"], STRUCTURED_TEMPERATURE)

    def test_refused_json_schema_steps_down_and_is_remembered_per_endpoint_and_model(self):
        refusal = http_error(400, '{"error": {"message": "Unknown response_format type: json_schema"}}')
        answer, payloads = self.send([refusal])
        self.assertEqual(answer, '{"text": "訳文"}')
        self.assertEqual([p["response_format"]["type"] for p in payloads], ["json_schema", "json_object"])
        # The next request goes straight to what answered, without meeting the refusal again.
        _, payloads = self.send([])
        self.assertEqual([p["response_format"]["type"] for p in payloads], ["json_object"])
        _, payloads = self.send([], model="another-model")
        self.assertEqual([p["response_format"]["type"] for p in payloads], ["json_schema"])
        _, payloads = self.send([], provider_options={"api": {"base_url": "https://other.example/v1"}})
        self.assertEqual([p["response_format"]["type"] for p in payloads], ["json_schema"])

    def test_server_refusing_both_forms_gets_the_prompt_only(self):
        # LM Studio refuses json_object; a server taking neither form gets no response_format at all.
        answer, payloads = self.send([http_error(400, "'response_format.type' must be 'json_schema' or 'text'"),
                                      http_error(422, "unsupported")])
        self.assertEqual(answer, '{"text": "訳文"}')
        self.assertEqual([p.get("response_format", {}).get("type") for p in payloads], ["json_schema", "json_object", None])
        self.assertTrue(all(p["temperature"] == STRUCTURED_TEMPERATURE for p in payloads))
        _, payloads = self.send([])
        self.assertEqual([("response_format" in p, "temperature" in p) for p in payloads], [(False, True)])

    def test_refused_temperature_is_left_out_and_remembered(self):
        refusal = http_error(400, json.dumps({"error": {"message": "Unsupported value: 'temperature' does not support 0.2 "
                                                                   "with this model.", "param": "temperature"}}))
        answer, payloads = self.send([refusal], model="my-azure-deployment")
        self.assertEqual(answer, '{"text": "訳文"}')
        self.assertEqual([("temperature" in p, p["response_format"]["type"]) for p in payloads],
                         [(True, "json_schema"), (False, "json_schema")])
        _, payloads = self.send([], model="my-azure-deployment")
        self.assertEqual([("temperature" in p, p["response_format"]["type"]) for p in payloads], [(False, "json_schema")])

    def test_validation_error_echoing_the_request_steps_down_the_form_first(self):
        # A 422 may hold the request it refused, temperature included: that is no refusal of the temperature.
        echo = http_error(422, json.dumps({"detail": [{"loc": ["body", "response_format", "type"], "msg": "invalid",
                                                       "input": {"temperature": 0.2, "response_format": {}}}]}))
        answer, payloads = self.send([echo])
        self.assertEqual(answer, '{"text": "訳文"}')
        self.assertEqual([(p["response_format"]["type"], "temperature" in p) for p in payloads],
                         [("json_schema", True), ("json_object", True)])
        # A body about the temperature alone leaves the form as it is.
        forget_refused_options()
        answer, payloads = self.send([http_error(400, "temperature is not supported for this model")])
        self.assertEqual([(p["response_format"]["type"], "temperature" in p) for p in payloads],
                         [("json_schema", True), ("json_schema", False)])

    def test_refused_form_is_remembered_per_kind_of_schema(self):
        parts = {"type": "object", "properties": {"parts": {"type": "array", "items": {"anyOf": [
            {"type": "object", "properties": {"kind": {"type": "string"}}}]}}}}
        self.send([http_error(400, "anyOf is not supported in json_schema")], schema=parts)
        _, payloads = self.send([], schema=parts)
        self.assertEqual([p["response_format"]["type"] for p in payloads], ["json_object"])
        _, payloads = self.send([])
        self.assertEqual([p["response_format"]["type"] for p in payloads], ["json_schema"])

    def test_refusal_for_another_reason_reports_the_first_error_and_remembers_nothing(self):
        # A context too long (or an effort the model does not take) fails in every form: nothing is learnt.
        too_long = http_error(400, "This model's maximum context length is 8192 tokens.")
        answer, payloads = self.send([too_long] * 4, reasoning_effort="high")
        self.assertIsInstance(answer, RuntimeError)
        self.assertNotIsInstance(answer, TransientError)
        self.assertIn("HTTP 400", str(answer))
        self.assertIn("既定値", str(answer))
        self.assertEqual([p.get("response_format", {}).get("type") for p in payloads], ["json_schema", "json_object", None])
        _, payloads = self.send([])
        self.assertEqual([p["response_format"]["type"] for p in payloads], ["json_schema"])

    def test_only_refusals_step_down(self):
        for error, sends in ((http_error(401, "invalid api key"), 1), (http_error(404, "Not Found"), 1),
                             (http_error(404, "No endpoints found that support the requested parameters"), 2),
                             (http_error(500, "Invalid response_format"), 2)):
            with self.subTest(error=error.code, body=sends):
                forget_refused_options()
                with patch.object(OpenAICompatProvider, "transport_backoff", 0.0):
                    answer, payloads = self.send([error])
                self.assertEqual(len(payloads), sends)
                if sends == 1:
                    self.assertIsInstance(answer, RuntimeError)
                else:
                    self.assertEqual(answer, '{"text": "訳文"}')

    def test_temporary_error_while_stepping_down_is_sent_again_from_the_start(self):
        refusal = http_error(400, "response_format json_schema is not supported")
        answer, payloads = self.send([refusal, http_error(503, "busy"), refusal])
        self.assertEqual(answer, '{"text": "訳文"}')
        self.assertEqual([p["response_format"]["type"] for p in payloads],
                         ["json_schema", "json_object", "json_schema", "json_object"])


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

    def test_cli_exit_is_judged_by_its_error_output_only(self):
        """The model's text and the status events never decide: only stderr and the events reporting an error."""
        success = (0, [self.result("訳文", is_error=False)], "")
        document = "You've hit your usage credit limit; refresh token; quota; 401 Unauthorized"
        status = {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "overageDisabledReason": "out_of_credits"}}
        assistant = {"type": "assistant", "message": {"content": [{"type": "text", "text": document}]}}
        error, runs = self.claude((1, [status, assistant], ""), success)
        self.assertEqual((error, runs), (None, 2))
        codex_answer = {"type": "item.completed", "item": {"type": "agent_message", "text": document}}
        dropped = "stream disconnected before completion"
        error, runs = self.claude((1, [codex_answer, {"type": "error", "message": dropped},
                                       {"type": "turn.failed", "error": {"message": dropped}}], ""),
                                  provider_id="codex", cls=CodexProvider)
        self.assertIsInstance(error, TransientError)
        self.assertEqual(runs, 3)  # Sent again, as many times as a temporary failure is.
        self.assertEqual(str(error), f"Codex接続に失敗しました。ログイン状態・利用枠を確認してください。\n{dropped}")
        # Shown as judged: the error once, without the answer.
        error, _ = self.claude((1, [codex_answer, {"type": "turn.failed", "error": {"message": "Not logged in"}}], "warn"),
                               provider_id="codex", cls=CodexProvider)
        self.assertEqual(str(error), "Codex接続に失敗しました。ログイン状態・利用枠を確認してください。\nwarn\nNot logged in")

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
