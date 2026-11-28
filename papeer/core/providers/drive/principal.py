"""Shared domain-separated principal digest, independent from canonical scope UUIDs."""
import hashlib
import json


def google_drive_principal_digest(permission_id: str) -> str:
    if (not isinstance(permission_id, str) or not permission_id or len(permission_id) > 200
            or any(ord(char) <= 0x20 or ord(char) == 0x7f or 0xd800 <= ord(char) <= 0xdfff for char in permission_id)):
        raise ValueError('drive-principal-invalid')
    encoded = json.dumps(['papeer.provider.principal.v1', 'google-drive', 'drive.permissionId', permission_id],
                         ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()
