"""Retained server-owned Native preparation, guarded by explicit writer coverage.

Unknown actual-profile/global-device/external writers still refuse admission.
No caller path, subset or quiescence boolean creates a preparation capability.
"""
from copy import deepcopy
import json
import re
import threading
import time
from uuid import uuid4

from papeer.core import paths
from papeer.core.device_authority import reserve_maintenance
from papeer.core.edit_storage import edit_storage_root
from papeer.core.migrations.legacy_backup import NativeLegacyBackup, _publication_lock, _safe_stat
from papeer.core.fileio import sync_directory
from papeer.core.migrations.legacy_device import NativeLegacyHeldDeviceBackup
from papeer.core.migrations.legacy_inputs import NativeLegacyInputs
from papeer.core.migrations.legacy_preparation_journal import NativePreparationJournal, selection_binding
from papeer.core.migrations.legacy_startup import NativeLegacyStartup
from sidecar import deps
from sidecar.lifecycle import instance
from sidecar.canonical_host import authority
from sidecar.routes import provider_owner
from . import census, preview_gate
from .history import retain_selected_histories

_current = None
_entry_lock = threading.RLock()


def _selection_digest(selection):
    """Bind location bytes and selected history identities, never a live lock."""
    selection.assert_current()
    value = selection_binding(selection.root, selection.device)
    selection.assert_current()
    return value


