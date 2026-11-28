"""Durable evidence for a Native preparation; never grants live writer ownership.

The active record and terminal events are immutable. All updates use the
existing backup publication lock and refuse conflicting identities.
"""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from papeer.core.edit_contracts import validate_id, validate_legacybackupsource
from papeer.core import paths
from papeer.core.fileio import replace_file, sync_directory
from papeer.core.migrations.legacy_backup import _directory, _publication_lock, _publish, _read_bounded_bytes, _safe_stat
from papeer.core.migrations.legacy_startup import NativeLegacyStartup


def selection_binding(root, device):
    """Read the same location/history identity as census; grants no lease."""
    root, device = Path(root).absolute(), Path(device).absolute()
    if paths.selected_data_directory().absolute() != root or paths.device_directory().absolute() != device:
        raise ValueError('maintenance-selection-changed')
    for path in (root, device):
        for parent in (path, *path.parents): _safe_stat(parent, directory=True)
    def identity(path):
        value = _safe_stat(path, directory=True)
        return value.st_dev, value.st_ino
    file = device / 'storage-location.json'
    raw = None
    if file.exists() or file.is_symlink() or file.is_junction():
        before = _safe_stat(file)
        if before.st_size > 65536: raise ValueError('maintenance-location-unreadable')
        raw = _read_bounded_bytes(file, 65_536)
        value = paths._parse_storage_location_settings(raw.decode('utf8')); after = _safe_stat(file)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or raw != _read_bounded_bytes(file, 65_536):
            raise ValueError('maintenance-location-changed')
        if value.get('pending') is not None: raise ValueError('maintenance-pending-location-unresolved')
    keys = {paths.library_key(root)}
    if raw is not None:
        value = json.loads(raw)
        if Path(value['path']).absolute() == root and value.get('history_key'):
            keys.add(value['history_key'])
    base = device / 'history'
    if base.exists() or base.is_symlink() or base.is_junction(): _safe_stat(base, directory=True)
    histories = []
    for key in sorted(keys):
        folder = base / key
        histories.append((key, identity(folder) if folder.exists() or folder.is_symlink() or folder.is_junction() else None))
    value = {'root': identity(root), 'device': identity(device), 'history': histories,
             'location': None if raw is None else hashlib.sha256(raw).hexdigest()}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf8')).hexdigest()


