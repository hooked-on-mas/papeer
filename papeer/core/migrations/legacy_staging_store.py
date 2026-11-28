"""Staging store of the Native legacy conversion (work B7-c, DESIGN-r161-b7-staging.md 3.2-3.3, 4, 5.2-5.4).

A staging is ONE SQLite file, `<Library parent>/.<Library name>-shared-app-staging/<runId>/content.sqlite3`, beside the Library and
apart from the canonical store (`.<name>-shared-app/`) and the backups (`.<name>-shared-app-backups/`). It holds the existing
canonical edit schema (the 11 `edit_*` tables, written only through `SqliteEditRepository` and the allowlisted authority below)
and the `migration_staging_*` tables of this module: the run row (with the whole sealed B6 manifest), the plan, the converted
roots before assembly, the old-to-new ID table, the provenance and the verification result.

Nothing here converts anything and nothing here is called from a route, the CLI or startup (callers are tests only). It never
opens the Library, the canonical store or a backup. No dataset control record is ever written: a staging has no active pointer,
and the authority below refuses every operation that would edit, publish or install it.

`staging_status` is read-only (SQLite `mode=ro`; a WAL database opened that way can create or rewrite its `-shm` file inside the
staging folder, nothing else). It classifies a run's folder as absent / uninitialized / resumable / staged / orphaned, and
everything it cannot classify as `diagnostic-required` with closed reason codes; it never repairs, deletes or advances anything.

Refusals are `ValueError('staging-<reason>')` with the closed reasons below (no path, text or exception text). No `ValueError`
subclass is defined here (tests/test_sidecar_errors.py).
"""
from __future__ import annotations

from contextlib import closing, contextmanager
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import sqlite3
import stat

from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_contracts import validate_id
from papeer.core.edit_model import canonical_json
from papeer.core.edit_repository import initialize_edit_schema

VERSION = 1
SCOPE = 'native-legacy-staging-v1'
STATUS_SCOPE = 'native-legacy-staging-status-v1'
MANIFEST_SCOPE = 'native-legacy-conversion-input-v1'      # sidecar/migrations/conversion_input.SCOPE (a test pins the equality)
CONVERTER_VERSION = 'b7-v1'                                  # also the TypeScript converter's version (B7-e); a test pins the equality
DB_NAME = 'content.sqlite3'
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
# `publishable` is not a phase and cannot be stored (CHECK constraint): B7 never produces a publishable staging (5.5).
PHASES = ('initialized', 'resources', 'planned', 'units', 'assembled', 'verified', 'staged')
EDIT_TABLES = ('edit_roots', 'edit_batches', 'edit_projections', 'edit_projection_pages', 'edit_publications', 'edit_resources',
               'edit_resource_bytes', 'edit_checkpoints', 'edit_intents', 'edit_datasets', 'edit_dataset_controls')
STAGING_TABLES = ('migration_staging_run', 'migration_staging_plan', 'migration_staging_units', 'migration_staging_ids',
                  'migration_staging_provenance', 'migration_staging_verification')
# Rows here would mean a user edit, an intent, a publication, an installed dataset or a control record: never in a staging.
FORBIDDEN_ROW_TABLES = ('edit_batches', 'edit_intents', 'edit_publications', 'edit_datasets', 'edit_dataset_controls')

# Every operation name `SqliteEditRepository` asks its authority for (a test scans the source so that a new one cannot appear unnoticed).
REPOSITORY_OPERATIONS = frozenset({
    'read', 'receipt', 'pending', 'pending-records', 'pending-publications', 'intent', 'pending-intents', 'checkpoint', 'datasets',
    'dataset-control', 'read-resource', 'resource-metadata',
    'commit', 'publish', 'replace-intent', 'store-resource', 'initialize', 'install-checkpoint', 'install-dataset',
    'replace-dataset-control', 'receive-records', 'acknowledge-upload'})
# The only operations a staging allows (DESIGN 4.2): resources and the one assembled checkpoint go in; reads come out. Roots are
# never installed one at a time (`initialize`), so a half-assembled Library cannot be read (5.5 item 3).
ALLOWED_OPERATIONS = frozenset({
    'store-resource', 'install-checkpoint', 'checkpoint', 'read', 'read-resource', 'resource-metadata', 'datasets', 'dataset-control'})
# The two operations that write, and the only phases in which each is allowed (work B7-f; REVIEW-r161-b7c low 2): a resource goes in
# only before every resource is there, the one checkpoint only once every unit is there. `bundled` steps run only for these two.
WRITE_PHASES = {'store-resource': ('initialized',), 'install-checkpoint': ('units',)}
# The only phases in which the old-to-new ID and provenance rows may still be written (work B7-g; REVIEW-r161-b7f low 2): a resource's own rows
# (`initialized`) and the plan's rows (`resources`, moving to `planned`). From `planned` on they are fixed; a sealed (`staged`) run is never written.
ID_ROW_PHASES = ('initialized', 'resources')

_P = 'staging-'
REASONS = tuple(_P + name for name in (
    'busy', 'shutdown-pending', 'cancelled', 'capacity-exceeded', 'disk-insufficient', 'state-unavailable', 'source-changed',
    'library-lock-unavailable', 'other-writer-present', 'instance-writer-unverified', 'input-changed', 'converter-changed',
    'plan-changed', 'unit-conflict', 'id-changed', 'id-collision', 'resource-mismatch', 'verification-failed',
    'provenance-incomplete', 'diagnostic-required', 'orphaned', 'operation-denied', 'not-publishable', 'unavailable',
    # Added by work B7-f: the rows of the Library cannot be listed (nothing can be staged), and the converter's plan did not
    # agree with the writer's own independent counts (nothing was written).
    'rows-not-listable', 'plan-rejected'))