class NativePreparation:
    """The same retained coordinator, bound to an actual instance-owned selection."""
    def __init__(self, selection, record=None, action='capture'):
        self._selection = selection
        self.root = selection.root
        self.device = selection.device
        self._lock = threading.RLock()
        self._library_lock = None
        self._thread = None
        self._done = threading.Event()
        self._reserved = False
        self._pinned = False
        self._state = 'ready'
        self._phase = 'not-started'
        self._failure = None
        self._run = str(uuid4())
        self._peer = str(uuid4())
        self._library = str(uuid4())
        self._backup_ids = tuple(str(uuid4()) for _ in range(3))
        self._input_set = None
        self._closed = False
        self._tokens = ()
        self._provider = None
        self._provider_stop_known = False
        self._device_lease = None
        self._history_lease = None
        self._cleanup_id = str(uuid4())
        self._record = deepcopy(record)
        self._action = action
        if record is not None:
            self._run = record['runId']
            self._peer = record['peerId']
            self._library = record['libraryId']
            self._backup_ids = tuple(record['backupIds'])

    def _selected(self):
        self._selection.assert_current()

    def _sources(self):
        return (NativeLegacyBackup(self.root),
                NativeLegacyBackup(edit_storage_root(self.root), allow_missing=True),
                NativeLegacyHeldDeviceBackup(self.root, device_root=self.device))

    def status(self):
        with self._lock:
            return {'runId': self._run, 'state': self._state, 'phase': self._phase,
                    'failure': self._failure, 'scope': 'native-preparation-only'}

    def start(self):
        """Reserve and return; the caller's counted request must finish normally."""
        with self._lock:
            if self._closed: raise ValueError('controlled-copy-closed')
            if self._thread is not None: return self.status()
            self._selected()
            location = self.device / 'storage-location.json'
            if location.exists():
                _safe_stat(location)
                value = json.loads(location.read_text('utf8'))
                if not isinstance(value, dict) or value.get('pending') is not None:
                    raise ValueError('controlled-copy-unresolved-location')
            # This is a real OS LibraryLock; an unheld/failed lock never admits capture.
            self._library_lock = instance.retain_for_maintenance(self, self.root)
            if not instance.activity.begin_request():
                instance.abandon_maintenance(self)
                raise ValueError('controlled-copy-lifetime-unavailable')
            self._pinned = True
            try:
                deps.reserve_library_maintenance(self)
                self._reserved = True
                self._manager = deps.job_manager
                self._state = 'running'; self._phase = 'draining'
                self._thread = threading.Thread(target=self._work, name='Native-controlled-copy', daemon=True)
                self._thread.start()
            except BaseException:
                if self._thread is not None:
                    # Thread.start can be interrupted after native launch. An
                    # unknown start must keep the owner/fence, never reopen it.
                    self._phase = 'start-unknown'
                    self._failure = 'controlled-copy-start-unknown'
                    raise
                if self._reserved: deps.release_library_maintenance(self); self._reserved = False
                instance.activity.end_request(); self._pinned = False
                instance.abandon_maintenance(self)
                raise
            return self.status()

    def _work(self):
        try:
            self._manager.close()
            # Fence transaction owners under their real registry lock. Every
            # enrollment token is cancelled before waiting outside that lock.
            with authority._lock:
                self._tokens = authority._offline_jobs.close()
                authority.revoke_all()
            # begin_shutdown may block. This owned worker remains registered,
            # keeping admission, Activity pin and real LibraryLock throughout.
            self._provider = provider_owner.stop_if_created()
            self._provider_stop_known = True
            if not self._manager.wait_idle(5): raise ValueError('controlled-copy-jobs-incomplete')
            if not deps.wait_for_library_requests(5): raise ValueError('controlled-copy-requests-incomplete')
            deadline = time.monotonic() + 5
            if any(not token.done.wait(max(0, deadline - time.monotonic())) for token in self._tokens):
                raise ValueError('controlled-copy-offline-jobs-incomplete')
            if self._provider is not None and not self._provider.finish_shutdown(5):
                raise ValueError('controlled-copy-provider-incomplete')
            with authority._lock:
                # A request admitted before the reservation may have minted a
                # late lease; no request/registered writer remains now.
                authority.revoke_all()
            # Acquire only AFTER our own drains: an admitted request may itself
            # need the writer lease. Never hold it while waiting for that request.
            self._device_lease = reserve_maintenance(timeout=5)
            self._selection.assert_current()
            self._history_lease = retain_selected_histories(self._selection, timeout=5)
            self._selection.assert_coverage(self._device_lease, self._history_lease)
            self._selected()
            if self._library_lock is None or not self._library_lock.held: raise ValueError('controlled-copy-lock-lost')
            if deps.job_manager is not self._manager: raise ValueError('controlled-copy-owner-changed')
            # Re-read deferred locations after drain: a previously admitted
            # settings request could have created a pending destination.
            location = self.device / 'storage-location.json'
            if location.exists():
                _safe_stat(location)
                value = json.loads(location.read_text('utf8'))
                if not isinstance(value, dict) or value.get('pending') is not None:
                    raise ValueError('controlled-copy-unresolved-location')
            with self._lock: self._phase = 'capturing'
            sources = self._sources()
            journal = NativePreparationJournal(self.root)
            record = {'version': 1, 'runId': self._run, 'peerId': self._peer, 'libraryId': self._library,
                      'sources': [deepcopy(source.store.source) for source in sources], 'backupIds': list(self._backup_ids),
                      'selectionSha256': _selection_digest(self._selection),
                      'policy': 'native-local-capture-only-v1'}
            if self._record is not None and self._record != record:
                raise ValueError('maintenance-selection-changed')
            journal.begin(record)
            self._record = record
            startup = NativeLegacyStartup(self.root)
            hold = startup.read()
            if hold is not None and hold != {'version': 1, 'runId': self._run}:
                raise ValueError('maintenance-hold-mismatch')
            if self._action == 'cancel':
                journal.mark(record, 'cancel-intent')
                journal.mark_cleanup(record, self._cleanup_id, 'begin')
                self._selection.assert_coverage(self._device_lease, self._history_lease)
                with _publication_lock(startup.root):
                    if journal.read() != record or startup.read() not in (None, {'version': 1, 'runId': self._run}):
                        raise ValueError('maintenance-hold-mismatch')
                    if startup.read() is not None:
                        _safe_stat(startup.path)
                        startup.path.unlink()
                        sync_directory(startup.path.parent)
                journal.mark(record, 'cancel-complete')
                with self._lock:
                    self._phase = 'restart-required'; self._state = 'cancelled'
                return
            if journal.event(self._run, 'cancel-intent'):
                raise ValueError('maintenance-cancel-incomplete')
            startup.hold({'version': 1, 'runId': self._run})
            existing = NativeLegacyInputs(self.root).read(self._run)
            if existing is None:
                plans = [source.inventory(identity) for source, identity in zip(sources, self._backup_ids, strict=True)]
            else:
                if existing['catalog']['identity']['libraryId'] != self._library:
                    raise ValueError('maintenance-input-set-mismatch')
                plans = []
                for source, identity in zip(sources, self._backup_ids, strict=True):
                    matches = [entry['plan'] for entry in existing['inputs'] if entry['peerId'] == self._peer
                               and entry['plan']['manifest']['source'] == source.store.source
                               and entry['plan']['manifest']['id'] == identity]
                    if len(matches) != 1:
                        raise ValueError('maintenance-input-set-mismatch')
                    source.assert_current(matches[0]); plans.append(matches[0])
            ordered = sorted(zip(sources, plans, strict=True), key=lambda pair: (pair[1]['manifest']['source']['kind'], pair[1]['manifest']['source']['id']))
            value = {'catalog': {'version': 1, 'runId': self._run,
                     'identity': {'accountId': 'native-local' if self._selection.managed else 'controlled-copy-local', 'libraryId': self._library},
                     'peers': [{'id': self._peer, 'sources': [deepcopy(plan['manifest']['source']) for _, plan in ordered]}]},
                     'inputs': [{'peerId': self._peer, 'plan': deepcopy(plan)} for _, plan in ordered]}
            if existing is not None and existing != value:
                raise ValueError('maintenance-input-set-mismatch')
            NativeLegacyInputs(self.root).prepare(value)
            for source, plan in ordered: source.capture(plan)
            for source, plan in ordered: source.assert_current(plan)
            # Fresh stores cold-load immutable metadata/body hashes; never open
            # the live original's SQL, replay WAL or initialize a Library.
            if NativeLegacyInputs(self.root).read(self._run) != value:
                raise ValueError('controlled-copy-input-set-mismatch')
            for source, plan in zip(self._sources(), plans, strict=True):
                identity = plan['manifest']['id']
                if source.load(identity) != plan['manifest'] or source.plan(identity) != plan:
                    raise ValueError('controlled-copy-readback-mismatch')
                for entry in plan['manifest']['entries']: source.object(identity, entry)
                with source.analysis_copy(identity):
                    pass
            for source, plan in ordered: source.assert_current(plan)
            self._selection.assert_coverage(self._device_lease, self._history_lease)
            self._selected()
            if self._library_lock is None or not self._library_lock.held: raise ValueError('controlled-copy-lock-lost')
            with self._lock:
                self._input_set = value; self._phase = 'cold-readback-complete'; self._state = 'captured'
        except Exception as error:  # noqa: BLE001 - retain failed capture and its fence; never resume a partial outcome
            with self._lock:
                self._state = 'failed'
                self._failure = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z][a-z0-9-]{0,95}', str(error)) else type(error).__name__
        finally:
            self._done.set()
            # Admission, lifetime and lock intentionally remain retained even
            # after failure/timeout. Only explicit isolated-runtime disposal ends them.

    def wait(self, timeout):
        self._done.wait(timeout)
        return self.status()

    def abandon(self, run_id):
        """Cancel only a quiescent capture, retaining the live fences until exit."""
        with self._lock:
            if run_id != self._run or not self._done.is_set() or self._record is None or self._thread is None or self._thread.is_alive():
                raise ValueError('maintenance-cancel-unavailable')
            evidence = _durable_recovery_status()
            if evidence is None or evidence.get('runId') != run_id or evidence.get('phase') not in ('not-collected', 'hold-only', 'partial', 'artifacts-verified', 'cancel-interrupted'):
                raise ValueError('maintenance-cancel-unavailable')
            if self._device_lease is None or self._history_lease is None or self._library_lock is None or not self._library_lock.held:
                raise ValueError('maintenance-cancel-unavailable')
            self._selection.assert_coverage(self._device_lease, self._history_lease)
            journal = NativePreparationJournal(self.root)
            record, startup = self._record, NativeLegacyStartup(self.root)
            if record['selectionSha256'] != _selection_digest(self._selection):
                raise ValueError('maintenance-selection-changed')
            journal.mark(record, 'cancel-intent')
            journal.mark_cleanup(record, self._cleanup_id, 'begin')
            with _publication_lock(startup.root):
                if journal.read() != record or startup.read() not in (None, {'version': 1, 'runId': run_id}):
                    raise ValueError('maintenance-hold-mismatch')
                if startup.read() is not None:
                    _safe_stat(startup.path)
                    startup.path.unlink()
                    sync_directory(startup.path.parent)
            journal.mark(record, 'cancel-complete')
            self._state = 'cancelled'; self._phase = 'restart-required'
            return self.status()

    def ready_for_release(self):
        return self._closed and (self._thread is None or not self._thread.is_alive())

    def shutdown_wait(self, timeout):
        """Never join the counted request from its own start handler or worker."""
        if self._thread is threading.current_thread(): return False
        deadline = time.monotonic() + max(0, timeout)
        if self._thread is not None:
            self._thread.join(max(0, deadline - time.monotonic()))
            if self._thread.is_alive(): return False
        with self._lock:
            if self._closed: return True
            if (not self._manager.wait_idle(max(0, deadline - time.monotonic()))
                    or not deps.wait_for_library_requests(max(0, deadline - time.monotonic()))
                    or any(not token.done.wait(max(0, deadline - time.monotonic())) for token in self._tokens)):
                return False
            if (not self._provider_stop_known or self._provider is not None
                    and not self._provider.finish_shutdown(max(0, deadline - time.monotonic()))):
                return False
            journal = NativePreparationJournal(self.root) if self._record is not None else None
            if journal is not None:
                try: journal.mark_cleanup(self._record, self._cleanup_id, 'begin')
                except (OSError, ValueError):
                    self._phase = 'cleanup-unknown'; self._failure = 'maintenance-cleanup-journal-unknown'; return False
            if self._history_lease is not None:
                try:
                    self._history_lease.release()
                except (OSError, ValueError):
                    self._phase = 'cleanup-unknown'
                    self._failure = 'maintenance-history-cleanup-unknown'
                    return False
                self._history_lease = None
            if self._device_lease is not None:
                self._device_lease.release()
                self._device_lease = None
            if journal is not None:
                try: journal.mark_cleanup(self._record, self._cleanup_id, 'complete')
                except (OSError, ValueError):
                    self._phase = 'cleanup-unknown'; self._failure = 'maintenance-cleanup-journal-unknown'; return False
            self._closed = True
            if self._pinned: instance.activity.end_request(); self._pinned = False
            instance.finish_maintenance(self)
            return True