class NativePreparationJournal:
    def __init__(self, root):
        self.source = Path(root).absolute()
        self.startup = NativeLegacyStartup(root)
        self.folder = self.startup.root / 'bootstrap'
        self.active = self.folder / 'preparation-active.json'

    @staticmethod
    def _bytes(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf8')

    @staticmethod
    def _parents(path):
        for parent in reversed((path.parent, *path.parent.parents)):
            _directory(parent)

    @staticmethod
    def _record(value):
        if not isinstance(value, dict) or set(value) != {'version', 'runId', 'peerId', 'libraryId', 'sources', 'backupIds', 'selectionSha256', 'policy'}:
            raise ValueError('maintenance-journal-invalid')
        if type(value['version']) is not int or value['version'] != 1 or value['policy'] != 'native-local-capture-only-v1':
            raise ValueError('maintenance-journal-invalid')
        for key in ('runId', 'peerId', 'libraryId'):
            validate_id(value[key])
        if not isinstance(value['selectionSha256'], str) or not re.fullmatch('[0-9a-f]{64}', value['selectionSha256']):
            raise ValueError('maintenance-journal-invalid')
        if not isinstance(value['sources'], list) or not isinstance(value['backupIds'], list) or len(value['sources']) != 3 or len(value['backupIds']) != 3:
            raise ValueError('maintenance-journal-invalid')
        for source in value['sources']:
            validate_legacybackupsource(source)
        for identity in value['backupIds']:
            validate_id(identity)
        if len(set(value['backupIds'])) != 3 or len({(item['kind'], item['id']) for item in value['sources']}) != 3:
            raise ValueError('maintenance-journal-invalid')
        return value

    def read(self):
        if not self.active.exists() and not self.active.is_symlink() and not self.active.is_junction():
            return None
        for parent in (self.active.parent, *self.active.parent.parents):
            _safe_stat(parent, directory=True)
        return self._record(json.loads(_read_bounded_bytes(self.active, 65_536).decode('utf8')))

    def begin(self, record):
        value = self._record(deepcopy(record))
        previous = self.read()
        if previous is None or previous == value:
            self._parents(self.active)
            _publish(self.active, self._bytes(value))
        else:
            if (not self.event(previous['runId'], 'cancel-intent') or not self.event(previous['runId'], 'cancel-complete')
                    or self.cleanup_state(previous['runId']) != 'complete' or self.startup.read() is not None
                    or selection_binding(self.source, paths.device_directory()) != previous['selectionSha256']):
                raise ValueError('maintenance-journal-changed')
            archive = self.folder / 'preparation-archive' / (previous['runId'] + '.json')
            self._parents(archive)
            _publish(archive, self._bytes(previous))
            fd, name = tempfile.mkstemp(prefix='.preparation-', suffix='.tmp', dir=self.folder)
            temporary = Path(name)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(self._bytes(value)); stream.flush(); os.fsync(stream.fileno())
                with _publication_lock(self.startup.root):
                    if self.read() != previous or self.startup.read() is not None:
                        raise ValueError('maintenance-journal-changed')
                    if (not self.event(previous['runId'], 'cancel-intent') or not self.event(previous['runId'], 'cancel-complete')
                            or self.cleanup_state(previous['runId']) != 'complete'
                            or selection_binding(self.source, paths.device_directory()) != previous['selectionSha256']):
                        raise ValueError('maintenance-journal-changed')
                    replace_file(temporary, self.active)
                    sync_directory(self.folder)
            finally:
                temporary.unlink(missing_ok=True)
        if self.read() != value:
            raise ValueError('maintenance-journal-changed')
        return value

    def _event_path(self, run_id, kind):
        validate_id(run_id)
        if kind not in ('cancel-intent', 'cancel-complete'):
            raise ValueError('maintenance-journal-event')
        return self.folder / 'preparation-events' / run_id / (kind + '.json')

    def event(self, run_id, kind):
        path = self._event_path(run_id, kind)
        if not path.exists() and not path.is_symlink() and not path.is_junction():
            return False
        for parent in (path.parent, *path.parent.parents):
            _safe_stat(parent, directory=True)
        if json.loads(_read_bounded_bytes(path, 1024).decode('utf8')) != {'version': 1, 'runId': run_id, 'event': kind}:
            raise ValueError('maintenance-journal-event')
        return True

    def mark(self, record, kind):
        if self.read() != record:
            raise ValueError('maintenance-journal-changed')
        value = {'version': 1, 'runId': record['runId'], 'event': kind}
        path = self._event_path(record['runId'], kind)
        self._parents(path)
        _publish(path, self._bytes(value))
        if not self.event(record['runId'], kind) or self.read() != record:
            raise ValueError('maintenance-journal-changed')

    def mark_cleanup(self, record, attempt_id, phase):
        validate_id(attempt_id)
        if phase not in ('begin', 'complete') or self.read() != record:
            raise ValueError('maintenance-journal-event')
        event = {'version': 1, 'runId': record['runId'], 'attemptId': attempt_id, 'phase': phase}
        path = self.folder / 'preparation-events' / record['runId'] / ('cleanup-' + attempt_id + '-' + phase + '.json')
        self._parents(path)
        _publish(path, self._bytes(event))
        if self.read() != record or json.loads(_read_bounded_bytes(path, 1024).decode('utf8')) != event:
            raise ValueError('maintenance-journal-changed')

    def cleanup_state(self, run_id):
        validate_id(run_id)
        folder = self.folder / 'preparation-events' / run_id
        if not folder.exists() and not folder.is_symlink() and not folder.is_junction():
            return 'none'
        _safe_stat(folder, directory=True)
        begin, complete = set(), set()
        for path in folder.iterdir():
            if path.name in ('cancel-intent.json', 'cancel-complete.json'):
                self.event(run_id, path.stem)
                continue
            match = re.fullmatch(r'cleanup-([0-9a-f-]{36})-(begin|complete)\.json', path.name)
            if match is None:
                raise ValueError('maintenance-journal-event')
            attempt, phase = match.groups(); validate_id(attempt)
            if json.loads(_read_bounded_bytes(path, 1024).decode('utf8')) != {'version': 1, 'runId': run_id, 'attemptId': attempt, 'phase': phase}:
                raise ValueError('maintenance-journal-event')
            (begin if phase == 'begin' else complete).add(attempt)
        if not complete.issubset(begin):
            raise ValueError('maintenance-journal-event')
        return 'none' if not begin else 'complete' if begin == complete else 'pending'

