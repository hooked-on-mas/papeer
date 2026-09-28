from pathlib import Path
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import pymupdf as fitz
from papeer.core.exports import interleaved_cache
from papeer.core.paths import PaperFiles
from tools.review_publish import REVIEW_BACKUPS_KEPT, apply_review, prune_review_backups
from papeer.translation.translation_preview import remove_unused_runs, translated_page_numbers, translated_page
from papeer.pdf.pdf_engine import extract_pdf, translation_units
from papeer.core import fileio
from papeer.core.fileio import atomic_write_json
from papeer.core.config import Settings
from papeer.translation.translation import RetryState, translation_fingerprint
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
            db.execute('INSERT INTO papers VALUES (?, ?)', (folder.name, 'partial'))
            db.commit()
        for name, prefix in [('original.pdf', 'Original'), ('translated.pdf', 'Previous')]:
            with fitz.open() as pdf:
                for n in range(1,4):
                    pdf.new_page(width=400,height=400).insert_text((40,80),f'{prefix} content for page {n}.')
                pdf.save(folder/name)
        atomic_write_json(folder/'translation-report.json',dict(pages=3,translated_pages=[1,2,3],readability_warnings=[dict(page=2,scale=.2,font_size=2)]))
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
            # The interleaved PDF is discarded and built again from the new translation when opened.
            self.assertFalse((folder/'interleaved.pdf').exists())
            with fitz.open(interleaved_cache(PaperFiles(folder))) as pdf: self.assertEqual(len(pdf),6)
            self.assertFalse((Path(receipts[0]['backup'])/'staged').exists())
            self.assertEqual(translated_page_numbers(folder,3),[1,2,3])
            with closing(sqlite3.connect(root/'library.sqlite3')) as db:
                self.assertEqual(db.execute('SELECT status FROM papers').fetchone()[0], 'translated')
            self.assertEqual(translated_page(folder,1),(folder/'translated.pdf',1))
            md=(folder/'translation.md').read_text('utf8')
            self.assertIn('Keep first',md); self.assertIn('Keep last',md); self.assertNotIn('Remove old',md)
            cache=json.loads((folder/'translation-cache.json').read_text('utf8'))
            self.assertEqual(cache['fingerprint'], '6c63a22da018705247a85b8e6f4ef3c1a44bd22333ac8a21a8a87757e1996838')
            self.assertEqual(cache['fingerprint'],translation_fingerprint(Settings(),translation_units(extract_pdf(folder/'original.pdf'))))
            self.assertTrue(cache['translations'])
            self.assertEqual(json.loads((folder/'translation-report.json').read_text('utf8'))['readability_warnings'],[])

    def test_published_blocks_leave_the_retry_record_readable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); folder=self.prepare(root)
            units=translation_units(extract_pdf(folder/'original.pdf'))
            reviewed=next(u['id'] for u in units if u['page']==2)
            atomic_write_json(folder/'translation-cache.json', dict(
                fingerprint=translation_fingerprint(Settings(),units), translations={},
                retry_state=dict(attempts={reviewed:2}, retry_calls=1, unanswered={reviewed:1})))
            apply_review(root/'papers',root/'review')
            retry=json.loads((folder/'translation-cache.json').read_text('utf8'))['retry_state']
            # An unanswered record without its attempt would be refused as corrupt by the next translation.
            self.assertEqual(RetryState.from_cache(retry).to_cache(), dict(attempts={}, retry_calls=1, unanswered={}))

    def test_failed_commit_restores_all_existing_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); folder=self.prepare(root)
            before={p.name:p.read_bytes() for p in folder.iterdir() if p.is_file()}
            replace=fileio.os.replace
            def fail(path,target):
                if Path(path).name=='translation-cache.json': raise OSError('simulated locked file')
                return replace(path,target)
            with patch.object(fileio.os,'replace',fail),self.assertRaises(OSError):
                apply_review(root/'papers',root/'review')
            after={p.name:p.read_bytes() for p in folder.iterdir() if p.is_file()}
            self.assertEqual(before,after)

    def test_unfinished_translation_pages_are_backed_up_with_the_preview_naming_them(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); folder=self.prepare(root)
            run='b'*32
            (folder/'translation-pages'/run).mkdir(parents=True)
            with fitz.open() as pdf:
                pdf.new_page(width=400,height=400).insert_text((40,80),'Unfinished run page 1.')
                pdf.save(folder/'translation-pages'/run/'page-1.pdf')
            atomic_write_json(folder/'translation-preview.json',dict(run_id=run,pages=[1],target_pages=[1,2,3],
                                                                     total_pages=3,complete=False))
            receipts=apply_review(root/'papers',root/'review')
            backup=Path(receipts[0]['backup'])
            self.assertTrue((backup/'translation-pages'/run/'page-1.pdf').is_file())
            with fitz.open(folder/'translated.pdf') as pdf:
                self.assertIn('Unfinished run page 1.',pdf[0].get_text())
            # The published preview is complete, so the library no longer needs the run; the backup keeps it.
            remove_unused_runs(folder)
            self.assertFalse((folder/'translation-pages').exists())
            self.assertEqual(json.loads((backup/'translation-preview.json').read_text('utf8'))['run_id'],run)

    def test_only_the_newest_applied_backups_are_kept(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder=Path(temporary)
            names=[]
            for n in range(9):
                name=f'2026090{n+1}T000000Z-{n:08x}'
                (folder/'review-backups'/name).mkdir(parents=True)
                # 3 and 7 failed (staging kept for diagnosis, no receipt).
                if n not in (3,7): (folder/'review-backups'/name/'receipt.json').write_text('{}','utf8')
                names.append(name)
            (folder/'review-backups'/'notes').mkdir()
            prune_review_backups(folder,keep=5)
            kept=sorted(p.name for p in (folder/'review-backups').iterdir())
            # Applied: 0 1 2 4 5 6 8 -> the newest five start at 2; failed 3 and 7 are newer and stay.
            self.assertEqual(kept,sorted(names[2:]+['notes']))
            prune_review_backups(folder,keep=5)
            self.assertEqual(sorted(p.name for p in (folder/'review-backups').iterdir()),kept)

    def test_repeated_publishes_keep_a_bounded_number_of_backups(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); folder=self.prepare(root)
            receipts=[]
            for _ in range(REVIEW_BACKUPS_KEPT+2):
                with patch('tools.review_publish.datetime') as clock:
                    clock.now.return_value=datetime(2026,9,1,tzinfo=timezone.utc)+timedelta(minutes=len(receipts))
                    receipts+=apply_review(root/'papers',root/'review')
            backups=sorted(p.name for p in (folder/'review-backups').iterdir())
            self.assertEqual(len(backups),REVIEW_BACKUPS_KEPT)
            # The latest receipt's backup, which tools.verify_review_publish reads, is always kept.
            self.assertEqual(backups[-1],Path(receipts[-1]['backup']).name)
            self.assertEqual(backups[0],Path(receipts[2]['backup']).name)

    def test_changed_original_is_rejected_before_replacing_anything(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); folder=self.prepare(root)
            before=(folder/'translated.pdf').read_bytes()
            with (folder/'original.pdf').open('ab') as stream: stream.write(b'\nchanged')
            with self.assertRaises(ValueError): apply_review(root/'papers',root/'review')
            self.assertEqual(before,(folder/'translated.pdf').read_bytes())
