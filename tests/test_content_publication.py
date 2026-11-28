import base64
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3

import pytest

from native_core_test_authority import core_repository
from papeer.core.edits.resources import publication_item, assert_resource_bindings, assert_resource_metadata, inspected_resource
from _native_owner_api import owner_api

FOLDER = Path(__file__).parent / "fixtures"
FIXTURE = json.loads((FOLDER / "shared-edits.json").read_text(encoding="utf-8"))
RESOURCE = FIXTURE["resource"]["metadata"]
SOURCE = (FOLDER / FIXTURE["resource"]["file"]).read_bytes()


@pytest.fixture
def setup(tmp_path):
    @contextmanager
    def connection():
        with sqlite3.connect(tmp_path / "library.sqlite3") as db:
            yield db
    scope = {"accountId": "fixture", "libraryId": FIXTURE["libraryId"], "epoch": "publication"}
    repository = core_repository(connection, scope)
    for key in ("document", "markdown", "library"):
        repository.initialize(FIXTURE[key])
    return repository, connection, scope


def save_resource(repository):
    return repository.store_resource(RESOURCE["id"], RESOURCE["sha256"], RESOURCE["mediaType"], SOURCE)


def test_same_publication_corpus_and_background_binding_rules():
    for entry in FIXTURE["publications"]:
        assert publication_item(entry["value"])["kind"] == entry["name"]
    for entry in FIXTURE["invalidPublications"]:
        with pytest.raises(ValueError):
            publication_item(entry["value"])
    document = FIXTURE["publications"][0]["value"]["content"]
    assert_resource_bindings(document, lambda _: RESOURCE)
    for metadata in [None, {**RESOURCE, "sha256": "a" * 64}, {**RESOURCE, "pdfPages": []}, {**RESOURCE, "mediaType": "image/png"}]:
        with pytest.raises(ValueError, match="missing-or-stale-resource"):
            assert_resource_bindings(document, lambda _: metadata)
    wrong = deepcopy(document)
    wrong["pages"][0]["widthPt"] += 10
    with pytest.raises(ValueError, match="resource-page-dimensions"):
        assert_resource_bindings(wrong, lambda _: RESOURCE)
    with pytest.raises(ValueError, match="resource-pdf-metadata"):
        assert_resource_metadata({**RESOURCE, "mediaType": "image/png"})


