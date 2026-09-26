import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import pymupdf as fitz

from papeer.layout.page_selection import parse_page_selection
from papeer.core.service import PaperService
from papeer.pdf.pdf_engine import build_translated_pdf
from papeer.core.storage import Library
from papeer.translation.translation_preview import read_preview, translated_page, translated_page_numbers
from test_workflow import FakeProvider


class PageSelectionTests(unittest.TestCase):
    def test_partial_translation_preserves_stale_pages_during_and_after_run(self):
        for change in ('version', 'model'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / 'source.pdf'
                with fitz.open() as pdf:
                    for n in range(3):
                        pdf.new_page().insert_text((40, 70), f'Original content on page {n + 1}.')
                    pdf.save(source)
                library = Library(root / 'library')
                identity, _ = library.import_pdf(source)
                folder = library.folder(identity)
                provider = FakeProvider()
                service = PaperService(library, provider, threading.Event())
                service.translate(identity, {1, 2})
                with fitz.open(folder / 'translated.pdf') as pdf:
                    before = [pdf[n].get_pixmap().samples for n in (0, 1)]
                old_cache = (folder / 'translation-cache.json').read_bytes()
                seen = []
                def ready(*_):
                    preview = read_preview(folder)
                    if preview and not preview['complete']:
                        seen.append(preview['pages'])
                        for n in (0, 1):
                            path, index = translated_page(folder, n)
                            with fitz.open(path) as pdf:
                                self.assertEqual(pdf[index].get_pixmap().samples, before[n])
                service.page_ready = ready
                if change == 'model':
                    provider.settings.model = 'another-model'
                from papeer.translation.translation import translation_version
                version = 'new-version' if change == 'version' else translation_version()
                with patch('papeer.core.service.translation_version', return_value=version):
                    report = service.translate(identity, {3})
                self.assertTrue(seen)
                self.assertEqual(report['preserved_pages'], [1, 2])
                self.assertEqual(report['translated_pages'], [1, 2, 3])
                self.assertEqual(translated_page_numbers(folder, 3), [1, 2, 3])
                with fitz.open(folder / 'translated.pdf') as pdf:
                    for n in (0, 1):
                        self.assertEqual(pdf[n].get_pixmap().samples, before[n])
                    self.assertIn('適応制御', pdf[2].get_text())
                self.assertEqual((folder / 'translation.md').read_text('utf-8').count('適応制御'), 3)
                backup = folder / 'translation-pages' / read_preview(folder)['run_id'] / 'previous-translation-cache.json'
                self.assertEqual(backup.read_bytes(), old_cache)

    def test_retained_pages_survive_interruption_and_next_run(self):
        from papeer.providers import Cancelled
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.pdf'
            with fitz.open() as pdf:
                for n in range(3):
                    pdf.new_page().insert_text((40, 70), f'Original content on page {n + 1}.')
                pdf.save(source)
            library = Library(root / 'library')
            identity, _ = library.import_pdf(source)
            folder = library.folder(identity)
            provider = FakeProvider()
            service = PaperService(library, provider, threading.Event())
            service.translate(identity, {1})
            provider.interrupt_after = provider.calls + 1
            with patch('papeer.core.service.translation_version', return_value='changed'):
                with self.assertRaises(Cancelled):
                    service.translate(identity, {2})
                self.assertEqual(translated_page_numbers(folder, 3), [1])
                path, index = translated_page(folder, 0)
                with fitz.open(path) as pdf:
                    self.assertIn('適応制御', pdf[index].get_text())
                provider.interrupt_after = None
                report = service.translate(identity, {3})
            self.assertEqual(report['translated_pages'], [1, 3])

    def test_interrupted_retranslation_keeps_earlier_translations_and_old_runs_are_removed(self):
        from papeer.providers import Cancelled
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.pdf'
            with fitz.open() as pdf:
                for n in range(3):
                    pdf.new_page().insert_text((40, 70), f'Original content on page {n + 1}.')
                pdf.save(source)
            library = Library(root / 'library')
            identity, _ = library.import_pdf(source)
            folder = library.folder(identity)
            provider = FakeProvider()
            service = PaperService(library, provider, threading.Event())
            service.translate(identity)
            first_run = read_preview(folder)['run_id']
            provider.interrupt_after = provider.calls + 2
            with patch('papeer.core.service.translation_version', return_value='changed'):
                with self.assertRaises(Cancelled):
                    service.translate(identity)
                # Pages not redone before the interruption still show their earlier translation.
                self.assertEqual(translated_page_numbers(folder, 3), [1, 2, 3])
                for n in range(3):
                    path, index = translated_page(folder, n)
                    with fitz.open(path) as pdf:
                        self.assertIn('適応制御', pdf[index].get_text())
                provider.interrupt_after = None
                report = service.translate(identity, {2})
            self.assertEqual(report['translated_pages'], [1, 2, 3])
            runs = {run.name for run in (folder / 'translation-pages').iterdir()}
            self.assertEqual(runs, {read_preview(folder)['run_id']})
            self.assertNotIn(first_run, runs)

    def test_completed_pages_survive_model_change_and_restart_until_version_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.pdf'
            with fitz.open() as pdf:
                for n in range(1, 4):
                    pdf.new_page().insert_text((40, 70), f'Original content on page {n}.')
                pdf.save(source)
            library = Library(root / 'library')
            identity, _ = library.import_pdf(source)
            first = FakeProvider()
            PaperService(library, first, threading.Event()).translate(identity, {1})
            cache_path = library.folder(identity) / 'translation-cache.json'
            cache = json.loads(cache_path.read_text('utf-8'))
            self.assertEqual(set(cache['completed_pages']), {'1'})
            self.assertEqual(cache['completed_pages']['1']['version'], cache['translation_version'])

            second = FakeProvider()
            second.settings.model = 'different-model'
            service = PaperService(Library(root / 'library'), second, threading.Event())
            report = service.translate(identity, {1, 2})
            self.assertEqual(second.calls, 1)
            self.assertEqual(report['already_translated_pages'], [1])
            self.assertEqual(report['translated_pages'], [1, 2])
            service.translate(identity, {1, 2})
            self.assertEqual(second.calls, 1)
            with patch('papeer.core.service.translation_version', return_value='next-version'):
                report = service.translate(identity, {1})
            self.assertEqual(second.calls, 2)
            self.assertEqual(report['already_translated_pages'], [])

    def test_legacy_cache_without_code_version_is_retranslated(self):
        with tempfile.TemporaryDirectory() as temporary:
            library = Library(Path(temporary))
            identity, _ = library.import_pdf(Path(__file__).parent / 'fixtures/sample.pdf')
            provider = FakeProvider()
            service = PaperService(library, provider, threading.Event())
            service.translate(identity, {1})
            cache_path = library.folder(identity) / 'translation-cache.json'
            cache = json.loads(cache_path.read_text('utf-8'))
            del cache['translation_version'], cache['completed_pages']
            cache_path.write_text(json.dumps(cache), 'utf-8')
            calls = provider.calls
            service.translate(identity, {1})
            self.assertGreater(provider.calls, calls)
            self.assertIn('1', json.loads(cache_path.read_text('utf-8'))['completed_pages'])

    def test_page_continuation_is_translated_once_and_expands_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'continuation.pdf'
            with fitz.open() as pdf:
                pdf.new_page().insert_text((40, 700), 'The proposed approach applies to the following')
                pdf.new_page().insert_text((40, 70), 'class of systems under these assumptions.')
                pdf.new_page().insert_text((40, 70), 'An unrelated complete paragraph on another page.')
                pdf.save(source)
            library = Library(root / 'library')
            identity, _ = library.import_pdf(source)
            sent = []
            class RecordingProvider(FakeProvider):
                def generate(inner, instruction, data, schema=None):
                    sent.extend(json.loads(data))
                    return super().generate(instruction, data, schema)
            provider = RecordingProvider()
            messages = []
            service = PaperService(library, provider, threading.Event(), messages.append)
            report = service.translate(identity, {2})
            self.assertEqual(report['requested_pages'], [2])
            self.assertEqual(report['selected_pages'], [1, 2])
            self.assertEqual(report['translated_pages'], [1, 2])
            self.assertEqual(len(sent), 1)
            self.assertIn('following\nclass', sent[0]['text'])
            self.assertTrue(any('p.1' in message for message in messages))
            folder = library.folder(identity)
            markdown = (folder / 'translation.md').read_text('utf-8')
            self.assertEqual(markdown.count('適応制御'), 1)
            self.assertEqual(markdown.count('追従誤差'), 1)
            calls = provider.calls
            service.translate(identity, {1})
            self.assertEqual(provider.calls, calls)

    def test_failed_destination_withholds_entire_shared_sentence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'continuation.pdf'
            with fitz.open() as pdf:
                pdf.new_page().insert_text((40, 700), 'The proposed approach applies to the following')
                pdf.new_page().insert_text((40, 70), 'class of systems under these assumptions.')
                pdf.save(source)
            library = Library(root / 'library')
            identity, _ = library.import_pdf(source)
            def build(*args, **kwargs):
                if kwargs.get('page_numbers') == {2}:
                    raise ValueError('Synthetic destination failure')
                return build_translated_pdf(*args, **kwargs)
            service = PaperService(library, FakeProvider(), threading.Event())
            with patch('papeer.core.service.build_translated_pdf', side_effect=build):
                report = service.translate(identity, {1})
            self.assertEqual(report['translated_pages'], [])
            self.assertEqual(report['skipped_pages'], [1, 2])
            with fitz.open(source) as original, fitz.open(library.folder(identity) / 'translated.pdf') as output:
                for n in (0, 1):
                    self.assertEqual(original[n].get_pixmap().samples, output[n].get_pixmap().samples)

    def test_file_write_failure_is_not_treated_as_page_layout_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            library = Library(Path(temporary))
            identity, _ = library.import_pdf(Path(__file__).parent / 'fixtures/sample.pdf')
            service = PaperService(library, FakeProvider(), threading.Event())
            with patch('papeer.core.service.build_translated_pdf', side_effect=OSError('disk full')):
                with self.assertRaisesRegex(OSError, 'disk full'):
                    service.translate(identity)
            self.assertEqual(read_preview(library.folder(identity))['skipped_pages'], [])

    def test_pdf_failure_skips_page_and_resume_reuses_translations(self):
        for failed in ({2}, {1, 2, 3}):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / 'source.pdf'
                with fitz.open() as pdf:
                    for number in range(1, 4):
                        pdf.new_page().insert_text((40, 70), f'Original content on page {number}.')
                    pdf.save(source)
                library = Library(root / 'library')
                identity, _ = library.import_pdf(source)
                folder = library.folder(identity)
                provider = FakeProvider()
                attempted, messages = [], []

                def build(*args, **kwargs):
                    pages = kwargs.get('page_numbers')
                    if pages:
                        number = next(iter(pages))
                        attempted.append(number)
                        if number in failed:
                            raise ValueError('本文と数式の領域を分離できませんでした。')
                    return build_translated_pdf(*args, **kwargs)

                def ready(*_):
                    preview = read_preview(folder)
                    if preview and not preview['complete']:
                        for number in preview['skipped_pages']:
                            self.assertEqual(translated_page(folder, number - 1), (folder / 'original.pdf', number - 1))

                service = PaperService(library, provider, threading.Event(), messages.append, ready)
                with patch('papeer.core.service.build_translated_pdf', side_effect=build):
                    report = service.translate(identity)
                self.assertEqual(attempted, [1, 2, 3])
                self.assertEqual(report['skipped_pages'], sorted(failed))
                self.assertEqual(set(report['page_errors']), {str(n) for n in failed})
                self.assertEqual(report['translated_pages'], sorted({1, 2, 3} - failed))
                self.assertEqual(library.paper(identity)['status'], '一部翻訳済み')
                self.assertTrue(any('スキップ' in message for message in messages))
                with fitz.open(source) as original, fitz.open(folder / 'translated.pdf') as translated:
                    self.assertEqual(translated.page_count, 3)
                    for number in range(1, 4):
                        if number in failed:
                            self.assertEqual(original[number - 1].get_pixmap().samples,
                                             translated[number - 1].get_pixmap().samples)
                        else:
                            self.assertIn('適応制御', translated[number - 1].get_text())
                    with fitz.open(folder / 'interleaved.pdf') as paired:
                        self.assertEqual(paired.page_count, 6)
                        for index in range(3):
                            self.assertEqual(paired[index * 2].get_text(), original[index].get_text())
                            self.assertEqual(paired[index * 2 + 1].get_text(), translated[index].get_text())
                calls = provider.calls
                report = service.translate(identity)
                self.assertEqual(provider.calls, calls)
                self.assertEqual(report['skipped_pages'], [])
                self.assertEqual(report['translated_pages'], [1, 2, 3])

    def test_ranges_and_japanese_separators(self):
        self.assertEqual(parse_page_selection('１、３～５, 8, 3–4', 10), {1, 3, 4, 5, 8})
        for value in ['', '0', '11', '5-2', '1,,3', '1-', '-3', '1.5', 'all', '1-999999999']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_page_selection(value, 10)

    def test_selected_pages_accumulate_without_retranslating_or_resetting_budget(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.pdf'
            with fitz.open() as pdf:
                for number in range(1, 4):
                    page = pdf.new_page()
                    page.insert_text((40, 70), f'Original content on page {number}.', fontsize=12)
                pdf.save(source)
            library = Library(root / 'library')
            identity, _ = library.import_pdf(source)
            folder = library.folder(identity)

            class RecordingProvider(FakeProvider):
                requested_pages = []
                def generate(inner, instruction, data, schema=None):
                    inner.requested_pages.append({u['page'] for u in json.loads(data)})
                    return super().generate(instruction, data, schema)

            provider = RecordingProvider()
            service = PaperService(library, provider, threading.Event())
            report = service.translate(identity, {2})
            self.assertEqual(provider.requested_pages, [{2}])
            self.assertEqual(report['selected_pages'], [2])
            self.assertEqual(report['translated_pages'], [2])
            self.assertEqual(report['untranslated_pages'], [1, 3])
            self.assertEqual(library.paper(identity)['status'], '一部翻訳済み')
            self.assertEqual(translated_page_numbers(folder, 3), [2])
            self.assertTrue(read_preview(folder)['complete'])
            with fitz.open(folder / 'translated.pdf') as pdf:
                self.assertEqual(pdf.page_count, 3)
                self.assertIn('Original content on page 1.', pdf[0].get_text())
                self.assertIn('適応制御', pdf[1].get_text())
                self.assertIn('Original content on page 3.', pdf[2].get_text())
            cache_path = folder / 'translation-cache.json'
            before = json.loads(cache_path.read_text('utf-8'))
            # Simulate an earlier completed recovery: selecting another range
            # must retain both the budget and saved translation content.
            unit_id = next(iter(before['translations']))
            before['retry_state']['attempts'][unit_id] = 2
            before['retry_state']['retry_calls'] = 1
            cache_path.write_text(json.dumps(before), 'utf-8')
            report = service.translate(identity, {3})
            after = json.loads(cache_path.read_text('utf-8'))
            self.assertEqual(provider.requested_pages, [{2}, {3}])
            self.assertEqual(report['translated_pages'], [2, 3])
            self.assertEqual(after['fingerprint'], before['fingerprint'])
            self.assertEqual(after['retry_state']['retry_calls'], 1)
            self.assertEqual(after['translations'][unit_id], before['translations'][unit_id])
            service.translate(identity, {2, 3})
            self.assertEqual(provider.calls, 2)
            service.translate(identity)
            self.assertEqual(provider.requested_pages, [{2}, {3}, {1}])
            self.assertEqual(library.paper(identity)['status'], '翻訳済み')
            self.assertEqual(translated_page_numbers(folder, 3), [1, 2, 3])

    def test_unselected_pages_show_original_while_selected_pages_wait(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            preview = {'run_id': 'a' * 32, 'pages': [2], 'target_pages': [2, 4], 'total_pages': 5, 'complete': False}
            (folder / 'translation-preview.json').write_text(json.dumps(preview), 'utf-8')
            self.assertEqual(translated_page(folder, 0), (folder / 'original.pdf', 0))
            self.assertEqual(translated_page(folder, 3), (None, 0))
            self.assertEqual(translated_page_numbers(folder, 5), [2])

    def test_unselected_blank_page_is_not_counted_as_translated(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'blank-page.pdf'
            with fitz.open() as pdf:
                pdf.new_page().insert_text((40, 70), 'Translate this first page.')
                pdf.new_page()
                pdf.save(source)
            library = Library(root / 'library')
            identity, _ = library.import_pdf(source)
            report = PaperService(library, FakeProvider(), threading.Event()).translate(identity, {1})
            self.assertEqual(report['translated_pages'], [1])
            self.assertEqual(translated_page_numbers(library.folder(identity), 2), [1])

    def test_invalid_selection_does_not_start_model_or_modify_library(self):
        with tempfile.TemporaryDirectory() as temporary:
            library = Library(Path(temporary))
            identity, _ = library.import_pdf(Path(__file__).parent / 'fixtures/sample.pdf')
            provider = FakeProvider()
            for selection in [set(), {0}, {3}, {True}, {'1'}]:
                with self.subTest(selection=selection), self.assertRaises(ValueError):
                    PaperService(library, provider, threading.Event()).translate(identity, selection)
            self.assertEqual(provider.calls, 0)
            self.assertEqual(library.paper(identity)['status'], '追加済み')
            self.assertFalse((library.folder(identity) / 'translation-cache.json').exists())


if __name__ == '__main__':
    unittest.main()