# Closed reasons of a `diagnostic-required` status (never an exception text or a path).
DIAGNOSTIC_REASONS = (
    'link-refused', 'unexpected-entries', 'database-unreadable', 'quick-check-failed', 'schema-mismatch', 'foreign-key-violation',
    'run-row-missing', 'run-row-invalid', 'manifest-invalid', 'phase-mismatch', 'plan-invalid', 'unit-plan-mismatch',
    'multiple-checkpoints', 'checkpoint-mismatch', 'verification-invalid', 'foreign-scope', 'forbidden-rows', 'duplicate-rows',
    'unreadable')
_HEX64 = re.compile(r'^[0-9a-f]{64}$')
_CURRENT = object()


class _Diagnostic(Exception):     # not a ValueError: it never leaves this module
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _check_run_id(value):
    """A run ID is the preparation's UUID; anything else is one closed refusal (the text is never echoed)."""
    try:
        validate_id(value)
    except (ValueError, TypeError):
        raise ValueError(_P + 'state-unavailable') from None


# ----- locations ---------------------------------------------------------------------------------
def staging_base(root):
    """`.<name>-shared-app-staging` beside the Library folder (never inside it, never the canonical or backup folder)."""
    source = Path(root).resolve()
    if not source.name:
        raise ValueError(_P + 'state-unavailable')
    return source.with_name('.' + source.name + '-shared-app-staging')


def staging_folder(root, run_id):
    _check_run_id(run_id)
    return staging_base(root) / run_id


def staging_scope(account_id, library_id, run_id):
    """The dataset scope of a run: the epoch is derived from the run ID, never random (so a resume has the same scope)."""
    _check_run_id(run_id)
    _check_run_id(library_id)
    if type(account_id) is not str or not 1 <= len(account_id) <= 200:
        raise ValueError(_P + 'state-unavailable')
    return {'accountId': account_id, 'libraryId': library_id, 'epoch': 'legacy-' + run_id}


def _namespace(scope):
    return json.dumps([scope['accountId'], scope['libraryId'], scope['epoch']], ensure_ascii=False, separators=(',', ':'))


def _kind(path):
    """None (absent), 'dir', 'file', 'link' (symlink, junction or any reparse point) or 'other'; never follows a link."""
    try:
        value = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(value.st_mode) or getattr(value, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 1024):
        return 'link'
    return 'dir' if stat.S_ISDIR(value.st_mode) else 'file' if stat.S_ISREG(value.st_mode) else 'other'


# ----- schema ------------------------------------------------------------------------------------
def _staging_ddl():
    phases = ','.join(f"'{name}'" for name in PHASES)
    return (
        'CREATE TABLE IF NOT EXISTS migration_staging_run (run_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version=1), '
        'scope TEXT NOT NULL, manifest TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, journal_record_sha256 TEXT NOT NULL, '
        'input_set_sha256 TEXT NOT NULL, converter_version TEXT NOT NULL, '
        f'phase TEXT NOT NULL CHECK(phase IN ({phases})), plan_sha256 TEXT, checkpoint_sha256 TEXT, report_sha256 TEXT)',
        'CREATE TABLE IF NOT EXISTS migration_staging_plan (run_id TEXT PRIMARY KEY REFERENCES migration_staging_run(run_id), '
        'plan TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS migration_staging_units (run_id TEXT NOT NULL REFERENCES migration_staging_run(run_id), '
        'seq INTEGER NOT NULL, unit_kind TEXT NOT NULL, target_id TEXT NOT NULL, payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL, '
        'PRIMARY KEY(run_id,unit_kind,target_id), UNIQUE(run_id,seq))',
        'CREATE TABLE IF NOT EXISTS migration_staging_ids (run_id TEXT NOT NULL REFERENCES migration_staging_run(run_id), '
        'kind TEXT NOT NULL, source_key TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY(run_id,kind,source_key), '
        'UNIQUE(run_id,target_id))',
        'CREATE TABLE IF NOT EXISTS migration_staging_provenance (run_id TEXT NOT NULL REFERENCES migration_staging_run(run_id), '
        'target_kind TEXT NOT NULL, target_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_key TEXT NOT NULL, '
        'source_sha256 TEXT NOT NULL, converter_version TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, '
        'PRIMARY KEY(run_id,target_kind,target_id))',
        'CREATE TABLE IF NOT EXISTS migration_staging_verification (run_id TEXT PRIMARY KEY REFERENCES migration_staging_run(run_id), '
        'report TEXT NOT NULL, report_sha256 TEXT NOT NULL)')


def initialize_staging_schema(db):
    """The edit schema plus the staging tables; the caller owns the write transaction (idempotent DDL)."""
    initialize_edit_schema(db)
    for statement in _staging_ddl():
        db.execute(statement)


_EXPECTED_SCHEMA = None


def _schema_of(db):
    # `LIKE 'sqlite_%'` would also skip names such as `sqlitex_hidden` (`_` matches any character): REVIEW-r161-b7c low 1.
    rows = db.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_'").fetchall()
    return {(kind, name): (table, sql) for kind, name, table, sql in rows}


def expected_schema():
    """What `initialize_staging_schema` makes (built once in memory): every table, index, view and trigger of a staging."""
    global _EXPECTED_SCHEMA
    if _EXPECTED_SCHEMA is None:
        with closing(sqlite3.connect(':memory:')) as db:
            initialize_staging_schema(db)
            _EXPECTED_SCHEMA = _schema_of(db)
    return _EXPECTED_SCHEMA


