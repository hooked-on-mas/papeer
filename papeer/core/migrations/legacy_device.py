"""Read only the current library's durable device footprint, before settings/history recovery.

No credential, process lock, log or OCR model is opened. History is normally limited
to this library; a damaged location keeps every potential history instead of guessing.
Unknown files with this library's key and interrupted atomic writes are preserved.
"""
import json
import os
from pathlib import Path
import re

from papeer.core import paths
from papeer.core.edit_contracts import validate_id
from papeer.core.migrations.legacy_backup import NativeLegacyBackup, _safe_stat, _same_handle

GLOBAL_FILES = frozenset({"device-settings.json", "storage-location.json", "history-settings.json", "ocr-settings.json"})


class NativeLegacyDeviceBackup(NativeLegacyBackup):
    def __init__(self, library_root: Path, device_root: Path | None = None, backup_root: Path | None = None):
        self.library = library_root.resolve()
        self.library_key = paths.library_key(self.library)
        self.history_keys: set[str] | None = {self.library_key}
        source = device_root if device_root is not None else paths.device_directory()
        destination = backup_root if backup_root is not None else self.library.with_name("." + self.library.name + "-shared-app-backups") / "device"
        super().__init__(source, destination, source_kind="desktop-device", select=self._selected,
                         selection_id=self._selection_identity(), allow_missing=True)

    def _selection_identity(self):
        return "device-records-v1:" + self.library_key

    def _selected(self, key):
        name = key[0]
        if name == "history":
            return len(key) == 1 or self.history_keys is None or key[1] in self.history_keys
        if len(key) > 1:
            return True  # Only reached below a selected top-level record/directory.
        return (name in GLOBAL_FILES or name.startswith(self.library_key + ".") or name.startswith("." + self.library_key + ".")
                or any(name.startswith("." + item + ".") and name.endswith(".tmp") for item in GLOBAL_FILES))

    def _location_matches(self, value):
        return value["path"] == str(self.library)

    def _location(self):
        path = self.source / "storage-location.json"
        if not path.exists() and not path.is_symlink() and not path.is_junction():
            return None
        before = _safe_stat(path)
        with path.open("rb") as stream:
            if not _same_handle(before, os.fstat(stream.fileno())):
                raise ValueError("backup-source-changed")
            return stream.read()

    def _scan(self, identity):
        validate_id(identity)
        location = self._location()
        self.history_keys = {self.library_key}
        if location is not None:
            try:
                value = json.loads(location)
                if not isinstance(value, dict) or not isinstance(value.get("path"), str) or not Path(value["path"]).is_absolute():
                    raise ValueError("unknown history location")
                key = value.get("history_key")
                if key is not None and (not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key)):
                    raise ValueError("unknown history key")
                if self._location_matches(value) and key:
                    self.history_keys.add(key)
            except (ValueError, UnicodeError):
                # Retain the damaged setting verbatim and all history it could have named.
                # Semantic recovery of that mapping is a later conversion decision.
                self.history_keys = None
        result = super()._scan(identity)
        if self._location() != location:
            raise ValueError("backup-source-changed")
        return result


class NativeLegacyHeldDeviceBackup(NativeLegacyDeviceBackup):
    """Selected operational history locks are held, not migration input bytes.

    A distinct selection identity preserves every existing v1 backup/reader.
    Other unknown/interrupted history files remain included verbatim.
    """
    def _selection_identity(self):
        return "device-records-v2-held-history:" + self.library_key

    def _selected(self, key):
        if len(key) == 3 and key[0] == 'history' and key[2] == '.lock':
            return False
        return super()._selected(key)

    def _location_matches(self, value):
        # Preserve a configured historical alias for equivalent Windows casing.
        # Existing v1 callers retain their exact original selection semantics.
        return Path(value['path']).absolute() == self.library
