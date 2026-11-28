"""Canonical provider bytes validation: validated data never grants authority."""
from __future__ import annotations
import hashlib
import json
from papeer.core.edit_contracts import EDIT_LIMITS, validate_canonicalproviderdescriptor
from papeer.core.edit_model import canonical_json


def read_provider_descriptor_bytes(data: bytes, expected_sha256: str, expected_scope: dict):
    if not data or len(data) > EDIT_LIMITS['providerDescriptorBytes'] or len(expected_sha256) != 64 or any(c not in '0123456789abcdef' for c in expected_sha256):
        raise ValueError('provider-descriptor-size-or-hash')
    if data.startswith(b'\xef\xbb\xbf'):
        raise ValueError('provider-descriptor-bom')
    try:
        text = data.decode('utf-8', errors='strict')
        value = json.loads(text)
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError('provider-descriptor-json') from exc
    validate_canonicalproviderdescriptor(value)
    if canonical_json(value) != text:
        raise ValueError('provider-descriptor-noncanonical')
    if value['scope'] != expected_scope:
        raise ValueError('provider-descriptor-scope')
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_sha256:
        raise ValueError('provider-descriptor-hash')
    return {'descriptor': value, 'sha256': digest}
