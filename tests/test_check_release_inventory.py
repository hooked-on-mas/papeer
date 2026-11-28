"""Release gates must reject missing/stale evidence on the actual build platform."""
from copy import deepcopy
from pathlib import Path

import pytest

from tools.check_release_inventory import check
from tools.license_inventory import SCHEMA_VERSION, SOURCE_FILES, TARGETS, source_hashes


@pytest.fixture
def inventory(tmp_path):
    for name in SOURCE_FILES:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("lock")
    (tmp_path / "LICENSE.evidence").write_text("License text")
    base = {"name": "dependency", "version": "1", "license": "MIT", "licenseEvidence": "LICENSE.evidence"}
    return {"schemaVersion": SCHEMA_VERSION, "target": TARGETS["linux-x64"].label + "; Python 3.12",
            "sourceFiles": source_hashes(tmp_path), "packages": {
                "python": [{**base, "scopes": ["runtime"]}],
                "javascript": [{**base, "scopes": ["production"], "targetRelevant": True}],
                "rust": [{**base, "scopes": ["normal-graph"]}],
            }}


def test_host_inventory_must_be_current_and_have_every_ecosystem(inventory, tmp_path):
    target = TARGETS["linux-x64"]
    assert check(inventory, tmp_path, target) == []
    assert "different platform" in " ".join(check(inventory, tmp_path, TARGETS["windows-x64"]))
    (tmp_path / SOURCE_FILES[0]).write_text("new lock")
    assert "stale source" in " ".join(check(inventory, tmp_path, target))
    del inventory["packages"]["rust"]
    assert "rust: missing package inventory" in check(inventory, tmp_path, target)


@pytest.mark.parametrize("ecosystem", ["python", "javascript", "rust"])
def test_unknown_runtime_licenses_and_missing_evidence_block_release(inventory, tmp_path, ecosystem):
    broken = deepcopy(inventory)
    broken["packages"][ecosystem][0]["license"] = "unknown"
    assert "missing license declaration" in " ".join(check(broken, tmp_path, TARGETS["linux-x64"]))
    (tmp_path / "LICENSE.evidence").unlink()
    assert "missing local license evidence" in " ".join(check(inventory, tmp_path, TARGETS["linux-x64"]))


def test_other_platform_optional_dependencies_do_not_block_release(inventory, tmp_path):
    inventory["packages"]["python"].append({"scopes": ["other-platform-in-lock"], "license": "unknown"})
    inventory["packages"]["javascript"].append({"scopes": ["production"], "targetRelevant": False, "license": "unknown"})
    assert check(inventory, tmp_path, TARGETS["linux-x64"]) == []


def test_cargo_evidence_can_use_the_inventory_home_abbreviation(inventory, tmp_path, monkeypatch):
    inventory["packages"]["rust"][0]["licenseEvidence"] = "~/registry/Cargo.toml"
    expanduser = Path.expanduser
    monkeypatch.setattr(Path, "expanduser", lambda path: tmp_path / "LICENSE.evidence"
                        if path.as_posix() == "~/registry/Cargo.toml" else expanduser(path))
    assert check(inventory, tmp_path, TARGETS["linux-x64"]) == []