def _durable_recovery_status(limits=None, cancel=None):
    """Read-only interruption classification; not a journal or reacquired lease.

    Only a validated hold supplies runId. An orphan/corrupt bootstrap footprint
    never becomes idle or a fabricated captured run; it needs explicit recovery.
    Optional `limits` bound metadata/entry/byte reads and `cancel` (an Event) stops
    the streamed object hashing; the defaults keep the unbounded classification
    used by status/start/recover. Only when `limits` is given, a limit overrun
    (backup-read-limit) is raised as such instead of being folded into the
    'unreadable' classification, so that a caller can report "over the limit".
    """
    result = {'state': 'recovery-required', 'phase': 'interrupted',
              'failure': 'maintenance-interrupted', 'scope': 'native-preparation-only'}
    try:
        # Validate raw known-folder identities before resolving a selected path
        # through device storage-location metadata. Do not create any directory.
        device = paths.device_directory().absolute()
        for parent in reversed((device, *device.parents)):
            if parent.exists() or parent.is_symlink() or parent.is_junction():
                _safe_stat(parent, directory=True)
        root = paths.selected_data_directory().absolute()
        current = instance.current_library_root()
        if current is not None and current.absolute() != root:
            raise ValueError('maintenance-selection-changed')
        for parent in reversed((root, *root.parents)):
            if parent.exists() or parent.is_symlink() or parent.is_junction():
                _safe_stat(parent, directory=True)
        startup = NativeLegacyStartup(root)
        bootstrap = startup.path.parent
        for parent in reversed((bootstrap, *bootstrap.parents)):
            if parent.exists() or parent.is_symlink() or parent.is_junction():
                _safe_stat(parent, directory=True)
        if not bootstrap.exists():
            return None
        if startup.path.exists() or startup.path.is_symlink() or startup.path.is_junction():
            if _safe_stat(startup.path).st_size > 65_536:
                raise ValueError('maintenance-hold-unreadable')
        hold = startup.read()
        journal = NativePreparationJournal(root)
        record = journal.read()
        if record is None:
            if hold is not None: result['runId'] = hold['runId']
            result['failure'] = 'maintenance-durable-state-unverified'
            return result
        run_id = record['runId']; result['runId'] = run_id
        if hold is not None and hold != {'version': 1, 'runId': run_id}:
            raise ValueError('maintenance-hold-mismatch')
        # The recorded folder names alone do not identify the selected device,
        # history and location settings after a restart.
        if selection_binding(root, device) != record['selectionSha256']:
            raise ValueError('maintenance-selection-changed')
        intent = journal.event(run_id, 'cancel-intent')
        complete = journal.event(run_id, 'cancel-complete')
        cleanup = journal.cleanup_state(run_id)
        if cleanup == 'pending' or complete and cleanup != 'complete':
            result['phase'] = 'cleanup-unknown'; result['failure'] = 'maintenance-cleanup-unknown'; return result
        if complete:
            if not intent or hold is not None: raise ValueError('maintenance-cancel-incomplete')
            if selection_binding(root, device) != record['selectionSha256']:
                raise ValueError('maintenance-selection-changed')
            return {'state': 'cancelled', 'phase': 'restart-complete', 'runId': run_id,
                    'scope': 'native-preparation-only'}
        if intent:
            result['phase'] = 'cancel-interrupted'; return result
        sources = (NativeLegacyBackup(root), NativeLegacyBackup(edit_storage_root(root), allow_missing=True),
                   NativeLegacyHeldDeviceBackup(root, device_root=device))
        if [source.store.source for source in sources] != record['sources']:
            raise ValueError('maintenance-selection-changed')
        value = NativeLegacyInputs(root).read(run_id, limits=limits)
        if value is None:
            result['phase'] = 'hold-only' if hold else 'not-collected'
            return result
        if hold is None or value['catalog']['identity']['libraryId'] != record['libraryId']:
            raise ValueError('maintenance-input-set-mismatch')
        complete_count = 0
        for source, identity in zip(sources, record['backupIds'], strict=True):
            matches = [entry['plan'] for entry in value['inputs'] if entry['peerId'] == record['peerId']
                       and entry['plan']['manifest']['source'] == source.store.source
                       and entry['plan']['manifest']['id'] == identity]
            if len(matches) != 1: raise ValueError('maintenance-input-set-mismatch')
            plan = source.plan(identity, limits=limits)
            manifest = source.load(identity, limits=limits, cancel=cancel)
            if plan is not None and plan != matches[0]: raise ValueError('maintenance-input-set-mismatch')
            if manifest is not None:
                if plan != matches[0] or manifest != matches[0]['manifest']:
                    raise ValueError('maintenance-input-set-mismatch')
                # load() already verifies every object by streaming its hash.
                # Reading each full body again is unbounded and adds no proof.
                complete_count += 1
        if selection_binding(root, device) != record['selectionSha256']:
            raise ValueError('maintenance-selection-changed')
        result['phase'] = 'artifacts-verified' if complete_count == 3 else 'partial'
        return result
    except (OSError, ValueError, RecursionError) as error:
        if limits is not None and isinstance(error, ValueError) and str(error) == 'backup-read-limit':
            raise
        result['failure'] = 'maintenance-durable-state-unreadable'
        return result


