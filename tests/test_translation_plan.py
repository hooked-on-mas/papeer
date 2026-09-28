"""The translation dialog's preview of a run must name the pages the run takes from its cache."""
from dataclasses import replace
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import pymupdf as fitz

from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.core.terminology import save_global_glossary
from papeer.core.translation_plan import translation_plan
from test_workflow import FakeProvider


class TranslationPlanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        source = root / "source.pdf"
        with fitz.open() as pdf:
            for n in range(3):
                pdf.new_page().insert_text((40, 70), f"Original adaptive content on page {n + 1}.")
            pdf.save(source)
        self.library = Library(root / "library")
        self.paper, _ = self.library.import_pdf(source)
        self.provider = FakeProvider()
        self.service = PaperService(self.library, self.provider, threading.Event())

    def tearDown(self):
        self.tmp.cleanup()

    def plan(self, pages=None, model=None):
        settings = self.provider.settings if model is None else replace(self.provider.settings, model=model)
        return translation_plan(self.library, self.paper, settings, pages)

    def translate(self, pages=None):
        calls = self.provider.calls
        report = self.service.translate(self.paper, pages)
        return report, self.provider.calls - calls

    def test_untranslated_paper_needs_the_model_for_every_page(self):
        plan = self.plan()
        self.assertEqual(plan["selected_pages"], [1, 2, 3])
        self.assertEqual(plan["pending_pages"], [1, 2, 3])
        self.assertEqual(plan["reusable_pages"], [])
        self.assertEqual(plan["retranslated_pages"], [])
        self.assertTrue(plan["needs_ai"])

    def test_reusable_pages_are_the_pages_translate_takes_from_the_cache(self):
        self.translate({1, 2})
        plan = self.plan()
        self.assertEqual((plan["reusable_pages"], plan["pending_pages"]), ([1, 2], [3]))
        report, _ = self.translate()
        self.assertEqual(report["already_translated_pages"], plan["reusable_pages"])
        # Everything is saved now: starting again only redraws the PDF, without asking the model.
        plan = self.plan()
        self.assertFalse(plan["needs_ai"])
        self.assertEqual(plan["reusable_pages"], [1, 2, 3])
        report, calls = self.translate()
        self.assertEqual(calls, 0)
        self.assertEqual(report["already_translated_pages"], [1, 2, 3])
        self.assertFalse(self.plan({2})["needs_ai"])

    def test_another_model_matches_what_translate_reuses(self):
        self.translate({1, 2})
        plan = self.plan(model="second-model")
        self.assertEqual(plan["model"], "second-model")
        self.provider.settings.model = "second-model"
        report, calls = self.translate()
        self.assertEqual(report["already_translated_pages"], plan["reusable_pages"])
        self.assertEqual(calls > 0, plan["needs_ai"])

    def test_retranslated_pages_name_the_models_they_were_made_with(self):
        self.provider.settings.model = "first-model"
        self.translate({1, 2})
        # A new glossary term changes the source of every page, whatever decides the model's part.
        save_global_glossary(self.library.root, [{"source": "adaptive", "target": "適応"}], [])
        plan = self.plan(model="second-model")
        self.assertEqual(plan["pending_pages"], [1, 2, 3])
        # Page 3 has no translation yet: only the translated pages count as retranslated.
        self.assertEqual(plan["retranslated_pages"], [1, 2])
        self.assertEqual(plan["previous_models"], ["first-model"])

    def test_changed_glossary_needs_the_model_again(self):
        self.translate()
        save_global_glossary(self.library.root, [{"source": "adaptive", "target": "適応"}], [])
        plan = self.plan()
        self.assertEqual(plan["retranslated_pages"], [1, 2, 3])
        report, calls = self.translate()
        self.assertGreater(calls, 0)
        self.assertEqual(report["already_translated_pages"], [])

    def test_cache_is_reused_when_the_drawing_code_changes(self):
        # Pages are redrawn from saved translations when only the code changes, as in
        # PaperService.translate (TranslationKey keys the cache without the code version).
        self.translate()
        changed = "code-sha256-" + "b" * 64
        with patch("papeer.core.service.loaded_version", return_value=changed):
            plan = self.plan()
            self.assertFalse(plan["needs_ai"])
            self.assertEqual(plan["reusable_pages"], [1, 2, 3])
            report, calls = self.translate()
        self.assertEqual(calls, 0)
        self.assertEqual(report["already_translated_pages"], plan["reusable_pages"])

    def test_changed_translation_prompt_needs_the_model_again(self):
        # The prompt is part of the key: the plan reads it as translate() does.
        self.translate()
        with patch("papeer.core.prompts.load", side_effect=lambda name: "changed instruction"):
            plan = self.plan()
        self.assertTrue(plan["needs_ai"])
        self.assertEqual(plan["retranslated_pages"], [1, 2, 3])


def test_route_reads_the_plan_without_starting_a_job():
    from fastapi.testclient import TestClient
    from sidecar.app import app
    from sidecar.deps import job_manager
    from test_sidecar_api import FIXTURE_PDF, _wait

    with tempfile.TemporaryDirectory() as tmp_dir, patch.dict(
            "os.environ", {"PAPEER_DATA_DIR": tmp_dir, "PAPEER_TOKEN": "", "PAPEER_DEV_NO_AUTH": "1"}):
        client = TestClient(app)
        _wait(client.post("/api/papers/import", json={"paths": [str(FIXTURE_PDF)]}).json()["job_id"])
        paper_id = client.get("/api/papers").json()[0]["id"]
        jobs = len(job_manager.get_jobs())
        response = client.get(f"/api/papers/{paper_id}/translation-plan", params={"pages": "1", "model": "other"})
        assert response.status_code == 200
        plan = response.json()
        assert plan["model"] == "other" and 1 in plan["selected_pages"] and plan["needs_ai"]
        assert len(job_manager.get_jobs()) == jobs
        assert client.get(f"/api/papers/{paper_id}/translation-plan", params={"pages": "0"}).status_code == 400
