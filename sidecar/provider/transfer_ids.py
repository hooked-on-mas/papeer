"""Durable physical Drive IDs in the existing host-only provider artifacts store."""
import hashlib
import json
import re
from papeer.core.edit_model import canonical_json
from papeer.core.edits.provider.activation import assert_provider_schema
from sidecar.canonical_host import _provider_proof


class TransferIds:
    def __init__(self, owner, host):
        self._owner, self._host = owner, host

    def _key(self, scope, kind, logical_id):
        value = canonical_json([scope, kind, logical_id]).encode('utf8')
        return 'transfer:' + hashlib.sha256(value).hexdigest()

    def _read(self, db, key, expected):
        row = db.execute('SELECT payload FROM canonical_provider_artifacts WHERE owner=? AND request_id=?', (self._owner.namespace, key)).fetchone()
        if not row: return None
        value = json.loads(row[0])
        if (set(value) != {'version', 'scope', 'kind', 'logicalId', 'digest', 'ids'} or value['version'] != 1
                or any(value[k] != expected[k] for k in ('scope', 'kind', 'logicalId', 'digest'))
                or not isinstance(value['ids'], list) or len(value['ids']) != expected['count']
                or len(set(value['ids'])) != len(value['ids'])
                or any(not isinstance(item, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', item) for item in value['ids'])):
            raise ValueError('provider-transfer-id-conflict')
        return value['ids']

    def ensure(self, kind, logical_id, digest, count):
        if kind not in {'record', 'resource', 'receipt'} or count != (2 if kind == 'resource' else 1): raise ValueError('provider-transfer-invalid')
        if not re.fullmatch(r'[0-9a-f-]{73}' if kind == 'receipt' else r'[0-9a-f-]{36}', logical_id) or not re.fullmatch(r'[0-9a-f]{64}', digest): raise ValueError('provider-transfer-invalid')
        scope = self._owner.assert_admitted(); expected = {'scope': scope, 'kind': kind, 'logicalId': logical_id, 'digest': digest, 'count': count}
        key = self._key(scope, kind, logical_id)
        with self._owner.transaction('provider-read') as db:
            assert_provider_schema(db); _provider_proof(db, self._owner, scope)
            prior = self._read(db, key, expected)
        if prior is not None: return prior
        with self._owner.provider_guard(self._host):
            allocated = self._host.allocate_file_ids(count)
        if (not isinstance(allocated, list) or len(allocated) != count or len(set(allocated)) != count
                or any(not isinstance(item, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', item) for item in allocated)):
            raise ValueError('provider-allocation-invalid')
        self._owner.assert_admitted()
        with self._owner.transaction('provider-prepare') as db:
            assert_provider_schema(db); _provider_proof(db, self._owner, scope)
            prior = self._read(db, key, expected)
            if prior is not None: return prior
            value = {'version': 1, 'scope': scope, 'kind': kind, 'logicalId': logical_id, 'digest': digest, 'ids': allocated}
            db.execute('INSERT INTO canonical_provider_artifacts VALUES(?,?,?)', (self._owner.namespace, key, canonical_json(value)))
        return allocated