# ----- connection --------------------------------------------------------------------------------
def _database_path(root, run_id, *, create):
    """Folder and database path of a run, links refused; `create` makes the staging root and the run folder (nothing else)."""
    folder = staging_folder(root, run_id)
    base = folder.parent
    for path, make in ((base, create), (folder, create)):
        kind = _kind(path)
        if kind is None and make:
            path.mkdir(mode=0o700, exist_ok=True)
            kind = _kind(path)
        if kind is None:
            raise ValueError(_P + 'state-unavailable')
        if kind != 'dir':
            raise ValueError(_P + 'diagnostic-required')
    path = folder / DB_NAME
    kind = _kind(path)
    if kind not in (None, 'file'):
        raise ValueError(_P + 'diagnostic-required')
    if kind is None and not create:
        raise ValueError(_P + 'state-unavailable')
    return path


@contextmanager
def staging_connection(root, run_id, *, create=False):
    """One write transaction on the staging DB: WAL, synchronous=FULL, foreign keys; commit on success, rollback on any error.

    `create` (only the first initialization) makes the staging root and the run folder; nothing is created otherwise.
    """
    path = _database_path(root, run_id, create=create)
    with closing(sqlite3.connect(path, timeout=30, isolation_level=None)) as db:
        try:
            if db.execute('PRAGMA journal_mode=WAL').fetchone() != ('wal',):
                raise ValueError(_P + 'unavailable')
            db.execute('PRAGMA synchronous=FULL')
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('BEGIN IMMEDIATE')
        except sqlite3.DatabaseError:
            raise ValueError(_P + 'diagnostic-required') from None      # not a database (an SQLite error while opening)
        try:
            yield db
        except BaseException:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        db.execute('COMMIT')


@contextmanager
def _readonly(root, run_id):
    path = _database_path(root, run_id, create=False)
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=30, isolation_level=None)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')              # one snapshot for all the checks of a status
        try:
            yield db
        finally:
            if db.in_transaction:
                db.execute('ROLLBACK')


# ----- authority ---------------------------------------------------------------------------------
class StagingAuthority:
    """The only authority a staging repository gets: an allowlist of operations and exactly one dataset scope.

    `current` (a callable that returns when the admission that created this authority is still valid and raises otherwise,
    normally the sidecar's token and hold check) is called before a transaction opens and again before it commits.
    """

    def __init__(self, root, run_id, scope, current):
        _check_run_id(run_id)
        try:
            valid = (type(scope) is dict and set(scope) == {'accountId', 'libraryId', 'epoch'} and callable(current)
                     and scope == staging_scope(scope['accountId'], scope['libraryId'], run_id))
        except (ValueError, TypeError):
            valid = False
        if not valid:
            raise ValueError(_P + 'operation-denied')
        self._root, self._run_id, self._scope, self._current = root, run_id, deepcopy(scope), current
        self._steps = []

    def assert_current(self):
        self._current()

    @contextmanager
    def bundled(self, step):
        """While active, `step(operation, db)` runs inside every WRITING transaction (`store-resource`, `install-checkpoint`), after the
        repository's own work and before the commit: the writer's way to write the old-to-new ID and provenance rows in the SAME
        transaction as a resource or a checkpoint (DESIGN 5.1 D). A step that raises rolls the whole transaction back. Steps are for
        one writer thread; they nest. Reads never run a step (REVIEW-r161-b7c low 3).
        """
        if not callable(step):
            raise ValueError(_P + 'operation-denied')
        self._steps.append(step)
        try:
            yield
        finally:
            self._steps.remove(step)

    def _open(self, db):
        row = db.execute('SELECT scope, phase FROM migration_staging_run WHERE run_id=?', (self._run_id,)).fetchone()
        if row is None or row[0] != canonical_json(self._scope):
            raise ValueError(_P + 'state-unavailable')       # not the DB this authority was made for
        return row[1]

    @staticmethod
    def _assert_no_forbidden_rows(db):
        """A write that left a user edit, an intent, a publication, a dataset or a control record behind never commits (low 3 and 4)."""
        for table in FORBIDDEN_ROW_TABLES:
            if db.execute(f'SELECT 1 FROM {table} LIMIT 1').fetchone() is not None:
                raise ValueError(_P + 'operation-denied')

    @contextmanager
    def transaction(self, operation, scope):
        if type(operation) is not str or operation not in ALLOWED_OPERATIONS or scope != self._scope:
            raise ValueError(_P + 'operation-denied')
        self.assert_current()
        with staging_connection(self._root, self._run_id) as db:
            phase = self._open(db)
            writes = operation in ('store-resource', 'install-checkpoint')
            if operation in WRITE_PHASES and phase not in WRITE_PHASES[operation]:
                raise ValueError(_P + 'operation-denied')
            yield db
            if writes:
                for step in tuple(self._steps):
                    step(operation, db)
                self._assert_no_forbidden_rows(db)
            self.assert_current()

    @contextmanager
    def write(self):
        """One transaction of the writer's own rows (plan, units, phase, verification, seal): checked before it opens and before it commits."""
        self.assert_current()
        with staging_connection(self._root, self._run_id) as db:
            if self._open(db) == PHASES[-1]:
                raise ValueError(_P + 'operation-denied')       # a sealed staging is never written again (work B7-g)
            yield db
            self._assert_no_forbidden_rows(db)
            self.assert_current()


# ----- run row and manifest ----------------------------------------------------------------------
def assert_manifest(manifest, run_id):
    """The sealed B6 manifest of this run: shape, literal refusal of the whole Library and the recomputed manifestSha256."""
    try:
        validate_id(run_id)
        if (type(manifest) is not dict or manifest.get('version') != 1 or manifest.get('scope') != MANIFEST_SCOPE
                or manifest.get('runId') != run_id):
            raise ValueError('manifest')
        validate_id(manifest['libraryId'])
        if not all(type(manifest.get(key)) is str and _HEX64.fullmatch(manifest[key])
                   for key in ('journalRecordSha256', 'inputSetSha256', 'manifestSha256')):
            raise ValueError('manifest')
        whole = manifest.get('wholeLibrary')
        if type(whole) is not dict or whole.get('status') != 'refused':
            raise ValueError('manifest')
        if edit_content_hash({key: value for key, value in manifest.items() if key != 'manifestSha256'}) != manifest['manifestSha256']:
            raise ValueError('manifest')
        if len(canonical_json(manifest).encode('utf-8')) > MAX_MANIFEST_BYTES:
            raise ValueError('manifest')
    except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
        raise ValueError(_P + 'input-changed') from None


