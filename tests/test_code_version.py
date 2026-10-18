import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from papeer.core.code_version import (CLI_EXE, RENDER_DIRECTORIES, RENDER_EXCLUDED, RENDER_SOURCES, SIDECAR_DIR,
                                      SIDECAR_EXE, application_version, bundle_version, check_build, source_version)

ROOT = Path(__file__).resolve().parent.parent


class CodeVersionTests(unittest.TestCase):
    def test_only_render_sources_change_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'papeer').mkdir()
            for name in RENDER_SOURCES:
                target = root / 'papeer' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'x = 1\n')
            module = root / 'papeer' / 'pdf' / 'pdf_engine.py'
            original = source_version(root)
            module.touch()
            module.write_bytes(b'x = 1\r\n')
            (root / 'README.md').write_text('documentation')
            (root / 'papeer' / 'module.pyc').write_bytes(b'bytecode')
            self.assertEqual(source_version(root), original)
            for name in ('pdf_viewer.py', 'code_version.py', 'storage.py', 'config.py', '__init__.py', 'extra_ui.py',
                         'translation/translation.py', 'providers/codex.py', 'core/terminology.py'):
                excluded = root / 'papeer' / name
                excluded.parent.mkdir(parents=True, exist_ok=True)
                excluded.write_bytes(b'first version\n')
                self.assertEqual(source_version(root), original)
                excluded.write_bytes(b'changed version\n')
                self.assertEqual(source_version(root), original)
                excluded.unlink()
                self.assertEqual(source_version(root), original)
            (root / 'main.py').write_bytes(b'changed entry point\n')
            self.assertEqual(source_version(root), original)
            for name in RENDER_SOURCES:
                with self.subTest(name=name):
                    path = root / 'papeer' / name
                    path.write_bytes(b'x = 2\n')
                    self.assertNotEqual(source_version(root), original)
                    path.write_bytes(b'x = 1\n')
            extra = root / 'papeer' / 'new_layout.py'
            extra.write_bytes(b'x = 1\n')
            with patch('papeer.core.code_version.RENDER_SOURCES',
                       (*RENDER_SOURCES, extra.name)):
                self.assertNotEqual(source_version(root), original)
            module.unlink()
            with self.assertRaises(FileNotFoundError):
                source_version(root)

    def test_every_module_in_render_directories_is_listed_or_excluded(self):
        # A new module in these folders must be classified: listed modules redraw translated PDFs
        # when changed; excluded ones must not affect the drawing (translations are keyed separately).
        found = {path.relative_to(ROOT / 'papeer').as_posix()
                 for directory in RENDER_DIRECTORIES for path in (ROOT / 'papeer' / directory).rglob('*.py')}
        listed = set(RENDER_SOURCES) | set(RENDER_EXCLUDED)
        self.assertEqual(sorted(found - listed), [], '未分類のモジュールを RENDER_SOURCES か RENDER_EXCLUDED に追加してください')
        self.assertFalse(set(RENDER_SOURCES) & set(RENDER_EXCLUDED))
        for name in listed:
            with self.subTest(name=name):
                self.assertTrue((ROOT / 'papeer' / name).is_file(), '存在しないモジュールが一覧に残っています')

    def test_build_check_requires_matching_records_of_the_bundled_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in RENDER_SOURCES:
                target = root / 'papeer' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'x = 1\n')
            (root / 'papeer' / 'core' / 'prompts').mkdir()
            (root / 'papeer' / 'core' / 'prompts' / 'translation.txt').write_bytes(b'prompt\n')
            (root / 'sidecar').mkdir()
            (root / 'sidecar' / 'app.py').write_bytes(b'app = 1\n')
            for name in ('sidecar.spec', 'pyproject.toml', 'uv.lock'):
                (root / name).write_bytes(b'first\n')
            record, bundle = root / 'code-version.txt', root / 'sidecar-sources.txt'
            self.assertEqual(len(check_build(root, record, bundle)), 4)
            record.write_text(source_version(root) + '\n', encoding='utf-8')
            bundle.write_text(bundle_version(root) + '\n', encoding='utf-8')
            (root / SIDECAR_EXE).parent.mkdir(parents=True)
            (root / SIDECAR_EXE).write_bytes(b'exe')
            (root / CLI_EXE).write_bytes(b'cli')
            # The sidecar folder carries the code-version.txt it was built with (sidecar.spec datas).
            bundled = root / SIDECAR_DIR / '_internal' / 'code-version.txt'
            self.assertEqual(check_build(root, record, bundle),
                             [f'{SIDECAR_DIR.as_posix()}/_internal/code-version.txt が code-version.txt と一致しません。'])
            bundled.parent.mkdir()
            bundled.write_text('code-sha256-' + '0' * 64 + '\n', encoding='utf-8')
            self.assertEqual(len(check_build(root, record, bundle)), 1)
            bundled.write_bytes(record.read_bytes().replace(b'\n', b'\r\n'))
            self.assertEqual(check_build(root, record, bundle), [])
            # A checkout touches file times and may convert line endings; neither is a change.
            later = time.time() + 3600
            for path in [*root.rglob('*')]:
                if path.is_file():
                    os.utime(path, (later, later))
            (root / 'sidecar' / 'app.py').write_bytes(b'app = 1\r\n')
            (root / 'papeer' / '__pycache__').mkdir()
            (root / 'papeer' / '__pycache__' / 'x.cpython-312.pyc').write_bytes(b'bytecode')
            self.assertEqual(check_build(root, record, bundle), [])
            # Any bundled file or dependency edited after the build, even outside RENDER_SOURCES.
            for name in ('sidecar/app.py', 'papeer/core/prompts/translation.txt', 'uv.lock', 'pyproject.toml',
                         'sidecar.spec'):
                with self.subTest(name=name):
                    original = (root / name).read_bytes()
                    (root / name).write_bytes(original + b'changed\n')
                    self.assertEqual(len(check_build(root, record, bundle)), 1)
                    (root / name).write_bytes(original)
            (root / 'sidecar' / 'new_route.py').write_bytes(b'x = 1\n')
            self.assertEqual(len(check_build(root, record, bundle)), 1)
            (root / 'sidecar' / 'new_route.py').unlink()
            (root / 'papeer' / RENDER_SOURCES[0]).write_bytes(b'x = 2\n')
            problems = check_build(root, record, bundle)
            self.assertEqual(problems[0], 'code-version.txt が現在のソースと一致しません。')
            self.assertEqual(len(problems), 2)
            (root / 'papeer' / RENDER_SOURCES[0]).write_bytes(b'x = 1\n')
            (root / SIDECAR_EXE).unlink()
            self.assertEqual(len(check_build(root, record, bundle)), 1)
            (root / SIDECAR_EXE).write_bytes(b'exe')
            # The command line client is part of the build: a folder without it is not complete.
            (root / CLI_EXE).unlink()
            self.assertEqual(check_build(root, record, bundle), [f'{CLI_EXE.as_posix()} がありません。'])

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