def start():
    global _current
    with _entry_lock:
        if _current is not None:
            _current._selection.assert_current()
            return _current.status()
        # A cold capture would wait for the counted preview request and fail
        # with controlled-copy-requests-incomplete; refuse before starting.
        if preview_gate.gate.inflight():
            raise ValueError('maintenance-preview-pending')
        previous = _durable_recovery_status()
        if previous is not None and previous['state'] != 'cancelled':
            raise census.CoverageUnresolved('maintenance-recovery-required')
        selection = census.select_current()
        operation = NativePreparation(selection)
        # Register before launch so lost delivery never starts a second operation.
        _current = operation
        try: return operation.start()
        except BaseException:
            if operation._thread is None: _current = None
            raise


def status():
    with _entry_lock:
        if _current is not None:
            return _current.status()
        recovery = _durable_recovery_status()
        return recovery if recovery is not None else {'state': 'idle', 'scope': 'native-preparation-only'}


def recover(run_id, action):
    """Restart capture or abandon, always using this process's real selection."""
    global _current
    if action not in ('capture', 'cancel'):
        raise ValueError('maintenance-action-invalid')
    with _entry_lock:
        # Resume and abandon never run beside a read-only preview of the same backup.
        if preview_gate.gate.inflight():
            raise ValueError('maintenance-preview-pending')
        if _current is not None:
            if _current._run != run_id: raise ValueError('maintenance-run-mismatch')
            if action == 'cancel' and _current.status()['state'] == 'cancelled': return _current.status()
            if action == 'cancel': return _current.abandon(run_id)
            return _current.status()
        recovery = _durable_recovery_status()
        if action == 'cancel' and recovery is not None and recovery.get('state') == 'cancelled' and recovery.get('runId') == run_id:
            return recovery
        if recovery is None or recovery.get('state') != 'recovery-required' or recovery.get('runId') != run_id:
            raise ValueError('maintenance-recovery-unavailable')
        if recovery.get('phase') not in ('not-collected', 'hold-only', 'partial', 'artifacts-verified', 'cancel-interrupted'):
            raise ValueError('maintenance-recovery-unavailable')
        if action == 'capture' and recovery.get('phase') == 'cancel-interrupted':
            raise ValueError('maintenance-recovery-unavailable')
        selection = census.select_current()
        record = NativePreparationJournal(selection.root).read()
        if record is None or record['runId'] != run_id:
            raise ValueError('maintenance-recovery-unavailable')
        operation = NativePreparation(selection, record, action)
        _current = operation
        try: return operation.start()
        except BaseException:
            if operation._thread is None: _current = None
            raise


