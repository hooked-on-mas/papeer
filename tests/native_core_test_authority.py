"""Test-only Core harness, not a host lease or production authorization.

Existing low-level storage tests may use this explicit purpose to test edit and
migration semantics without claiming bearer, owner, or transaction admission.
"""
from contextlib import contextmanager
from papeer.core.edit_repository import initialize_edit_schema
from papeer.core.bootstrap.canonical_initialization_sqlite import initialize_canonical_metadata

_READ = {'read','receipt','pending','pending-records','pending-publications','intent','pending-intents','checkpoint','datasets','dataset-control','read-resource','resource-metadata','bootstrap-list','bootstrap-query','bootstrap-snapshot'}
_WRITE = {'commit','publish','replace-intent','store-resource','initialize','install-checkpoint','install-dataset','replace-dataset-control','receive-records','acknowledge-upload','bootstrap-peer','bootstrap-prepare','bootstrap-execute','bootstrap-acknowledge'}

def provision_for_core_test(connection):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        initialize_edit_schema(db); initialize_canonical_metadata(db)

class CoreTestAuthority:
    def __init__(self, connection, account_id):
        self._connection = connection
        self.account_id = account_id
        self.current = True

    def assert_current(self):
        if not self.current: raise ValueError('lease-expired')

    @contextmanager
    def transaction(self, operation, scope=None):
        if operation not in _READ | _WRITE: raise ValueError('operation-denied')
        self.assert_current()
        with self._connection() as db:
            db.execute('BEGIN IMMEDIATE' if operation in _WRITE else 'BEGIN')
            yield db
            self.assert_current()


def core_repository(connection, scope):
    """Test-only replacement for the former ``SqliteEditRepository(connection, scope)`` fixtures.

    The schema is provisioned explicitly (idempotent DDL, as a restart would find it) and every
    repository transaction enters the Core harness above. This is not a host lease or owner admission.
    """
    from papeer.core.edit_repository import SqliteEditRepository
    provision_for_core_test(connection)
    return SqliteEditRepository(CoreTestAuthority(connection, scope['accountId']), scope)
