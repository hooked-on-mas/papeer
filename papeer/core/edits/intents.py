"""Recovery intent validation; the TypeScript lifecycle owns retry/Undo decisions."""
from papeer.core.edit_contracts import validate_editintentrecord
from papeer.core.edit_model import assert_batch, reject
from papeer.core.edits.resources import publication_item


def requested_batch(request):
    return request["batch"] if "batch" in request else request["publication"]["libraryBatch"]


def assert_edit_intent(record, library_id, target_id):
    validate_editintentrecord(record)
    intent = record["intent"]
    original = requested_batch(intent["request"])
    assert_batch(original)
    if "publication" in intent["request"]:
        publication_item(intent["request"]["publication"])
    if original["libraryId"] != library_id or original["targetId"] != target_id:
        reject("intent-scope")
    for request in [intent["request"]] + ([intent["inverse"]] if "inverse" in intent else []):
        batch, history = requested_batch(request), request.get("history")
        assert_batch(batch)
        if history and (history["operationId"] != batch["id"] or history["afterVersion"] != batch["id"] or history["beforeVersion"] != batch["parents"][0]):
            reject("history-mismatch")
    if "inverse" in intent:
        inverse = intent["inverse"]["batch"]
        if (not intent["undoRequested"] or not intent["dispatched"] or inverse["id"] == original["id"]
                or inverse["libraryId"] != library_id or inverse["targetId"] != target_id or inverse["parents"] != [original["id"]]):
            reject("intent-inverse")


def assert_intent_transition(previous, following):
    a, b = previous["intent"], following["intent"]
    if (a["request"] != b["request"] or a["dispatched"] and not b["dispatched"] or a["undoRequested"] and not b["undoRequested"]
            or a.get("inverse") and a["inverse"] != b.get("inverse")):
        reject("intent-history-loss")