def initialize_run(root, run_id, *, account_id, manifest):
    """T_init: the staging folder, the schema and the run row (with the whole manifest) in ONE transaction; phase `initialized`.

    Only for a folder without a database or with a database that has no table (P1, DESIGN 5.2). A database that has any table is
    never initialized again here (a resume reads the run row; anything else is `diagnostic-required`).
    """
    assert_manifest(manifest, run_id)
    scope = staging_scope(account_id, manifest['libraryId'], run_id)
    with staging_connection(root, run_id, create=True) as db:
        try:
            has_tables = db.execute('SELECT COUNT(*) FROM sqlite_master').fetchone()[0]
        except sqlite3.DatabaseError:
            raise ValueError(_P + 'diagnostic-required') from None
        if has_tables:
            raise ValueError(_P + 'diagnostic-required')
        initialize_staging_schema(db)
        db.execute('INSERT INTO migration_staging_run VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)',
                   (run_id, VERSION, canonical_json(scope), canonical_json(manifest), manifest['manifestSha256'],
                    manifest['journalRecordSha256'], manifest['inputSetSha256'], CONVERTER_VERSION, PHASES[0]))
    return {'runId': run_id, 'scope': scope, 'manifest': deepcopy(manifest), 'manifestSha256': manifest['manifestSha256'],
            'journalRecordSha256': manifest['journalRecordSha256'], 'inputSetSha256': manifest['inputSetSha256'],
            'converterVersion': CONVERTER_VERSION, 'phase': PHASES[0], 'planSha256': None, 'checkpointSha256': None,
            'reportSha256': None}


def _optional_hash(value):
    if value is not None and not (type(value) is str and _HEX64.fullmatch(value)):
        raise _Diagnostic('run-row-invalid')
    return value


def _read_run(db, run_id):
    """The validated run row (a public record) or None when there is no row; any oddity is a diagnostic."""
    rows = db.execute('SELECT run_id, version, scope, manifest, manifest_sha256, journal_record_sha256, input_set_sha256, '
                      'converter_version, phase, plan_sha256, checkpoint_sha256, report_sha256 FROM migration_staging_run').fetchall()
    if not rows:
        return None
    if len(rows) != 1:
        raise _Diagnostic('run-row-invalid')
    (identifier, version, scope, manifest, manifest_hash, journal, input_set, converter, phase, plan, checkpoint, report) = rows[0]
    if (identifier != run_id or type(version) is not int or version != VERSION or phase not in PHASES
            or not all(type(value) is str for value in (scope, manifest, manifest_hash, journal, input_set, converter))
            or not converter or not all(type(value) is str and _HEX64.fullmatch(value) for value in (manifest_hash, journal, input_set))):
        raise _Diagnostic('run-row-invalid')
    plan, checkpoint, report = _optional_hash(plan), _optional_hash(checkpoint), _optional_hash(report)
    try:
        manifest_value, scope_value = json.loads(manifest), json.loads(scope)
        assert_manifest(manifest_value, run_id)
    except (ValueError, TypeError, RecursionError):
        raise _Diagnostic('manifest-invalid') from None
    if (manifest_value['manifestSha256'] != manifest_hash or manifest_value['journalRecordSha256'] != journal
            or manifest_value['inputSetSha256'] != input_set):
        raise _Diagnostic('manifest-invalid')
    try:
        expected_scope = staging_scope(scope_value.get('accountId') if type(scope_value) is dict else None, manifest_value['libraryId'], run_id)
    except (ValueError, TypeError):
        raise _Diagnostic('run-row-invalid') from None
    if scope_value != expected_scope or canonical_json(scope_value) != scope:
        raise _Diagnostic('run-row-invalid')
    return {'runId': run_id, 'scope': scope_value, 'manifest': manifest_value, 'manifestSha256': manifest_hash,
            'journalRecordSha256': journal, 'inputSetSha256': input_set, 'converterVersion': converter, 'phase': phase,
            'planSha256': plan, 'checkpointSha256': checkpoint, 'reportSha256': report}


def read_run_record(root, run_id):
    """The run row of an existing staging (read-only), or ValueError('staging-state-unavailable' / '-diagnostic-required')."""
    try:
        with _readonly(root, run_id) as db:
            record = _read_run(db, run_id)
    except _Diagnostic:
        raise ValueError(_P + 'diagnostic-required') from None
    except sqlite3.Error:
        raise ValueError(_P + 'diagnostic-required') from None
    if record is None:
        raise ValueError(_P + 'diagnostic-required')
    return record


def assert_resumable(record, manifest, *, converter_version=CONVERTER_VERSION, plan_sha256=None):
    """Same run, same manifest (rebuilt from the run, not trusted from the row), same converter, same plan: else nothing is written."""
    assert_manifest(manifest, record['runId'])
    if (manifest != record['manifest'] or manifest['manifestSha256'] != record['manifestSha256']
            or manifest['journalRecordSha256'] != record['journalRecordSha256'] or manifest['inputSetSha256'] != record['inputSetSha256']):
        raise ValueError(_P + 'input-changed')
    if converter_version != record['converterVersion']:
        raise ValueError(_P + 'converter-changed')
    if plan_sha256 is not None and record['planSha256'] is not None and plan_sha256 != record['planSha256']:
        raise ValueError(_P + 'plan-changed')


