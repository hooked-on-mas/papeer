"""Conversion input of the Native legacy backup, read-only (work B6-c).

Connects the pure inventory (papeer.core.migrations.legacy_inventory) to the registered preparation
run and to the existing Notebook extractor. It reads the three registered backups (their SQLite files
through one verified, disposable working copy, see below), classifies every table, column, file and
directory, counts the rows of each Notebook independently of the extractor, runs the extractor, and checks
that the two agree. It never writes the Library, the backups or any manifest: the only transient write is
the `.analysis-*` copy that NativeLegacyBackup always removes. The result is returned, never stored.

Admission follows the Notebook preview exactly (sidecar/migrations/preview_gate.py): one reader at a time
on the shared gate, sticky shutdown, cancellation through the token, the gate released only at the very
end of the worker. Unlike the preview it also refuses to start while any process other than this one may
hold writer rights (a foreign LibraryLock, another Library's instance files, a rewritten writer record).

Whole-Library conversion is ALWAYS refused here: WebView storage, Drive, other peers and browsers are not
collected. The refusal reasons are the work list for B7. Nothing in this module is called from a route,
the CLI or startup; callers are tests only.

Working copy and capacity (work B7-b, DESIGN-r161-b7-staging.md 7.2): the three backups are verified once each (`load`:
every object's size and sha256) and only the SQLite family of a source (the database, its -wal and -shm) is copied, once, into
one `.analysis-*` folder; the inventory, the row tables and the extraction of every Notebook share that copy (the inventory
checks its tree first, before the database is opened; an opened copy no longer equals the manifest). A Notebook's notebook.json
and a device's storage-location.json are read from their backup objects, verified as they are read. The preview's 256 MiB bound
(`notebook_preview.LIMITS`) is not used here: this module has its own `CONVERSION_LIMITS`, a free-space check before the copy
and a per-resource cap. The extractor is `notebook_projection_from_copy`, the preview's own extraction body.

Callers must check `legacy_inventory.notebooks_listable` (and so the SQLite companion files) before any
Notebook row table is read: notebook_ids and notebook_row_table do not examine the WAL themselves.
"""
from collections import Counter
from concurrent.futures import wait as wait_futures
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re

from papeer.core.edit_contracts import validate_id
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_storage import edit_storage_root
from papeer.core.instance import instance_key
from papeer.core.migrations import legacy_inventory
from papeer.core.migrations.legacy_backup import BackupReadLimits, NativeLegacyBackup, _safe_stat, sqlite_family
from papeer.core.migrations.legacy_device import NativeLegacyHeldDeviceBackup
from papeer.core.migrations.legacy_notebook_backup import (
    assert_notebook_settled, notebook_entries, notebook_projection_from_copy)
from papeer.core.migrations.legacy_staging_rows import normalize_notebook_table
from sidecar.lifecycle import instance
from . import census, notebook_preview, preparation, preview_gate

SCOPE = 'native-legacy-conversion-input-v1'
VERSION = 1
MIB = 1024 * 1024
MAX_INSTANCE_FILES = 512
MAX_EXTRACTION_BYTES = 64 * MIB     # read at call time (tests lower it)
MAX_MANIFEST_BYTES = 8 * MIB
# The bound of a conversion (read at call time; tests lower it). Unlike the preview's 256 MiB for the whole backup, it covers
# a Library with PDFs. total_bytes is a PROVISIONAL value (decision J12 is open: it needs the size of a real Library, U4):
# it bounds the time of the one verification pass over a backup, not the disk of a working copy (only the SQLite family
# is copied, and the free-space check below covers that).
CONVERSION_LIMITS = BackupReadLimits(metadata_bytes=8 * MIB, entries=100_000, total_bytes=4096 * MIB)
MAX_RESOURCE_BYTES = 512 * MIB      # one resource (a PDF) that a conversion would stage; below SQLite's 1e9 value limit
DISK_MARGIN_BYTES = 256 * MIB       # free space required beyond what the working copy needs
EXPECTED_ERRORS = notebook_preview.EXPECTED_ERRORS
_P = 'conversion-input-'
REASONS = tuple(_P + name for name in (
    'busy', 'shutdown-pending', 'cancelled', 'capacity-exceeded', 'disk-insufficient', 'state-unavailable', 'source-changed',
    'library-lock-unavailable', 'coverage-unresolved', 'instance-writer-unverified', 'instance-census-unbounded',
    'other-writer-present', 'inventory-self-check-failed', 'inventory-copy-mismatch', 'row-coverage-mismatch',
    'whole-library-refused', 'unavailable'))
