"""Supported normal Windows local legacy preparation, not a global snapshot.

Real same-Library ownership + own drain protect content; actual selected history
locks protect old/new history APIs. Global device preferences are independently
versioned whole-file inputs, not a common transaction with the Library. No caller
path/boolean, PID absence or protocol marker alone grants this admission.
"""
from dataclasses import dataclass
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys

from papeer.core import cloud_drive_auth, paths
from papeer.core.device_authority import MaintenanceLease
from papeer.core.edit_storage import edit_storage_root
from papeer.core.instance import instance_key
from papeer.core.migrations.legacy_backup import _safe_stat
from sidecar import deps
from sidecar.lifecycle import instance
from .history import RetainedHistories

_controlled_roots = {}  # Test materializer only, never an HTTP input.


class CoverageUnresolved(ValueError):
    pass


def _root(path):
    value = Path(path).absolute()
    for parent in (value, *value.parents):
        _safe_stat(parent, directory=True)
    return value


def _identity(path):
    value = _safe_stat(path, directory=True)
    return value.st_dev, value.st_ino


def _location(device):
    file = device / 'storage-location.json'
    if not file.exists() and not file.is_symlink() and not file.is_junction():
        return None
    before = _safe_stat(file)
    if before.st_size > 65_536:
        raise CoverageUnresolved('maintenance-location-unreadable')
    raw = file.read_bytes()
    # Use the actual strict existing location validator, then bind its raw
    # version too. It reads only; it never applies a pending move or Settings.load.
    value = paths.storage_location_settings()
    after = _safe_stat(file)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise CoverageUnresolved('maintenance-location-changed')
    if raw != file.read_bytes():
        raise CoverageUnresolved('maintenance-location-changed')
    if value.get('pending') is not None:
        raise CoverageUnresolved('maintenance-pending-location-unresolved')
    return raw


def _history_refs(root, device, raw):
    keys = {paths.library_key(root)}
    if raw is not None:
        value = json.loads(raw)
        if Path(value['path']).absolute() == root and value.get('history_key'):
            keys.add(value['history_key'])
    base = device / 'history'
    if base.exists() or base.is_symlink() or base.is_junction():
        _safe_stat(base, directory=True)
    result = []
    for key in sorted(keys):
        folder = base / key
        if folder.exists() or folder.is_symlink() or folder.is_junction():
            result.append((key, _identity(folder)))
        else:
            result.append((key, None))
    return tuple(result)


def _fixed_windows_drive(root):
    if sys.platform != 'win32' or not root.drive or str(root).startswith('\\\\'):
        raise CoverageUnresolved('maintenance-local-volume-unverified')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    query = kernel.GetDriveTypeW
    query.argtypes, query.restype = [wintypes.LPCWSTR], wintypes.UINT
    if query(root.anchor) != 3:  # DRIVE_FIXED
        raise CoverageUnresolved('maintenance-local-volume-unverified')


def _managed_policy(root, device, lock, raw):
    if paths.app_env('DATA_DIR') or root != paths.default_data_directory().absolute():
        raise CoverageUnresolved('maintenance-custom-location-unresolved')
    _fixed_windows_drive(root)
    if raw is not None and Path(json.loads(raw)['path']).absolute() != root:
        raise CoverageUnresolved('maintenance-custom-location-unresolved')
    if not lock.writer_protocol_current(root):
        raise CoverageUnresolved('maintenance-instance-protocol-unverified')
    if not cloud_drive_auth.local_preparation_ready():
        raise CoverageUnresolved('maintenance-credential-operation-active')
    key = paths.library_key(root)
    for file in (device / (key + '.json'), device / (key + '.cloud-drive.json'),
                 device / 'google-drive-credentials.dpapi'):
        if file.exists() or file.is_symlink() or file.is_junction():
            raise CoverageUnresolved('maintenance-remote-or-sync-unresolved')
    canonical = edit_storage_root(root)
    if canonical.exists() or canonical.is_symlink() or canonical.is_junction():
        raise CoverageUnresolved('maintenance-canonical-provider-unresolved')
    folder = device / 'instances'
    _safe_stat(folder, directory=True)
    own = instance_key(root)
    allowed = {own + '.lock', own + '.json', own + '.writer-v1.json'}
    entries = list(folder.iterdir())
    if len(entries) > 512:
        raise CoverageUnresolved('maintenance-instance-census-unbounded')
    for file in entries:
        _safe_stat(file)
        if file.name not in allowed:
            raise CoverageUnresolved('maintenance-other-library-writers-unresolved')


@dataclass(frozen=True)
class NativeSelection:
    root: Path
    device: Path
    held_lock: object
    root_identity: tuple
    device_identity: tuple
    managed: bool
    location: bytes | None
    history_refs: tuple

    def assert_current(self):
        selected = _root(paths.selected_data_directory())
        device = _root(paths.device_directory())
        if selected != self.root or device != self.device or deps.get_data_dir().absolute() != self.root:
            raise CoverageUnresolved('maintenance-selection-changed')
        if _identity(selected) != self.root_identity or _identity(device) != self.device_identity:
            raise CoverageUnresolved('maintenance-selection-changed')
        if not instance.owns_library_lock(self.root, self.held_lock):
            raise CoverageUnresolved('maintenance-lock-unavailable')
        raw = _location(device)
        if raw != self.location or _history_refs(self.root, self.device, raw) != self.history_refs:
            raise CoverageUnresolved('maintenance-history-selection-changed')
        if self.managed:
            _managed_policy(self.root, self.device, self.held_lock, raw)

    def assert_coverage(self, lease: MaintenanceLease, histories: RetainedHistories):
        lease.assert_current()
        if lease.root != self.device or lease.identity != self.device_identity:
            raise CoverageUnresolved('maintenance-device-authority-mismatch')
        histories.assert_current()
        self.assert_current()


def select_current():
    root = _root(paths.selected_data_directory())
    device = _root(paths.device_directory())
    if deps.get_data_dir().absolute() != root:
        raise CoverageUnresolved('maintenance-selection-changed')
    lock = instance.current_library_lock(root)
    if lock is None:
        raise CoverageUnresolved('maintenance-lock-unavailable')
    raw = _location(device)
    registered = _controlled_roots.get((root, device))
    managed = registered != (lock, _identity(root), _identity(device))
    selection = NativeSelection(root, device, lock, _identity(root), _identity(device), managed,
                                raw, _history_refs(root, device, raw))
    selection.assert_current()
    return selection
