import hashlib
import json
from pathlib import Path
import threading
from unittest.mock import patch

import pytest

from _summary_responses import clean_summary_response
from papeer.core.paths import PaperFiles
from papeer.core.service import PaperService
from papeer.core.storage import Library
from papeer.core.summary_quality import finalize_article, verify_edits
from papeer.providers import Cancelled


IDENTITY = "a" * 32
SOURCE = "At K=4 the methods are similar. At K=8 ADPT performs better."
UNITS = [{"page": 1, "text": SOURCE}]


def edit(original="ADPT always wins.", replacement="K=4では同等、K=8ではADPTが優れる。"):
    return dict(category="condition", reason="比較条件", original=original, replacement=replacement,
                page=1, evidence="At K=8 ADPT performs better.")


def verdict(request, supported=True):
    return json.dumps({"decisions": [dict(index=index, supported=supported, needs_change=True, reason="条件を照合した",
        page=1, evidence="At K=4 the methods are similar.") for index in range(len(request["edits"]))]})


def test_audit_repairs_review_miss_and_requires_clean_pass_on_exact_final_article():
    calls = []

    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            calls.append(request)
            if request.get("phase") == "verify_edits":
                return verdict(request)
            if request.get("phase") == "acceptance_audit" and "always" in request["article"]:
                return json.dumps(dict(edits=[edit()], checked_pages=[1], coverage=[]))
            return clean_summary_response(data)

    article, report = finalize_article("ADPT always wins.", IDENTITY, UNITS, Provider(), threading.Event(),
                                       lambda _: None, lambda text: text, lambda _: [])
    assert "K=4" in article and "always" not in article
    assert len(report["audits"]) == 2 and report["audits"][-1]["edits"] == []
    assert report["acceptance"] == "passed" and len(report["verified_edits"]) == 1
    assert report["acceptance_article_sha256"] == hashlib.sha256(article.encode()).hexdigest()
    assert calls[-1]["article"] == article


def test_real_quote_does_not_make_semantically_wrong_edit_acceptable():
    calls = []

    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            calls.append(request)
            if request.get("phase") == "verify_edits":
                return verdict(request, supported=False)
            if request.get("phase") == "acceptance_audit":
                return json.dumps(dict(edits=[edit(replacement="ADPT is superior at every K.")], checked_pages=[1], coverage=[]))
            return json.dumps({"edits": [edit(replacement="ADPT is superior at every K.")]})

    with pytest.raises(ValueError, match="収束"):
        finalize_article("ADPT always wins.", IDENTITY, UNITS, Provider(), threading.Event(),
                         lambda _: None, lambda text: text, lambda _: [])
    assert len(calls) == 10  # Review + four audits; every rejected proposal stays unapplied.
    assert all(request["article"] == "ADPT always wins." for request in calls)


def test_verified_fixes_are_kept_when_another_proposal_is_rejected():
    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            if request.get("phase") == "verify_edits":
                answer = json.loads(verdict(request))
                answer["decisions"][1]["supported"] = False
                return json.dumps(answer)
            if request.get("phase") == "acceptance_audit":
                assert "K=4" in request["article"] and "Correct other finding." in request["article"]
                assert "Wrong new finding." not in request["article"]
                return clean_summary_response(data)
            return json.dumps({"edits": [edit(), edit("Correct other finding.", "Wrong new finding.")]})

    article, report = finalize_article("ADPT always wins. Correct other finding.", IDENTITY, UNITS,
        Provider(), threading.Event(), lambda _: None, lambda text: text, lambda _: [])
    assert "K=4" in article and "Correct other finding." in article
    assert len(report["edits"]) == len(report["verified_edits"]) == len(report["rejected_edits"]) == 1
    assert report["acceptance"] == "passed" and report["audits"][-1]["rejected_edits"] == []


