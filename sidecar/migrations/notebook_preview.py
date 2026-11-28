"""Bounded, cancellable, read-only Notebook preview from the registered Native backup.

Runs only on the preview_gate worker thread. It never writes the library, the backup
or any snapshot; the sole transient write is the disposable `.analysis-*` copy that
NativeLegacyBackup.analysis_copy always removes. Every answer is a fresh
reconciliation of the journal, hold, input set, plans and manifests, so a changed
or cancelled state is refused rather than shown.

Scope is deliberately small: nothing here claims page-text conversion, original PDF
fidelity, whole-Library or other-source coverage, writer quiescence or migration.
"""
import base64
import json
import re
import sqlite3

from papeer.core.edit_storage import edit_storage_root
from papeer.core.migrations.legacy_backup import BackupReadLimits, NativeLegacyBackup
from papeer.core.migrations.legacy_device import NativeLegacyHeldDeviceBackup
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_notebook_backup import notebook_projection_input
from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal, selection_binding
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
from . import census, preparation, preview_gate

SCOPE = 'native-notebook-preview-only'
MIB = 1024 * 1024
# Read at call time (tests lower them). total_bytes bounds the whole desktop-library
# backup, because the analysis copy and the object hash cover every entry.
LIMITS = BackupReadLimits(metadata_bytes=8 * MIB, entries=10_000, total_bytes=256 * MIB)
MAX_NOTEBOOKS = 256
MAX_PAGES = 256
MAX_ANNOTATION_ROWS = 20_000
MAX_NOTEBOOK_BYTES = 2 * MIB
MAX_PROJECTION_BYTES = 6 * MIB
MAX_RESPONSE = 8 * MIB
_ID = re.compile(r'^[0-9a-f]{32}$')
_CAPACITY = re.compile(r'^preview-(?:[a-z]+-)*capacity-exceeded$')
BLOCKED_REASONS = ('preview-busy', 'preview-shutdown-pending', 'preview-cancelled',
                   'preview-capacity-exceeded', 'preview-unavailable')
EXPECTED_ERRORS = (OSError, ValueError, RecursionError, sqlite3.Error)


def blocked_reason(error):
    """Map an internal cause to one of the allowed codes; never expose text or paths."""
    text = str(error) if isinstance(error, ValueError) else ''
    if text in ('preview-busy', 'preview-shutdown-pending'):
        return text
    if text in ('backup-read-cancelled', 'preview-cancelled'):
        return 'preview-cancelled'
    if text in ('backup-read-limit', 'legacy-notebook-read-limit') or _CAPACITY.fullmatch(text):
        return 'preview-capacity-exceeded'
    return 'preview-unavailable'


def _limits_view():
    return {'backupTotalBytes': LIMITS.total_bytes, 'backupEntries': LIMITS.entries, 'metadataBytes': LIMITS.metadata_bytes,
            'maxNotebooks': MAX_NOTEBOOKS, 'maxPages': MAX_PAGES, 'maxAnnotationRows': MAX_ANNOTATION_ROWS,
            'maxNotebookBytes': MAX_NOTEBOOK_BYTES, 'maxProjectionBytes': MAX_PROJECTION_BYTES, 'maxResponse': MAX_RESPONSE}


def _cancelled(token):
    if token.cancel.is_set():
        raise ValueError('preview-cancelled')


