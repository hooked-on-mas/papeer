import base64
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sqlite3

import pytest

from papeer.core.edit_model import apply_batch, assert_batch, assert_snapshot
from papeer.core.edits.resources import assert_resource_bindings, is_image_media_type
from papeer.core.edits.datasets import assert_dataset_checkpoint, checkpoint_hash, checkpoint_resource_ids
from native_core_test_authority import core_repository

FIXTURE = json.loads((Path(__file__).parent / "fixtures/shared-edits.json").read_text(encoding="utf-8"))
IMAGES = FIXTURE["markdownImages"]
METADATA = IMAGES["metadata"]
WITH_IMAGE = apply_batch(FIXTURE["markdown"], IMAGES["batch"])


def test_shared_manifest_replacement_and_required_unique_bindings():
    assert WITH_IMAGE["imageResources"] == IMAGES["batch"]["imageResources"]
    assert WITH_IMAGE["content"] == IMAGES["batch"]["content"]
    assert apply_batch(WITH_IMAGE, IMAGES["remove"])["imageResources"] == []
    for original, validate in [(WITH_IMAGE, assert_snapshot), (IMAGES["batch"], assert_batch)]:
        missing = deepcopy(original)
        del missing["imageResources"]
        with pytest.raises(ValueError):
            validate(missing)
        duplicate = {**original, "imageResources": original["imageResources"] * 2}
        with pytest.raises(ValueError, match="duplicate-markdown-image"):
            validate(duplicate)


def test_shared_image_mime_and_binding_rules():
    for entry in IMAGES["mediaTypes"]:
        assert is_image_media_type(entry["value"]) == entry["valid"]
    assert_resource_bindings(WITH_IMAGE, lambda _: METADATA)
    for invalid in [None, {**METADATA, "id": FIXTURE["libraryId"]}, {**METADATA, "sha256": "0" * 64},
                    {**METADATA, "mediaType": "text/html"}, {**METADATA, "mediaType": "image/*"}]:
        with pytest.raises(ValueError, match="missing-or-stale-image-resource"):
            assert_resource_bindings(WITH_IMAGE, lambda _: invalid)


def test_sqlite_keeps_historical_image_resources_after_removal(tmp_path):
    @contextmanager
    def connection():
        with sqlite3.connect(tmp_path / "images.sqlite3") as db:
            yield db
    scope = {"accountId": "images", "libraryId": FIXTURE["libraryId"], "epoch": "one"}
    repository = core_repository(connection, scope)
    for key in ["document", "markdown", "library"]:
        repository.initialize(FIXTURE[key])
    assert repository.commit(IMAGES["batch"])["status"] == "aborted"
    data = base64.b64decode(IMAGES["bytesBase64"])
    with pytest.raises(ValueError, match="hash"):
        repository.store_resource(METADATA["id"], "0" * 64, METADATA["mediaType"], data)
    repository.store_resource(METADATA["id"], METADATA["sha256"], METADATA["mediaType"], data)
    assert repository.commit(IMAGES["batch"])["status"] == "durable"
    assert repository.commit(IMAGES["remove"])["status"] == "durable"
    checkpoint = repository.checkpoint()
    assert checkpoint_resource_ids(checkpoint) == [METADATA["id"]]
    manifest = {"version": 1, "id": METADATA["id"], "scope": scope, "checkpointSha256": checkpoint_hash(checkpoint), "resources": [METADATA]}
    assert_dataset_checkpoint(manifest, checkpoint, scope)
    with pytest.raises(ValueError, match="missing-or-stale-image-resource"):
        assert_dataset_checkpoint({**manifest, "resources": [{**METADATA, "sha256": "0" * 64}]}, checkpoint, scope)