_MAPPED = {
    'preview-busy': _P + 'busy', 'preview-shutdown-pending': _P + 'shutdown-pending',
    'preview-cancelled': _P + 'cancelled', 'backup-read-cancelled': _P + 'cancelled', 'inventory-cancelled': _P + 'cancelled',
    'backup-read-limit': _P + 'capacity-exceeded', 'legacy-notebook-read-limit': _P + 'capacity-exceeded',
    'inventory-capacity-exceeded': _P + 'capacity-exceeded', 'backup-disk-insufficient': _P + 'disk-insufficient',
    'preview-state-unavailable': _P + 'state-unavailable',
    'preview-source-changed': _P + 'source-changed', 'backup-source-changed': _P + 'source-changed',
    'legacy-notebook-input-changed': _P + 'source-changed',
    'inventory-self-check-failed': _P + 'inventory-self-check-failed', 'inventory-copy-mismatch': _P + 'inventory-copy-mismatch'}
# Codes of the extractor that say the state or the backup changed or is inconsistent, not that one notebook is unsupported.
_STATE_CODES = frozenset({
    'legacy-notebook-hold-mismatch', 'legacy-notebook-input-set-missing', 'legacy-notebook-input-not-unique',
    'legacy-notebook-source-mismatch', 'legacy-notebook-plan-or-manifest-mismatch',
    'legacy-notebook-full-native-backup-required', 'legacy-notebook-id-invalid'})
_BLOCK_CODE = re.compile(r'^[a-z0-9-]{1,96}$')
KINDS = legacy_inventory.KINDS


def reason_of(error):
    """Map an internal cause to the closed set of reasons; never an exception text or a path."""
    if isinstance(error, census.CoverageUnresolved):
        return _P + ('library-lock-unavailable' if str(error) == 'maintenance-lock-unavailable' else 'coverage-unresolved')
    text = str(error) if isinstance(error, ValueError) and len(error.args) == 1 else ''
    if text in REASONS:
        return text
    if text in _MAPPED:
        return _MAPPED[text]
    if notebook_preview._CAPACITY.fullmatch(text):
        return _P + 'capacity-exceeded'
    return _P + 'unavailable'


def _cancelled(token):
    if token.cancel.is_set():
        raise ValueError('preview-cancelled')


# ----- admission --------------------------------------------------------------------------------
def _assert_external_writers(selection):
    """Refuse unless this process alone can hold writer rights to the selected Library (never a caller's claim).

    Whether a stale lock file or a live writer is behind another name is NOT distinguished: another Library's
    lock is never tried (taking it could block that Library's start).
    """
    root, device = selection.root, selection.device
    if not instance.owns_library_lock(root, selection.held_lock):
        raise ValueError(_P + 'library-lock-unavailable')
    if not selection.held_lock.writer_protocol_current(root):
        raise ValueError(_P + 'instance-writer-unverified')
    folder = device / 'instances'
    _safe_stat(folder, directory=True)
    own = instance_key(root)
    allowed = {own + '.lock', own + '.json', own + '.writer-v1.json'}
    count = 0
    with os.scandir(folder) as names:
        for item in names:
            count += 1
            if count > MAX_INSTANCE_FILES:
                raise ValueError(_P + 'instance-census-unbounded')
            if item.name not in allowed:
                raise ValueError(_P + 'other-writer-present')
            _safe_stat(Path(item.path))      # a link, junction or directory under an own name is refused too


def _admission_selection():
    with preparation._entry_lock:
        owner = preparation._current
    return owner._selection if owner is not None else census.select_current()


def _selection(token):
    return token.owner._selection if token.kind == 'live' else census.select_current()


def admit(run_id):
    """Admit one reader on the shared gate, or raise ValueError('conversion-input-...') / an internal cause."""
    try:
        validate_id(run_id)
    except ValueError:
        raise ValueError(_P + 'state-unavailable') from None      # no such run; the invalid text is not echoed
    if preview_gate.gate.closed:
        raise ValueError(_P + 'shutdown-pending')
    _assert_external_writers(_admission_selection())
    return preparation.admit_preview(run_id)


# ----- worker -----------------------------------------------------------------------------------
def _block_reason(error):
    """Reason code of one unsupported notebook, or re-raise when the failure stops the whole run."""
    if reason_of(error) != _P + 'unavailable' or not isinstance(error, ValueError):
        raise error
    text = str(error)
    if text in _STATE_CODES or text.startswith('backup-'):
        raise error
    return text if _BLOCK_CODE.fullmatch(text) else 'extraction-unavailable'