def shutdown_wait(timeout):
    owner = instance.maintenance_owner()
    return owner is None or owner.shutdown_wait(timeout)


def admit_preview(run_id):
    """Admit one read-only Notebook preview, or raise ValueError with a reason code.

    Only the admission is under _entry_lock (so start/resume/abandon order against it);
    the extraction itself holds no coordinator lock, keeping status() responsive.
    """
    gate = preview_gate.gate
    with _entry_lock:
        if gate.closed:
            raise ValueError('preview-shutdown-pending')
        owner = _current
        if owner is not None:
            try:
                thread = owner._thread
                if (owner._run != run_id or owner.status()['state'] != 'captured' or thread is None or thread.is_alive()
                        or owner._closed or owner._library_lock is None or not owner._library_lock.held
                        or owner._device_lease is None or owner._history_lease is None
                        or owner._record is None):
                    raise ValueError('preview-state-unavailable')
                owner._selection.assert_coverage(owner._device_lease, owner._history_lease)
                if owner._record['selectionSha256'] != _selection_digest(owner._selection):
                    raise ValueError('preview-state-unavailable')
            except Exception as error:  # noqa: BLE001 - any doubt about the live owner refuses
                raise ValueError('preview-state-unavailable') from error
            return gate.admit(run_id, 'live', owner)
        if instance.maintenance_owner() is not None or deps.maintenance_running():
            raise ValueError('preview-state-unavailable')
        return gate.admit(run_id, 'cold', None)


def wait_for_shutdown():
    # A domestic app/lifespan exit cannot abandon a live capture or a running
    # preview reader. Forced OS termination remains an interruption with
    # partial artifacts (and possibly an .analysis-* folder), never success.
    #
    # r153 review: the preview reader is waited for FIRST. owner.shutdown_wait releases
    # the device/history leases and finishes the maintenance, which must never happen
    # while a preview thread may still read the backup. Closing the gate (sticky) makes
    # this path cancel a running preview even when it was not reached through stop_work
    # (for example the ASGI lifespan).
    preview_gate.gate.close()
    while not preview_gate.gate.wait_idle(.2): time.sleep(.05)
    while not shutdown_wait(.2): time.sleep(.05)
