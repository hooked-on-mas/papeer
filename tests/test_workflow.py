from __future__ import annotations
from tests._memos import read_memo, set_memo

import copy
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path

from _summary_responses import clean_summary_response
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import pymupdf as fitz

from papeer.core import exports
from papeer.core.config import Settings
from papeer.core.paths import PaperFiles
from papeer.pdf.pdf_engine import batches, bilingual_pdf, interleaved_pdf, build_translated_pdf, page_png, translation_units
from papeer.providers import Cancelled, create_provider
from papeer.core.service import PaperService, link_citations, stored_translations
from papeer.translation.translation import validate_translations
from papeer.core.storage import Library, normalize_collection_name
from papeer.layout.math_layout import MATH_TOKEN

FIXTURE = Path(__file__).parent / "fixtures/sample.pdf"


class FakeProvider:
    def __init__(self, cancel=None):
        # One request at a time, so tests can rely on the order of requests and pages.
        self.settings = Settings(translation_concurrency=1)
        self.calls = 0
        self.cancel = cancel
        self.interrupt_after = None

    def generate(self, instruction, data, schema=None):
        self.calls += 1
        if self.interrupt_after == self.calls:
            raise Cancelled("test interruption")
        if schema:
            units = json.loads(data)
            if "edits" in schema.get("properties", {}):
                return clean_summary_response(data)
            if isinstance(units, dict) and "blocks" in units:  # The first request of a batch.
                units = units["blocks"]
            if isinstance(units, dict) and "source_parts" in units:
                return json.dumps({"parts": [dict(part) if part["kind"] == "math" else
                    {"kind": "text", "text": "適応制御の検証結果。追従誤差を18%削減した。"}
                    for part in units["source_parts"]]}, ensure_ascii=False)
            if isinstance(units, dict) and "texts" in units:
                units = units["texts"]
            return json.dumps({"translations": [{"id": x["id"], "text": "適応制御の検証結果。追従誤差を18%削減した。" + " ".join(MATH_TOKEN.findall(x["text"]))}
                                                 for x in units]}, ensure_ascii=False)
        if "keywords" in instruction:
            return "adaptive controller tracking error limitations"
        if "research notes" in instruction:
            import re
            citation = re.search(r"\[[0-9a-f]{32}:p\d+\]", data)
            return "適応制御の論文です。 " + (citation[0] if citation else "")
        if "previous_dialogue" in data:
            payload = json.loads(data)
            import re
            citation = re.search(r"\[[0-9a-f]{32}:p\d+\]", payload["evidence"])
            return "追従誤差は0.82です。 " + citation[0]
        return "# サマリー\n\n" + data


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.library = Library(self.root / "日本語の 保存先")
        self.paper_id, _ = self.library.import_pdf(FIXTURE)
        self.cancel = threading.Event()

    def tearDown(self):
        self.tmp.cleanup()

    def test_import_duplicate_search_note_and_restart(self):
        duplicate, created = self.library.import_pdf(FIXTURE)
        self.assertEqual(duplicate, self.paper_id)
        self.assertFalse(created)
        set_memo(self.library, self.paper_id, note="制御工学の読書メモ", collection_name="制御")
        reopened = Library(self.library.root)
        self.assertEqual(len(reopened.papers("制御工学")), 0)  # Memo search is added in a later stage.
        self.assertEqual(len(reopened.papers("sensor delay")), 1)
        self.assertEqual(read_memo(reopened, self.paper_id), "制御工学の読書メモ")
        self.assertEqual(reopened.papers("%' OR 1=1 --"), [])

    def test_nested_collection_paths_are_normalized_and_saved_on_import(self):
        self.assertEqual(normalize_collection_name(r" 制御工学\\ 読書会 / 2026 "),
                         "制御工学 / 読書会 / 2026")
        second = self.root / "second.pdf"
        second.write_bytes(FIXTURE.read_bytes() + b"\n% distinct copy")
        paper_id, created = self.library.import_pdf(second, r" 制御工学\\ 読書会 ")
        self.assertTrue(created)
        self.assertEqual(self.library.paper(paper_id)["collection_name"], "制御工学 / 読書会")

    def test_translation_pdf_text_and_cache_resume(self):
        provider = FakeProvider()
        service = PaperService(self.library, provider, self.cancel)
        result = service.translate(self.paper_id)
        self.assertGreaterEqual(result["pages"], 2)
        folder = self.library.folder(self.paper_id)
        with fitz.open(folder / "translated.pdf") as pdf:
            text = "".join(p.get_text() for p in pdf)
            self.assertIn("適応制御", text)
            self.assertIn("18%", text)
        # The interleaved PDF is no longer written by translation, only when it is asked for.
        self.assertFalse((folder / "interleaved.pdf").exists())
        files = PaperFiles(folder)
        with (fitz.open(folder / "original.pdf") as original,
              fitz.open(folder / "translated.pdf") as translated,
              fitz.open(exports.interleaved_cache(files)) as paired):
            self.assertEqual(paired.page_count, original.page_count * 2)
            for index in range(original.page_count):
                for offset, source in enumerate((original, translated)):
                    page = paired[2 * index + offset]
                    self.assertEqual(page.get_text(), source[index].get_text())
                    self.assertEqual(page.rect, source[index].rect)
        with patch("papeer.core.exports.interleaved_pdf", side_effect=AssertionError("rebuilt")):
            exports.interleaved_cache(files)  # Reused while the translation is unchanged.
        initial_calls = provider.calls
        service.translate(self.paper_id)
        self.assertEqual(provider.calls, initial_calls, "cached translation must avoid repeated AI calls")
        # A new translated.pdf discards the paired copy built from the previous one.
        self.assertFalse((folder / "interleaved.pdf").exists())
        self.assertTrue(page_png(folder / "translated.pdf", 0).startswith(b"\x89PNG"))
        bilingual_pdf(folder / "original.pdf", folder / "translated.pdf", self.root / "bilingual.pdf")
        with fitz.open(self.root / "bilingual.pdf") as pdf:
            self.assertGreater(pdf[0].rect.width, 1000)
            self.assertIn("Adaptive Control", pdf[0].get_text())
            self.assertIn("適応制御", pdf[0].get_text())

    def test_effort_change_preserves_completed_translation_on_resume(self):
        provider = FakeProvider()
        service = PaperService(self.library, provider, self.cancel)
        service.translate(self.paper_id, {1})
        path = self.library.folder(self.paper_id) / "translation-cache.json"
        before = stored_translations(json.loads(path.read_text("utf-8")))
        calls = provider.calls
        provider.settings.reasoning_effort = "high"
        service.translate(self.paper_id, {1})
        self.assertEqual(provider.calls, calls)
        service.translate(self.paper_id, {1, 2})
        self.assertGreater(provider.calls, calls)
        after = stored_translations(json.loads(path.read_text("utf-8")))
        self.assertTrue(all(after[key] == value for key, value in before.items()))

    def test_interleaved_pdf_preserves_rotation_and_existing_output_on_mismatch(self):
        original, translated, output = [self.root / name for name in ('original.pdf', 'translated.pdf', 'interleaved.pdf')]
        for path, rotation in ((original, 90), (translated, 180)):
            with fitz.open() as pdf:
                page = pdf.new_page(width=300, height=400)
                page.insert_text((40, 70), path.stem)
                page.set_rotation(rotation)
                pdf.save(path)
        interleaved_pdf(original, translated, output)
        with fitz.open(output) as pdf:
            self.assertEqual([p.rotation for p in pdf], [90, 180])
            self.assertEqual([p.get_text().strip() for p in pdf], ['original', 'translated'])
        before = output.read_bytes()
        with fitz.open(translated) as pdf:
            pdf.new_page()
            pdf.saveIncr()
        with self.assertRaisesRegex(ValueError, 'ページ数'):
            interleaved_pdf(original, translated, output)
        self.assertEqual(output.read_bytes(), before)
        with self.assertRaisesRegex(ValueError, '保存先'):
            interleaved_pdf(original, translated, original)

    def test_oversize_translation_stays_on_original_page_without_truncation(self):
        document = self.library.document(self.paper_id)
        block = document["blocks"][0]
        very_long = "長い訳文です。" * 1000 + "末尾の検証文字列"
        destination = self.root / "overflow.pdf"
        report = build_translated_pdf(FIXTURE, document, {block["id"]: very_long}, destination)
        self.assertEqual(report["overflow_blocks"], 0)
        self.assertEqual(report["scaled_blocks"], 1)
        self.assertEqual(report["supplements"], [])
        with fitz.open(destination) as pdf:
            self.assertEqual(pdf.page_count, 2)
            extracted = "".join(p.get_text() for p in pdf)
            self.assertIn("末尾の検証文字列", extracted.replace("\n", ""))
            self.assertNotIn("翻訳補足", extracted)

    def test_invalid_ai_output_is_not_accepted(self):
        expected = [{"id": "a"}, {"id": "b"}]
        bad = [
            {"translations": [{"id": "a", "text": "訳"}]},
            {"translations": [{"id": "a", "text": "訳"}, {"id": "a", "text": "重複"}]},
            {"translations": [{"id": "a", "text": ""}, {"id": "b", "text": "訳"}]},
        ]
        for value in bad:
            with self.assertRaises(ValueError):
                validate_translations(json.dumps(value), expected)

    def test_long_blocks_are_bounded_and_reconstruct_original(self):
        text = "English text " * 3000
        units = translation_units({"blocks": [{"id": "p1b1", "page": 1, "text": text}]})
        self.assertEqual("".join(x["text"] for x in units), text)
        self.assertTrue(all(len(x["text"]) <= 6500 for x in units))
        self.assertTrue(all(sum(len(x["text"]) + 100 for x in b) <= 9000 for b in batches(units)))

    def test_split_block_marker_stays_inside_the_pdf_layout(self):
        from papeer.core.reading_tools import library_search, translation_paragraphs
        from papeer.core.search import search_paper
        from papeer.core.service import page_translation_text
        from papeer.layout.reading_flow import UNIT_JOINER
        # A low limit splits the fixture's longer paragraphs into several units.
        with patch("papeer.pdf.pdf_engine.UNIT_LIMIT", 120):
            document = self.library.document(self.paper_id)
            units = translation_units(document)
            split = {u["block"] for u in units if not u["id"].endswith("_0")}
            self.assertTrue(split)
            PaperService(self.library, FakeProvider(), self.cancel).translate(self.paper_id)
            folder = self.library.folder(self.paper_id)
            files = PaperFiles(folder)
            cache = json.loads(files.translation_cache.read_text("utf-8"))
            self.assertTrue(stored_translations(cache))
            self.assertNotIn(UNIT_JOINER, json.dumps(cache, ensure_ascii=False))
            # translation.md: one paragraph per block, the parts joined like one text.
            markdown = files.translation_md.read_text("utf-8")
            self.assertNotIn(UNIT_JOINER, markdown)
            sections = {block_id: text for _, block_id, text in files.translation_sections()}
            for block_id in split:
                self.assertNotIn("\n", sections[block_id])
                self.assertIn("削減した。適応制御", sections[block_id])
            # 「翻訳の確認・修正」 lists the units themselves.
            paragraphs = translation_paragraphs(self.library, self.paper_id)
            self.assertEqual(len(paragraphs), len(units))
            self.assertFalse(any(UNIT_JOINER in p["text"] for p in paragraphs))
            pages = {u["page"] for u in units if u["block"] in split}
            for page in pages:
                self.assertFalse(any(UNIT_JOINER in text for text in page_translation_text(folder, document, page)))
            found = search_paper(self.library, self.paper_id, "削減した。適応制御", side="translated")
            self.assertTrue(found["results"])
            self.assertNotIn(UNIT_JOINER, json.dumps(found, ensure_ascii=False))
            everywhere = library_search(self.library, "削減した。適応制御")
            self.assertTrue(everywhere["results"])
            self.assertNotIn(UNIT_JOINER, json.dumps(everywhere, ensure_ascii=False))
            with fitz.open(folder / "translated.pdf") as pdf:
                self.assertNotIn(UNIT_JOINER, "".join(p.get_text() for p in pdf))

    def test_cancel_keeps_completed_translation_for_next_run(self):
        folder = self.library.folder(self.paper_id)
        document = copy.deepcopy(self.library.document(self.paper_id))  # The shared value is never changed in place.
        document["blocks"][0]["text"] = "Long English paragraph. " * 1500
        document["blocks"][0]["translation_text"] = document["blocks"][0]["text"]
        (folder / "document.json").write_text(json.dumps(document), "utf-8")
        provider = FakeProvider()
        provider.interrupt_after = 2
        with self.assertRaises(Cancelled):
            PaperService(self.library, provider, self.cancel).translate(self.paper_id)
        cache = json.loads((folder / "translation-cache.json").read_text("utf-8"))
        self.assertGreater(len(stored_translations(cache)), 0)
        self.assertFalse((folder / "translated.pdf").exists())
        from papeer.translation.translation_preview import read_preview
        self.assertNotIn(1, read_preview(folder)["pages"], "a partially translated page must not be published")
        provider.interrupt_after = None
        result = PaperService(self.library, provider, self.cancel).translate(self.paper_id)
        self.assertGreaterEqual(result["pages"], 2)

    def test_completed_page_is_published_before_next_request_and_survives_failure(self):
        from papeer.translation.translation_preview import read_preview, translated_page

        folder = self.library.folder(self.paper_id)
        notifications = []

        class PausingProvider(FakeProvider):
            def generate(inner, instruction, data, schema=None):
                if inner.calls == 1:
                    self.assertEqual(read_preview(folder)["pages"], [1])
                    path, page_index = translated_page(folder, 0)
                    self.assertEqual(page_index, 0)
                    with fitz.open(path) as pdf:
                        self.assertEqual(pdf.page_count, 1)
                        self.assertIn("適応制御", pdf[0].get_text())
                    self.assertEqual(translated_page(folder, 1), (None, 0))
                    self.assertFalse((folder / "translated.pdf").exists())
                    self.assertIn((self.paper_id, 1), notifications)
                    raise Cancelled("pause after page one")
                units = json.loads(data)["blocks"]
                self.assertEqual({u["id"].split("b")[0] for u in units}, {"p1"})
                return super().generate(instruction, data, schema)

        with self.assertRaises(Cancelled):
            PaperService(self.library, PausingProvider(), self.cancel,
                         page_ready=lambda *args: notifications.append(args)).translate(self.paper_id)
        preview_path, _ = translated_page(folder, 0)
        self.assertTrue(preview_path.exists())
        paused = json.loads((folder / "translation-cache.json").read_text("utf-8"))
        before = stored_translations(paused)
        provider = FakeProvider()
        PaperService(Library(self.library.root), provider, self.cancel).translate(self.paper_id)
        remaining = [u for u in translation_units(self.library.document(self.paper_id)) if u["id"] not in before]
        self.assertEqual({u["page"] for u in remaining}, {2})
        # The second page's request got no answer: it is sent again as one normal request, spending no retries.
        self.assertEqual(paused["retry_state"]["unanswered"], {u["id"]: 1 for u in remaining})
        self.assertEqual(provider.calls, 1, "interrupted second-page units go back to a normal request")
        self.assertEqual(json.loads((folder / "translation-cache.json").read_text("utf-8"))["retry_state"]["retry_calls"], 0)
        after = stored_translations(json.loads((folder / "translation-cache.json").read_text("utf-8")))
        self.assertTrue(all(after[k] == v for k, v in before.items()))
        self.assertTrue(read_preview(folder)["complete"])
        self.assertEqual(translated_page(folder, 1), (folder / "translated.pdf", 1))

    def test_article_and_qa_are_persisted_with_citations(self):
        service = PaperService(self.library, FakeProvider(), self.cancel)
        article = service.article(self.paper_id)
        self.assertTrue((self.library.folder(self.paper_id) / "article.md").exists())
        self.assertIn("papeer://", article)
        answer = service.ask(self.paper_id, "追従誤差は？")
        self.assertIn("papeer://", answer)
        self.assertEqual(len(self.library.messages(self.paper_id)), 2)
        answer = service.ask(self.paper_id, "実験の限界は？", entire_library=True)
        self.assertIn("抜粋", answer)

    def test_partial_batch_failure_saves_valid_items_and_resumes_only_missing(self):
        class DamagedProvider(FakeProvider):
            def generate(self, instruction, data, schema=None):
                if self.calls:
                    raise RuntimeError("recovery connection failed")
                answer = json.loads(super().generate(instruction, data, schema))
                self.initial_ids = {x["id"] for x in answer["translations"]}
                self.missing_id = answer["translations"].pop()["id"]
                return json.dumps(answer)

        folder = self.library.folder(self.paper_id)
        existing = (folder / "original.pdf").read_bytes()
        (folder / "translated.pdf").write_bytes(existing)
        provider = DamagedProvider()
        with self.assertRaisesRegex(RuntimeError, "connection failed"):
            PaperService(self.library, provider, self.cancel).translate(self.paper_id)
        cache = json.loads((folder / "translation-cache.json").read_text("utf-8"))
        self.assertEqual(set(stored_translations(cache)), provider.initial_ids - {provider.missing_id})
        self.assertEqual(cache["retry_state"]["attempts"][provider.missing_id], 2)
        self.assertEqual(cache["retry_state"]["retry_calls"], 1)
        # The first retry went out but got no answer.
        self.assertEqual(cache["retry_state"]["unanswered"], {provider.missing_id: 1})
        self.assertEqual((folder / "translated.pdf").read_bytes(), existing)
        self.assertEqual(self.library.paper(self.paper_id)["status"], "resumable")

        class ResumeProvider(FakeProvider):
            def generate(inner, instruction, data, schema=None):
                payload = json.loads(data)
                if inner.calls == 0:
                    # The unanswered retry is sent again as it was.
                    self.assertIn("source_parts", payload)
                else:
                    self.assertFalse({u["id"] for u in payload["blocks"]} & set(stored_translations(cache)))
                return super().generate(instruction, data, schema)

        resumed = ResumeProvider()
        PaperService(self.library, resumed, self.cancel).translate(self.paper_id)
        self.assertEqual(resumed.calls, 2)
        self.assertEqual(self.library.paper(self.paper_id)["status"], "translated")

    def test_retry_limit_skips_block_continues_pages_and_persists_on_reopen(self):
        class InvalidProvider(FakeProvider):
            def generate(inner, instruction, data, schema=None):
                payload = json.loads(data)
                if "blocks" in payload:
                    answer = json.loads(super().generate(instruction, data, schema))
                    if not hasattr(inner, "missing_id"):
                        inner.missing_id = answer["translations"].pop()["id"]
                    return json.dumps(answer)
                inner.calls += 1
                return json.dumps({"parts": []} if "source_parts" in payload else {"translations": []})

        provider = InvalidProvider()
        report = PaperService(self.library, provider, self.cancel).translate(self.paper_id)
        self.assertEqual(provider.calls, 5)  # Two pages and three retries.
        self.assertEqual(report["skipped_blocks"], [provider.missing_id])
        self.assertEqual(report["translated_pages"], [1, 2])
        self.assertEqual(self.library.paper(self.paper_id)["status"], "partial")
        folder = self.library.folder(self.paper_id)
        before = (folder / "translation-cache.json").read_bytes()
        cache = json.loads(before)
        self.assertNotIn(provider.missing_id, stored_translations(cache))
        self.assertEqual(cache["retry_state"]["retry_calls"], 3)
        self.assertEqual(cache["retry_state"]["attempts"][provider.missing_id], 4)
        units = translation_units(self.library.document(self.paper_id))
        self.assertEqual(set(stored_translations(cache)), {u["id"] for u in units} - {provider.missing_id})
        source = next(u["text"] for u in units if u["id"] == provider.missing_id)
        self.assertIn(source, (folder / "translation.md").read_text("utf-8"))
        reopened = Library(self.library.root)
        resumed = FakeProvider()
        resumed_report = PaperService(reopened, resumed, self.cancel).translate(self.paper_id)
        self.assertEqual(resumed_report["skipped_blocks"], [provider.missing_id])
        self.assertEqual(resumed.calls, 0)
        self.assertEqual((folder / "translation-cache.json").read_bytes(), before)

    def test_citation_pages_are_validated(self):
        answer = link_citations(f"[{self.paper_id}:p2] [{self.paper_id}:p999]", {self.paper_id: 2})
        self.assertIn(f"papeer://{self.paper_id}/2", answer)
        self.assertIn("参照未確認", answer)
        self.assertNotIn(f"papeer://{self.paper_id}/999", answer)

    def test_placeholder_citations_resolve_for_a_single_document(self):
        answer = link_citations("A [documentid:p4]。B [document_id:p1, p2]。C [documentid:p999]。", {self.paper_id: 2})
        self.assertNotIn("documentid", answer)
        self.assertNotIn("document_id", answer)
        self.assertIn(f"[p.1](papeer://{self.paper_id}/1) [p.2](papeer://{self.paper_id}/2)", answer)
        self.assertIn("参照未確認", answer)
        # With several documents in scope the placeholder is ambiguous and stays as written.
        other = "0" * 32
        self.assertEqual(link_citations("[documentid:p1]", {self.paper_id: 2, other: 2}), "[documentid:p1]")

    def test_scanned_pdf_is_reported(self):
        target = self.root / "scan.pdf"
        with fitz.open() as document:
            page = document.new_page()
            page.draw_rect(fitz.Rect(20, 20, 60, 60), fill=(0, 0, 0))
            document.save(target)
        with self.assertRaisesRegex(ValueError, "OCR"):
            self.library.import_pdf(target)

    def test_secrets_are_not_written_to_settings(self):
        Settings(api_key="test-secret-do-not-persist").save(self.root)
        self.assertNotIn("test-secret", (self.root / "settings.json").read_text("utf-8"))

    def test_api_transport_with_local_fake_endpoint(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(handler):
                payload = json.loads(handler.rfile.read(int(handler.headers["Content-Length"])))
                self.assertEqual(handler.path, "/v1/chat/completions")
                self.assertEqual(payload["model"], "test-model")
                response = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": "接続確認"}}]}).encode()
                handler.send_response(200)
                handler.send_header("Content-Type", "application/json")
                handler.end_headers()
                handler.wfile.write(response)
            def log_message(self, *args):
                pass
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            settings = Settings(provider="api", model="test-model",
                            provider_options={"api": {"base_url": f"http://127.0.0.1:{server.server_port}/v1"}})
            self.assertEqual(create_provider(settings, self.cancel).generate("test", "日本語"), "接続確認")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_codex_transport_does_not_shell_interpolate_documents(self):
        """A real process through the npm layout: codex.cmd is never run, its JS entry is, with "node".

        Python stands in for node, so the entry is a Python script; the shim would exit with 9 if run.
        """
        shim = self.root / "npm" / "codex.cmd"
        entry = shim.parent / "node_modules/@openai/codex/bin/codex.js"
        entry.parent.mkdir(parents=True)
        shim.write_text("@exit /b 9\n", "utf-8")
        entry.write_text("import os,sys,pathlib\ndata=sys.stdin.buffer.read().decode('utf-8')\n"
                         "assert '日本語 & test `literal` $(literal) %PATH% ^& |' in data\n"
                         "assert '--sandbox' in sys.argv and 'read-only' in sys.argv\n"
                         "assert 'features.plugins=false' in sys.argv\n"
                         "assert 'PAPEER_TOKEN' not in os.environ and os.environ['KEEP_THIS'] == '1'\n"
                         "out=sys.argv[sys.argv.index('--output-last-message')+1]\n"
                         "pathlib.Path(out).write_text('回答',encoding='utf-8')\n", "utf-8")
        settings = Settings(provider_options={"codex": {"cli_path": str(shim)}}, timeout_seconds=30)
        node = lambda name, *args, **kwargs: sys.executable if name == "node" else None  # noqa: E731
        with patch("shutil.which", side_effect=node), \
                patch.dict(os.environ, {"PAPEER_TOKEN": "sidecar-token", "KEEP_THIS": "1"}):
            result = create_provider(settings, self.cancel).generate(
                "read", "日本語 & test `literal` $(literal) %PATH% ^& |")
        self.assertEqual(result, "回答")


if __name__ == "__main__":
    unittest.main()
