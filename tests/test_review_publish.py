from pathlib import Path
from contextlib import closing
import json
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import pymupdf as fitz
from papeer.core.review_publish import apply_review
from papeer.translation.translation_preview import translated_page_numbers, translated_page
from papeer.pdf.pdf_engine import extract_pdf, translation_units, save_json
from papeer.core.config import Settings
from papeer.translation.translation import translation_fingerprint
from tools.review_fresh_layout import review
from test_workflow import FakeProvider


class ReviewPublishTests(unittest.TestCase):
    def test_shared_sentence_review_and_publish_are_consistent_across_pages(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); folder=root/'papers'/('a'*32)
            folder.mkdir(parents=True)
            with fitz.open() as pdf:
                pdf.new_page().insert_text((40,700),'The proposed approach applies to the following')
                pdf.new_page().insert_text((40,70),'class of systems under these assumptions.')
                pdf.save(folder/'original.pdf')
            fake=FakeProvider()
            with patch('tools.review_fresh_layout.create_provider',return_value=fake):
                manifest=review(root/'papers',root/'review',1,1,['aaaa:2'])
            self.assertEqual({r['page'] for r in manifest['results']},{1,2})
            self.assertEqual(fake.calls,1)
            with self.assertRaisesRegex(ValueError,'まとめて'):
                apply_review(root/'papers',root/'review',['aaaa:2'])
            self.assertFalse((folder/'translated.pdf').exists())
            apply_review(root/'papers',root/'review')
            markdown=(folder/'translation.md').read_text('utf8')
            self.assertEqual(markdown.count('適応制御'),1)
            self.assertEqual(markdown.count('追従誤差'),1)
            self.assertIn('## p.1',markdown)
            self.assertIn('## p.2',markdown)

    def prepare(self, root):
        folder = root/'papers'/('a'*32)
        folder.mkdir(parents=True)
        with closing(sqlite3.connect(root/'library.sqlite3')) as db:
            db.execute('CREATE TABLE papers (id TEXT PRIMARY KEY, status TEXT)')
            db.execute('INSERT INTO papers VALUES (?, ?)', (folder.name, '一部翻訳済み'))
            db.commit()
        for name, prefix in [('original.pdf', 'Original'), ('translated.pdf', 'Previous')]:
            with fitz.open() as pdf:
                for n in range(1,4):
                    pdf.new_page(width=400,height=400).insert_text((40,80),f'{prefix} content for page {n}.')
                pdf.save(folder/name)
        save_json(folder/'translation-report.json',dict(pages=3,translated_pages=[1,2,3],readability_warnings=[dict(page=2,scale=.2,font_size=2)]))
        (folder/'translation.md').write_text('# Paper\n\n## p.1 / old\n\nKeep first\n\n## p.2 / old\n\nRemove old\n\n## p.3 / old\n\nKeep last\n', 'utf8')
        with patch('tools.review_fresh_layout.create_provider', return_value=FakeProvider()):
            review(root/'papers', root/'review', 1, 1, ['aaaa:2'], settings=Settings())
        return folder

    def test_publishes_only_selected_page_and_updates_related_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); folder=self.prepare(root)
            original=(folder/'original.pdf').read_bytes()
            old=(folder/'translated.pdf').read_bytes()
            with fitz.open(folder/'translated.pdf') as pdf:
                untouched={n:pdf[n].get_pixmap().samples for n in (0,2)}
            receipts=apply_review(root/'papers',root/'review')
            self.assertEqual((folder/'original.pdf').read_bytes(),original)
            self.assertEqual((Path(receipts[0]['backup'])/'translated.pdf').read_bytes(),old)
            with fitz.open(folder/'translated.pdf') as pdf, fitz.open(root/'review'/'aaaa-p2.pdf') as fresh:
                self.assertEqual(len(pdf),3)
                for n,pixels in untouched.items(): self.assertEqual(pdf[n].get_pixmap().samples,pixels)
                self.assertEqual(pdf[1].get_pixmap().samples,fresh[0].get_pixmap().samples)
            with fitz.open(folder/'interleaved.pdf') as pdf: self.assertEqual(len(pdf),6)
            self.assertEqual(translated_page_numbers(folder,3),[1,2,3])
            with closing(sqlite3.connect(root/'library.sqlite3')) as db:
                self.assertEqual(db.execute('SELECT status FROM papers').fetchone()[0], '翻訳済み')
            self.assertEqual(translated_page(folder,1),(folder/'translated.pdf',1))
            md=(folder/'translation.md').read_text('utf8')
            self.assertIn('Keep first',md); self.assertIn('Keep last',md); self.assertNotIn('Remove old',md)
            cache=json.loads((folder/'translation-cache.json').read_text('utf8'))
            self.assertEqual(cache['fingerprint'], 'cb477b19d1fd3dcf59deb5122c48533c2cb469d052fcb226db32c641592447b8')
            self.assertEqual(cache['fingerprint'],translation_fingerprint(Settings(),translation_units(extract_pdf(folder/'original.pdf'))))
            self.assertTrue(cache['translations'])
            self.assertEqual(json.loads((folder/'translation-report.json').read_text('utf8'))['readability_warnings'],[])

    def test_failed_commit_restores_all_existing_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); folder=self.prepare(root)
            before={p.name:p.read_bytes() for p in folder.iterdir() if p.is_file()}
            replace=Path.replace
            def fail(path,target):
                if path.name=='translation-cache.json': raise OSError('simulated locked file')
                return replace(path,target)
            with patch.object(Path,'replace',fail),self.assertRaises(OSError):
                apply_review(root/'papers',root/'review')
            after={p.name:p.read_bytes() for p in folder.iterdir() if p.is_file()}
            self.assertEqual(before,after)

    def test_changed_original_is_rejected_before_replacing_anything(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); folder=self.prepare(root)
            before=(folder/'translated.pdf').read_bytes()
            with (folder/'original.pdf').open('ab') as stream: stream.write(b'\nchanged')
            with self.assertRaises(ValueError): apply_review(root/'papers',root/'review')
            self.assertEqual(before,(folder/'translated.pdf').read_bytes())
