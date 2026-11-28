"""Immutable transfer/archive record validation shared with editRecord.ts."""
from copy import deepcopy
from papeer.core.edit_contracts import validate_editrecord
from papeer.core.edit_model import assert_batch, reject
from papeer.core.edits.resources import publication_item


def assert_edit_record(value):
    validate_editrecord(value)
    batch, history, publication = value["batch"], value.get("history"), value.get("publication")
    assert_batch(batch)
    if history and (history["operationId"] != batch["id"] or history["afterVersion"] != batch["id"]
                    or history["beforeVersion"] != batch["parents"][0] or history.get("action", {}).get("operationId") == batch["id"]):
        reject("history-mismatch")
    if publication:
        publication_item(publication)
        if publication["libraryBatch"] != batch:
            reject("publication-id-reused")


def merge_edit_record(previous, incoming):
    if previous["batch"] != incoming["batch"]:
        reject("batch-id-reused")
    for key in ("history", "publication"):
        if key in previous and key in incoming and previous[key] != incoming[key]:
            reject("history-id-reused" if key == "history" else "publication-id-reused")
    return {"batch": deepcopy(previous["batch"]), **{key: deepcopy(previous.get(key, incoming.get(key)))
            for key in ("history", "publication") if key in previous or key in incoming}}


def history_status(record, records, roots):
    """Missing batches/metadata are pending; a closed, unrelated reference is invalid."""
    action = record.get("history", {}).get("action")
    if not action:
        return "valid"
    by_id = {value["batch"]["id"]: value for value in records}
    root_versions = {root["version"] for root in roots}
    path, seen, current = [], set(), record["batch"]["parents"][0]
    while current not in seen:
        seen.add(current)
        ancestor = by_id.get(current)
        if ancestor is None:
            if current not in root_versions:
                return "pending"
            break
        batch = ancestor["batch"]
        if batch["targetId"] != record["batch"]["targetId"]:
            return "invalid"
        if batch["kind"] == "resolution" or len(batch["parents"]) != 1:
            break  # A resolution begins a new history stack.
        path.append(ancestor)
        current = batch["parents"][0]
    else:
        return "pending"  # Graph validation reports cycles independently.
    referenced = next((value for value in path if value["batch"]["id"] == action["operationId"]), None)
    if referenced is None or referenced.get("history", {}).get("action"):
        return "invalid"
    if any("history" not in value for value in path):
        return "pending"
    undo, redo = [], []
    for value in [*reversed(path), record]:
        history = value["history"]
        step = history.get("action")
        if not step:
            undo.append(history["operationId"])
            redo.clear()
        else:
            source, target = (undo, redo) if step["kind"] == "undo" else (redo, undo)
            if not source or source[-1] != step["operationId"]:
                return "invalid"
            target.append(source.pop())
        if len(undo) > 50:
            undo.pop(0)
    return "valid"


def validate_histories(records, roots, incoming_ids):
    """Drop only previously deferred invalid metadata; keep its valid content batch."""
    values = list(records.values())
    for batch_id, record in records.items():
        if history_status(record, values, roots) == "invalid":
            if batch_id in incoming_ids:
                reject("history-action-order")
            records[batch_id] = {key: value for key, value in record.items() if key != "history"}
