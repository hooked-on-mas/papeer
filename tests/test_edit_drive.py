"""Native transport interoperates with the Web wire format; it owns no replication policy."""
import base64
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import re

from fastapi.testclient import TestClient
import pytest

from papeer.core.edit_drive import DriveEditStorage, scope_namespace
from sidecar import deps
from sidecar.app import app
from sidecar.routes import edits

FIXTURES = Path(__file__).parent / "fixtures"
FIXTURE = json.loads((FIXTURES / "shared-edits.json").read_text("utf-8"))
METADATA = FIXTURE["resource"]["metadata"]
DATA = (FIXTURES / FIXTURE["resource"]["file"]).read_bytes()
SCOPE = {"accountId": "日本語-account", "libraryId": FIXTURE["libraryId"], "epoch": "new-dataset"}


class MemoryDrive:
    def __init__(self):
        self.objects = {}
        self.fail_after_upload = False
        self.binary_reads = 0

    def assert_current(self):
        pass

    def bind_account(self, account_id):
        if account_id != SCOPE['accountId']:
            raise ValueError('drive-account-mismatch')
        return self

    def list(self, query):
        properties = re.findall(r"key='([^']+)' and value='([^']+)'", query)
        return [{"id": key, "size": str(len(value[1]))} for key, value in self.objects.items()
                if all(value[0]["properties"].get(k) == v for k, v in properties)]

    def json(self, url):
        key = url.split("/")[-1].split("?")[0]
        metadata, data = self.objects[key]
        if "alt=media" in url:
            return json.loads(data)
        return {"size": str(len(data)), "properties": metadata["properties"]}

    def request(self, url):
        key = url.split("/")[-1].split("?")[0]
        self.binary_reads += 1
        return io.BytesIO(self.objects[key][1])

    def upload(self, path, metadata, cancel):
        assert not cancel.is_set()
        key = "file-" + str(len(self.objects))
        self.objects[key] = (deepcopy(metadata), path.read_bytes())
        if self.fail_after_upload:
            self.fail_after_upload = False
            raise ValueError("response-lost")
        return key


def test_native_storage_preserves_web_envelopes_and_epoch_namespace():
    drive = MemoryDrive()
    storage = DriveEditStorage(SCOPE, "folder", drive)
    expected = hashlib.sha256(json.dumps(list(SCOPE.values()), ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    assert storage.namespace == expected
    storage.save_resource(METADATA, DATA)
    publication = FIXTURE["publications"][0]["value"]
    storage.upload_json(publication["libraryBatch"]["id"], {"kind": "edit-record", "record": {"batch": publication["libraryBatch"], "publication": publication}})
    values = [storage.read_json(file["id"]) for file in storage.files()]
    assert [value["kind"] for value in values] == ["resource", "edit-record"]
    assert values[1]["record"]["publication"] == FIXTURE["publications"][0]["value"]
    descriptor = values[0]
    assert storage.read_resource(descriptor["metadata"], descriptor["blobId"]) == DATA
    for header, _ in drive.objects.values():
        assert header["parents"] == ["folder"]
        assert header["properties"]["scope"] == expected
    assert DriveEditStorage({**SCOPE, "epoch": "other"}, "folder", drive).files() == []
    with pytest.raises(ValueError, match="drive-account-mismatch"):
        DriveEditStorage({**SCOPE, "accountId": "other"}, "folder", drive)
    with pytest.raises(ValueError, match="scope-or-version"):
        DriveEditStorage({**SCOPE, "epoch": "other"}, "folder", drive).read_json(storage.files()[0]["id"])


def test_lost_resource_response_retry_and_damage_never_rebind_or_delete():
    drive = MemoryDrive()
    storage = DriveEditStorage(SCOPE, "folder", drive)
    drive.fail_after_upload = True
    with pytest.raises(ValueError, match="response-lost"):
        storage.save_resource(METADATA, DATA)
    assert storage.files() == []  # No descriptor before the body is durable.
    storage.save_resource(METADATA, DATA)
    body_keys = lambda: [key for key, (header, _) in drive.objects.items() if header["properties"]["papeer"] == "edits-resource-v1"]
    assert len(body_keys()) == 1
    corrupt = body_keys()[0]
    header, _ = drive.objects[corrupt]
    drive.objects[corrupt] = (header, b"x" * len(DATA))
    with pytest.raises(ValueError, match="resource-hash"):
        storage.read_resource(METADATA, corrupt)
    storage.save_resource(METADATA, DATA)
    assert len(body_keys()) == 2
    assert corrupt in drive.objects
    descriptor = storage.read_json(storage.files()[-1]["id"])
    assert storage.read_resource(METADATA, descriptor["blobId"]) == DATA
    before = len(drive.objects)
    with pytest.raises(ValueError, match="resource-hash"):
        storage.save_resource(METADATA, b"wrong")
    assert len(drive.objects) == before


def test_native_transport_authentication_and_payload_validation(monkeypatch):
    # D2 closes the seven Drive endpoints at the route dependency until a provider grant exists ("provider-unconfigured").
    # The wire round trip is exercised on the transport itself; the authenticated routes must never reach it.
    drive = MemoryDrive()
    monkeypatch.setattr(edits, "drive_storage", lambda body: DriveEditStorage(body.scope.model_dump(), body.folderId, drive))
    storage = DriveEditStorage(SCOPE, "folder", drive)
    storage.save_resource(METADATA, DATA)
    file_id = storage.files()[0]["id"]
    descriptor = storage.read_json(file_id)
    assert storage.read_resource(METADATA, descriptor["blobId"]) == DATA
    saved = deepcopy(drive.objects)
    body = {"scope": SCOPE, "folderId": "folder", "leaseId": "fixture-lease"}
    with TestClient(app) as client:
        assert client.post("/api/edits/drive/files", json=body).status_code == 401
        monkeypatch.setattr(deps, "get_auth_token", lambda: "drive-route-token")
        auth = {"Authorization": "Bearer drive-route-token"}
        requests = [("save-resource", {**body, "metadata": METADATA, "dataBase64": base64.b64encode(DATA).decode("ascii")}),
                    ("files", body), ("read-json", {**body, "fileId": file_id}),
                    ("read-resource", {**body, "metadata": METADATA, "blobId": descriptor["blobId"]}),
                    ("files", {**body, "folderId": "bad'query"}), ("read-json", {**body, "fileId": "../outside"}),
                    ("save-json", {**body, "editId": "bad", "value": {}}), ("lease", {"scope": SCOPE, "folderId": "folder"}),
                    ("check-lease", body)]
        for route, payload in requests:
            response = client.post("/api/edits/drive/" + route, json=payload, headers=auth)
            assert response.status_code == 403 and response.json() == {"detail": "provider-unconfigured"}, route
    assert drive.objects == saved


@pytest.mark.parametrize("scope", [{}, {**SCOPE, "extra": "no"}, {**SCOPE, "epoch": ""}])
def test_invalid_scope_cannot_address_a_remote_namespace(scope):
    with pytest.raises(ValueError, match="empty-scope"):
        scope_namespace(scope)
