"""The dependency license inventories (docs/dependency-license-inventory*.json) and tools/license_inventory.py."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import tomllib

import pytest

from tools.license_inventory import INVENTORY, SCHEMA_VERSION, SOURCE_FILES, TARGETS, WINDOWS, check, dumps, \
    host_target, inventory_files, platform_matches, python_inventory, refresh_source_hashes, source_hashes, \
    stale_sources, write

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def inventory():
    return json.loads((ROOT / INVENTORY).read_bytes())


def test_inventory_was_made_from_the_current_lock_files(inventory):
    stale = stale_sources(inventory, ROOT)
    assert not stale, (f"{', '.join(stale)} が {INVENTORY} の作成後に変わっています。"
                       "`just licenses` で台帳を作り直してコミットしてください。")
    assert [row["path"] for row in inventory["sourceFiles"]] == list(SOURCE_FILES)
    assert inventory["schemaVersion"] == SCHEMA_VERSION


def test_python_rows_are_exactly_the_locked_packages(inventory):
    # Independent of the hashes: the Python rows name every uv.lock package at its locked version.
    locked = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    expected = {(item["name"], item["version"]) for item in locked["package"] if item["name"] != "papeer"}
    assert {(row["name"], row["version"]) for row in inventory["packages"]["python"]} == expected


def test_summary_counts_the_rows(inventory):
    for ecosystem, rows in inventory["packages"].items():
        summary = inventory["summary"][ecosystem]
        assert summary["rows"] == len(rows)
        assert summary["unknownLicenseRows"] == sum(row["license"] == "unknown" for row in rows)
        assert summary["directRows"] == sum(row["dependencyType"] == "direct" for row in rows)


@pytest.mark.parametrize("path", inventory_files(ROOT))
def test_no_unknown_license_among_what_each_platform_uses(path):
    inventory = json.loads((ROOT / path).read_bytes())
    assert [row["path"] for row in inventory["sourceFiles"]] == list(SOURCE_FILES)
    packages = inventory["packages"]
    assert [row["name"] for row in packages["python"]
            if row["license"] == "unknown" and row["scopes"] != ["other-platform-in-lock"]] == []
    assert [row["name"] for row in packages["javascript"] if row["license"] == "unknown" and row["targetRelevant"]] == []
    assert [row["name"] for row in packages["rust"] if row["license"] == "unknown"] == []


def test_each_platform_has_its_own_inventory_and_the_windows_one_is_there():
    assert INVENTORY == "docs/dependency-license-inventory.json" == WINDOWS.inventory
    assert {target.inventory for target in TARGETS.values()} == {
        INVENTORY, "docs/dependency-license-inventory.macos-arm64.json",
        "docs/dependency-license-inventory.macos-x64.json", "docs/dependency-license-inventory.linux-x64.json"}
    assert inventory_files(ROOT)[0] == INVENTORY


@pytest.mark.parametrize(("system", "machine", "target"), [
    ("win32", "AMD64", "windows-x64"), ("darwin", "arm64", "macos-arm64"), ("darwin", "x86_64", "macos-x64"),
    ("linux", "x86_64", "linux-x64"), ("linux", "aarch64", None), ("win32", "ARM64", None)])
def test_the_inventory_made_here_is_this_machines_platforms(system, machine, target):
    found = host_target(system, machine)
    assert (found.name if found else None) == target


def test_optional_binaries_count_for_the_platforms_they_are_built_for():
    assert platform_matches(None, "win32")
    assert platform_matches(["darwin"], "darwin") and not platform_matches(["darwin"], "linux")
    assert not platform_matches(["!win32"], "win32") and platform_matches(["!win32"], "linux")
    # libc is Linux's only: a glibc build is not a musl one, and elsewhere no libc is asked for.
    assert platform_matches(["glibc"], "glibc") and not platform_matches(["musl"], "glibc")
    assert platform_matches(["musl"], None)


@pytest.mark.skipif(not (ROOT / ".venv").is_dir(), reason="needs the virtual environment (uv sync)")
def test_python_markers_choose_each_platforms_packages():
    def scopes(target: str) -> dict[str, list[str]]:
        return {row["name"]: row["scopes"] for row in python_inventory(ROOT, TARGETS[target])}

    windows, mac, linux = scopes("windows-x64"), scopes("macos-arm64"), scopes("linux-x64")
    assert "runtime" in windows["winrt-runtime"] and windows["pyobjc-core"] == ["other-platform-in-lock"]
    assert "runtime" in mac["pyobjc-core"] and mac["winrt-runtime"] == ["other-platform-in-lock"]
    assert linux["pyobjc-core"] == linux["winrt-runtime"] == ["other-platform-in-lock"]


def test_bundled_assets_match_the_files(inventory):
    fonts = [asset for asset in inventory["bundledAssets"] if "sha256" in asset]
    assert len(fonts) == 2
    for asset in fonts:
        data = (ROOT / "papeer/core/assets/fonts" / asset["name"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == asset["sha256"], asset["name"]
        assert (ROOT / asset["licenseEvidence"]).is_file()
    pdfjs = ROOT / "frontend/public/pdfjs"
    counts = {asset["name"].split(" copied")[0]: asset for asset in inventory["bundledAssets"]}
    assert counts["PDF.js CMaps"]["fileCountIncludingLicense"] == len(list((pdfjs / "cmaps").iterdir()))
    assert counts["PDF.js Foxit standard fonts"]["fontFileCount"] == len(list((pdfjs / "standard_fonts").glob("Foxit*.pfb")))
    assert counts["PDF.js Liberation Sans standard fonts"]["fontFileCount"] == len(
        list((pdfjs / "standard_fonts").glob("LiberationSans*.ttf")))


def test_the_file_is_written_as_the_generator_formats_it():
    # `just bump` loads and dumps it to refresh the hashes: that must not reformat anything else.
    text = (ROOT / INVENTORY).read_bytes().decode("utf-8")
    assert dumps(json.loads(text)) == text


@pytest.fixture
def repo(tmp_path):
    for relative in (*SOURCE_FILES, INVENTORY):
        (tmp_path / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, tmp_path / relative)
    return tmp_path


def test_a_changed_or_missing_lock_file_is_stale(repo):
    inventory = json.loads((repo / INVENTORY).read_bytes())
    assert stale_sources(inventory, repo) == []
    lock = repo / "frontend/pnpm-lock.yaml"
    lock.write_bytes(lock.read_bytes() + b"\n")
    (repo / "uv.lock").unlink()
    assert stale_sources(inventory, repo) == ["uv.lock", "frontend/pnpm-lock.yaml"]
    out = io.StringIO()
    assert not check(repo, out=out)
    assert "just licenses" in out.getvalue() and "frontend/pnpm-lock.yaml" in out.getvalue()
    # An inventory from before sourceFiles recorded hashes (schema 1: plain paths) is stale too.
    assert stale_sources({"sourceFiles": list(SOURCE_FILES)}, ROOT) == list(SOURCE_FILES)


def test_check_passes_for_the_current_files(repo):
    out = io.StringIO()
    assert check(repo, out=out)
    assert "一致" in out.getvalue()
    # Another platform's inventory is checked once it has been made (see the test below for when it is stale).
    assert "まだ作られていません" in out.getvalue()
    linux = repo / TARGETS["linux-x64"].inventory
    inventory = json.loads((repo / INVENTORY).read_bytes())
    linux.write_bytes(dumps(inventory).encode("utf-8"))
    assert check(repo, out=io.StringIO())
    linux.unlink()
    (repo / INVENTORY).unlink()
    assert not check(repo, out=io.StringIO())


def test_a_stale_inventory_for_another_platform_only_warns(repo):
    inventory = json.loads((repo / INVENTORY).read_bytes())
    linux = repo / TARGETS["linux-x64"].inventory
    linux.write_bytes(dumps({**inventory, "sourceFiles": []}).encode("utf-8"))
    out, err = io.StringIO(), io.StringIO()
    assert check(repo, out=out, err=err)
    assert "警告" in err.getvalue() and "licenses ジョブ" in err.getvalue() and "uv.lock" in err.getvalue()
    assert "警告" not in out.getvalue()
    # The Windows one being stale still fails.
    lock = repo / "frontend/pnpm-lock.yaml"
    lock.write_bytes(lock.read_bytes() + b"\n")
    assert not check(repo, out=io.StringIO(), err=io.StringIO())


def test_refresh_replaces_only_the_given_hashes(repo):
    text = (repo / INVENTORY).read_bytes().decode("utf-8")
    refreshed = refresh_source_hashes(text, {"uv.lock": b"changed"})
    before, after = json.loads(text), json.loads(refreshed)
    assert after["sourceFiles"][0] == {"path": "uv.lock", "sha256": hashlib.sha256(b"changed").hexdigest()}
    assert after["sourceFiles"][1:] == before["sourceFiles"][1:]
    assert {**after, "sourceFiles": None} == {**before, "sourceFiles": None}


def test_write_leaves_the_file_alone_when_only_the_date_would_change(repo):
    path = repo / INVENTORY
    inventory = json.loads(path.read_bytes())
    original = path.read_bytes()
    assert not write({**inventory, "auditDate": "2999-01-01"}, repo)
    assert path.read_bytes() == original
    changed = {**inventory, "auditDate": "2999-01-01", "sourceFiles": source_hashes(repo)[:1]}
    assert write(changed, repo)
    assert json.loads(path.read_bytes()) == changed
