import json
import threading

import pytest

from papeer.core.summary_evidence import indexed_sources, resolve_evidence
from papeer.core.summary_quality import verify_edits
from papeer.core.summary_review import _apply_edits


SOURCE = "The source contains x², a PDF ligature ﬁ, and a con-\nstrained model. " * 15


def test_model_selects_source_handle_without_retyping_math_or_pdf_line_breaks():
    sources = indexed_sources([{"page": 7, "text": SOURCE}])
    span = sources[0]["evidence_spans"][1]
    edit = dict(category="fact", reason="原文を参照", original="Draft", replacement="Correct result.",
                page=7, evidence="", evidence_id=span["id"])
    article, edits = _apply_edits("Draft", {"edits": [edit]}, sources, lambda text: text)
    assert article == "Correct result."
    assert edits[0]["evidence"] == span["text"] and edits[0]["evidence"] in SOURCE
    assert resolve_evidence(edit, [sources[0], sources[0]]) == span["text"]
    for bad in [dict(edit, page=8), dict(edit, evidence_id="invented-id")]:
        with pytest.raises(ValueError, match="根拠ID"):
            _apply_edits("Draft", {"edits": [bad]}, sources, lambda text: text)


def test_semantic_verifier_returns_actual_source_even_when_model_cannot_copy_the_formula():
    class Provider:
        def generate(self, instruction, data, schema):
            item = schema["properties"]["decisions"]["items"]
            assert set(item["required"]) == set(item["properties"])
            request = json.loads(data)
            span = request["source_pages"][0]["evidence_spans"][0]
            return json.dumps({"decisions": [dict(index=0, supported=True, needs_change=True,
                reason="近似と保証を照合", page=7, evidence="", evidence_id=span["id"])]})

    decisions = verify_edits("Draft", [{"page": 7, "original": "Draft", "replacement": "Result"}],
                             [{"page": 7, "text": SOURCE}], Provider(), threading.Event())
    assert decisions[0]["evidence"] == SOURCE[:600]
