from email.message import Message
import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import pymupdf as fitz

from papeer.core import exports
from papeer.core.paths import PaperFiles
from papeer.layout.page_selection import parse_page_selection
from papeer.core.service import PaperService
from papeer.pdf.pdf_engine import build_translated_pdf, translation_units
from papeer.core.storage import Library
from papeer.translation.translation import (BUILTIN_PROMPT_REVISION, TRANSLATION_PROTOCOL, TranslationKey,
                                             legacy_translation_fingerprint, prompt_identity, translation_identity)
from papeer.translation.translation_preview import read_preview, translated_page, translated_page_numbers
from papeer.core import prompts
from papeer.core.config import Settings
from papeer.core.terminology import apply_glossary, effective_glossary
from papeer.providers import create_provider
from papeer.providers.openai_compat import OpenAICompatProvider, forget_refused_options
from test_workflow import FakeProvider


# The built-in translation.txt this test last approved (test_builtin_translation_prompt_edits_are_decided).
BUILTIN_TRANSLATION_PROMPT_SHA256 = '3a67b4686483bdd0bdfd5aaaa6e48ea5ab4e4fb703575544aa01b93997831f60'


class PageSelectionTests(unittest.TestCase):
    def test_partial_translation_preserves_stale_pages_during_and_after_run(self):
        for change in ('protocol', 'model'):
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
                protocol = TRANSLATION_PROTOCOL + (change == 'protocol')
                with patch('papeer.translation.translation.TRANSLATION_PROTOCOL', protocol):
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
                # Once complete, the run keeps only the cache it replaced: the reader shows translated.pdf.
                run = folder / 'translation-pages' / read_preview(folder)['run_id']
                self.assertEqual((run / 'previous-translation-cache.json').read_bytes(), old_cache)
                self.assertEqual([p.name for p in run.iterdir()], ['previous-translation-cache.json'])

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
            with patch('papeer.translation.translation.TRANSLATION_PROTOCOL', TRANSLATION_PROTOCOL + 1):
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
            with patch('papeer.translation.translation.TRANSLATION_PROTOCOL', TRANSLATION_PROTOCOL + 1):
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
            self.assertEqual(list((folder / 'translation-pages').rglob('*.pdf')), [])

    def test_completed_pages_are_reused_until_translation_inputs_change(self):
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
            self.assertTrue(cache['translation_version'].startswith('translation-sha256-'))

            # After a restart, and with another effort, the saved page is reused.
            provider = FakeProvider()
            provider.settings.reasoning_effort = 'high'
            service = PaperService(Library(root / 'library'), provider, threading.Event())
            report = service.translate(identity, {1, 2})
            self.assertEqual(provider.calls, 1)
            self.assertEqual(report['already_translated_pages'], [1])
            self.assertEqual(report['translated_pages'], [1, 2])
            service.translate(identity, {1, 2})
            self.assertEqual(provider.calls, 1)
            # Each input of the translation asks the model again: the prompt in use (edited in
            # the settings), the model, and the protocol raised by hand.
            prompts.save_overrides({'translation': prompts.load('translation') + '\n訳文は簡潔に。'})
            report = service.translate(identity, {1})
            self.assertEqual(provider.calls, 2)
            self.assertEqual(report['already_translated_pages'], [])
            service.translate(identity, {1})
            self.assertEqual(provider.calls, 2)
            prompts.save_overrides({'translation': ''})
            provider.settings.model = 'different-model'
            report = service.translate(identity, {1})
            self.assertEqual(provider.calls, 3)
            self.assertEqual(report['already_translated_pages'], [])
            with patch('papeer.translation.translation.TRANSLATION_PROTOCOL', TRANSLATION_PROTOCOL + 1):
                report = service.translate(identity, {1})
            self.assertEqual(provider.calls, 4)
            self.assertEqual(report['already_translated_pages'], [])

    def test_render_code_change_redraws_from_saved_translations(self):
        with tempfile.TemporaryDirectory() as temporary:
            library = Library(Path(temporary))
            identity, _ = library.import_pdf(Path(__file__).parent / 'fixtures/sample.pdf')
            provider = FakeProvider()
            service = PaperService(library, provider, threading.Event())
            first = service.translate(identity)
            calls = provider.calls
            drawn = []

            def build(*args, **kwargs):
                drawn.append(kwargs.get('page_numbers') or kwargs.get('translate_page_numbers'))
                return build_translated_pdf(*args, **kwargs)

            changed = 'code-sha256-' + 'b' * 64
            self.assertNotEqual(first['render_version'], changed)
            with patch('papeer.core.service.loaded_version', return_value=changed), \
                    patch('papeer.core.service.build_translated_pdf', side_effect=build):
                report = service.translate(identity)
            self.assertEqual(provider.calls, calls)
            self.assertEqual(report['already_translated_pages'], report['selected_pages'])
            self.assertEqual(report['translation_version'], first['translation_version'])
            self.assertEqual(report['render_version'], changed)
            self.assertTrue(drawn)
            with fitz.open(library.folder(identity) / 'translated.pdf') as pdf:
                self.assertIn('適応制御', pdf[0].get_text())

    def test_translation_identity_uses_base_url_only_for_the_api(self):
        instruction = prompts.load('translation')
        for provider, differs in (('codex', False), ('claude', False), ('api', True)):
            with self.subTest(provider=provider):
                values = [translation_identity(Settings.from_values({
                    'provider': provider, 'provider_options': {'api': {'base_url': url}}}), instruction)
                    for url in ('https://one.example/v1', 'https://two.example/v1')]
                self.assertEqual(values[0] != values[1], differs)
        api = Settings.from_values({'provider': 'api', 'provider_options': {'api': {'base_url': 'https://one.example/v1/'}}})
        same = Settings.from_values({'provider': 'api', 'provider_options': {'api': {'base_url': ' https://one.example/v1'}}})
        self.assertEqual(translation_identity(api, instruction), translation_identity(same, instruction))
        self.assertNotEqual(translation_identity(api, instruction), translation_identity(api, instruction + '。'))

    def test_translation_identity_is_pinned(self):
        # How requests are sent and answers read (structured output, temperature, JSON parsing, prompt
        # wording besides the translation prompt) is not part of the key: changing it must not make
        # saved papers translate again. Update these values only together with TRANSLATION_PROTOCOL,
        # BUILTIN_PROMPT_REVISION or a deliberate change of what the key holds.
        settings = Settings.from_values({'provider': 'api', 'model': 'gpt-4.1-mini',
                                         'provider_options': {'api': {'base_url': 'https://api.example/v1'}}})
        self.assertEqual(translation_identity(settings, '独自の翻訳指示です。'),
                         'translation-sha256-1ab69f652d6b0c7876c60f512ce3d3b445d206818d873760a4bb6d26a45b66e7')
        self.assertEqual(translation_identity(settings, prompts.builtin('translation')),
                         'translation-sha256-756d024fb94ec2928745e1470c040c53d39eb6f356c350a860615d45e5026475')
        self.assertEqual(TranslationKey.current(settings, '独自の翻訳指示です。',
                                                [{'id': 'p1b0', 'page': 1, 'text': 'A sentence.'}]).fingerprint,
                         '43f8f123992c0bb8f83d32def0565b9bc90ed77f94f8352addc9603a6a588046')

    def test_saved_translations_do_not_depend_on_how_the_api_was_asked(self):
        """A paper translated through a server that refused structured output is reused by one that takes it."""
        forget_refused_options()
        self.addCleanup(forget_refused_options)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source.pdf'
            with fitz.open() as pdf:
                for n in range(1, 3):
                    pdf.new_page().insert_text((40, 70), f'Original content on page {n}.')
                pdf.save(source)
            library = Library(root / 'library')
            identity, _ = library.import_pdf(source)
            settings = Settings(provider='api', model='local-model', translation_concurrency=1,
                                provider_options={'api': {'base_url': 'http://localhost:1234/v1'}})
            formats = []

            def serve(refuse):
                def fetch(request):
                    payload = json.loads(request.data)
                    kind = payload.get('response_format', {}).get('type')
                    formats.append(kind)
                    if kind in refuse:
                        raise HTTPError('http://localhost:1234/v1', 400, 'unsupported', Message(),
                                        io.BytesIO(b'response_format is not supported'))  # type: ignore[arg-type]
                    units = json.loads(payload['messages'][1]['content'])['blocks']
                    content = json.dumps({'translations': [{'id': u['id'], 'text': '適応制御の検証結果。'} for u in units]},
                                         ensure_ascii=False)
                    return json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': content}}]}).encode()
                return patch.object(OpenAICompatProvider, '_fetch', side_effect=fetch)

            with serve({'json_schema', 'json_object'}):
                first = PaperService(library, create_provider(settings, threading.Event()), threading.Event()).translate(identity)
            self.assertEqual(first['translated_pages'], [1, 2])
            self.assertEqual(formats[:3], ['json_schema', 'json_object', None])
            forget_refused_options()
            formats.clear()
            with serve(set()):
                again = PaperService(library, create_provider(settings, threading.Event()), threading.Event()).translate(identity)
            self.assertEqual(formats, [])
            self.assertEqual(again['already_translated_pages'], [1, 2])
            self.assertEqual(again['translation_version'], first['translation_version'])

    def _legacy_paper(self, root):
        """A paper translated (pages 1 and 2) by a version before TranslationKey: code hashes in the cache."""
        source = root / 'source.pdf'
        with fitz.open() as pdf:
            for n in range(1, 4):
                pdf.new_page().insert_text((40, 70), f'Original content on page {n}.')
            pdf.save(source)
        library = Library(root / 'library')
        identity, _ = library.import_pdf(source)
        provider = FakeProvider()
        PaperService(library, provider, threading.Event()).translate(identity, {1, 2})
        cache_path = library.folder(identity) / 'translation-cache.json'
        cache = json.loads(cache_path.read_text('utf-8'))
        old = 'code-sha256-' + 'a' * 64
        units = translation_units(library.document(identity))
        apply_glossary(units, effective_glossary(library, identity))
        cache['translation_version'] = old
        cache['fingerprint'] = legacy_translation_fingerprint(provider.settings, units)
        for entry in cache['completed_pages'].values():
            entry['version'] = old
        cache_path.write_text(json.dumps(cache), 'utf-8')
        return library, identity, cache_path

    def test_cache_from_before_translation_key_is_adopted_without_asking_the_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            library, identity, cache_path = self._legacy_paper(Path(temporary))
            before = json.loads(cache_path.read_text('utf-8'))
            before['retry_state'] = {'attempts': {next(iter(before['translations'])): 2}, 'retry_calls': 1}
            cache_path.write_text(json.dumps(before), 'utf-8')
            provider = FakeProvider()
            service = PaperService(library, provider, threading.Event())
            report = service.translate(identity)
            # Only page 3, never translated, goes to the model.
            self.assertEqual(provider.calls, 1)
            self.assertEqual(report['already_translated_pages'], [1, 2])
            after = json.loads(cache_path.read_text('utf-8'))
            current = translation_identity(provider.settings, prompts.load('translation'))
            self.assertEqual(after['translation_version'], current)
            self.assertEqual({entry['version'] for entry in after['completed_pages'].values()}, {current})
            for number in ('1', '2'):
                self.assertEqual(after['completed_pages'][number]['translations'],
                                 before['completed_pages'][number]['translations'])
            # The retry budget of the old cache is kept, not reset.
            self.assertEqual(after['retry_state']['retry_calls'], 1)
            # Migrated once: from now on the records are ordinary current ones.
            service.translate(identity)
            self.assertEqual(provider.calls, 1)

    def test_cache_from_before_translation_key_is_retranslated_when_inputs_may_differ(self):
        cases = {
            'model': lambda provider: setattr(provider.settings, 'model', 'another-model'),
            'prompt': lambda provider: prompts.save_overrides({'translation': '独自の翻訳指示です。'}),
            'protocol': lambda provider: None,
        }
        for name, change in cases.items():
            with self.subTest(change=name), tempfile.TemporaryDirectory() as temporary:
                library, identity, _ = self._legacy_paper(Path(temporary))
                provider = FakeProvider()
                change(provider)
                with patch('papeer.translation.translation.TRANSLATION_PROTOCOL',
                           TRANSLATION_PROTOCOL + (name == 'protocol')):
                    report = PaperService(library, provider, threading.Event()).translate(identity, {1, 2})
                self.assertEqual(report['already_translated_pages'], [])
                self.assertEqual(provider.calls, 2)
                prompts.save_overrides({'translation': ''})

    def test_old_cache_entry_is_matched_by_model_and_new_entry_by_identity(self):
        settings = Settings(translation_concurrency=1)
        key = TranslationKey.current(settings, prompts.load('translation'), [])
        old = 'code-sha256-' + 'c' * 64
        self.assertTrue(key.matches_page({'version': key.identity}))
        self.assertTrue(key.matches_page({'version': old, 'model': settings.model}))
        self.assertFalse(key.matches_page({'version': old, 'model': 'other'}))
        self.assertFalse(key.matches_page({'version': 'code-sha256-short', 'model': settings.model}))
        self.assertFalse(key.matches_page({'model': settings.model}))
        self.assertTrue(key.matches_cache({'translation_version': old, 'fingerprint': key.legacy_fingerprint}))
        self.assertFalse(key.matches_cache({'translation_version': old, 'fingerprint': key.fingerprint}))
        self.assertFalse(key.matches_cache({'translation_version': key.identity, 'fingerprint': key.legacy_fingerprint}))
        self.assertFalse(key.matches_cache({'fingerprint': key.legacy_fingerprint}))
        custom = TranslationKey.current(settings, '独自の翻訳指示です。', [])
        self.assertIsNone(custom.legacy_fingerprint)
        self.assertFalse(custom.matches_page({'version': old, 'model': settings.model}))

    def test_builtin_prompt_counts_by_revision_and_overrides_by_text(self):
        builtin = prompts.builtin('translation')
        self.assertEqual(prompt_identity(builtin), f'builtin-{BUILTIN_PROMPT_REVISION}')
        self.assertTrue(prompt_identity('独自の翻訳指示です。').startswith('custom-sha256-'))
        # Editing the built-in text without raising the revision keeps saved translations
        # (a documented trade-off); raising it translates again.
        with patch('papeer.core.prompts.builtin', return_value=builtin + '\n訳語を統一する。'):
            edited = prompts.builtin('translation')
            self.assertEqual(prompt_identity(edited), f'builtin-{BUILTIN_PROMPT_REVISION}')
            with patch('papeer.translation.translation.BUILTIN_PROMPT_REVISION', BUILTIN_PROMPT_REVISION + 1):
                self.assertEqual(prompt_identity(edited), f'builtin-{BUILTIN_PROMPT_REVISION + 1}')
                # An override still holding the first built-in text counts as revision 1,
                # which caches from before TranslationKey were made with.
                old_text = '最初の既定の翻訳指示'
                with patch('papeer.translation.translation.LEGACY_PROMPT_SHA256',
                           hashlib.sha256(old_text.encode()).hexdigest()):
                    self.assertEqual(prompt_identity(old_text), 'builtin-1')
                    settings = Settings(translation_concurrency=1)
                    self.assertIsNotNone(TranslationKey.current(settings, old_text, []).legacy_fingerprint)
                    self.assertIsNone(TranslationKey.current(settings, edited, []).legacy_fingerprint)
        # The settings dialog saves an override equal to the built-in text as no override;
        # one saved anyway still counts as the built-in prompt.
        prompts.save_overrides({'translation': builtin})
        self.assertEqual(prompt_identity(prompts.load('translation')), f'builtin-{BUILTIN_PROMPT_REVISION}')
        prompts.save_overrides({'translation': ''})

    def test_builtin_translation_prompt_edits_are_decided(self):
        text = prompts.builtin('translation')
        self.assertEqual(
            hashlib.sha256(text.encode('utf-8')).hexdigest(), BUILTIN_TRANSLATION_PROMPT_SHA256,
            '既定の translation.txt が変わりました。既存の訳文を訳し直すべき変更なら '
            'papeer/translation/translation.py の BUILTIN_PROMPT_REVISION を上げ、'
            'そうでなければそのままにしてから、このテストの BUILTIN_TRANSLATION_PROMPT_SHA256 を更新してください。'
            '（LEGACY_PROMPT_SHA256 は変えないこと）')

    def test_paragraph_revision_keeps_the_key_and_model_the_page_was_translated_with(self):
        with tempfile.TemporaryDirectory() as temporary:
            library = Library(Path(temporary))
            identity, _ = library.import_pdf(Path(__file__).parent / 'fixtures/sample.pdf')
            PaperService(library, FakeProvider(), threading.Event()).translate(identity, {1})
            cache_path = library.folder(identity) / 'translation-cache.json'
            before = json.loads(cache_path.read_text('utf-8'))['completed_pages']['1']
            unit_id, text = next(iter(before['translations'].items()))
            provider = FakeProvider()
            provider.settings.model = 'another-model'
            service = PaperService(library, provider, threading.Event())
            service.translate(identity, {1}, replacements={unit_id: text + '（修正）'})
            self.assertEqual(provider.calls, 0)
            after = json.loads(cache_path.read_text('utf-8'))['completed_pages']['1']
            self.assertEqual(after['translations'][unit_id], text + '（修正）')
            self.assertEqual((after['version'], after['model']), (before['version'], before['model']))
            # So the revised page is not taken for a translation by the current model.
            report = service.translate(identity, {1})
            self.assertEqual(report['already_translated_pages'], [])
            self.assertGreater(provider.calls, 0)

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
                    sent.extend(json.loads(data)['blocks'])
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
                    with fitz.open(exports.interleaved_cache(PaperFiles(folder))) as paired:
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
                    inner.requested_pages.append({int(u['id'][1:].split('b')[0]) for u in json.loads(data)['blocks']})
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
