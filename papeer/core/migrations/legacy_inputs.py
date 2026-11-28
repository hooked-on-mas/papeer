"""Immutable, explicitly declared multi-peer raw-input plans; not a cutover/freeze marker."""
from copy import deepcopy
import json

from papeer.core.edit_contracts import validate_id, validate_legacymigrationcatalog, validate_legacymigrationinputset
from papeer.core.migrations.legacy_backup import (_directory, _publish, _read_metadata, _safe_stat,
                                                 assert_backup_plan, assert_read_limits)
from papeer.core.migrations.legacy_startup import NativeLegacyStartup


def _source_key(peer_id, source):
    return peer_id, source["kind"], source["id"]


def assert_migration_catalog(value):
    validate_legacymigrationcatalog(value)
    peers = [peer["id"] for peer in value["peers"]]
    keys = [_source_key(peer["id"], source) for peer in value["peers"] for source in peer["sources"]]
    if peers != sorted(set(peers)) or keys != sorted(set(keys)):
        raise ValueError("migration-source-order-or-duplicate")


def assert_migration_input_set(value):
    validate_legacymigrationinputset(value)
    assert_migration_catalog(value["catalog"])
    expected = [_source_key(peer["id"], source) for peer in value["catalog"]["peers"] for source in peer["sources"]]
    if [_source_key(item["peerId"], item["plan"]["manifest"]["source"]) for item in value["inputs"]] != expected:
        raise ValueError("migration-source-coverage")
    ids, shared = {value["catalog"]["runId"]}, {}
    for item in value["inputs"]:
        plan = item["plan"]
        assert_backup_plan(plan)
        manifest = plan["manifest"]
        if manifest["id"] in ids:
            raise ValueError("migration-backup-id-reused")
        ids.add(manifest["id"])
        if manifest["source"]["kind"] == "drive":
            source_id = manifest["source"]["id"]
            if source_id in shared and shared[source_id] != manifest["inventorySha256"]:
                raise ValueError("migration-shared-source-disagrees")
            shared[source_id] = manifest["inventorySha256"]


class NativeLegacyInputs:
    def __init__(self, library_root):
        self.startup = NativeLegacyStartup(library_root)
        self.root = self.startup.root / "bootstrap" / "inputs"

    def read(self, run_id, *, limits=None):
        validate_id(run_id)
        path = self.root / (run_id + ".json")
        if not path.exists() and not path.is_symlink() and not path.is_junction():
            return None
        for parent in (path.parent, *path.parent.parents):
            _safe_stat(parent, directory=True)
        _safe_stat(path)
        value = json.loads(_read_metadata(path, limits))
        assert_migration_input_set(value)
        if value["catalog"]["runId"] != run_id:
            raise ValueError("migration-input-set-identity")
        assert_read_limits([item["plan"]["manifest"] for item in value["inputs"]], limits)
        return value

    def prepare(self, value):
        stable = deepcopy(value)
        assert_migration_input_set(stable)
        run_id = stable["catalog"]["runId"]
        if self.startup.read() != {"version": 1, "runId": run_id}:
            raise ValueError("migration-hold-required")
        for parent in reversed((self.root, *self.root.parents)):
            _directory(parent)
        _publish(self.root / (run_id + ".json"),
                 json.dumps(stable, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
