"""Admission, status and the writer of the Native legacy staging (work B7-c and B7-f, DESIGN-r161-b7-staging.md 3, 5, 6, 8, 10.2).

This is the sidecar side of `papeer.core.migrations.legacy_staging_store`. Nothing in this module is called from a route, the CLI or
startup; callers are tests only (decision J1: the TypeScript converter is reached only through a `convert` callable the caller hands in,
in work B7 the test bridge).

Admission follows the conversion input exactly, with one more check at the end:
  (1) a closed gate is `staging-shutdown-pending`; (2) another process that may hold writer rights is refused
  (`conversion_input._assert_external_writers`); (3) the one shared gate (preview, conversion input and staging are mutually busy,
  and `start`/`resume`/`abandon` of the preparation are refused while it is held) is taken through
  `preparation.admit_preview(run_id)`; (4) under that token: the hold must be this run's, a cold run must be classified by the
  existing recovery classifier as `recovery-required/artifacts-verified` (so K2, K8-K11 and every other interrupted state stop
  here: `staging-state-unavailable`), and the staging folder must classify as absent / uninitialized / resumable / staged
  (`staging-diagnostic-required` otherwise). The gate is released again on any refusal; a successful admission holds it until
  `release`. Only a run ID is accepted: no path, digest or "writers are stopped" claim authorises anything.

The writer (`build`, work B7-f) takes ONE admission and runs the whole of DESIGN 5.1 on the gate's thread: it reads the verified copy
and the backup once (`conversion_input._build` with a hook), asks `convert` for the plan, and checks that plan against numbers it
counted itself BEFORE anything is written (`staging-plan-rejected`). It then writes, one transaction at a time and in this order:
resources (each with its ID and provenance rows in the same transaction), the plan (with every ID and provenance row), the units,
the ONE assembled checkpoint, and then reads everything back and verifies it (`staging-verification-failed` /
`staging-provenance-incomplete`; the phase stays `assembled`), and finally seals (`staged`). `staged` is the only final state:
`assert_staging_publishable` always refuses, and always names the residual reasons.

Resume (work B7-g, DESIGN 5.2). The same call again after an interruption continues the same run from the phase the staging is in, and
the result is the one an uninterrupted run makes (the same ID table, plan hash, residual reasons and rows):
  absent / uninitialized (P0, P1) - from the start; `initialized` (P2-P4) - the resources still missing; `resources` (P5) - the plan;
  `planned` (P6) - the units still missing; `units` (P7) - the assembly (a checkpoint already installed is kept, not installed twice);
  `assembled` (P8) - the read-back verification; `verified` (P9) - the seal; `staged` - nothing is written, the same report is returned.
A resume starts only when everything that made the staging is the same again: the run, the manifest REBUILT from the verified sources
(`staging-input-changed`), the converter version (`staging-converter-changed`) and, once a plan is stored, the plan the converter makes now
(`staging-plan-changed`); the units and resources already stored must equal the plan's (`staging-unit-conflict`, `staging-resource-mismatch`).
Nothing is ever deleted or overwritten to make a resume work, and a staging that cannot be classified (`staging-diagnostic-required`)
is not touched at all. Nothing that is rebuilt is random: IDs come from the converter's stable ID, never from a clock or a UUID.

Refusals are `ValueError('staging-<reason>')` from the closed set `legacy_staging_store.REASONS`, optionally with a second argument
(a list of closed check codes, never an exception text, a title or a path); an unexpected exception (KeyError, TypeError, ...) is
wrapped as `staging-unavailable` and never echoed.
"""
from concurrent.futures import wait as wait_futures
from contextlib import contextmanager
from copy import deepcopy
import base64
import hashlib
import json
import re
import shutil
from typing import NoReturn

import pymupdf

from papeer.core import paths
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_contracts import validate_id
from papeer.core.edit_model import EditGraph
from papeer.core.edit_repository import SqliteEditRepository
from papeer.core.edits.datasets import checkpoint_hash, checkpoint_resource_ids
from papeer.core.migrations import legacy_staging_accounting as accounting
from papeer.core.migrations import legacy_staging_store as store
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_staging_rows import extract_staging_rows
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
from . import census, conversion_input, notebook_preview, preparation, preview_gate

_P = 'staging-'
SCOPE = store.SCOPE
# Staging states that admission lets through. `staged` is admitted because a second call of a finished run answers with the
# same report and writes nothing (DESIGN 5.2); the writer decides what each state means. `orphaned` cannot occur: the hold's
# run is the one admitted.
ADMITTED_STATES = ('absent', 'uninitialized', 'resumable', 'staged')
# `conversion-input-<name>` reasons that have the same name as a staging reason; every other cause is `staging-unavailable`.
_SAME_NAMES = frozenset({
    'busy', 'shutdown-pending', 'cancelled', 'capacity-exceeded', 'disk-insufficient', 'state-unavailable', 'source-changed',
    'library-lock-unavailable', 'instance-writer-unverified', 'other-writer-present'})