# ----- the writer's rows (work B7-f, DESIGN 4.1, 5.1, 5.5) ---------------------------------------------
# Every helper takes the `db` of one transaction the caller opened with `StagingAuthority.write()` (or a `bundled` step) and changes the
# phase in the SAME transaction as the rows that justify it. A helper only moves a phase forward from the one phase it expects: a
# phase is never skipped and never set back (`staging-operation-denied` otherwise), and the rows of an earlier phase are never rewritten.
def advance_phase(db, run_id, source, target, **fields):
    names = {'plan_sha256', 'checkpoint_sha256', 'report_sha256'}
    if source not in PHASES or target not in PHASES or PHASES.index(target) != PHASES.index(source) + 1 or set(fields) - names:
        raise ValueError(_P + 'operation-denied')
    if not all(type(value) is str and _HEX64.fullmatch(value) for value in fields.values()):
        raise ValueError(_P + 'operation-denied')
    sets = ''.join(f', {name}=?' for name in fields)
    cursor = db.execute(f'UPDATE migration_staging_run SET phase=?{sets} WHERE run_id=? AND phase=?', (target, *fields.values(), run_id, source))
    if cursor.rowcount != 1:
        raise ValueError(_P + 'operation-denied')


def _phase(db, run_id):
    row = db.execute('SELECT phase FROM migration_staging_run WHERE run_id=?', (run_id,)).fetchone()
    if row is None:
        raise ValueError(_P + 'state-unavailable')
    return row[0]


def put_ids(db, run_id, ids):
    """Old-to-new IDs (DESIGN 3.4). The same (kind, source) with the same target is kept as it is; another target for it is `-id-changed`,
    another source for a target is `-id-collision`. Nothing is overwritten. Only in `ID_ROW_PHASES` (work B7-g)."""
    if _phase(db, run_id) not in ID_ROW_PHASES:
        raise ValueError(_P + 'operation-denied')
    for entry in ids:
        if type(entry) is not dict or set(entry) != {'kind', 'source', 'targetId'} or type(entry['kind']) is not str or type(entry['targetId']) is not str:
            raise ValueError(_P + 'id-collision')
        source = canonical_json(entry['source'])
        old = db.execute('SELECT target_id FROM migration_staging_ids WHERE run_id=? AND kind=? AND source_key=?',
                         (run_id, entry['kind'], source)).fetchone()
        if old is not None:
            if old[0] != entry['targetId']:
                raise ValueError(_P + 'id-changed')
            continue
        try:
            db.execute('INSERT INTO migration_staging_ids VALUES(?,?,?,?)', (run_id, entry['kind'], source, entry['targetId']))
        except sqlite3.IntegrityError:
            raise ValueError(_P + 'id-collision') from None


def put_provenance(db, run_id, rows, *, manifest_sha256):
    """Provenance rows (DESIGN 3.5), one per (target kind, target ID); the run's manifest and the converter version are written by this
    function, never taken from the caller. Only in `ID_ROW_PHASES` (work B7-g)."""
    if _phase(db, run_id) not in ID_ROW_PHASES:
        raise ValueError(_P + 'operation-denied')
    for row in rows:
        if (type(row) is not dict or set(row) != {'targetKind', 'targetId', 'sourceKind', 'sourceKey', 'sourceSha256'}
                or not all(type(row[key]) is str for key in ('targetKind', 'targetId', 'sourceKind', 'sourceSha256'))):
            raise ValueError(_P + 'provenance-incomplete')
        values = (run_id, row['targetKind'], row['targetId'], row['sourceKind'], canonical_json(row['sourceKey']), row['sourceSha256'],
                  CONVERTER_VERSION, manifest_sha256)
        old = db.execute('SELECT * FROM migration_staging_provenance WHERE run_id=? AND target_kind=? AND target_id=?', values[:3]).fetchone()
        if old is not None:
            if tuple(old) != values:
                raise ValueError(_P + 'id-changed')
            continue
        db.execute('INSERT INTO migration_staging_provenance VALUES(?,?,?,?,?,?,?,?)', values)


def put_plan(db, run_id, plan_row, ids, provenance, *, manifest_sha256):
    """T_plan: the plan row, the ID table and the provenance of every content object, and phase `resources` -> `planned`."""
    if _phase(db, run_id) != 'resources':
        raise ValueError(_P + 'operation-denied')
    if type(plan_row) is not dict or type(plan_row.get('units')) is not list:
        raise ValueError(_P + 'plan-changed')
    plan_hash = edit_content_hash(plan_row)
    db.execute('INSERT INTO migration_staging_plan VALUES(?,?)', (run_id, canonical_json(plan_row)))
    put_ids(db, run_id, ids)
    put_provenance(db, run_id, provenance, manifest_sha256=manifest_sha256)
    advance_phase(db, run_id, 'resources', 'planned', plan_sha256=plan_hash)
    return plan_hash