def _check_rows(table, value):
    """The extractor's coverage must equal the independent row table (3.6), page by page."""
    coverage, annotations = value['coverage'], value['annotations']
    strokes = {item['pageId']: item['strokeCount'] for item in table['ink']}
    marks = Counter(item['pageId'] for item in table['bookmarks'])
    if not (value['sourceDocumentId'] == table['sourceDocumentId'] and value['entry'] == table['notebookEntry']
            and coverage['pageRows'] == len(table['pages']) and coverage['inkRows'] == len(table['ink'])
            and coverage['bookmarkRows'] == len(table['bookmarks'])
            and coverage['inkPages'] == [item['page'] for item in table['ink']]
            and coverage['bookmarkIds'] == [item['id'] for item in table['bookmarks']]
            and [item['pageId'] for item in annotations] == table['pageIds']
            and all(len(item['ink']) == strokes.get(item['pageId'], 0) and len(item['bookmarks']) == marks.get(item['pageId'], 0)
                    for item in annotations)):
        raise ValueError(_P + 'row-coverage-mismatch')


def _library_tables(token, copy, manifest, source, budget, read_entry=None):
    """Notebook row tables of the library copy, only when its database can really be listed (WAL included)."""
    if not (legacy_inventory.notebooks_listable(source) and source['sqlite']['walComplete'] is True
            and 'sqlite-wal-incomplete' not in source['sqlite']['reasons']):
        return []
    ids = legacy_inventory.notebook_ids(copy, cancel=token.cancel, budget=budget)
    if len(ids) > notebook_preview.MAX_NOTEBOOKS:
        raise ValueError('preview-notebook-capacity-exceeded')
    # A row the manifest cannot hold makes ITS Notebook blocked instead of the whole manifest invalid (work B7-f; REVIEW-r161-b6d low 2).
    # A well-formed table is returned unchanged.
    return [normalize_notebook_table(
        legacy_inventory.notebook_row_table(copy, manifest, identifier, cancel=token.cancel, budget=budget, read_entry=read_entry))
        for identifier in ids]


def _sqlite_names(kind, manifest):
    """The SQLite files of a source that are in its manifest (a Library's database or a canonical store's); none for a device."""
    name = {'desktop-library': 'library.sqlite3', 'canonical': 'content.sqlite3'}.get(kind)
    keys = {tuple(entry['key']) for entry in manifest['entries']}
    return () if name is None else tuple(item for item in sqlite_family(name) if (item,) in keys)


@contextmanager
def _source_copy(token, backup, backup_id, names):
    """The one working copy of a source (its SQLite family only; verified, with a free-space check), or None when it has none.

    A source without a database has nothing to open, but its backup is still verified once, like the others.
    """
    limits = CONVERSION_LIMITS
    if names:
        with backup.sqlite_working_copy(backup_id, names, limits=limits, cancel=token.cancel,
                                        free_margin=DISK_MARGIN_BYTES) as copy:
            yield copy
    else:
        if backup.load(backup_id, limits=limits, cancel=token.cancel) is None:
            raise ValueError('backup-completion-missing')
        yield None