# The closed codes of the row extraction (legacy_staging_rows) that say more than "unavailable" (REVIEW-r161-b7d low 2).
_ROWS_REASONS = {'staging-rows-cancelled': _P + 'cancelled', 'staging-rows-capacity-exceeded': _P + 'capacity-exceeded',
                 'staging-rows-copy-changed': _P + 'source-changed'}
_CODE = re.compile(r'^[a-z0-9-]{1,64}$')
MAX_RESOURCE_BYTES = conversion_input.MAX_RESOURCE_BYTES
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
# The checks the verification (DESIGN 8) runs, named in the report. A name is listed only when the check ran and found nothing wrong.
CHECKS = ('status', 'plan', 'units', 'checkpoint', 'ids', 'coverage', 'library', 'documents', 'markdown', 'resources', 'resource-bytes',
          'provenance', 'forbidden-rows')


def reason_of(error):
    """Map an internal cause to the closed set of staging reasons; never an exception text or a path."""
    if isinstance(error, ValueError) and error.args and type(error.args[0]) is str:
        first = error.args[0]
        if first in store.REASONS and (len(error.args) == 1 or (len(error.args) == 2 and _codes(error.args[1]) is not None)):
            return first
        if len(error.args) == 1 and first in _ROWS_REASONS:
            return _ROWS_REASONS[first]
    name = conversion_input.reason_of(error).removeprefix(conversion_input._P)
    return _P + name if name in _SAME_NAMES else _P + 'unavailable'


def _codes(value):
    """A list of closed check codes (or None when `value` is anything else): the only detail a refusal carries."""
    return list(value) if isinstance(value, (list, tuple)) and len(value) <= 64 and all(type(item) is str and _CODE.fullmatch(item) for item in value) else None


def _refuse(reason, codes=None) -> NoReturn:
    raise ValueError(reason, sorted(set(codes))) if codes else ValueError(reason)


class Admission:
    """One admitted staging run. It holds the shared gate (`token`) until `release`."""
    __slots__ = ('token', 'run_id', 'root', 'status')

    def __init__(self, token, run_id, root, status):
        self.token, self.run_id, self.root, self.status = token, run_id, root, status


def _hold_is(root, run_id):
    return NativeLegacyStartup(root).read() == {'version': 1, 'runId': run_id}


def _assert_run_state(token, run_id):
    """The state that admitted the token (hold, live owner or a verified cold run) and the staging folder's classification."""
    selection = conversion_input._selection(token)
    root = selection.root
    if not _hold_is(root, run_id):
        raise ValueError('preview-state-unavailable')
    if token.kind == 'cold':
        # The classifier verifies the three plans, manifests and every object hash and the storage-location binding.
        # K2/K11 (durable state unverified/unreadable), K8/K10 (cleanup unknown), K9 (cancel interrupted) and a finished
        # cancel all come back with another phase.
        status = preparation._durable_recovery_status(limits=conversion_input.CONVERSION_LIMITS, cancel=token.cancel)
        if token.cancel.is_set():
            raise ValueError('preview-cancelled')
        if (status is None or status.get('state') != 'recovery-required' or status.get('phase') != 'artifacts-verified'
                or status.get('runId') != run_id):
            raise ValueError('preview-state-unavailable')
    status = store.staging_status(root, run_id, hold_run_id=run_id)
    if status['state'] not in ADMITTED_STATES:
        raise ValueError(_P + 'diagnostic-required')
    notebook_preview._still_admitted(token)
    return root, status


def admit(run_id):
    """Admit one staging run on the shared gate, or raise ValueError('staging-<reason>'). The caller must `release`."""
    try:
        try:
            validate_id(run_id)
        except ValueError:
            raise ValueError(_P + 'state-unavailable') from None      # no such run; the invalid text is not echoed
        if preview_gate.gate.closed:
            raise ValueError(_P + 'shutdown-pending')
        conversion_input._assert_external_writers(conversion_input._admission_selection())
        token = preparation.admit_preview(run_id)
    except Exception as error:  # noqa: BLE001 - every refusal is one closed reason
        raise ValueError(reason_of(error)) from None
    try:
        root, status = _assert_run_state(token, run_id)
    except BaseException as error:
        preview_gate.gate.finish(token)
        if isinstance(error, Exception):
            raise ValueError(reason_of(error)) from None
        raise
    return Admission(token, run_id, root, status)


def release(admission):
    """Let go of the shared gate (idempotent)."""
    preview_gate.gate.finish(admission.token)


@contextmanager
def admitted(run_id):
    admission = admit(run_id)
    try:
        yield admission
    finally:
        release(admission)


def _current(admission):
    """Whether the admission is still valid: the token is not released, not cancelled, the owner and the hold are the same."""
    try:
        if admission.token.done.is_set():
            raise ValueError('preview-state-unavailable')
        notebook_preview._still_admitted(admission.token)
        if not _hold_is(admission.root, admission.run_id):
            raise ValueError('preview-state-unavailable')
    except Exception as error:  # noqa: BLE001
        raise ValueError(reason_of(error)) from None


def authority(admission, scope):
    """The staging authority (operation allowlist, one scope) bound to this admission; it stops working when the admission ends."""
    return store.StagingAuthority(admission.root, admission.run_id, scope, lambda: _current(admission))


