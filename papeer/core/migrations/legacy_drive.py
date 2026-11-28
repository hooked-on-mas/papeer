"""Authenticated read-only Drive I/O for the shared migration source collector."""
from urllib.parse import urlencode

from papeer.core.cloud_drive import API, Drive
from papeer.core.edit_drive import drive_id

FIELDS = "id,name,mimeType,version,size,sha256Checksum,parents,properties,trashed"


def _id(value):
    value = drive_id(value)
    if len(value) > 200:
        raise ValueError("invalid-drive-id")
    return value


class LegacyDriveRead:
    def __init__(self, drive=None):
        self.drive = drive or Drive()

    def account(self):
        value = self.drive.json(API.removesuffix("/files") + "/about?fields=user(permissionId)")
        identity = value.get("user", {}).get("permissionId")
        if not isinstance(identity, str) or not identity or len(identity) > 200:
            raise ValueError("backup-drive-account")
        return identity

    def metadata(self, identity):
        return self.drive.json(API + "/" + _id(identity) + "?" + urlencode({"fields": FIELDS, "supportsAllDrives": "true"}))

    def _list(self, query):
        files, token, seen = [], None, set()
        while True:
            params = {"q": query + " and trashed = false", "fields": "nextPageToken,incompleteSearch,files(" + FIELDS + ")",
                      "pageSize": "1000", "corpora": "user", "spaces": "drive", "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}
            if token:
                params["pageToken"] = token
            page = self.drive.json(API + "?" + urlencode(params))
            if page.get("incompleteSearch") is True or not isinstance(page.get("files"), list):
                raise ValueError("backup-drive-incomplete-list")
            files.extend(page["files"])
            token = page.get("nextPageToken")
            if token is None:
                return files
            if not isinstance(token, str) or not token or token in seen:
                raise ValueError("backup-drive-pagination")
            seen.add(token)

    def children(self, folder_id):
        return self._list("'" + _id(folder_id) + "' in parents")

    def library_files(self, library_id, kind):
        if kind not in ("ink-v1", "notes-v1", "note-blob-v1"):
            raise ValueError("backup-drive-operation-kind")
        return self._list("properties has { key='papeer' and value='" + kind + "' } and "
                          "properties has { key='library' and value='" + _id(library_id) + "' }")

    def read(self, identity):
        with self.drive.request(API + "/" + _id(identity) + "?alt=media&supportsAllDrives=true") as response:
            return response.read()