def _extract_notebooks(token, record, manifest, copy, tables, include_extractions, read_entry):
    """Notebook items (and, when asked, extractions) from the shared copy: one verified copy, no copy per notebook."""
    extractions, notebooks, total = {}, [], 0
    for table in tables:
        _cancelled(token)
        item = {'sourceDocumentId': table['sourceDocumentId'], 'notebookEntry': table['notebookEntry'], 'pageIds': table['pageIds'],
                'rows': {key: table[key] for key in ('pages', 'ink', 'bookmarks')},
                'status': 'blocked', 'reason': None, 'coverage': None, 'incomplete': []}
        notebooks.append(item)
        if table['problem'] is not None:
            item['reason'] = table['problem']
            continue
        if table['unmapped'] > 0:
            item['reason'] = 'notebook-annotation-unmapped'
            continue
        identifier = table['sourceDocumentId']
        try:
            entries = notebook_entries(manifest, identifier, max_notebook_bytes=notebook_preview.MAX_NOTEBOOK_BYTES,
                                       max_projection_bytes=notebook_preview.MAX_PROJECTION_BYTES)
            assert_notebook_settled(entries, identifier)
            if entries[('papers', identifier, 'original.pdf')]['byteLength'] > MAX_RESOURCE_BYTES:
                raise ValueError('resource-too-large')       # the Notebook's PDF is a resource a conversion would stage
            note = entries[('papers', identifier, 'notebook.json')]
            value = notebook_projection_from_copy(
                copy / 'library.sqlite3', manifest, identifier, lambda max_bytes, _entry=note: read_entry(_entry, max_bytes),
                library_id=record['libraryId'], run_id=token.run_id, peer_id=record['peerId'],
                max_notebook_bytes=notebook_preview.MAX_NOTEBOOK_BYTES, max_pages=notebook_preview.MAX_PAGES,
                max_annotation_rows=notebook_preview.MAX_ANNOTATION_ROWS,
                max_projection_bytes=notebook_preview.MAX_PROJECTION_BYTES, cancel=token.cancel)
        except EXPECTED_ERRORS as error:
            item['reason'] = _block_reason(error)
            continue
        _check_rows(table, value)
        item.update(status='extracted', reason=None, incomplete=list(value['incomplete']),
                    coverage={key: value['coverage'][key] for key in ('pageRows', 'inkRows', 'bookmarkRows')})
        if include_extractions:
            total += len(value['bytes']) + len(json.dumps(value['annotations'], ensure_ascii=True, allow_nan=False))
            if total > MAX_EXTRACTION_BYTES:
                raise ValueError('inventory-capacity-exceeded')
            extractions[identifier] = value
    return notebooks, extractions


def _build(token, include_extractions, library_hook=None):
    """The manifest, the report and (when asked) the Notebook extractions. `library_hook(copy, manifest, source, read_entry)` (work B7-f,
    the staging writer) runs once, inside the Library source's copy block, after the inventory, the row tables and the extraction and
    before the copy's last check: the one place that may read the verified copy again. Its result is returned as `hooked`."""
    limits = CONVERSION_LIMITS
    budget = legacy_inventory.InventoryBudget()
    before = notebook_preview._fingerprint(token, deep=True, limits=limits)
    selection = _selection(token)
    _assert_external_writers(selection)
    root, record, registered, plans, _references, _selectors = before
    backups = (NativeLegacyBackup(root), NativeLegacyBackup(edit_storage_root(root), allow_missing=True),
               NativeLegacyHeldDeviceBackup(root, device_root=selection.device))
    sources, tables, notebooks, extractions, hooked = [], [], [], {}, None
    for kind, backup, backup_id, plan in zip(KINDS, backups, record['backupIds'], plans, strict=True):
        _cancelled(token)
        manifest = plan['manifest']
        names = _sqlite_names(kind, manifest)

        def read_entry(entry, max_bytes, _backup=backup, _id=backup_id):
            return _backup.read_object(_id, entry, limits=limits, cancel=token.cancel, max_bytes=max_bytes)

        # One working copy at a time, and only of the SQLite family. Its tree must equal the registered manifest's
        # entries for those files (inventory-copy-mismatch); that check is the first use of the copy.
        with _source_copy(token, backup, backup_id, names) as copy:
            sources.append(legacy_inventory.inventory_source(
                kind, manifest, copy, library_key=backups[2].library_key, cancel=token.cancel, budget=budget,
                copied=frozenset((name,) for name in names), read_entry=read_entry))
            if kind == 'desktop-library':
                tables = _library_tables(token, copy, manifest, sources[-1], budget, read_entry)
                notebooks, extractions = _extract_notebooks(token, record, manifest, copy, tables, include_extractions, read_entry)
                if library_hook is not None:
                    hooked = library_hook(copy, manifest, sources[-1], read_entry)
            # The last use of this source's copy is over: its database (and -wal) must still equal the manifest. The inventory
            # checked the tree before the first open; nothing checked the copy afterwards, so the row table and the extraction
            # could have agreed on a copy that had been changed in between (work B7-d; REVIEW-r161-b7b low 3). The owner of
            # the copy's lifetime is the one that knows which use is the last, so the check is here; the staging row
            # extraction (legacy_staging_rows) also checks the file it read when it finishes.
            legacy_inventory.assert_copy_unchanged(copy, manifest, names, cancel=token.cancel)
    report = legacy_inventory.build_report(sources, tables, budget=budget)
    after = notebook_preview._fingerprint(token, deep=False, limits=limits)
    if before != after:
        raise ValueError('preview-source-changed')
    _assert_external_writers(_selection(token))
    manifest = _manifest(token, record, registered, plans, sources, report, notebooks)
    notebook_preview._still_admitted(token)
    result = {'manifest': manifest, 'report': report, 'extractions': extractions if include_extractions else None}
    if library_hook is not None:
        result['hooked'] = hooked
    return result