def repository(admission, scope):
    """A `SqliteEditRepository` over the staging DB of the admitted run, through `authority` only."""
    return SqliteEditRepository(authority(admission, scope), scope)


def status(run_id):
    """Read-only classification of a run's staging for the diagnostic path (no gate, no lock, nothing written or repaired).

    A staging that exists for a run other than the hold's is `orphaned` (read, never deleted).
    """
    try:
        try:
            validate_id(run_id)
        except ValueError:
            raise ValueError(_P + 'state-unavailable') from None
        root = census._root(paths.selected_data_directory())
        hold = NativeLegacyStartup(root).read()
        return store.staging_status(root, run_id, hold_run_id=None if hold is None else hold['runId'])
    except Exception as error:  # noqa: BLE001
        raise ValueError(reason_of(error)) from None


# ======================================================================================================================
# The writer (work B7-f)
# ======================================================================================================================
def _boundary(token, stage):
    """Just BEFORE a stage of the writer starts (never inside a transaction): the cancel check. `stage` names the stage that is about to run
    (gather, descriptors, convert, validate, initialize, resource, plan, unit, assemble, verify, seal); tests wrap this function to cancel, to
    stop or to tamper at one boundary (work B7-g adds its interruption points the same way). What is committed is never undone."""
    if token.cancel.is_set():
        raise ValueError(_P + 'cancelled')


def _fingerprint(token):
    return notebook_preview._fingerprint(token, deep=False, limits=conversion_input.CONVERSION_LIMITS)


def _gather(admission) -> tuple[dict, dict]:
    """One verified read of the sources: (the `_build` result, the staging rows of the Library). The shared copy is opened once."""
    token = admission.token

    def hook(copy, manifest, source, read_entry):
        result = extract_staging_rows(copy / 'library.sqlite3', manifest, source, read_entry=read_entry, cancel=token.cancel, verify_copy=False)
        if not result['listable'] or result['rows'] is None:
            return {'rows': None}
        # The rows as the converter receives them (JSON: a page number is a text key): the checks count in the same terms.
        return {'rows': json.loads(json.dumps(result['rows'], allow_nan=False)), 'rowsReport': result['report'], 'entries': deepcopy(manifest['entries']), 'read_entry': read_entry,
                'collections': accounting.collection_facts(copy / 'library.sqlite3')}

    built = conversion_input._build(token, True, hook)
    hooked = built['hooked']
    if hooked is None or hooked['rows'] is None:
        _refuse(_P + 'rows-not-listable')
    return built, hooked


def _pdf_pages(data):
    """The page sizes `SqliteEditRepository.store_resource` will compute (PyMuPDF `page.rect`), or None for a PDF that cannot be stored."""
    try:
        with pymupdf.open(stream=data, filetype='pdf') as document:
            if document.needs_pass or not 0 < document.page_count <= 100000:
                return None
            return [{'widthPt': page.rect.width, 'heightPt': page.rect.height} for page in document]
    except Exception:  # noqa: BLE001 - an unreadable PDF has no descriptor; the converter then blocks it (`pdf-resource-missing`)
        return None


def _descriptors(token, library_id, rows, entries, read_entry):
    """Resource descriptors made from verified backup objects, ONE object in memory at a time (DESIGN 7.2). A PDF or an image that is
    too large, unreadable or not what it claims gets no descriptor: the converter then does not convert what needs it."""
    result = []
    for pdf in rows['pdfs']:
        if pdf['file'] is None or pdf['fileMatchesRow'] is not True:
            continue
        key = ('papers', pdf['id'], 'original.pdf')
        entry = entries.get(key)
        if entry is None or entry['byteLength'] > MAX_RESOURCE_BYTES:
            continue
        pages = _pdf_pages(read_entry(entry, MAX_RESOURCE_BYTES))
        if pages is not None:
            result.append({'kind': 'pdf', 'resourceId': accounting.resource_id(library_id, 'pdf', key, entry['sha256']), 'sourceKey': list(key),
                           'sha256': entry['sha256'], 'byteLength': entry['byteLength'], 'mediaType': 'application/pdf', 'pdfPages': pages})
    for note in rows['markdown']:
        for media in note['media']:
            key = ('papers', note['id'], 'media', media['name'])
            entry = entries.get(key)
            if entry is None or entry['byteLength'] > MAX_RESOURCE_BYTES or not read_entry(entry, MAX_RESOURCE_BYTES).startswith(PNG_SIGNATURE):
                continue
            result.append({'kind': 'image', 'resourceId': accounting.resource_id(library_id, 'image', key, entry['sha256']), 'sourceKey': list(key),
                           'sha256': entry['sha256'], 'byteLength': entry['byteLength'], 'mediaType': 'image/png', 'pdfPages': None})
    return result


def _conversion_input(built, hooked, descriptors, web_ops):
    return {'manifest': built['manifest'],
            'extractions': [{'libraryId': item['libraryId'], 'sourceDocumentId': item['sourceDocumentId'], 'entry': item['entry'],
                             'bytesBase64': base64.b64encode(item['bytes']).decode('ascii'), 'annotations': item['annotations']}
                            for item in built['extractions'].values()],
            'rows': hooked['rows'], 'resources': descriptors, 'webAnnotationOpsRows': web_ops}