@pytest.mark.parametrize("supported", [True, False])
def test_optional_addition_or_false_positive_cannot_force_endless_rewrites(supported):
    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            if request.get("phase") == "verify_edits":
                answer = json.loads(verdict(request, supported=supported))
                answer["decisions"][0]["needs_change"] = False
                answer["decisions"][0]["reason"] = "元の説明は正確で、追加は任意の導出に過ぎない。"
                return json.dumps(answer)
            change = edit("Accurate summary.", "Accurate summary with an optional derivation.")
            if request.get("phase") == "acceptance_audit":
                answer = json.loads(clean_summary_response(data))
                answer["edits"] = [change]
                return json.dumps(answer)
            return json.dumps({"edits": [change]})

    article, report = finalize_article("Accurate summary.", IDENTITY, UNITS, Provider(), threading.Event(),
                                       lambda _: None, lambda text: text, lambda _: [])
    assert article == "Accurate summary."
    assert report["acceptance"] == "passed" and report["edits"] == []
    assert len(report["audits"]) == 1 and len(report["dismissed_suggestions"]) == 2


@pytest.mark.parametrize("fault", ["missing", "duplicate", "false_quote"])
def test_every_edit_needs_its_own_grounded_semantic_verdict(fault):
    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            answer = json.loads(verdict(request))
            if fault == "missing":
                answer["decisions"] = []
            elif fault == "duplicate":
                answer["decisions"] *= 2
            else:
                answer["decisions"][0]["evidence"] = "This quote is not in the source document."
            return json.dumps(answer)

    with pytest.raises(ValueError):
        verify_edits("Draft", [edit()], UNITS, Provider(), threading.Event())


def test_verifier_receives_complete_cited_pages_and_neighbors_within_selected_scope():
    sources = [{"page": page, "text": f"Page {page}: contextual source evidence."} for page in [1, 2, 3, 7, 8, 9]]
    change = edit(original=f"Figure [p.8](papeer://{IDENTITY}/8) contradicts the table.")

    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            assert [unit["page"] for unit in request["source_pages"]] == [1, 2, 7, 8, 9]
            return json.dumps({"decisions": [dict(index=0, supported=True, needs_change=True, reason="確認", page=8,
                evidence="Page 8: contextual source evidence.")]})

    verify_edits("Draft", [change], sources, Provider(), threading.Event())


def test_verifier_preserves_complete_long_condition_quote_instead_of_truncating_it():
    source = "The complete theorem requires " + "condition and " * 60 + "the stated finite-order assumptions."

    class Provider:
        def generate(self, *_):
            return json.dumps({"decisions": [dict(index=0, supported=True, needs_change=True, reason="条件を保持", page=1, evidence=source)]})

    decisions = verify_edits("Draft", [edit()], [{"page": 1, "text": source}], Provider(), threading.Event())
    assert 800 < len(decisions[0]["evidence"]) < 1600
    assert decisions[0]["evidence"].endswith("finite-order assumptions.")


def test_verifier_repairs_its_own_invented_quote_without_rewriting_the_proposed_edit():
    requests = []

    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            requests.append(request)
            answer = json.loads(verdict(request))
            if len(requests) == 1:
                answer["decisions"][0]["evidence"] = "Paraphrased source with invented words."
            return json.dumps(answer)

    decisions = verify_edits("Draft", [edit()], UNITS, Provider(), threading.Event())
    assert decisions[0]["supported"] and len(requests) == 2
    assert requests[0]["edits"] == requests[1]["edits"] == [edit()]
    assert "Paraphrased source" in requests[1]["previous_response_error"]


@pytest.mark.parametrize("fault", ["page", "quote", "anchor", "empty"])
def test_unsubstantiated_clean_audit_cannot_publish(fault):
    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            answer = json.loads(clean_summary_response(data))
            if request.get("phase") == "acceptance_audit":
                if fault == "page":
                    answer["checked_pages"] = []
                elif fault == "empty":
                    answer["coverage"] = []
                else:
                    answer["coverage"][0]["evidence" if fault == "quote" else "article_excerpt"] = "Invented evidence or summary passage."
            return json.dumps(answer)

    with pytest.raises(ValueError):
        finalize_article("Draft", IDENTITY, UNITS, Provider(), threading.Event(),
                         lambda _: None, lambda text: text, lambda _: [])


