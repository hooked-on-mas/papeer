from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from paperdesk.code_version import TRANSLATION_SOURCES, application_version, source_version


class CodeVersionTests(unittest.TestCase):
    def test_only_translation_sources_change_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'paperdesk').mkdir()
            for name in TRANSLATION_SOURCES:
                (root / 'paperdesk' / name).write_bytes(b'x = 1\n')
            module = root / 'paperdesk' / 'translation.py'
            original = source_version(root)
            module.touch()
            module.write_bytes(b'x = 1\r\n')
            (root / 'README.md').write_text('documentation')
            (root / 'paperdesk' / 'module.pyc').write_bytes(b'bytecode')
            self.assertEqual(source_version(root), original)
            for name in ('gui.py', 'pdf_viewer.py', 'winintegration.py',
                         'storage.py', 'config.py', '__init__.py', 'extra_ui.py'):
                excluded = root / 'paperdesk' / name
                excluded.write_bytes(b'first version\n')
                self.assertEqual(source_version(root), original)
                excluded.write_bytes(b'changed version\n')
                self.assertEqual(source_version(root), original)
                excluded.unlink()
                self.assertEqual(source_version(root), original)
            (root / 'main.py').write_bytes(b'changed entry point\n')
            self.assertEqual(source_version(root), original)
            for name in TRANSLATION_SOURCES:
                with self.subTest(name=name):
                    path = root / 'paperdesk' / name
                    path.write_bytes(b'x = 2\n')
                    self.assertNotEqual(source_version(root), original)
                    path.write_bytes(b'x = 1\n')
            extra = root / 'paperdesk' / 'new_translation.py'
            extra.write_bytes(b'x = 1\n')
            with patch('paperdesk.code_version.TRANSLATION_SOURCES',
                       (*TRANSLATION_SOURCES, extra.name)):
                self.assertNotEqual(source_version(root), original)
            module.unlink()
            with self.assertRaises(FileNotFoundError):
                source_version(root)

    def test_frozen_app_uses_build_identity_and_rejects_invalid_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            record = Path(temporary) / 'code-version.txt'
            expected = 'code-sha256-' + 'a' * 64
            record.write_text(expected + '\n', encoding='utf-8')
            with patch('sys.frozen', True, create=True), patch('sys._MEIPASS', temporary, create=True):
                self.assertEqual(application_version(), expected)
                record.write_text('invalid', encoding='utf-8')
                with self.assertRaises(ValueError):
                    application_version()
                record.unlink()
                with self.assertRaises(FileNotFoundError):
                    application_version()
