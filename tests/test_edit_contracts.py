from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys

import pytest

from papeer.core.edit_model import EditGraph, apply_batch, assert_snapshot, conflict_title

FIXTURE = json.loads((Path(__file__).parent / "fixtures/shared-edits.json").read_text(encoding="utf-8"))


def identity(value):
    return f"00000000-0000-0000-0000-{value:012d}"


def batch(value):
    return deepcopy(next(value_ for value_ in FIXTURE["batches"] if value_["id"] == identity(value)))


def graph(root=None):
    return EditGraph({"version": 1, "libraryId": FIXTURE["libraryId"], "root": root or FIXTURE["document"], "batches": []})


def test_owned_location_is_derived_and_detachment_uses_the_current_owner_folder():
    case = FIXTURE["ownership"]
    assert_snapshot(case["root"])
    moved = apply_batch(case["root"], case["move"])
    assert moved["items"][0]["folderId"] == identity(8101)
    assert all(item["folderId"] is None and item["ownerId"] == moved["items"][0]["id"] for item in moved["items"][1:])
    independent = apply_batch(moved, case["detach"])
    assert independent["items"][1]["ownerId"] is None
    assert independent["items"][1]["folderId"] == identity(8101)
    assert independent["items"][2]["ownerId"] == independent["items"][0]["id"]
    for invalid in FIXTURE["invalid"]:
        if invalid["name"] in ("owned-markdown-folder", "owned-attachment-folder", "deleted-owned-folder"):
            with pytest.raises(ValueError, match="owned-item-folder"):
                apply_batch(invalid["root"], invalid["batch"])


def test_generated_contracts_are_current():
    subprocess.run([sys.executable, "tools/generate_edit_contracts.py", "--check"], check=True)


@pytest.mark.parametrize("order", [[201, 202, 203, 204], [204, 202, 203, 201], [203, 201, 204, 202], [202, 204, 201, 203]])
def test_causal_branches_converge(order):
    value = graph()
    for number in order:
        value.receive([batch(number)])
        value.receive([batch(number)])
    assert value.view == {"heads": [identity(202), identity(204)], "waiting": [], "rejected": {}}
    assert len(value.states[identity(202)]["pages"][0]["annotations"]) == 1
    assert value.states[identity(204)]["pages"][0]["id"] == identity(4)
    assert value.states[identity(204)]["deletedPages"][0]["id"] == identity(3)
    assert EditGraph(value.checkpoint()).view == value.view


def test_wait_and_different_page_conflict():
    value = graph()
    value.receive([batch(202)])
    assert value.view["heads"] == [identity(100)]
    assert value.view["waiting"] == [identity(202)]
    value.receive([batch(201), batch(205)])
    assert value.view["heads"] == [identity(202), identity(205)]


def test_conditional_and_simultaneous_resolutions():
    value = graph()
    value.receive([batch(number) for number in [201, 202, 203, 204]])
    value.assert_local(batch(206))
    value.receive([batch(number) for number in [206, 207, 205]])
    assert value.view["heads"] == [identity(205), identity(206), identity(207)]
    with pytest.raises(ValueError, match="heads-changed"):
        value.assert_local(batch(206))
    late = graph()
    late.receive([batch(number) for number in [206, 205, 204, 202, 201, 203]])
    assert late.view["heads"] == [identity(205), identity(206)]


def test_duplicate_payload_and_cycles_are_atomic():
    value = graph()
    value.receive([batch(201)])
    before = value.checkpoint()
    changed = batch(201); changed["parents"] = [identity(999)]
    with pytest.raises(ValueError, match="batch-id-reused"):
        value.receive([batch(203), changed])
    assert before == value.checkpoint()
    a, b = batch(201), batch(202)
    a["parents"], b["parents"] = [identity(202)], [identity(201)]
    with pytest.raises(ValueError, match="parent-cycle"):
        graph().receive([a, b])


@pytest.mark.parametrize("case", FIXTURE["invalid"], ids=lambda case: case["name"])
def test_shared_invalid_corpus(case):
    before = deepcopy(case["root"])
    with pytest.raises(ValueError):
        apply_batch(case["root"], case["batch"])
    assert case["root"] == before


def test_all_families_and_unicode():
    for name in ("document", "markdown", "library"):
        assert_snapshot(FIXTURE[name])
    md = graph(FIXTURE["markdown"])
    md.receive([batch(501), batch(502)])
    assert md.view["heads"] == [identity(501), identity(502)]
    library = graph(FIXTURE["library"])
    library.receive([batch(302), batch(301)])
    assert library.view["heads"] == [identity(302)]
    assert len(library.states[identity(302)]["items"]) == 2
    assert len(conflict_title("𠮷" * 200)) == 200


def test_long_reverse_ordered_history_is_not_recursive():
    edits = []
    parent = FIXTURE["markdown"]["version"]
    for number in range(10000, 12000):
        edits.append({"kind": "markdown", "imageResources": [], "id": identity(number), "targetId": FIXTURE["markdown"]["id"], "libraryId": FIXTURE["libraryId"], "parents": [parent], "content": str(number)})
        parent = identity(number)
    value = graph(FIXTURE["markdown"])
    value.receive(list(reversed(edits)))
    assert value.view["heads"] == [identity(11999)]
    assert value.view["waiting"] == []


def test_non_finite_numbers_and_non_scalar_unicode_keys_are_rejected():
    value = deepcopy(FIXTURE["library"])
    value["items"][0]["metadata"][chr(0xD800)] = "invalid key"
    with pytest.raises(ValueError):
        assert_snapshot(value)
    for number in (float("inf"), 10 ** 400):
        value = deepcopy(FIXTURE["document"])
        value["pages"][0]["widthPt"] = number
        with pytest.raises(ValueError):
            assert_snapshot(value)
