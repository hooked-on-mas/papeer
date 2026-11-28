"""Host-local durable evidence, not an authentication credential."""
import re
from uuid import uuid4

_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')

def assert_local_owner_grant(value):
    if (not isinstance(value, dict) or set(value) != {'version','kind','contextId','namespaceId','revision'}
            or type(value['version']) is not int or value['version'] != 1 or value['kind'] != 'local-created'
            or any(not isinstance(value[key], str) or not _ID.fullmatch(value[key]) for key in ('contextId','namespaceId','revision'))):
        raise ValueError('recovery-required')

def make_local_owner_grant(make_id=lambda: str(uuid4())):
    value = {'version':1, 'kind':'local-created', 'contextId':make_id(), 'namespaceId':make_id(), 'revision':make_id()}
    assert_local_owner_grant(value)
    return value
