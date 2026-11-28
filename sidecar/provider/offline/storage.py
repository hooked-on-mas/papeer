"""Existing provider-artifacts table, with a disjoint non-UUID owner domain. No DDL."""
import json
from papeer.core.edit_model import canonical_json
from papeer.core.edits.provider.activation import assert_provider_schema
from .crypto import identifier, fail

TAG = 'host-offline-v1'
MAX_ROWS = 130
MAX_TOTAL_BYTES = 4 * 1024 * 1024
MAX_RECORD_BYTES = 400000


class VaultCapacityExceeded(ValueError):
    pass


def _raw_rows(db, context):
    return db.execute('SELECT request_id,payload FROM canonical_provider_artifacts WHERE owner=? ORDER BY request_id LIMIT ?',
                      (owner_key(context), MAX_ROWS + 1)).fetchall()


def _fits(rows):
    if len(rows) > MAX_ROWS: return False
    total = 0
    for _record_id, raw in rows:
        if type(raw) is not str: return False
        size = len(raw.encode('utf8'))
        if size > MAX_RECORD_BYTES: return False
        total += size
    return total <= MAX_TOTAL_BYTES


def _before_write(db, context, changes):
    current = _raw_rows(db, context)
    if not _fits(current): fail()
    rows = dict(current)
    for record_id, raw in changes.items():
        if raw is None: rows.pop(record_id, None)
        else: rows[record_id] = raw
    if not _fits(list(rows.items())): raise VaultCapacityExceeded('offline-capacity-exceeded')


def owner_key(context):
    return canonical_json([TAG, identifier(context)])


def key(context, kind, record_id):
    if kind not in ('header', 'counter', 'grant', 'pending'): fail()
    return canonical_json([TAG, identifier(context), kind, identifier(record_id)])


def read(db, context):
    assert_provider_schema(db)
    rows = _raw_rows(db, context)
    if not _fits(rows): fail()
    result = {'header': None, 'counter': None, 'grants': {}, 'pending': {}}
    for raw_key, raw in rows:
        try: parsed = json.loads(raw_key)
        except (ValueError, TypeError): fail()
        if (type(parsed) is not list or len(parsed) != 4 or parsed[:2] != [TAG, context]
                or parsed[2] not in ('header', 'counter', 'grant', 'pending') or type(raw) is not str or len(raw.encode('utf8')) > MAX_RECORD_BYTES): fail()
        identifier(parsed[3])
        if raw_key != key(context, parsed[2], parsed[3]): fail()
        if parsed[2] in ('grant', 'pending'): result['grants' if parsed[2] == 'grant' else 'pending'][parsed[3]] = raw
        else:
            if parsed[3] != context or result[parsed[2]] is not None: fail()
            result[parsed[2]] = raw
    if (result['header'] is None) != (result['counter'] is None): fail()
    if result['header'] is None and (result['grants'] or result['pending']): fail()
    if set(result['grants']) & set(result['pending']): fail()
    return result


def insert(db, context, kind, record_id, value):
    raw = canonical_json(value)
    _before_write(db, context, {key(context, kind, record_id): raw})
    db.execute('INSERT INTO canonical_provider_artifacts(owner,request_id,payload) VALUES(?,?,?)',
               (owner_key(context), key(context, kind, record_id), raw))


def reserve(db, context, expected_raw, replacement):
    raw = canonical_json(replacement)
    _before_write(db, context, {key(context, 'counter', context): raw})
    changed = db.execute('UPDATE canonical_provider_artifacts SET payload=? WHERE owner=? AND request_id=? AND payload=?',
                         (raw, owner_key(context), key(context, 'counter', context), expected_raw)).rowcount
    if changed != 1: fail()


def remove(db, context, record_id, expected_raw):
    changed = db.execute('DELETE FROM canonical_provider_artifacts WHERE owner=? AND request_id=? AND payload=?',
                         (owner_key(context), key(context, 'grant', record_id), expected_raw)).rowcount
    if changed != 1: fail()


def promote(db, context, record_id, raw):
    """Atomic exact-cipher move, with no transient row-count overshoot."""
    _before_write(db, context, {key(context, 'pending', record_id): None, key(context, 'grant', record_id): raw})
    changed = db.execute('DELETE FROM canonical_provider_artifacts WHERE owner=? AND request_id=? AND payload=?',
                         (owner_key(context), key(context, 'pending', record_id), raw)).rowcount
    if changed != 1: fail()
    # The source is deleted first inside the same transaction; rollback restores
    # it if the insertion fails. Stored ciphertext is copied byte-for-byte.
    _before_write(db, context, {key(context, 'grant', record_id): raw})
    db.execute('INSERT INTO canonical_provider_artifacts(owner,request_id,payload) VALUES(?,?,?)',
               (owner_key(context), key(context, 'grant', record_id), raw))


def remove_permission(db, context, kind, record_id, raw):
    if kind not in ('grant', 'pending'): fail()
    changed = db.execute('DELETE FROM canonical_provider_artifacts WHERE owner=? AND request_id=? AND payload=?',
                         (owner_key(context), key(context, kind, record_id), raw)).rowcount
    if changed != 1: fail()