_PLAN_KEYS = {'version', 'scope', 'converterVersion', 'libraryId', 'manifestSha256', 'units', 'resources', 'unusedResources', 'ids', 'provenance',
              'notConverted', 'residualReasons', 'coverage', 'counts', 'derived', 'wholeLibrary', 'planSha256'}
_UNIT_KEYS = {'seq', 'unitKind', 'sourceKind', 'targetId', 'payload', 'payloadSha256'}
_RESOURCE_KEYS = {'resourceId', 'sha256', 'byteLength', 'mediaType', 'sourceKey', 'usedBy'}


def _plan_model(plan, facts, descriptors):
    """The writer's own reading of the converter's plan (DESIGN 7.4: the caller's plan is not trusted): shape, header, the plan hash and
    every payload hash, then every independent check. Returns the model that is written; anything else is `staging-plan-rejected`."""
    manifest = facts['manifest']
    try:
        if (type(plan) is not dict or set(plan) != _PLAN_KEYS or plan['version'] != 1 or plan['scope'] != accounting.PLAN_SCOPE
                or plan['converterVersion'] != store.CONVERTER_VERSION or plan['libraryId'] != manifest['libraryId']
                or plan['manifestSha256'] != manifest['manifestSha256'] or plan['wholeLibrary'] != manifest['wholeLibrary']
                or edit_content_hash({key: value for key, value in plan.items() if key != 'planSha256'}) != plan['planSha256']
                or not all(type(unit) is dict and set(unit) == _UNIT_KEYS and edit_content_hash(unit['payload']) == unit['payloadSha256']
                           for unit in plan['units'])
                or not all(type(item) is dict and set(item) == _RESOURCE_KEYS for item in plan['resources'])
                or not all(type(item) is str for item in plan['residualReasons']) or plan['residualReasons'] != sorted(set(plan['residualReasons']))):
            _refuse(_P + 'plan-rejected', ['plan-shape'])
        by_id = {item['resourceId']: item for item in descriptors}
        if (sorted(item['resourceId'] for item in plan['resources']) != [item['resourceId'] for item in plan['resources']]
                or set(by_id) != {item['resourceId'] for item in plan['resources']} | set(plan['unusedResources'])
                or {item['resourceId'] for item in plan['resources']} & set(plan['unusedResources'])):
            _refuse(_P + 'plan-rejected', ['plan-resources'])
        model = {'units': [{key: unit[key] for key in ('seq', 'unitKind', 'targetId', 'payload')} for unit in plan['units']],
                 'ids': plan['ids'], 'provenance': plan['provenance'],
                 'resources': [{'id': item['resourceId'], 'sha256': item['sha256'], 'byteLength': item['byteLength'], 'mediaType': item['mediaType'],
                                'pdfPages': by_id[item['resourceId']]['pdfPages']} for item in plan['resources']],
                 'notConverted': plan['notConverted'], 'coverage': plan['coverage']}
        codes = accounting.check_conversion(model, facts)
    except (KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
        if isinstance(error, ValueError) and error.args and error.args[0] == _P + 'plan-rejected':
            raise
        _refuse(_P + 'plan-rejected', ['plan-shape'])
    if codes['verification'] or codes['provenance']:
        _refuse(_P + 'plan-rejected', [*codes['verification'], *codes['provenance']])
    return model


def _plan_row(plan, manifest_sha256):
    return {'version': 1, 'scope': accounting.PLAN_ROW_SCOPE, 'converterVersion': store.CONVERTER_VERSION, 'manifestSha256': manifest_sha256,
            'tsPlanSha256': plan['planSha256'], 'idsSha256': accounting.ids_hash(plan['ids']),
            'units': [{key: unit[key] for key in ('seq', 'unitKind', 'targetId', 'payloadSha256')} for unit in plan['units']],
            'resources': plan['resources'], 'unusedResources': plan['unusedResources'], 'notConverted': plan['notConverted'],
            'residualReasons': plan['residualReasons'], 'coverage': plan['coverage'], 'counts': plan['counts'], 'derived': plan['derived']}


def _stored_resource_is_planned(repo, resource, descriptor):
    """P3: a resource an interrupted run left behind is kept (not written again) only when it is exactly the planned one: its stored metadata
    and, by hash, its stored bytes. True when it is there and right, False when it is not there, `staging-resource-mismatch` otherwise."""
    try:
        stored = repo.read_resource(resource['resourceId'])
    except ValueError as error:
        if error.args and error.args[0] in store.REASONS:
            raise
        _refuse(_P + 'resource-mismatch')
    except Exception:  # noqa: BLE001 - StorageIntegrityError: the stored bytes disagree with their own hash
        _refuse(_P + 'resource-mismatch')
    if stored is None:
        return False
    metadata = stored['metadata']
    if (metadata['sha256'] != resource['sha256'] or metadata['byteLength'] != resource['byteLength'] or metadata['mediaType'] != resource['mediaType']
            or metadata.get('pdfPages') != descriptor['pdfPages']):
        _refuse(_P + 'resource-mismatch')
    return True


def _write_resources(admission, repo, plan, facts, hooked, manifest_sha256, descriptors):
    """D: the resources one at a time. Each resource, its ID row and its provenance row are ONE transaction; the last one also moves the
    phase to `resources` (a plan with no resource gets its own transaction). A resume (P2-P4) keeps the resources already stored, after
    checking them (`_stored_resource_is_planned`), and writes the rest: a transaction that did not commit left neither a resource nor its rows."""
    token, run_id, auth = admission.token, admission.run_id, repo.authority
    by_id = {item['resourceId']: item for item in descriptors}
    ids = {entry['targetId']: entry for entry in plan['ids'] if entry['kind'] == 'resource'}
    provenance = {row['targetId']: row for row in plan['provenance'] if row['targetKind'] == 'resource'}
    resources = plan['resources']
    for index, resource in enumerate(resources):
        _boundary(token, 'resource')
        rid = resource['resourceId']
        descriptor = by_id[rid]
        last = index == len(resources) - 1

        def step(operation, db, _id=ids[rid], _row=provenance[rid], _last=last):
            if operation == 'store-resource':
                store.put_ids(db, run_id, [_id])
                store.put_provenance(db, run_id, [_row], manifest_sha256=manifest_sha256)
                if _last:
                    store.advance_phase(db, run_id, 'initialized', 'resources')

        if _stored_resource_is_planned(repo, resource, descriptor):
            with auth.write() as db:                                # the same rows, in their own transaction (already there: kept)
                step('store-resource', db)
            continue
        entry = facts['entries'][tuple(resource['sourceKey'])]
        data = hooked['read_entry'](entry, MAX_RESOURCE_BYTES)
        if len(data) != resource['byteLength'] or hashlib.sha256(data).hexdigest() != resource['sha256']:
            _refuse(_P + 'resource-mismatch')
        expected = None if descriptor['pdfPages'] is None else {'id': rid, 'sha256': descriptor['sha256'], 'mediaType': descriptor['mediaType'],
                                                                 'byteLength': descriptor['byteLength'], 'pdfPages': descriptor['pdfPages']}
        try:
            with auth.bundled(step):
                repo.store_resource(rid, resource['sha256'], resource['mediaType'], data, expected)
        except ValueError as error:
            if error.args and error.args[0] in store.REASONS:
                raise
            _refuse(_P + 'resource-mismatch')
        except Exception:  # noqa: BLE001 - the repository's own refusals (StorageIntegrityError, a rejected resource)
            _refuse(_P + 'resource-mismatch')
        data = None
    if not resources:
        with auth.write() as db:
            store.advance_phase(db, run_id, 'initialized', 'resources')


def _read_back(call, code):
    """A read of the staging through the repository: whatever the repository refuses (stored bytes that disagree with themselves, a payload that
    is no longer a valid root) is a failed verification, never an unexpected error."""
    try:
        return call()
    except ValueError as error:
        if error.args and error.args[0] in store.REASONS:
            raise
        _refuse(_P + 'verification-failed', [code])
    except Exception:  # noqa: BLE001 - StorageIntegrityError, a rejected snapshot
        _refuse(_P + 'verification-failed', [code])


def _readback_model(rows, repo, plan_row):
    """What the staging actually holds, as a model for `check_conversion`: units, IDs and provenance as stored, the resources as stored."""
    resources = []
    for entry in plan_row['resources']:
        value = _read_back(lambda _id=entry['resourceId']: repo.read_resource(_id), 'resource-bytes')
        if value is None:
            _refuse(_P + 'verification-failed', ['resources'])
        metadata, data = value['metadata'], value['bytes']
        if (hashlib.sha256(data).hexdigest() != metadata['sha256'] or len(data) != metadata['byteLength'] or metadata['sha256'] != entry['sha256']
                or metadata['byteLength'] != entry['byteLength'] or metadata['mediaType'] != entry['mediaType']):
            _refuse(_P + 'verification-failed', ['resource-bytes'])
        resources.append({'id': metadata['id'], 'sha256': metadata['sha256'], 'byteLength': metadata['byteLength'], 'mediaType': metadata['mediaType'],
                          'pdfPages': metadata.get('pdfPages')})
    return {'units': rows['units'], 'ids': rows['ids'], 'provenance': [{key: row[key] for key in ('targetKind', 'targetId', 'sourceKind', 'sourceKey', 'sourceSha256')}
                                                                      for row in rows['provenance']],
            'resources': resources, 'notConverted': plan_row['notConverted'], 'coverage': plan_row['coverage']}


def _count_of(model):
    """Counts of what the staging holds (read back, never the converter's own)."""
    documents = {'pdf': 0, 'notebook': 0}
    kinds = {}
    for entry in model['ids']:
        if entry['kind'] in accounting.CONTENT_KINDS:
            kinds[entry['targetId']] = accounting.CONTENT_KINDS[entry['kind']]
    pages = ink = sticky = highlight = images = markdown = 0
    library = next(unit['payload'] for unit in model['units'] if unit['unitKind'] == 'library')
    for unit in model['units']:
        if unit['unitKind'] == 'document':
            documents[kinds[unit['targetId']]] += 1
            for page in unit['payload']['pages']:
                pages += 1
                for annotation in page['annotations']:
                    ink += annotation['kind'] == 'ink'
                    sticky += annotation['kind'] == 'sticky'
                    highlight += annotation['kind'] == 'highlight'
        elif unit['unitKind'] == 'markdown':
            markdown += 1
            images += len(unit['payload']['imageResources'])
    return {'items': len(library['items']), 'folders': len(library['folders']), 'links': len(library['links']),
            'tags': sum(len(item['tags']) for item in library['items']), 'documents': documents, 'markdown': markdown, 'pages': pages,
            'ink': ink, 'sticky': sticky, 'highlight': highlight, 'resources': len(model['resources']), 'images': images}


def _safe_key(key):
    """A source key for the report: ids and table names only; a folder is named by its path's hash (a title is content)."""
    return [key[0], edit_content_hash(key[1])] if key and key[0] == 'folder' and len(key) == 2 else list(key)


def _report(record, plan_row, model, facts, accounted):
    return {
        'version': 1, 'scope': accounting.REPORT_SCOPE, 'runId': record['runId'], 'manifestSha256': record['manifestSha256'],
        'stagingScope': record['scope'], 'converterVersion': record['converterVersion'], 'planSha256': record['planSha256'],
        'checkpointSha256': record['checkpointSha256'], 'counts': _count_of(model),
        'resolvedReasons': accounted['resolved'], 'residualReasons': accounted['residual'], 'accounting': accounted['accounting'],
        'notConverted': sorted(({'sourceKey': _safe_key(entry['sourceKey']), 'kind': entry['kind'], 'reason': entry['reason'],
                                 'residual': entry['residual'], 'count': entry['count']} for entry in model['notConverted']),
                               key=lambda item: (item['sourceKey'], item['reason'])),
        'provenance': {'targets': len({(row['targetKind'], row['targetId']) for row in model['provenance']}), 'rows': len(model['provenance'])},
        'verification': {'checks': list(CHECKS)}}


def _verify(admission, repo, facts, record):
    """H: read the whole staging back and check it (DESIGN 8) against numbers counted from the verified copy and the backup. Returns the
    report body. A failing check stops here with the phase unchanged (`assembled`); nothing is repaired."""
    root, run_id = admission.root, admission.run_id
    state = store.staging_status(root, run_id)
    if state['state'] != 'resumable' or state['phase'] != 'assembled' or state['reasons']:
        _refuse(_P + 'verification-failed', ['status'])
    rows = store.read_writer_rows(root, run_id)
    plan_row, failures = rows['plan'], set()
    if plan_row is None:
        _refuse(_P + 'verification-failed', ['plan'])
    if (edit_content_hash(plan_row) != record['planSha256'] or plan_row['manifestSha256'] != record['manifestSha256']
            or plan_row['converterVersion'] != record['converterVersion']):
        failures.add('plan')
    elif [{key: unit[key] for key in ('seq', 'unitKind', 'targetId', 'payloadSha256')} for unit in rows['units']] != plan_row['units'] \
            or any(edit_content_hash(unit['payload']) != unit['payloadSha256'] for unit in rows['units']):
        failures.add('units')
    if failures:
        _refuse(_P + 'verification-failed', failures)
    # the repository's own view of the one checkpoint: the same roots as the units, the hash the run row names, no edit, no rejected batch
    stored = _read_back(repo.checkpoint, 'checkpoint')
    roots = [unit['payload'] for unit in rows['units']]
    assembled = {'version': 1, 'libraryId': facts['libraryId'], 'roots': roots, 'edits': []}
    if ({root['id']: root for root in stored['roots']} != {root['id']: root for root in roots} or len(stored['roots']) != len(roots) or stored['edits']
            or checkpoint_hash(assembled) != record['checkpointSha256']):
        failures.add('checkpoint')
    else:
        for root_snapshot in roots:
            if EditGraph({'version': 1, 'libraryId': facts['libraryId'], 'root': root_snapshot, 'batches': []}).view['rejected']:
                failures.add('checkpoint')
    model = _readback_model(rows, repo, plan_row)
    if checkpoint_resource_ids(assembled) != sorted(item['id'] for item in model['resources']) or state['counts']['resources'] != len(model['resources']):
        failures.add('resources')
    provenance = set()
    if any(row['converterVersion'] != record['converterVersion'] or row['manifestSha256'] != record['manifestSha256'] for row in rows['provenance']):
        provenance.add('provenance-header')
    # The whole ID table, every kind, against the hash the plan row carries: the same check in the first run and in every later one.
    if plan_row.get('idsSha256') != accounting.ids_hash(model['ids']):
        failures.add('ids-table')
    codes = accounting.check_conversion(model, facts)
    failures |= set(codes['verification'])
    provenance |= set(codes['provenance'])
    if failures:
        _refuse(_P + 'verification-failed', failures | provenance)
    if provenance:
        _refuse(_P + 'provenance-incomplete', provenance)
    accounted = accounting.account(facts['manifest'], facts['report'], model, facts, plan_residual=plan_row['residualReasons'])
    return _report(record, plan_row, model, facts, accounted)


def _seal(admission, auth, start):
    """I: the last look before the phase moves. A time-of-check confirmation, not a lock (B6-c low 5): the real guarantee is the switch of B8."""
    token = admission.token
    conversion_input._assert_external_writers(conversion_input._selection(token))
    if start is not None and _fingerprint(token) != start:
        _refuse(_P + 'source-changed')
    notebook_preview._still_admitted(token)
    with auth.write() as db:
        return store.seal_run(db, admission.run_id)


def _free_space_check(root, plan, stored=0):
    """Free space for the resources still to be stored (a resume has `stored` bytes of them already) and the margin."""
    needed = max(0, sum(item['byteLength'] for item in plan['resources']) - stored) + conversion_input.DISK_MARGIN_BYTES
    if shutil.disk_usage(store.staging_base(root).parent).free < needed:
        _refuse(_P + 'disk-insufficient')


def _assert_units_stored(root, run_id, plan, *, complete):
    """A resume (P6, P7): the units already stored are exactly the plan's, payload text included (the column alone could hide a changed
    payload). Checked BEFORE another unit is written: a conflict stops the resume with nothing more written (`staging-unit-conflict`)."""
    wanted = {unit['seq']: {key: unit[key] for key in ('seq', 'unitKind', 'targetId', 'payloadSha256')} for unit in plan['units']}
    stored = store.read_units(root, run_id)
    if (complete and len(stored) != len(wanted)) or any(
            row['seq'] not in wanted or {key: row[key] for key in wanted[row['seq']]} != wanted[row['seq']]
            or row['payloadComputedSha256'] != row['payloadSha256'] for row in stored):
        _refuse(_P + 'unit-conflict')


def _reseal(admission):
    """P9 (phase `verified`): the seal again, after the same looks a resume always takes. The manifest is rebuilt from the verified sources and
    must be the stored one (work B7-g; REVIEW-r161-b7f low 1), and the durable state must be what it was when this call began."""
    token, root, run_id = admission.token, admission.root, admission.run_id
    start = _fingerprint(token)
    _boundary(token, 'gather')
    manifest = conversion_input._build(token, False)['manifest']
    record = store.read_run_record(root, run_id)
    store.assert_resumable(record, manifest)
    _boundary(token, 'seal')
    _seal(admission, authority(admission, record['scope']), start)
    return store.read_staged_report(root, run_id)


def _worker(admission, convert):
    token, root, run_id = admission.token, admission.root, admission.run_id
    state, phase = admission.status['state'], admission.status['phase']
    if state == 'staged':
        return store.read_staged_report(root, run_id)               # DESIGN 5.2: nothing is written
    if phase == 'verified':
        return _reseal(admission)
    start = _fingerprint(token)
    _boundary(token, 'gather')
    built, hooked = _gather(admission)
    manifest, library_id = built['manifest'], built['manifest']['libraryId']
    entries = {tuple(entry['key']): entry for entry in hooked['entries']}
    facts = accounting.make_facts(manifest, built['report'], hooked['rows'], entries=hooked['entries'], collections=hooked['collections'],
                                  extractions=built['extractions'])
    if facts['webOps'] is None:
        _refuse(_P + 'unavailable')
    resumed = state == 'resumable'
    record = None
    if resumed:
        record = store.read_run_record(root, run_id)
        if record['phase'] != phase:
            _refuse(_P + 'state-unavailable')                         # the status read at admission and the run row must agree
        store.assert_resumable(record, manifest)                      # same run, same manifest (rebuilt), same converter version
    rank = store.PHASES.index(phase) if resumed else 0                # a new run starts as `initialized`
    if rank < store.PHASES.index('assembled'):
        _boundary(token, 'descriptors')
        descriptors = _descriptors(token, library_id, hooked['rows'], entries, hooked['read_entry'])
        _boundary(token, 'convert')
        try:
            plan = convert(deepcopy(_conversion_input(built, hooked, descriptors, facts['webOps'])))
        except ValueError as error:
            if error.args and error.args[0] in store.REASONS:
                raise
            _refuse(_P + 'unavailable')
        plan = deepcopy(plan)
        _boundary(token, 'validate')
        _plan_model(plan, facts, descriptors)
        plan_row = _plan_row(plan, manifest['manifestSha256'])
        if resumed:                                                   # a stored plan must be the plan the converter makes now
            store.assert_resumable(record, manifest, plan_sha256=edit_content_hash(plan_row))
        _free_space_check(root, plan, (admission.status['counts'] or {}).get('resourceBytes', 0) if resumed else 0)
        if not resumed:
            _boundary(token, 'initialize')
            inputs = NativeLegacyInputs(root).read(run_id)
            if inputs is None:
                _refuse(_P + 'state-unavailable')
            account_id = inputs['catalog']['identity']['accountId']
            record = store.initialize_run(root, run_id, account_id=account_id, manifest=manifest)
        if record is None:
            _refuse(_P + 'state-unavailable')
        scope = record['scope']
        repo = repository(admission, scope)
        auth = repo.authority
        if rank <= store.PHASES.index('initialized'):
            _write_resources(admission, repo, plan, facts, hooked, manifest['manifestSha256'], descriptors)
        if rank <= store.PHASES.index('resources'):
            _boundary(token, 'plan')
            with auth.write() as db:
                store.put_plan(db, run_id, plan_row, [e for e in plan['ids'] if e['kind'] != 'resource'],
                               [row for row in plan['provenance'] if row['targetKind'] != 'resource'], manifest_sha256=manifest['manifestSha256'])
        if resumed and rank >= store.PHASES.index('planned'):
            _assert_units_stored(root, run_id, plan, complete=rank >= store.PHASES.index('units'))
        if rank <= store.PHASES.index('planned'):
            for unit in plan['units']:
                _boundary(token, 'unit')
                with auth.write() as db:
                    store.put_unit(db, run_id, unit)
        _boundary(token, 'assemble')
        checkpoint = {'version': 1, 'libraryId': library_id, 'roots': [unit['payload'] for unit in plan['units']], 'edits': []}
        installed = store.read_checkpoint_hashes(root, run_id)
        if installed not in ([], [checkpoint_hash(checkpoint)]):
            _refuse(_P + 'plan-changed')                              # a checkpoint of another plan is never added to
        if not installed:                                             # P7 has it already: installing it again would change nothing
            try:
                repo.install_checkpoint(checkpoint)
            except ValueError as error:
                if error.args and error.args[0] in store.REASONS:
                    raise
                _refuse(_P + 'verification-failed', ['checkpoint-rejected'])
            except Exception:  # noqa: BLE001 - the repository's own refusals
                _refuse(_P + 'verification-failed', ['checkpoint-rejected'])
        with auth.write() as db:
            store.mark_assembled(db, run_id, scope, checkpoint_hash(checkpoint))
        record = store.read_run_record(root, run_id)
    else:                                                             # phase `assembled`: verify again, with the same result
        if record is None:
            _refuse(_P + 'state-unavailable')
        scope = record['scope']
        repo = repository(admission, scope)
    auth = repo.authority
    _boundary(token, 'verify')
    report = _verify(admission, repo, facts, record)
    with auth.write() as db:
        store.put_verification(db, run_id, report)
    _boundary(token, 'seal')
    _seal(admission, auth, start)
    return store.read_staged_report(root, run_id)


def _run(admission, convert):
    """The worker body: one closed reason for every failure; the gate is released at the very end."""
    try:
        return _worker(admission, convert)
    except ValueError as error:
        reason = reason_of(error)
        details = _codes(error.args[1]) if len(error.args) == 2 and error.args[0] == reason else None
        raise (ValueError(reason, details) if details else ValueError(reason)) from None
    except Exception as error:  # noqa: BLE001 - KeyError, TypeError, OSError, ... never echoed
        raise ValueError(reason_of(error)) from None
    finally:
        release(admission)


def start(run_id, convert):
    """Admit the run and start the writer on the gate's thread: (token, future). Refusals are ValueError('staging-<reason>').

    `convert(staging_input) -> plan` is the TypeScript converter, reached by the caller (the test bridge in work B7). It receives a copy
    of the input (manifest, Notebook extractions, rows, resource descriptors, Web ledger count) and its answer is never trusted."""
    if not callable(convert):
        raise ValueError(_P + 'unavailable')
    admission = admit(run_id)
    try:
        future = preview_gate.gate.start(admission.token, lambda _token: _run(admission, convert))
    except BaseException as error:  # noqa: BLE001
        release(admission)
        if isinstance(error, Exception):
            raise ValueError(_P + 'unavailable') from None
        raise
    return admission.token, future


def build(run_id, convert, *, timeout=600):
    """Stage the run and return the report, or raise ValueError('staging-<reason>'[, [check codes]]). An expired timeout cancels the writer
    (the thread is still waited for by the gate and so by shutdown)."""
    token, future = start(run_id, convert)
    done, _pending = wait_futures([future], timeout=timeout)
    if not done:
        token.cancel.set()
        raise ValueError(_P + 'cancelled')
    return future.result()


def report(run_id):
    """The report of a `staged` run, read-only (no gate, nothing written): the diagnostic path and `assert_staging_publishable` use it."""
    try:
        try:
            validate_id(run_id)
        except ValueError:
            raise ValueError(_P + 'state-unavailable') from None
        return store.read_staged_report(census._root(paths.selected_data_directory()), run_id)
    except Exception as error:  # noqa: BLE001
        raise ValueError(reason_of(error)) from None


def assert_staging_publishable(run_id):
    """ALWAYS refuses (DESIGN 5.5): a staging is not a publishable dataset in work B7, whatever its report says. The refusal carries the
    residual reasons of the run; a run that is not `staged` carries `staging-incomplete`. There is no value that passes."""
    try:
        residual = [str(item) for item in report(run_id)['residualReasons']]
    except Exception:  # noqa: BLE001 - any trouble reading the report is still a refusal
        residual = ['staging-incomplete']
    raise ValueError(_P + 'not-publishable', residual)
