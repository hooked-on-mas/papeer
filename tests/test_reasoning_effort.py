from io import StringIO
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from paperdesk.core.config import REASONING_EFFORTS, Settings
from paperdesk.core.providers import Provider


class ReasoningEffortTests(unittest.TestCase):
    def test_legacy_settings_and_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "settings.json").write_text('{"model":"existing-model"}', "utf-8")
            self.assertEqual(Settings.load(root).reasoning_effort, "")
            for effort in REASONING_EFFORTS:
                with self.subTest(effort=effort):
                    settings = Settings(reasoning_effort=effort, api_key="session-secret")
                    settings.save(root)
                    self.assertEqual(Settings.load(root).reasoning_effort, effort)
                    self.assertNotIn("session-secret", (root / "settings.json").read_text("utf-8"))
        with self.assertRaises(ValueError):
            Settings(reasoning_effort="invalid")

    def test_api_sends_selected_effort_and_omits_default(self):
        for effort in REASONING_EFFORTS:
            with self.subTest(effort=effort):
                response = StringIO(json.dumps({"choices": [{"message": {"content": "訳文"}}]}))
                with patch("paperdesk.core.providers.urlopen", return_value=response) as request:
                    provider = Provider(Settings(provider="api", reasoning_effort=effort), threading.Event())
                    self.assertEqual(provider.generate("Translate", "text"), "訳文")
                payload = json.loads(request.call_args.args[0].data)
                if effort:
                    self.assertEqual(payload["reasoning_effort"], effort)
                else:
                    self.assertNotIn("reasoning_effort", payload)

    def test_codex_passes_effort_as_config_without_running_cli(self):
        for effort in REASONING_EFFORTS:
            with self.subTest(effort=effort):
                commands = []
                def launch(command, **kwargs):
                    commands.append(command)
                    output = Path(command[command.index("--output-last-message") + 1])
                    output.write_text("訳文", "utf-8")
                    return Mock(poll=Mock(return_value=0), returncode=0)
                with patch("paperdesk.core.providers.codex_command", return_value=["mock-codex"]), \
                     patch("paperdesk.core.providers.subprocess.Popen", side_effect=launch):
                    provider = Provider(Settings(reasoning_effort=effort), threading.Event())
                    self.assertEqual(provider.generate("Translate", "text"), "訳文")
                config = [value for value in commands[0] if value.startswith("model_reasoning_effort=")]
                self.assertEqual(config, [f'model_reasoning_effort="{effort}"'] if effort else [])
                if config:
                    self.assertEqual(commands[0][commands[0].index(config[0]) - 1], "-c")

    def test_unsupported_api_setting_explains_default_without_retry(self):
        error = HTTPError("https://example.invalid", 400, "unsupported", None, None)
        with patch("paperdesk.core.providers.urlopen", side_effect=error) as request:
            with self.assertRaisesRegex(RuntimeError, "既定値"):
                Provider(Settings(provider="api", reasoning_effort="high"), threading.Event()).generate("", "")
        request.assert_called_once()


if __name__ == "__main__":
    unittest.main()