def _fingerprint(token, *, deep, limits=None):
    """Reconcile every durable fact the preview relies on; return it as a comparable tuple.

    deep (cold only) first runs the existing recovery classifier, which verifies the
    three sources' plans, manifests and every object hash plus the storage-location
    binding, bounded by LIMITS and the cancel flag. The metadata comparison that
    follows is cheap and is repeated after the read to detect any change.
    `limits` (default LIMITS, read at call time) is the bound; the conversion input passes its own larger one (work B7-b),
    the preview never does.
    """
    limits = LIMITS if limits is None else limits
    run_id = token.run_id
    _cancelled(token)
    if token.kind == 'cold' and deep:
        status = preparation._durable_recovery_status(limits=limits, cancel=token.cancel)
        _cancelled(token)  # the classifier folds a cancelled read into 'unreadable'
        if (status is None or status.get('state') != 'recovery-required'
                or status.get('phase') != 'artifacts-verified' or status.get('runId') != run_id):
            raise ValueError('preview-state-unavailable')
    selection = token.owner._selection if token.kind == 'live' else census.select_current()
    root, device = selection.root, selection.device
    journal = NativePreparationJournal(root)
    record = journal.read()
    if record is None or record['runId'] != run_id:
        raise ValueError('preview-state-unavailable')
    if token.kind == 'live' and record != token.owner._record:
        raise ValueError('preview-state-unavailable')
    if selection_binding(root, device) != record['selectionSha256']:
        raise ValueError('preview-state-unavailable')
    if (journal.event(run_id, 'cancel-intent') or journal.event(run_id, 'cancel-complete')
            or journal.cleanup_state(run_id) == 'pending'):
        raise ValueError('preview-state-unavailable')
    if NativeLegacyStartup(root).read() != {'version': 1, 'runId': run_id}:
        raise ValueError('preview-state-unavailable')
    registered = NativeLegacyInputs(root).read(run_id, limits=limits)
    if registered is None or registered['catalog']['identity']['libraryId'] != record['libraryId']:
        raise ValueError('preview-state-unavailable')
    _cancelled(token)
    sources = (NativeLegacyBackup(root), NativeLegacyBackup(edit_storage_root(root), allow_missing=True),
               NativeLegacyHeldDeviceBackup(root, device_root=device))
    if [source.store.source for source in sources] != record['sources'] or record['sources'][0].get('kind') != 'desktop-library':
        raise ValueError('preview-state-unavailable')
    plans, references = [], []
    for source, backup_id in zip(sources, record['backupIds'], strict=True):
        matches = [item['plan'] for item in registered['inputs'] if item['peerId'] == record['peerId']
                   and item['plan']['manifest']['source'] == source.store.source
                   and item['plan']['manifest']['id'] == backup_id]
        if len(matches) != 1:
            raise ValueError('preview-state-unavailable')
        if source.plan(backup_id, limits=limits) != matches[0] or source.store.reference(backup_id, limits=limits) != matches[0]['manifest']:
            raise ValueError('preview-state-unavailable')
        plans.append(matches[0]); references.append(matches[0]['manifest'])
    candidates = [entry['key'] for entry in plans[0]['manifest']['entries']
                  if len(entry['key']) == 3 and entry['key'][0] == 'papers' and entry['key'][2] == 'notebook.json']
    if any(not isinstance(key[1], str) or not _ID.fullmatch(key[1]) for key in candidates):
        raise ValueError('preview-notebook-id-unsupported')
    selectors = sorted(key[1] for key in candidates)
    if len(set(selectors)) != len(selectors):
        raise ValueError('preview-notebook-id-unsupported')
    if len(selectors) > MAX_NOTEBOOKS:
        raise ValueError('preview-notebook-capacity-exceeded')
    return (root, record, registered, tuple(plans), tuple(references), tuple(selectors))


def _still_admitted(token):
    """Last check before an answer leaves: the state that admitted us must still hold."""
    with preparation._entry_lock:
        if token.cancel.is_set() or preview_gate.gate.closed:
            raise ValueError('preview-cancelled')
        if preparation._current is not token.owner:
            raise ValueError('preview-state-unavailable')
        if token.kind == 'live':
            owner = token.owner
            # Defense in depth: a result read after the owner released its leases is never shown.
            if (owner.status()['state'] != 'captured' or owner._closed
                    or owner._device_lease is None or owner._history_lease is None
                    or owner._library_lock is None or not owner._library_lock.held):
                raise ValueError('preview-state-unavailable')


def list_notebooks(token):
    before = _fingerprint(token, deep=True)
    _cancelled(token)
    after = _fingerprint(token, deep=False)
    if before != after:
        raise ValueError('preview-source-changed')
    _still_admitted(token)
    return {'selectors': list(before[5]), 'scope': SCOPE, 'limits': _limits_view()}


def read_notebook(token, selector):
    before = _fingerprint(token, deep=True)
    root, record, selectors = before[0], before[1], before[5]
    if not isinstance(selector, str) or selector not in selectors:
        raise ValueError('preview-selector-unavailable')
    value = notebook_projection_input(
        NativeLegacyBackup(root), token.run_id, record['peerId'], selector, limits=LIMITS,
        max_notebook_bytes=MAX_NOTEBOOK_BYTES, max_pages=MAX_PAGES, max_annotation_rows=MAX_ANNOTATION_ROWS,
        max_projection_bytes=MAX_PROJECTION_BYTES, cancel=token.cancel)
    after = _fingerprint(token, deep=False)
    if before != after:
        raise ValueError('preview-source-changed')
    _still_admitted(token)
    coverage = value['coverage']
    result = {key: value[key] for key in ('libraryId', 'sourceDocumentId', 'entry', 'annotations', 'incomplete')}
    result['bytesBase64'] = base64.b64encode(value['bytes']).decode('ascii')
    result['coverage'] = {key: coverage[key] for key in ('pageRows', 'inkRows', 'bookmarkRows')}
    result['scope'] = SCOPE
    if len(json.dumps(result, ensure_ascii=True, allow_nan=False).encode('utf8')) > MAX_RESPONSE:
        raise ValueError('preview-response-capacity-exceeded')
    return result


def run(token, selector=None):
    """Worker body (runs on the gate's thread). The gate is released only at the very end."""
    try:
        return list_notebooks(token) if selector is None else read_notebook(token, selector)
    finally:
        preview_gate.gate.finish(token)
