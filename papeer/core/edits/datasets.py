"""Completed dataset manifest rules, mirrored by runtime/edits/datasetManifest.ts."""
from papeer.core.edit_contracts import validate_datasetmanifest, validate_repositorycheckpoint
from papeer.core.edit_model import EditGraph, all_document_pages, assert_snapshot, reject
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edits.records import assert_edit_record, validate_histories
from papeer.core.edits.resources import assert_resource_bindings, assert_resource_metadata, publication_item


def checkpoint_hash(checkpoint):
    return edit_content_hash(checkpoint)


def snapshot_resources(snapshot):
    if snapshot["kind"] == "document":
        return {page["background"]["resourceId"] for page in all_document_pages(snapshot) if page["background"]["kind"] == "pdf"}
    if snapshot["kind"] == "library":
        return {item["resourceId"] for item in snapshot["items"] if "resourceId" in item}
    if snapshot["kind"] == "markdown":
        return {image["resourceId"] for image in snapshot["imageResources"]}
    return set()


def checkpoint_resource_ids(checkpoint):
    validate_repositorycheckpoint(checkpoint)
    ids = set()
    for root in checkpoint["roots"]:
        assert_snapshot(root)
        ids.update(snapshot_resources(root))
    for record in checkpoint["edits"]:
        assert_edit_record(record)
        batch = record["batch"]
        if batch["libraryId"] != checkpoint["libraryId"]:
            reject("batch-scope")
        if batch["kind"] == "resolution":
            ids.update(snapshot_resources(batch["snapshot"]))
        elif batch["kind"] == "markdown":
            ids.update(image["resourceId"] for image in batch["imageResources"])
        elif batch["kind"] == "document":
            for change in batch["changes"]:
                pages = change["translation"]["pages"] if change["type"] == "translation" and change["translation"] else (
                    [change["page"]] if change["type"] in {"insert", "replace"} else [])
                ids.update(page["background"]["resourceId"] for page in pages if page["background"]["kind"] == "pdf")
        elif batch["kind"] == "library":
            ids.update(change["item"]["resourceId"] for change in batch["changes"] if change["type"] == "put-item" and "resourceId" in change["item"])
        if "publication" in record:
            item = publication_item(record["publication"])
            if "resourceId" in item:
                ids.add(item["resourceId"])
            if "content" in record["publication"]:
                ids.update(snapshot_resources(record["publication"]["content"]))
    return sorted(ids)


def assert_dataset_manifest(value, scope=None):
    validate_datasetmanifest(value)
    if scope is not None and value["scope"] != scope:
        reject("dataset-scope")
    for resource in value["resources"]:
        assert_resource_metadata(resource)
    ids = [resource["id"] for resource in value["resources"]]
    if sorted(set(ids)) != ids:
        reject("dataset-resource-order")


def assert_dataset_checkpoint(manifest, checkpoint, scope):
    assert_dataset_manifest(manifest, scope)
    ids = checkpoint_resource_ids(checkpoint)
    if checkpoint["libraryId"] != scope["libraryId"]:
        reject("dataset-scope")
    if ids != [resource["id"] for resource in manifest["resources"]]:
        reject("dataset-resources")
    if checkpoint_hash(checkpoint) != manifest["checkpointSha256"]:
        reject("dataset-checkpoint-hash")
    roots = {root["id"]: root for root in checkpoint["roots"]}
    if len(roots) != len(checkpoint["roots"]):
        reject("checkpoint-duplicate-root")
    if roots.get(scope["libraryId"], {}).get("kind") != "library" or any(root["kind"] == "library" and root["id"] != scope["libraryId"] for root in roots.values()):
        reject("checkpoint-library")
    if len({record["batch"]["id"] for record in checkpoint["edits"]}) != len(checkpoint["edits"]):
        reject("checkpoint-duplicate-batch")
    records = {record["batch"]["id"]: record for record in checkpoint["edits"]}
    validate_histories(records, checkpoint["roots"], set(records))
    resources = {resource["id"]: resource for resource in manifest["resources"]}
    for root in roots.values():
        graph = EditGraph({"version": 1, "libraryId": scope["libraryId"], "root": root,
                           "batches": [record["batch"] for record in checkpoint["edits"] if record["batch"]["targetId"] == root["id"]]})
        if graph.view["rejected"]:
            reject(next(iter(graph.view["rejected"].values())))
        for snapshot in graph.states.values():
            assert_resource_bindings(snapshot, resources.get)
            if snapshot["kind"] == "library":
                for item in snapshot["items"]:
                    if item["kind"] != "attachment" and roots.get(item["id"], {}).get("kind") != ("markdown" if item["kind"] == "markdown" else "document"):
                        reject("dataset-content-missing")