def put_unit(db, run_id, unit):
    """T_unit: one converted root. It must be exactly the unit the stored plan lists (seq, kind, target, payload hash); an identical
    row already there is kept, a different one is `-unit-conflict`. The last unit moves the phase `planned` -> `units`."""
    if _phase(db, run_id) != 'planned':
        raise ValueError(_P + 'operation-denied')
    plan = json.loads(db.execute('SELECT plan FROM migration_staging_plan WHERE run_id=?', (run_id,)).fetchone()[0])
    if type(unit) is not dict:
        raise ValueError(_P + 'unit-conflict')
    payload = unit.get('payload')
    entry = {'seq': unit.get('seq'), 'unitKind': unit.get('unitKind'), 'targetId': unit.get('targetId'), 'payloadSha256': unit.get('payloadSha256')}
    if entry not in plan['units'] or type(payload) is not dict or edit_content_hash(payload) != entry['payloadSha256']:
        raise ValueError(_P + 'unit-conflict')
    old = db.execute('SELECT seq, payload_sha256 FROM migration_staging_units WHERE run_id=? AND unit_kind=? AND target_id=?',
                     (run_id, entry['unitKind'], entry['targetId'])).fetchone()
    if old is not None:
        if tuple(old) != (entry['seq'], entry['payloadSha256']):
            raise ValueError(_P + 'unit-conflict')
    else:
        try:
            db.execute('INSERT INTO migration_staging_units VALUES(?,?,?,?,?,?)',
                       (run_id, entry['seq'], entry['unitKind'], entry['targetId'], canonical_json(payload), entry['payloadSha256']))
        except sqlite3.IntegrityError:
            raise ValueError(_P + 'unit-conflict') from None
    if db.execute('SELECT COUNT(*) FROM migration_staging_units WHERE run_id=?', (run_id,)).fetchone()[0] == len(plan['units']):
        advance_phase(db, run_id, 'planned', 'units')


def mark_assembled(db, run_id, scope, checkpoint_sha256):
    """T_asm: the one checkpoint is installed (`edit_checkpoints` has its hash); phase `units` -> `assembled`."""
    if db.execute('SELECT 1 FROM edit_checkpoints WHERE scope=? AND sha256=?', (_namespace(scope), checkpoint_sha256)).fetchone() is None:
        raise ValueError(_P + 'operation-denied')
    advance_phase(db, run_id, 'units', 'assembled', checkpoint_sha256=checkpoint_sha256)


def put_verification(db, run_id, report):
    """T_ver: the verification result (the staging report without its own hash); phase `assembled` -> `verified`."""
    if _phase(db, run_id) != 'assembled':
        raise ValueError(_P + 'operation-denied')
    db.execute('INSERT INTO migration_staging_verification VALUES(?,?,?)', (run_id, canonical_json(report), edit_content_hash(report)))
    advance_phase(db, run_id, 'assembled', 'verified')


def seal_run(db, run_id):
    """T_seal: phase `verified` -> `staged`, the report hash is the verification row's. Nothing is written after this."""
    row = db.execute('SELECT report_sha256 FROM migration_staging_verification WHERE run_id=?', (run_id,)).fetchone()
    if row is None:
        raise ValueError(_P + 'operation-denied')
    advance_phase(db, run_id, 'verified', 'staged', report_sha256=row[0])
    return row[0]


def read_writer_rows(root, run_id):
    """Everything the writer stored outside the edit tables (read-only): the run record, the plan row, the units (payloads), the ID
    table, the provenance and the verification row. For the verification and the report, never for a decision about the old data."""
    try:
        with _readonly(root, run_id) as db:
            record = _read_run(db, run_id)
            if record is None:
                raise ValueError(_P + 'diagnostic-required')
            plan = db.execute('SELECT plan FROM migration_staging_plan WHERE run_id=?', (run_id,)).fetchone()
            verification = db.execute('SELECT report, report_sha256 FROM migration_staging_verification WHERE run_id=?', (run_id,)).fetchone()
            return {
                'record': record, 'plan': None if plan is None else json.loads(plan[0]),
                'units': [{'seq': seq, 'unitKind': kind, 'targetId': target, 'payload': json.loads(payload), 'payloadSha256': sha}
                          for seq, kind, target, payload, sha in db.execute(
                              'SELECT seq, unit_kind, target_id, payload, payload_sha256 FROM migration_staging_units WHERE run_id=? ORDER BY seq', (run_id,))],
                'ids': [{'kind': kind, 'source': json.loads(source), 'targetId': target} for kind, source, target in db.execute(
                    'SELECT kind, source_key, target_id FROM migration_staging_ids WHERE run_id=? ORDER BY kind, source_key', (run_id,))],
                'provenance': [{'targetKind': kind, 'targetId': target, 'sourceKind': source_kind, 'sourceKey': json.loads(key), 'sourceSha256': sha,
                                'converterVersion': converter, 'manifestSha256': manifest}
                               for kind, target, source_kind, key, sha, converter, manifest in db.execute(
                                   'SELECT target_kind, target_id, source_kind, source_key, source_sha256, converter_version, manifest_sha256 '
                                   'FROM migration_staging_provenance WHERE run_id=? ORDER BY target_kind, target_id', (run_id,))],
                'verification': None if verification is None else {'report': json.loads(verification[0]), 'reportSha256': verification[1]}}
    except _Diagnostic:
        raise ValueError(_P + 'diagnostic-required') from None
    except (sqlite3.Error, ValueError, TypeError, RecursionError) as error:
        if isinstance(error, ValueError) and error.args and error.args[0] in REASONS:
            raise
        raise ValueError(_P + 'diagnostic-required') from None


def _read_rows(root, run_id, reader):
    """`reader(db, record)` on one read-only snapshot of an existing run; the closed refusals of `read_writer_rows`."""
    try:
        with _readonly(root, run_id) as db:
            record = _read_run(db, run_id)
            if record is None:
                raise ValueError(_P + 'diagnostic-required')
            return reader(db, record)
    except _Diagnostic:
        raise ValueError(_P + 'diagnostic-required') from None
    except (sqlite3.Error, ValueError, TypeError, RecursionError) as error:
        if isinstance(error, ValueError) and error.args and error.args[0] in REASONS:
            raise
        raise ValueError(_P + 'diagnostic-required') from None


