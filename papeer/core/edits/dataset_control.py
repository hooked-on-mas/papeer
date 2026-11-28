"""Native validation/guards for the shared dataset control transaction."""
from copy import deepcopy

from papeer.core.edit_contracts import validate_datasetcontrolrecord
from papeer.core.edits.datasets import assert_dataset_checkpoint, assert_dataset_manifest
from papeer.core.edit_model import reject


def dataset_identity(scope):
    return {key: scope[key] for key in ("accountId", "libraryId")}


def dataset_access(record):
    frozen = record["transition"]["phase"] in {"prepared", "published"}
    return {"activeEpoch": record["active"]["scope"]["epoch"] if record["active"] else None,
            "stagingEpoch": record["transition"]["publication"]["manifest"]["scope"]["epoch"] if frozen else None,
            "frozen": frozen, "epochs": list(record["epochs"])}


def assert_dataset_access(access, scope, mode):
    if access is None:
        return
    denied = (access["frozen"] or access["activeEpoch"] != scope["epoch"]) if mode == "edit" else (
        access["stagingEpoch"] != scope["epoch"] if access["frozen"] else access["activeEpoch"] != scope["epoch"] and scope["epoch"] in access["epochs"])
    if denied:
        reject("dataset-frozen" if access["frozen"] else "dataset-inactive")


def assert_dataset_control(record, identity):
    validate_datasetcontrolrecord(record)
    if record["identity"] != identity:
        reject("dataset-scope")
    run, active, epochs = record["transition"], record["active"], record["epochs"]
    target = run["publication"]["manifest"]
    if run["mode"] == "initialize" and (run["source"] is not None or run["phase"] != "activated" or record["id"] != run["id"] or len(epochs) != 1):
        reject("dataset-initialize")
    for manifest in (target, run["source"], active):
        if manifest:
            assert_dataset_manifest(manifest)
            if dataset_identity(manifest["scope"]) != identity:
                reject("dataset-scope")
    if target["id"] == run["publication"]["checkpointObjectId"]:
        reject("dataset-object-id-reused")
    if run["source"] and (run["source"]["scope"]["epoch"] == target["scope"]["epoch"] or run["source"]["id"] == target["id"]):
        reject("dataset-epoch-reused")
    if len(set(epochs)) != len(epochs) or target["scope"]["epoch"] not in epochs or (run["source"] and run["source"]["scope"]["epoch"] not in epochs):
        reject("dataset-epochs")
    if active != (target if run["phase"] == "activated" else run["source"]):
        reject("dataset-active-mismatch")


def assert_dataset_control_plan(record, identity):
    assert_dataset_control(record, identity)
    publication = record["transition"]["publication"]
    assert_dataset_checkpoint(publication["manifest"], publication["checkpoint"], publication["manifest"]["scope"])
    if record["transition"]["mode"] == "initialize":
        assert_empty_initial_publication(publication)


def assert_dataset_control_transition(previous, record):
    run = record["transition"]
    old = previous["transition"] if previous else None
    if run['mode'] == 'initialize':
        reject('dataset-initialize-requires-bundle')
    if old is None or old["id"] != run["id"]:
        if old is not None and old["phase"] not in {"activated", "rolled-back"}:
            reject("dataset-transition-pending")
        if run["phase"] != "prepared" or run["source"] != (previous["active"] if previous else None):
            reject("dataset-transition-source")
        epoch = run["publication"]["manifest"]["scope"]["epoch"]
        before = previous["epochs"] if previous else []
        if epoch in before or record["epochs"] != [*before, epoch]:
            reject("dataset-epoch-reused")
        return
    if any(previous[key] != record[key] for key in ("identity", "epochs")) or any(old[key] != run[key] for key in ("mode", "source", "publication")):
        reject("dataset-plan-changed")
    allowed = {"prepared": {"published", "rolled-back"}, "published": {"activated", "rolled-back"}, "activated": {"rolled-back"}, "rolled-back": set()}
    if run["phase"] not in allowed[old["phase"]]:
        reject("dataset-phase")


def dataset_record(edit):
    return {key: value for key, value in edit.items() if key != "receipt"}


def assert_dataset_contained(state, checkpoint, exact=False):
    if state["intents"]:
        reject("dataset-pending-intents")
    roots = {root["id"]: root for root in checkpoint["roots"]}
    edits = {record["batch"]["id"]: record for record in checkpoint["edits"]}
    if (any(root != roots.get(root["id"]) for root in state["roots"]) or any(dataset_record(edit) != edits.get(edit["batch"]["id"]) for edit in state["edits"])
            or (exact and (len(state["roots"]) != len(roots) or len(state["edits"]) != len(edits)))):
        reject("dataset-content-changed")


def copied_dataset_receipts(source, target):
    by_id = {edit["batch"]["id"]: edit for edit in target["edits"]}
    values = []
    for edit in source["edits"]:
        destination = by_id.get(edit["batch"]["id"])
        if destination is None or dataset_record(destination) != dataset_record(edit):
            reject("dataset-content-changed")
        value = deepcopy(destination)
        if edit["receipt"]["upload"] == "pending":
            value["receipt"]["upload"] = "pending"
        value["receipt"]["importedBy"] = list(dict.fromkeys([*destination["receipt"]["importedBy"], *edit["receipt"]["importedBy"]]))
        values.append(value)
    return values


def assert_empty_initial_publication(publication):
    checkpoint, manifest = publication["checkpoint"], publication["manifest"]
    roots = checkpoint["roots"]
    if (manifest["resources"] or checkpoint["edits"] or len(roots) != 1 or roots[0]["kind"] != "library"
            or roots[0]["id"] != checkpoint["libraryId"] or any(roots[0][key] for key in ("items", "folders", "links", "deletions"))):
        reject("dataset-initialize-content")
