"""Native authenticated Drive I/O for the shared TypeScript edit transfer.

No import, adoption, outbox, or retry policy lives here. EditReplication and
adapters/drive/editTransfer.ts own those rules for both hosts.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import tempfile
import threading

from papeer.core.cloud_drive import API, Drive
from papeer.core.edits.resources import assert_resource_metadata
from papeer.core.fileio import atomic_write_bytes


def scope_namespace(scope):
    if set(scope) != {"accountId", "libraryId", "epoch"} or any(not isinstance(v, str) or not v for v in scope.values()):
        raise ValueError("empty-scope")
    value = json.dumps([scope["accountId"], scope["libraryId"], scope["epoch"]], ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def drive_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[\w-]+", value, flags=re.ASCII):
        raise ValueError("invalid-drive-id")
    return value


class DriveEditStorage:
    def __init__(self, scope, folder_id, drive=None, lease_id=None):
        self.namespace = scope_namespace(scope)
        self.folder_id = drive_id(folder_id)
        self.drive = drive or Drive(account_id=scope["accountId"], lease_id=lease_id)
        if lease_id is None:
            self.drive = self.drive.bind_account(scope["accountId"])

    def _query(self, kind):
        return ("properties has { key='papeer' and value='" + kind + "' } and "
                "properties has { key='scope' and value='" + self.namespace + "' }")

    def files(self):
        return [{"id": drive_id(file["id"]), "version": file.get("version"), "kind": file.get("properties", {}).get("editKind")} for file in self.drive.list(self._query("edits-v1"))]

    def _metadata(self, file_id, kind):
        file_id = drive_id(file_id)
        metadata = self.drive.json(API + "/" + file_id + "?fields=size,properties")
        properties = metadata.get("properties", {})
        if properties.get("papeer") != kind or properties.get("scope") != self.namespace:
            raise ValueError("resource-scope-or-version")
        return metadata

    def read_json(self, file_id):
        self._metadata(file_id, "edits-v1")
        return self.drive.json(API + "/" + drive_id(file_id) + "?alt=media")

    def _upload(self, data, name, media_type, properties):
        # The existing native uploader bounds network chunks and validates the
        # resumable URL before sending credentials. A stopped process may leave
        # an unreferenced immutable object; retry never overwrites another peer.
        with tempfile.TemporaryDirectory(prefix="papeer-edit-") as directory:
            path = Path(directory) / "payload"
            atomic_write_bytes(path, data)
            return drive_id(self.drive.upload(path, {"name": name, "parents": [self.folder_id],
                            "mimeType": media_type, "properties": properties}, threading.Event()))

    def upload_json(self, edit_id, value):
        if not isinstance(edit_id, str) or not re.fullmatch(r"[0-9a-f-]{36,73}", edit_id):
            raise ValueError("invalid-edit-object-id")
        self._upload(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                     "edit-" + edit_id + ".json", "application/json", {"papeer": "edits-v1", "scope": self.namespace, "editKind": value.get("kind", "")})

    def read_resource(self, metadata, blob_id):
        assert_resource_metadata(metadata)
        header = self._metadata(blob_id, "edits-resource-v1")
        if header.get("properties", {}).get("sha256") != metadata["sha256"] or str(header.get("size")) != str(metadata["byteLength"]):
            raise ValueError("resource-scope-or-version")
        with self.drive.request(API + "/" + drive_id(blob_id) + "?alt=media") as response:
            data = response.read(metadata["byteLength"] + 1)
        if len(data) != metadata["byteLength"] or hashlib.sha256(data).hexdigest() != metadata["sha256"]:
            raise ValueError("resource-hash")
        self.drive.assert_current()
        return data

    def save_resource(self, metadata, data):
        assert_resource_metadata(metadata)
        if len(data) != metadata["byteLength"] or hashlib.sha256(data).hexdigest() != metadata["sha256"]:
            raise ValueError("resource-hash")
        query = self._query("edits-resource-v1") + " and properties has { key='sha256' and value='" + metadata["sha256"] + "' }"
        blob_id = None
        for file in self.drive.list(query):
            try:
                self.read_resource(metadata, file["id"])
            except ValueError:
                continue  # Damaged immutable candidate: keep it, try another or upload a fresh body.
            blob_id = file["id"]
            break
        if blob_id is None:
            blob_id = self._upload(data, "resource-" + metadata["sha256"], "application/octet-stream",
                                   {"papeer": "edits-resource-v1", "scope": self.namespace, "sha256": metadata["sha256"]})
        self.upload_json(metadata["id"], {"kind": "resource", "metadata": metadata, "blobId": blob_id})
