"""Synthetic GET-only Drive for Python/native HTTP acceptance, never used by application startup."""
import base64
from copy import deepcopy
import io
import re
from urllib.parse import parse_qs, urlsplit


class FixtureLegacyDrive:
    def __init__(self, fixture):
        self.fixture = deepcopy(fixture)
        self.calls = []

    def json(self, url):
        self.calls.append(url)
        parts = urlsplit(url)
        params = parse_qs(parts.query)
        if parts.path.endswith("/about"):
            return {"user": {"permissionId": self.fixture["identity"]["accountId"]}}
        if parts.path.endswith("/files"):
            query = params["q"][0]
            properties = re.findall(r"key='([^']+)' and value='([^']+)'", query)
            parent = re.search(r"'([^']+)' in parents", query)
            files = [deepcopy(value["metadata"]) for _, value in sorted(self.fixture["objects"].items())
                     if not value["metadata"]["trashed"] and all(value["metadata"]["properties"].get(k) == v for k, v in properties)
                     and (not parent or parent[1] in value["metadata"]["parents"])]
            offset = int(params.get("pageToken", ["0"])[0])
            # Deliberately smaller than the requested 1000, including short/empty lists.
            return {"files": files[offset:offset + 2], "incompleteSearch": self.fixture.get("incompleteSearch", False),
                    **({"nextPageToken": str(offset + 2)} if offset + 2 < len(files) else {})}
        return deepcopy(self.fixture["objects"][parts.path.rsplit("/", 1)[1]]["metadata"])

    def request(self, url):
        self.calls.append(url)
        assert parse_qs(urlsplit(url).query).get("alt") == ["media"]
        return io.BytesIO(base64.b64decode(self.fixture["objects"][urlsplit(url).path.rsplit("/", 1)[1]]["dataBase64"]))