def read_units(root, run_id):
    """The converted roots as stored, in `seq` order, for a resume (work B7-g): `payloadSha256` is the column, `payloadComputedSha256` the
    hash of the stored text itself (so that a payload changed under an unchanged column is visible)."""
    def reader(db, _record):
        rows = db.execute('SELECT seq, unit_kind, target_id, payload, payload_sha256 FROM migration_staging_units WHERE run_id=? ORDER BY seq', (run_id,)).fetchall()
        return [{'seq': seq, 'unitKind': kind, 'targetId': target, 'payloadSha256': sha, 'payloadComputedSha256': edit_content_hash(json.loads(payload))}
                for seq, kind, target, payload, sha in rows]
    return _read_rows(root, run_id, reader)


def read_checkpoint_hashes(root, run_id):
    """The hashes of the checkpoints installed in the run's own staging namespace (a resume at P7 finds the one it made), sorted."""
    def reader(db, record):
        return sorted(row[0] for row in db.execute('SELECT sha256 FROM edit_checkpoints WHERE scope=?', (_namespace(record['scope']),)))
    return _read_rows(root, run_id, reader)


def read_staged_report(root, run_id):
    """The report of a `staged` run (the verification row's report plus its hash); any other phase is `staging-state-unavailable`."""
    rows = read_writer_rows(root, run_id)
    verification = rows['verification']
    if (rows['record']['phase'] != PHASES[-1] or verification is None or rows['record']['reportSha256'] != verification['reportSha256']
            or edit_content_hash(verification['report']) != verification['reportSha256']):
        raise ValueError(_P + 'state-unavailable')
    return {**verification['report'], 'reportSha256': verification['reportSha256']}


# ----- status ------------------------------------------------------------------------------------
def _scalar(db, sql, *args):
    return db.execute(sql, args).fetchone()[0]


def _counts(db, namespace, run_id):
    return {
        'resources': _scalar(db, 'SELECT COUNT(*) FROM edit_resources WHERE scope=?', namespace),
        'resourceBytes': _scalar(db, 'SELECT COALESCE(SUM(LENGTH(payload)),0) FROM edit_resource_bytes WHERE scope=?', namespace),
        'roots': _scalar(db, 'SELECT COUNT(*) FROM edit_roots WHERE scope=?', namespace),
        'checkpoints': _scalar(db, 'SELECT COUNT(*) FROM edit_checkpoints WHERE scope=?', namespace),
        'plan': _scalar(db, 'SELECT COUNT(*) FROM migration_staging_plan WHERE run_id=?', run_id),
        'units': _scalar(db, 'SELECT COUNT(*) FROM migration_staging_units WHERE run_id=?', run_id),
        'ids': _scalar(db, 'SELECT COUNT(*) FROM migration_staging_ids WHERE run_id=?', run_id),
        'provenance': _scalar(db, 'SELECT COUNT(*) FROM migration_staging_provenance WHERE run_id=?', run_id),
        'verification': _scalar(db, 'SELECT COUNT(*) FROM migration_staging_verification WHERE run_id=?', run_id)}


def _plan_units(db, run_id, record, bad):
    """The plan's unit list (or None), with the plan hash checked; problems go to `bad`."""
    row = db.execute('SELECT plan FROM migration_staging_plan WHERE run_id=?', (run_id,)).fetchone()
    if row is None:
        return None
    try:
        plan = json.loads(row[0])
        units = plan['units']
        if (type(row[0]) is not str or type(units) is not list or edit_content_hash(plan) != record['planSha256']
                or not all(type(unit) is dict and {'seq', 'unitKind', 'targetId', 'payloadSha256'} <= set(unit) for unit in units)):
            raise ValueError('plan')
        return {(unit['seq'], unit['unitKind'], unit['targetId'], unit['payloadSha256']) for unit in units}, len(units)
    except (ValueError, TypeError, KeyError, RecursionError):
        bad.add('plan-invalid')
        return None


def _consistency(db, run_id, record, counts, bad):
    """Phase and row counts must agree (DESIGN 5.3); anything else is a diagnostic, never a resume."""
    rank = PHASES.index(record['phase'])
    planned, units_done, assembled, verified, staged = (PHASES.index(name) for name in ('planned', 'units', 'assembled', 'verified', 'staged'))
    if (counts['plan'] == 1) != (rank >= planned) or (record['planSha256'] is not None) != (rank >= planned):
        bad.add('phase-mismatch')
    plan = _plan_units(db, run_id, record, bad) if counts['plan'] == 1 and rank >= planned else None
    if rank < planned and counts['units']:
        bad.add('phase-mismatch')
    if plan is not None:
        expected, total = plan
        rows = {tuple(row) for row in db.execute('SELECT seq, unit_kind, target_id, payload_sha256 FROM migration_staging_units WHERE run_id=?', (run_id,))}
        if not rows <= expected or counts['units'] > total or (rank >= units_done and counts['units'] != total):
            bad.add('unit-plan-mismatch')
    if counts['checkpoints'] > 1:
        bad.add('multiple-checkpoints')
    elif rank < units_done and (counts['checkpoints'] or counts['roots']):
        bad.add('phase-mismatch')                       # roots enter the staging namespace only in the one assembly transaction
    elif counts['roots'] and not counts['checkpoints']:
        bad.add('phase-mismatch')
    elif counts['checkpoints'] and not counts['roots']:
        bad.add('checkpoint-mismatch')                  # a checkpoint row is written together with the roots it installs
    elif rank >= assembled:
        stored = db.execute('SELECT sha256 FROM edit_checkpoints WHERE scope=?', (_namespace(record['scope']),)).fetchone()
        if counts['checkpoints'] != 1 or not counts['roots'] or record['checkpointSha256'] is None or stored is None or stored[0] != record['checkpointSha256']:
            bad.add('checkpoint-mismatch')
    elif record['checkpointSha256'] is not None:
        bad.add('checkpoint-mismatch')
    if (counts['verification'] == 1) != (rank >= verified):
        bad.add('verification-invalid')
    elif counts['verification'] == 1:
        row = db.execute('SELECT report, report_sha256 FROM migration_staging_verification WHERE run_id=?', (run_id,)).fetchone()
        try:
            if (type(row[0]) is not str or type(row[1]) is not str or not _HEX64.fullmatch(row[1])
                    or edit_content_hash(json.loads(row[0])) != row[1]):
                raise ValueError('verification')
        except (ValueError, RecursionError):
            bad.add('verification-invalid')
    if (record['reportSha256'] is not None) != (rank == staged):
        bad.add('phase-mismatch')