@pytest.mark.parametrize("entry", FIXTURE["publications"], ids=lambda entry: entry["name"])
def test_native_publication_abort_retry_restart_history_and_outbox(setup, entry):
    repository, connection, scope = setup
    assert save_resource(repository) == RESOURCE  # Parsed from the actual PDF, not request metadata.
    publication = deepcopy(entry["value"])
    batch = publication["libraryBatch"]
    content = publication.get("content")
    if content:
        assert repository.commit(batch)["status"] == "aborted"
    history = {"operationId": batch["id"], "beforeVersion": batch["parents"][0], "afterVersion": batch["id"], "undoRequested": False}
    with connection() as db:
        db.execute("CREATE TRIGGER fail_catalog BEFORE INSERT ON edit_projections WHEN NEW.target='" + scope["libraryId"] + "' BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    assert repository.publish(publication, history)["status"] == "aborted"
    if content:
        with pytest.raises(ValueError, match="missing-target"):
            repository.read(content["id"])
    assert repository.pending() == []
    assert repository.pending_publications() == []
    assert repository.receipt(batch["id"]) is None
    assert repository.read(scope["libraryId"])["heads"] == [FIXTURE["library"]["version"]]
    assert repository.read_resource(RESOURCE["id"])["bytes"] == SOURCE
    with connection() as db:
        db.execute("DROP TRIGGER fail_catalog")
    assert repository.publish(publication, history)["status"] == "durable"
    restarted = core_repository(connection, scope)
    assert restarted.pending_publications() == [publication]
    assert restarted.read(scope["libraryId"])["history"] == [history]
    assert restarted.publish(publication, history)["status"] == "durable"
    wrong = deepcopy(publication)
    wrong["libraryBatch"]["changes"][0]["item"]["title"] = "different payload"
    assert restarted.publish(wrong)["status"] == "aborted"
    if content:
        assert restarted.read(content["id"])["checkpoint"]["root"] == content
    restarted.acknowledge(batch["id"])
    assert restarted.pending_publications() == []
    item = publication_item(publication)
    assert restarted.read(scope["libraryId"])["publicationOrigins"] == [{"batchId": batch["id"], "itemId": item["id"],
                                                                         "kind": item["kind"], "contentVersion": content["version"] if content else None}]


def test_verified_resources_binding_immutable_ids_and_account_epoch_isolation(setup):
    repository, connection, scope = setup
    publication = deepcopy(FIXTURE["publications"][0]["value"])
    assert repository.publish(publication)["status"] == "aborted"
    with pytest.raises(ValueError, match="resource-hash"):
        repository.store_resource(RESOURCE["id"], "a" * 64, "application/pdf", SOURCE)
    assert repository.read_resource(RESOURCE["id"]) is None
    assert save_resource(repository) == RESOURCE
    with pytest.raises(ValueError, match="resource-id-reused"):
        repository.store_resource(RESOURCE["id"], hashlib.sha256(b"other").hexdigest(), "text/plain", b"other")
    for changes in [{"accountId": "other"}, {"epoch": "other"}]:
        isolated = core_repository(connection, {**scope, **changes})
        assert isolated.read_resource(RESOURCE["id"]) is None
    assert repository.publish(publication)["status"] == "durable"
    root = publication["content"]
    wrong = deepcopy(root["pages"][0])
    wrong["background"]["sourceRevision"] = "a" * 64
    batch = {"kind": "document", "id": "00000000-0000-0000-0000-000000009999", "libraryId": scope["libraryId"], "targetId": root["id"], "parents": [root["version"]],
             "changes": [{"type": "replace", "expected": {"pageId": wrong["id"], **{key: root["pages"][0][key] for key in ["backgroundRevision", "lifecycleVersion", "annotationVersion"]}}, "page": wrong}]}
    assert repository.commit(batch)["status"] == "aborted"
    assert repository.read(root["id"])["heads"] == [root["version"]]


def test_authenticated_publication_and_resource_api(monkeypatch, tmp_path):
    # Real bearer, durable grant, lease and admission on the same fixture roots at the grant namespace.
    def seed(repo):
        for key in ("document", "markdown", "library"):
            repo.initialize(FIXTURE[key])
    with owner_api(tmp_path, monkeypatch, FIXTURE["libraryId"], "publication", seed) as api:
        scope, repository = api.scope, api.core()
        body = {"scope": scope, "resourceId": RESOURCE["id"], "sha256": RESOURCE["sha256"], "mediaType": "application/pdf", "dataBase64": base64.b64encode(SOURCE).decode("ascii")}
        assert api.post("store-resource", body).json() == RESOURCE
        assert api.post("store-resource", {**body, "dataBase64": "not base64!"}).status_code == 422
        assert api.post("read-resource", {"scope": scope, "resourceId": RESOURCE["id"]}).json()["dataBase64"] == body["dataBase64"]
        publication = FIXTURE["publications"][0]["value"]
        assert api.post("publish", {"scope": scope, "publication": publication}).json()["status"] == "durable"
        assert api.post("pending-publications", scope).json() == [publication]
        assert repository.read(publication["content"]["id"])["checkpoint"]["root"] == publication["content"]


def test_canonical_resource_dimensions_are_preserved_only_after_inspection(setup):
    repository, _, _ = setup
    expected = deepcopy(RESOURCE)
    expected["pdfPages"][0]["widthPt"] += .0001
    assert inspected_resource(RESOURCE, expected) == expected
    assert repository.store_resource(RESOURCE["id"], RESOURCE["sha256"], "application/pdf", SOURCE, expected) == expected
    wrong = deepcopy(expected)
    wrong["pdfPages"][0]["widthPt"] += 1
    with pytest.raises(ValueError, match="resource-inspection-mismatch"):
        inspected_resource(RESOURCE, wrong)


def test_remote_creation_and_first_edit_are_one_transaction_and_keep_full_envelope(setup):
    repository, connection, _ = setup
    publication = deepcopy(FIXTURE["publications"][2]["value"])
    root = publication["content"]
    edit = {"kind": "markdown", "imageResources": [], "id": "00000000-0000-0000-0000-000000009999", "libraryId": FIXTURE["libraryId"],
            "targetId": root["id"], "parents": [root["version"]], "content": "next edit"}
    with connection() as db:
        db.execute("CREATE TRIGGER fail_first_edit BEFORE INSERT ON edit_projections WHEN NEW.version='" + edit["id"] + "' BEGIN SELECT RAISE(ABORT, 'quota'); END")
    with pytest.raises(sqlite3.Error, match="quota"):
        repository.receive_publications([publication], [edit])
    with pytest.raises(ValueError, match="missing-target"):
        repository.read(root["id"])
    assert repository.receipt(publication["libraryBatch"]["id"]) is None
    with connection() as db:
        db.execute("DROP TRIGGER fail_first_edit")
    repository.receive_publications([publication], [edit])
    assert repository.read(root["id"])["heads"] == [edit["id"]]
    assert repository.pending_publications() == []
    assert repository.pending() == []
    wrong = deepcopy(publication)
    wrong["content"]["content"] = "different initial content"
    with pytest.raises(ValueError, match="publication-id-reused"):
        repository.receive_publications([wrong])


def test_a_publication_waits_for_its_catalog_parent_without_exposing_its_item(setup):
    repository, _, scope = setup
    publication = deepcopy(FIXTURE["publications"][2]["value"])
    parent_id = "00000000-0000-0000-0000-000000009998"
    publication["libraryBatch"]["parents"] = [parent_id]
    repository.receive_publications([publication])
    state = repository.read(scope["libraryId"])
    assert state["heads"] == [FIXTURE["library"]["version"]]
    assert state["waiting"] == [publication["libraryBatch"]["id"]]
    parent = {"kind": "library", "id": parent_id, "libraryId": scope["libraryId"], "targetId": scope["libraryId"], "parents": [FIXTURE["library"]["version"]],
              "changes": [{"type": "put-folder", "folder": {"id": "00000000-0000-0000-0000-000000009997", "title": "folder", "parentId": None, "position": 0}}]}
    repository.receive([parent])
    assert repository.read(scope["libraryId"])["heads"] == [publication["libraryBatch"]["id"]]
    assert repository.read(publication["content"]["id"])["checkpoint"]["root"] == publication["content"]


def test_child_edit_arrives_before_creation_and_survives_restart_without_an_exposed_item(setup):
    repository, connection, scope = setup
    publication = FIXTURE["publications"][2]["value"]
    edit = {"kind": "markdown", "imageResources": [], "id": "00000000-0000-0000-0000-000000009996", "libraryId": scope["libraryId"], "targetId": publication["content"]["id"],
            "parents": [publication["content"]["version"]], "content": "child arrived first"}
    repository.receive([edit])
    with pytest.raises(ValueError, match="missing-target"):
        repository.read(edit["targetId"])
    assert repository.read(scope["libraryId"])["heads"] == [FIXTURE["library"]["version"]]
    restarted = core_repository(connection, scope)
    assert restarted.receipt(edit["id"])["durable"]
    restarted.receive_publications([publication])
    assert restarted.read(edit["targetId"])["heads"] == [edit["id"]]
    assert restarted.read(scope["libraryId"])["heads"] == [publication["libraryBatch"]["id"]]
