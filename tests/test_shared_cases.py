"""Rules the frontend keeps too, tested here against the same cases as its tests (frontend/tests/sharedCases.test.ts)."""
import json
from pathlib import Path
import re
import threading
import unittest
from unittest.mock import Mock, patch

from papeer.core.config import Settings
from papeer.core.storage import collection_ancestors, in_collection, normalize_collection_name
from papeer.layout.page_selection import parse_page_selection
from papeer.providers import create_provider
from papeer.providers.claude_code import ClaudeCodeProvider
from papeer.providers.codex import CodexProvider
from papeer.providers.common import TransientError, cli_failure_cause

FIXTURES = Path(__file__).parent / "fixtures"


def cases(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class SharedCaseTests(unittest.TestCase):
    def test_python_whitespace(self):
        """The fixture the frontend's whitespace is tested against is this Python's."""
        listed = [int(code, 16) for code in cases("python_whitespace.json")["code_points"]]
        self.assertEqual(listed, [code for code in range(0x110000) if chr(code).isspace()])
        self.assertEqual(listed, [code for code in range(0x110000) if re.fullmatch(r"\s", chr(code))])

    def test_page_ranges(self):
        for case in cases("page_ranges.json")["cases"]:
            with self.subTest(value=case["value"], page_count=case["page_count"]):
                if "pages" in case:
                    self.assertEqual(sorted(parse_page_selection(case["value"], case["page_count"])), case["pages"])
                else:
                    with self.assertRaises(ValueError) as raised:
                        parse_page_selection(case["value"], case["page_count"])
                    self.assertEqual(str(raised.exception), case["error"])

    def test_collection_paths(self):
        folders = cases("collection_paths.json")
        for case in folders["normalize"]:
            with self.subTest(normalize=case["value"]):
                self.assertEqual(normalize_collection_name(case["value"]), case["path"])
        for case in folders["ancestors"]:
            with self.subTest(ancestors=case["value"]):
                self.assertEqual(collection_ancestors(case["value"]), case["ancestors"])
        for case in folders["inside"]:
            with self.subTest(inside=case["value"], path=case["path"]):
                self.assertEqual(in_collection(case["value"], case["path"]), case["inside"])

    def test_cli_failures(self):
        """A failed CLI run is sent again or not, and names its cause, as the frontend tells the user."""
        failures = cases("cli_failures.json")
        runs = [(case["tool"], case["cause"], cli_stdout(case["tool"], case["output"]), case["output"])
                for case in failures["cases"]]
        runs += [(run["tool"], run["cause"], run["stdout"], run["detail"]) for run in failures["runs"]]
        lasting = {"quota", "login", "settings"}
        for tool, cause, stdout, detail in runs:
            with self.subTest(tool=tool, detail=detail):
                cls = ClaudeCodeProvider if tool == "claude" else CodexProvider
                error, sends = failed_run(cls, stdout)
                self.assertEqual(str(error), f"{cls.tool_name}接続に失敗しました。ログイン状態・利用枠を確認してください。\n{detail}")
                self.assertEqual(cli_failure_cause(detail), cause if cause in lasting else None)
                if cause in lasting:
                    self.assertIs(type(error), RuntimeError)  # Neither TransientError nor AnswerRejected.
                    self.assertEqual(sends, 1)
                else:  # network, or connection: nothing known either way.
                    self.assertIsInstance(error, TransientError)
                    self.assertGreater(sends, 1)
        self.assertEqual({case["cause"] for case in failures["cases"]}, lasting | {"network"})


def cli_stdout(tool: str, output: str) -> str:
    """What the CLI prints on stdout for a failure that it reports as `output`."""
    if tool == "claude":  # stream-json's result event.
        events = [{"type": "result", "subtype": "success", "is_error": True, "result": output,
                   "usage": {"input_tokens": 10, "output_tokens": 0}}]
    else:  # codex exec --json: the error, then the failed turn.
        events = [{"type": "error", "message": output}, {"type": "turn.failed", "error": {"message": output}}]
    return "\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n"


def failed_run(cls, printed: str) -> tuple[Exception, int]:
    """The error generate() ends with when every run of the CLI exits 1 printing `printed`, and the runs it made."""
    sends = []

    def popen(command, cwd=None, stdin=None, stdout=None, stderr=None, **kwargs):
        sends.append(command)
        stdout.write(printed.encode("utf-8"))
        stdout.flush()
        return Mock(poll=Mock(return_value=1), returncode=1)

    with patch.object(cls, "command", return_value=["cli"]), patch.object(cls, "transport_backoff", 0.0), \
            patch("papeer.providers.common.subprocess.Popen", side_effect=popen):
        provider = create_provider(Settings(provider=cls.spec.id, model="m"), threading.Event())
        try:
            provider.generate("Translate", "data")
        except Exception as error:  # noqa: BLE001 - the test inspects the type
            return error, len(sends)
    raise AssertionError("the run did not fail")


if __name__ == "__main__":
    unittest.main()