def test_audit_gets_specific_feedback_to_repair_its_own_coverage_quote():
    calls = []

    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            answer = json.loads(clean_summary_response(data))
            if request.get("phase") == "acceptance_audit":
                calls.append(request)
                if len(calls) == 1:
                    answer["coverage"][0]["evidence"] = "Altered mathematical notation and words."
            return json.dumps(answer)

    _, report = finalize_article("Draft", IDENTITY, UNITS, Provider(), threading.Event(),
                                 lambda _: None, lambda text: text, lambda _: [])
    assert report["acceptance"] == "passed" and len(calls) == 2
    assert "Altered mathematical notation" in calls[1]["previous_response_error"]
    assert "PDF p.1" in calls[1]["previous_response_error"]


def test_no_convergence_is_bounded_and_does_not_replace_existing_article(tmp_path):
    library = Library(tmp_path / "library")
    identity, _ = library.import_pdf(Path(__file__).parent / "fixtures/sample.pdf")
    files = PaperFiles(library.folder(identity))
    files.article_md.write_text("Previously accepted article", "utf-8")
    files.article_review.write_text('{"previous": true}', "utf-8")
    audit_calls = 0

    class Provider:
        def generate(self, instruction, data, schema=None):
            nonlocal audit_calls
            if not schema:
                return f"Version A [{identity}:p1]"
            request = json.loads(data)
            if request.get("phase") == "verify_edits":
                source = request["source_pages"][0]
                return json.dumps({"decisions": [dict(index=0, supported=True, needs_change=True, reason="確認", page=source["page"], evidence=source["text"][:40])]})
            if request.get("phase") == "acceptance_audit":
                audit_calls += 1
                change = edit("Version A" if "Version A" in request["article"] else "Version B",
                              "Version B" if "Version A" in request["article"] else "Version A")
                change["evidence"] = request["source_pages"][0]["text"][:40]
                return json.dumps(dict(edits=[change], checked_pages=request["review_pages"], coverage=[]))
            return '{"edits": []}'

    with patch("papeer.core.service.summary_figures", return_value=[]), pytest.raises(ValueError, match="収束"):
        PaperService(library, Provider(), threading.Event()).article(identity)
    assert audit_calls == 4
    assert files.article_md.read_text("utf-8") == "Previously accepted article"
    assert json.loads(files.article_review.read_text("utf-8")) == {"previous": True}


def test_last_permitted_repair_still_gets_a_separate_clean_confirmation_pass():
    audit_calls = 0

    class Provider:
        def generate(self, instruction, data, schema):
            nonlocal audit_calls
            request = json.loads(data)
            if request.get("phase") == "verify_edits":
                return verdict(request)
            if request.get("phase") == "acceptance_audit":
                audit_calls += 1
                if audit_calls <= 3:
                    return json.dumps(dict(edits=[edit(request["article"], f"Version {audit_calls}")],
                                           checked_pages=[1], coverage=[]))
            return clean_summary_response(data)

    article, report = finalize_article("Draft", IDENTITY, UNITS, Provider(), threading.Event(),
                                       lambda _: None, lambda text: text, lambda _: [])
    assert article == "Version 3" and audit_calls == 4
    assert report["acceptance"] == "passed" and report["audits"][-1]["edits"] == []


def test_cancel_during_audit_never_returns_accepted_article():
    cancel = threading.Event()

    class Provider:
        def generate(self, instruction, data, schema):
            request = json.loads(data)
            if request.get("phase") == "acceptance_audit":
                cancel.set()
            return clean_summary_response(data)

    with pytest.raises(Cancelled):
        finalize_article("Draft", IDENTITY, UNITS, Provider(), cancel,
                         lambda _: None, lambda text: text, lambda _: [])