def _classify(root, run_id):
    """(state, phase, counts, reasons) of one run folder; read-only."""
    base = staging_base(root)
    folder = base / run_id
    for path, kinds in ((base, (None, 'dir')), (folder, (None, 'dir'))):
        kind = _kind(path)
        if kind is None:
            return 'absent', None, None, []
        if kind not in kinds:
            return 'diagnostic-required', None, None, ['link-refused' if kind == 'link' else 'unexpected-entries']
    names = set(os.listdir(folder))
    if names - {DB_NAME, DB_NAME + '-wal', DB_NAME + '-shm'}:
        return 'diagnostic-required', None, None, ['unexpected-entries']
    kinds = {name: _kind(folder / name) for name in names}
    if any(kind == 'link' for kind in kinds.values()):
        return 'diagnostic-required', None, None, ['link-refused']
    if any(kind != 'file' for kind in kinds.values()):
        return 'diagnostic-required', None, None, ['unexpected-entries']
    if DB_NAME not in names:
        return ('uninitialized', None, None, []) if not names else ('diagnostic-required', None, None, ['unexpected-entries'])
    record, counts, bad = None, None, set()
    try:
        with _readonly(root, run_id) as db:
            if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                return 'diagnostic-required', None, None, ['quick-check-failed']
            actual = _schema_of(db)
            if not actual:
                return 'uninitialized', None, None, []
            if actual != expected_schema():
                return 'diagnostic-required', None, None, ['schema-mismatch']
            try:
                record = _read_run(db, run_id)
            except _Diagnostic as error:
                return 'diagnostic-required', None, None, [error.reason]
            if record is None:
                return 'diagnostic-required', None, None, ['run-row-missing']
            namespace = _namespace(record['scope'])
            if db.execute('PRAGMA foreign_key_check').fetchall():
                bad.add('foreign-key-violation')
            for table in EDIT_TABLES:
                if table == 'edit_dataset_controls':
                    continue
                if _scalar(db, f'SELECT COUNT(*) FROM {table} WHERE scope IS NOT ?', namespace):
                    bad.add('foreign-scope')
            for table in STAGING_TABLES[1:]:
                if _scalar(db, f'SELECT COUNT(*) FROM {table} WHERE run_id IS NOT ?', run_id):
                    bad.add('foreign-scope')
            if any(_scalar(db, f'SELECT COUNT(*) FROM {table}') for table in FORBIDDEN_ROW_TABLES):
                bad.add('forbidden-rows')
            if (_scalar(db, 'SELECT COUNT(*) FROM (SELECT 1 FROM migration_staging_ids GROUP BY run_id, target_id HAVING COUNT(*) > 1)')
                    or _scalar(db, 'SELECT COUNT(*) FROM (SELECT 1 FROM migration_staging_provenance GROUP BY run_id, target_kind, target_id HAVING COUNT(*) > 1)')):
                bad.add('duplicate-rows')
            counts = _counts(db, namespace, run_id)
            _consistency(db, run_id, record, counts, bad)
    except sqlite3.DatabaseError:
        return 'diagnostic-required', None, None, ['database-unreadable']
    except OSError:
        return 'diagnostic-required', None, None, ['unreadable']
    if record is None or counts is None:
        return 'diagnostic-required', None, None, ['unreadable']
    if bad:
        return 'diagnostic-required', record['phase'], counts, sorted(bad)
    return ('staged' if record['phase'] == PHASES[-1] else 'resumable'), record['phase'], counts, []


def staging_status(root, run_id, *, hold_run_id=_CURRENT):
    """Read-only classification of one run's staging (DESIGN 5.2, 5.3): never a path, text or exception text.

    state: `absent` (no folder), `uninitialized` (folder without a database, or a database without a table: P1), `resumable` (a run
    row and consistent counts; `phase` says where), `staged` (phase `staged` and everything consistent: the only complete state),
    `diagnostic-required` (anything that cannot be classified; `reasons` are closed codes) and `orphaned` (a staging that exists
    for a run that is not the hold's run: only when `hold_run_id` is given and differs; read, never deleted; `underlying` is the
    classification it would otherwise have). `complete` is true only for `staged`.
    """
    _check_run_id(run_id)
    state, phase, counts, reasons = _classify(root, run_id)
    result = {'version': VERSION, 'scope': STATUS_SCOPE, 'runId': run_id, 'state': state, 'phase': phase,
              'complete': state == 'staged', 'counts': counts, 'reasons': reasons}
    if hold_run_id is not _CURRENT and hold_run_id != run_id and state != 'absent':
        result.update(state='orphaned', underlying=state, complete=False)
    return result


def staging_runs(root):
    """The run folders under the staging root (names only): {'runIds': [...], 'unexpected': <count of other entries>}; read-only."""
    base = staging_base(root)
    kind = _kind(base)
    if kind is None:
        return {'runIds': [], 'unexpected': 0}
    if kind != 'dir':
        raise ValueError(_P + 'diagnostic-required')
    run_ids, unexpected = [], 0
    for name in sorted(os.listdir(base)):
        try:
            validate_id(name)
            valid = _kind(base / name) == 'dir'
        except ValueError:
            valid = False
        if valid:
            run_ids.append(name)
        else:
            unexpected += 1
    return {'runIds': run_ids, 'unexpected': unexpected}