def _manifest(token, record, registered, plans, sources, report, notebooks):
    library = sources[0]
    database = library['sqlite']
    wal = sorted(name for name in ('library.sqlite3-shm', 'library.sqlite3-wal')
                 if any(entry['key'] == [name] for entry in library['entries']))
    reasons = set(legacy_inventory.whole_library_assessment(report)['reasons'])
    if any(item['status'] == 'blocked' for item in notebooks):
        reasons.add('notebook-extraction-blocked')
    manifest = {
        'version': VERSION, 'scope': SCOPE, 'runId': token.run_id, 'peerId': record['peerId'], 'libraryId': record['libraryId'],
        'journalRecordSha256': edit_content_hash(record), 'selectionSha256': record['selectionSha256'],
        'inputSetSha256': edit_content_hash(registered),
        'sources': [{'kind': source['kind'], 'sourceId': source['sourceId'], 'backupId': source['backupId'],
                     'planSha256': edit_content_hash(plan), 'observationSha256': plan['observationSha256'],
                     'inventorySha256': source['inventorySha256'], 'entryCount': source['entryCount'],
                     'totalBytes': source['totalBytes']} for source, plan in zip(sources, plans, strict=True)],
        'inventory': {'reportSha256': report['reportSha256'], 'summary': report['summary']},
        'sqlite': None if database is None else {
            'journalMode': database['journalMode'], 'walEntries': wal, 'walComplete': database['walComplete'],
            'userVersion': database['userVersion'], 'quickCheck': database['quickCheck'],
            'notebooksListable': legacy_inventory.notebooks_listable(library)},
        'notebooks': notebooks,
        'wholeLibrary': {'status': 'refused', 'reasons': sorted(reasons)}}
    manifest['manifestSha256'] = edit_content_hash(manifest)
    if len(json.dumps(manifest, ensure_ascii=True, allow_nan=False).encode('utf-8')) > MAX_MANIFEST_BYTES:
        raise ValueError('inventory-capacity-exceeded')
    return manifest


def run(token, include_extractions=False):
    """Worker body (runs on the gate's thread). The gate is released only at the very end."""
    try:
        return _build(token, include_extractions)
    finally:
        preview_gate.gate.finish(token)


# ----- public -----------------------------------------------------------------------------------
def start(run_id, *, include_extractions=False):
    """Admit and launch the worker: (token, future). Refusals are ValueError('conversion-input-<reason>')."""
    try:
        if type(include_extractions) is not bool:
            raise ValueError(_P + 'unavailable')
        token = admit(run_id)
        # gate.start keeps the gate busy when the thread state is unknown and frees it otherwise.
        future = preview_gate.gate.start(token, lambda current: run(current, include_extractions))
    except (*EXPECTED_ERRORS, RuntimeError) as error:
        reason = reason_of(error)
    else:
        return token, future
    raise ValueError(reason) from None


def build(run_id, *, timeout=120, include_extractions=False):
    """{'manifest', 'report', 'extractions'} for the run, or ValueError('conversion-input-<reason>').

    Only run_id (and the test-only include_extractions, timeout) are accepted: no caller path, digest or
    "writers are stopped" claim can authorise anything. An expired timeout cancels the worker; its thread
    is still waited for by the gate (and so by shutdown).
    """
    token, future = start(run_id, include_extractions=include_extractions)
    done, _pending = wait_futures([future], timeout=timeout)
    if not done:
        token.cancel.set()
        raise ValueError(_P + 'cancelled')
    try:
        return future.result()
    except (*EXPECTED_ERRORS, RuntimeError) as error:
        reason = reason_of(error)
    raise ValueError(reason) from None


def assert_whole_library_convertible(manifest):
    """B6 never converts the whole Library: always raises, with the manifest's reasons in args[1]."""
    whole = manifest.get('wholeLibrary') if isinstance(manifest, dict) else None
    reasons = whole.get('reasons') if isinstance(whole, dict) else None
    if not (isinstance(reasons, list) and reasons and all(isinstance(item, str) for item in reasons)):
        raise ValueError(_P + 'whole-library-refused', ['manifest-invalid'])
    raise ValueError(_P + 'whole-library-refused', list(reasons))
