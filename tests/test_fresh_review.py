from pathlib import Path
import json
import shutil
import tempfile
import unittest
from unittest.mock import patch
from tools.review_fresh_layout import review
from test_workflow import FakeProvider, FIXTURE


class FreshReviewTests(unittest.TestCase):
    def test_every_review_translates_original_and_ignores_stale_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / 'papers' / ('a' * 32)
            folder.mkdir(parents=True)
            shutil.copyfile(FIXTURE, folder / 'original.pdf')
            for name in ('translated.pdf', 'translation-cache.json', 'document.json'):
                (folder / name).write_bytes(b'invalid stale data')
            fake = FakeProvider()
            with patch('tools.review_fresh_layout.Provider', return_value=fake):
                first = review(root / 'papers', root / 'first', 1, 1, ['aaaa:1'])
                calls = fake.calls
                self.assertGreater(calls, 0)
                second = review(root / 'papers', root / 'second', 1, 1, ['aaaa:1'])
                self.assertGreater(fake.calls, calls)
                with self.assertRaises(FileExistsError):
                    review(root / 'papers', root / 'first', 1, 1, ['aaaa:1'])
            self.assertTrue(first['fresh_translation'])
            self.assertEqual(first['results'][0]['source_sha256'], second['results'][0]['source_sha256'])
            self.assertEqual((folder / 'translation-cache.json').read_bytes(), b'invalid stale data')
