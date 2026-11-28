"""Finite resource/publication rules shared with contentPublication.ts fixtures."""
from copy import deepcopy
import re
from papeer.core.edit_contracts import validate_contentpublication, validate_resourcemetadata
from papeer.core.edit_model import all_document_pages, assert_batch, assert_snapshot, reject


def publication_item(value):
    validate_contentpublication(value)
    batch = value["libraryBatch"]
    assert_batch(batch)
    items = [change["item"] for change in batch["changes"] if change["type"] == "put-item"]
    if len(items) != 1 or any(change["type"] not in {"put-item", "add-link"} for change in batch["changes"]):
        reject("publication-changes")
    item = items[0]
    content = value.get("content")
    if content is not None:
        assert_snapshot(content)
        expected = "markdown" if item["kind"] == "markdown" else "document" if item["kind"] in {"pdf", "notebook"} else None
        if content["id"] != item["id"] or content["kind"] != expected:
            reject("publication-content-kind")
    elif item["kind"] != "attachment":
        reject("publication-content-required")
    if item["kind"] in {"pdf", "attachment"} and not item.get("resourceId"):
        reject("publication-resource-required")
    return item


def assert_resource_metadata(value):
    validate_resourcemetadata(value)
    if (value["mediaType"] == "application/pdf") != bool(value.get("pdfPages")):
        reject("resource-pdf-metadata")


def inspected_resource(computed, expected=None):
    assert_resource_metadata(computed)
    if expected is None:
        return computed
    assert_resource_metadata(expected)
    if any(computed[key] != expected[key] for key in ["id", "sha256", "mediaType", "byteLength"]):
        reject("resource-inspection-mismatch")
    pages, expected_pages = computed.get("pdfPages", []), expected.get("pdfPages", [])
    if len(pages) != len(expected_pages) or any(abs(a[key] - b[key]) > .001 for a, b in zip(pages, expected_pages) for key in ["widthPt", "heightPt"]):
        reject("resource-inspection-mismatch")
    return deepcopy(expected)


def is_image_media_type(value):
    return bool(re.fullmatch(r"image/[a-z0-9!#$%&'*+.^_`|~-]+", value, re.IGNORECASE | re.ASCII)) and value.lower() != "image/*"


def assert_resource_bindings(snapshot, resource):
    metadata_by_id = {}
    def lookup(resource_id):
        if resource_id not in metadata_by_id:
            metadata_by_id[resource_id] = resource(resource_id)
        return metadata_by_id[resource_id]
    if snapshot["kind"] == "document":
        for page in all_document_pages(snapshot):
            background = page["background"]
            if background["kind"] != "pdf":
                continue
            metadata = lookup(background["resourceId"])
            pages = metadata.get("pdfPages", []) if metadata else []
            index = background["pdfPage"] - 1
            if (not metadata or metadata["mediaType"] != "application/pdf" or metadata["sha256"] != background["sourceRevision"]
                    or index < 0 or index >= len(pages)):
                reject("missing-or-stale-resource")
            physical = pages[index]
            if abs(physical["widthPt"] - page["widthPt"]) > .001 or abs(physical["heightPt"] - page["heightPt"]) > .001:
                reject("resource-page-dimensions")
    elif snapshot["kind"] == "library":
        for item in snapshot["items"]:
            if item.get("resourceId") and lookup(item["resourceId"]) is None:
                reject("missing-resource")
    elif snapshot["kind"] == "markdown":
        for image in snapshot["imageResources"]:
            metadata = lookup(image["resourceId"])
            if (not metadata or metadata["id"] != image["resourceId"] or metadata["sha256"] != image["sha256"]
                    or not is_image_media_type(metadata["mediaType"])):
                reject("missing-or-stale-image-resource")
