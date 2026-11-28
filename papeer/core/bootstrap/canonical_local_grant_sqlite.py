"""Explicit fixed-context provision and readonly discovery in the canonical SQLite file.

The host supplies a fixed path inside its already-authorized storage root. This
module does not issue leases, open libraries, or infer authority from IDs.
"""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from papeer.core.bootstrap.canonical_local_grant import assert_local_owner_grant, make_local_owner_grant

_KEY = 'primary-local-context'
_GRANT = 'canonical_local_owner_grants'

def _tables(db):
    return {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}

def _occupied(db, tables):
    # Identifiers originate in SQLite itself, not caller input. Count every canonical
    # table, including partial states and unknown future canonical/edit tables.
    for name in tables:
        if name != _GRANT and (name.startswith('edit_') or name.startswith('canonical_')):
            if db.execute('SELECT 1 FROM "' + name.replace('"','""') + '" LIMIT 1').fetchone(): return True
    return False

def _grant(db):
    columns = db.execute('PRAGMA table_info(canonical_local_owner_grants)').fetchall()
    if (len(columns) != 2 or columns[0][1:3] != ('key','TEXT') or columns[0][5] != 1
            or columns[1][1:3] != ('payload','TEXT') or columns[1][3] != 1 or columns[1][5] != 0):
        raise ValueError('recovery-required')
    rows = db.execute('SELECT key,payload FROM canonical_local_owner_grants LIMIT 2').fetchall()
    if not rows: return None
    if len(rows) != 1 or rows[0][0] != _KEY: raise ValueError('recovery-required')
    try: value = json.loads(rows[0][1]); assert_local_owner_grant(value)
    except (TypeError, ValueError): raise ValueError('recovery-required') from None
    return value

def _refuse_link(path):
    if path.is_symlink() or path.is_junction() or path.parent.is_symlink() or path.parent.is_junction():
        raise ValueError('recovery-required')

def discover_local_grant(path):
    path = Path(path)
    try:
        _refuse_link(path)
        if not path.exists(): return {'status':'setup-required','reason':'absent'}
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=0)) as db:
            db.execute('BEGIN'); tables = _tables(db)
            grant = _grant(db) if _GRANT in tables else None
            if grant: return {'status':'ready','grant':grant}
            if _occupied(db,tables): return {'status':'recovery-required','reason':'ungranted-canonical-state'}
            return {'status':'setup-required','reason':'schema-upgrade' if _GRANT not in tables else 'absent'}
    except sqlite3.OperationalError as error:
        if getattr(error, 'sqlite_errorcode', None) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
            return {'status':'blocked','reason':'database-busy'}
        return {'status':'recovery-required','reason':'storage-error'}
    except (sqlite3.DatabaseError, ValueError): return {'status':'recovery-required','reason':'invalid-grant'}

def provision_local_grant(path, make_id=None):
    path = Path(path); _refuse_link(path)
    # The host must prepare its fixed parent; creating arbitrary directory trees is
    # outside this operation. BEGIN IMMEDIATE serializes both winner and occupancy.
    with closing(sqlite3.connect(path, timeout=30)) as db:
        try:
            db.execute('BEGIN IMMEDIATE'); tables = _tables(db)
            if _GRANT in tables:
                existing = _grant(db)
                if existing: db.commit(); return existing
            if _occupied(db,tables): raise ValueError('recovery-required')
            if _GRANT not in tables:
                db.execute('CREATE TABLE canonical_local_owner_grants (key TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            grant = make_local_owner_grant() if make_id is None else make_local_owner_grant(make_id)
            db.execute('INSERT INTO canonical_local_owner_grants (key,payload) VALUES (?,?)', (_KEY,json.dumps(grant,separators=(',',':'))))
            db.commit(); return grant
        except BaseException:
            db.rollback(); raise
