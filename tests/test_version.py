"""The app version: one MAJOR.MINOR.PATCH in every manifest, `just bump`, the CHANGELOG and /health."""
from datetime import date
import io
import json
from pathlib import Path
import re
import shutil

import pytest

import papeer
from tools.bump_version import CHANGELOG, SPOTS, VersionError, bump, check, cut_changelog, main, parse_version, \
    read_versions, release_notes

ROOT = Path(__file__).resolve().parents[1]


def test_every_manifest_carries_the_same_version():
    versions = read_versions(ROOT)
    assert {spot.path for spot in SPOTS} >= {"pyproject.toml", "frontend/package.json",
                                             "frontend/src-tauri/tauri.conf.json", "frontend/src-tauri/Cargo.toml"}
    assert set(versions.values()) == {papeer.__version__}, versions
    parse_version(papeer.__version__)
    assert check(ROOT, out=io.StringIO())


def test_changelog_keeps_an_unreleased_section():
    text = (ROOT / CHANGELOG).read_text(encoding="utf-8")
    assert re.search(r"^## \[Unreleased\]$", text, re.M)
    assert re.search(r"^\[Unreleased\]: https://github\.com/", text, re.M)


@pytest.mark.parametrize("value", ["1.2", "1.2.3.4", "01.2.3", "1.2.3-beta.1", "1.2.3+build", "v1.2.3",
                                   "256.0.0", "0.256.0", "0.0.65536", ""])
def test_versions_the_installers_cannot_take_are_refused(value):
    with pytest.raises(VersionError):
        parse_version(value)


def test_plain_semver_within_msi_limits_is_accepted():
    assert parse_version("0.10.2") == (0, 10, 2)
    assert parse_version("255.255.65535") == (255, 255, 65535)


@pytest.fixture
def repo(tmp_path):
    for relative in [spot.path for spot in SPOTS] + [CHANGELOG]:
        (tmp_path / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, tmp_path / relative)
    return tmp_path


def changed_lines(before: str, after: str) -> list[tuple[str, str]]:
    old, new = before.split("\n"), after.split("\n")
    assert len(old) == len(new)
    return [(a, b) for a, b in zip(old, new) if a != b]


def test_bump_rewrites_only_the_project_version(repo):
    current = papeer.__version__
    major, minor, patch = parse_version(current)
    target = f"{major}.{minor + 1}.0"
    before = {spot.path: (repo / spot.path).read_bytes().decode("utf-8") for spot in SPOTS}
    expected_notes = release_notes((repo / CHANGELOG).read_text(encoding="utf-8"), "Unreleased")

    bump(target, root=repo, today=date(2026, 10, 1), out=io.StringIO())

    assert set(read_versions(repo).values()) == {target}
    for spot in SPOTS:
        after = (repo / spot.path).read_bytes().decode("utf-8")
        # One line each: dependencies in the lock files keep their versions, and LF stays LF.
        [(old, new)] = changed_lines(before[spot.path], after)
        assert old.replace(current, target) == new, spot.path
        assert "\r\n" not in after
    log = (repo / CHANGELOG).read_text(encoding="utf-8")
    assert f"## [Unreleased]\n\n## [{target}] - 2026-10-01\n" in log
    assert f"[Unreleased]: https://github.com/fukao-m/paperdesk/compare/v{target}...HEAD" in log
    assert f"[{target}]: https://github.com/fukao-m/paperdesk/releases/tag/v{target}" in log
    notes = release_notes(log, target)
    assert notes == expected_notes and "[Unreleased]" not in notes and "## [" not in notes


def test_bump_refuses_a_lower_or_the_same_version_and_writes_nothing(repo):
    snapshot = {p: p.read_bytes() for p in repo.rglob("*") if p.is_file()}
    for value in ("0.0.1", papeer.__version__, "1.0"):
        with pytest.raises(VersionError):
            bump(value, root=repo, out=io.StringIO())
    assert {p: p.read_bytes() for p in repo.rglob("*") if p.is_file()} == snapshot


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_bump_needs_changelog_entries(repo, newline):
    log = "# 変更履歴\n\n## [Unreleased]\n\n[Unreleased]: https://github.com/o/r/commits/main\n"
    (repo / CHANGELOG).write_bytes(log.replace("\n", newline).encode("utf-8"))
    with pytest.raises(VersionError, match="空"):
        bump("9.0.0", root=repo, out=io.StringIO())
    assert read_versions(repo)["pyproject.toml"] == papeer.__version__


def test_bump_fixes_a_manifest_that_fell_behind(repo):
    path = repo / "frontend/src-tauri/tauri.conf.json"
    path.write_bytes(path.read_bytes().replace(f'"version": "{papeer.__version__}"'.encode(), b'"version": "0.0.1"'))
    out = io.StringIO()
    assert not check(repo, out=out)
    assert "0.0.1        frontend/src-tauri/tauri.conf.json" in out.getvalue()
    bump("9.0.0", root=repo, out=io.StringIO())
    assert set(read_versions(repo).values()) == {"9.0.0"}


def test_a_missing_version_line_is_reported(repo):
    path = repo / "papeer/__init__.py"
    path.write_text("\"\"\"No version here.\"\"\"\n", encoding="utf-8")
    with pytest.raises(VersionError, match="papeer/__init__.py"):
        read_versions(repo)


def test_later_releases_link_to_the_comparison():
    log = ("# 変更履歴\n\n## [Unreleased]\n\n### Fixed\n\n- 直した。\n\n## [0.3.0] - 2026-10-01\n\n### Added\n\n- 足した。\n\n"
           "[Unreleased]: https://github.com/o/r/compare/v0.3.0...HEAD\n"
           "[0.3.0]: https://github.com/o/r/releases/tag/v0.3.0\n")
    cut = cut_changelog(log, "0.3.1", date(2026, 11, 2))
    assert "## [Unreleased]\n\n## [0.3.1] - 2026-11-02\n\n### Fixed\n\n- 直した。\n\n## [0.3.0]" in cut
    assert cut.endswith("[Unreleased]: https://github.com/o/r/compare/v0.3.1...HEAD\n"
                        "[0.3.1]: https://github.com/o/r/compare/v0.3.0...v0.3.1\n"
                        "[0.3.0]: https://github.com/o/r/releases/tag/v0.3.0\n")
    assert release_notes(cut, "0.3.1") == "### Fixed\n\n- 直した。\n"
    assert release_notes(cut, "0.3.0") == "### Added\n\n- 足した。\n"
    with pytest.raises(VersionError):
        release_notes(cut, "0.2.0")
    with pytest.raises(VersionError, match="すでに"):
        cut_changelog(cut, "0.3.1", date(2026, 11, 3))
    # A CHANGELOG saved with CRLF is cut the same way and keeps CRLF.
    crlf = cut_changelog(log.replace("\n", "\r\n"), "0.3.1", date(2026, 11, 2))
    assert crlf == cut.replace("\n", "\r\n")
    assert release_notes(crlf, "0.3.1") == "### Fixed\n\n- 直した。\n"


def test_cli_check_compares_with_the_tag(capsys):
    assert main(["--check"]) == 0
    assert main(["--check", papeer.__version__]) == 0
    assert main(["--check", "99.0.0"]) == 1
    assert "99.0.0" in capsys.readouterr().out


def test_release_workflow_builds_on_version_tags():
    yaml = pytest.importorskip("yaml")
    workflow = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    # PyYAML reads the bare key `on` as True.
    # By hand: the installers of a branch as the run's artifacts, without a release.
    assert workflow[True] == {"push": {"tags": ["v*"]}, "workflow_dispatch": None}
    assert workflow["permissions"] == {"contents": "read"}
    build, release = workflow["jobs"]["build"], workflow["jobs"]["release"]
    assert build["runs-on"] == "${{ matrix.os }}" and build["permissions"] == {"contents": "read"}
    # Windows, both Macs (one disk image each: no universal sidecar) and Linux (.deb only).
    rows = {row["name"]: (row["os"], row["installers"]) for row in build["strategy"]["matrix"]["include"]}
    assert rows == {"windows-x64": ("windows-latest", "nsis/*-setup.exe msi/*.msi"),
                    "macos-arm64": ("macos-latest", "dmg/*.dmg"), "macos-x64": ("macos-15-intel", "dmg/*.dmg"),
                    "linux-x64": ("ubuntu-22.04", "deb/*.deb")}
    # Only the job that creates the release may write, it runs on a tag only, and it runs no project code or
    # setup action.
    assert release["needs"] == "build" and release["permissions"] == {"contents": "write"}
    assert release["if"] == "startsWith(github.ref, 'refs/tags/v')"
    assert [step["uses"].split("@")[0] for step in release["steps"] if "uses" in step] == ["actions/download-artifact"]
    # The Mac app's ad-hoc signatures and the .deb are checked before they are collected.
    scripts = {step.get("name"): step.get("run", "") for step in build["steps"]}
    assert "Signature=adhoc" in scripts["Check the ad-hoc signatures"]
    assert "tools/sign_sidecar.py --verify" in scripts["Check the ad-hoc signatures"]
    assert "papeer-sidecar" in scripts["Check the .deb"] and "papeer-cli" in scripts["Check the .deb"]
    checkout = next(step for step in build["steps"] if step.get("uses", "").startswith("actions/checkout@"))
    assert checkout["with"]["persist-credentials"] is False
    for job in (build, release):
        for step in job["steps"]:
            if "uses" in step:  # Pinned to a full commit SHA.
                assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", step["uses"]), step["uses"]
    build_scripts = "\n".join(step.get("run", "") for step in build["steps"])
    assert "tools/bump_version.py --check" in build_scripts and "just build" in build_scripts
    assert "gh release" in "\n".join(step.get("run", "") for step in release["steps"])


def test_health_reports_the_release_and_the_code_version_separately(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    from sidecar.app import app

    monkeypatch.setenv("PAPEER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PAPEER_DEV_NO_AUTH", "1")
    monkeypatch.setenv("PAPEER_TOKEN", "")
    data = TestClient(app).get("/health").json()
    assert data["version"] == papeer.__version__
    assert re.fullmatch(r"code-sha256-[0-9a-f]{64}", data["code_version"])
    assert app.version == papeer.__version__


def test_a_failed_write_puts_back_the_files_already_written(repo, monkeypatch):
    import tools.bump_version as bump_version

    snapshot = {p: p.read_bytes() for p in repo.rglob("*") if p.is_file()}
    real_write = bump_version.atomic_write_bytes
    calls = []

    def failing_write(path, data):
        calls.append(path)
        if len(calls) == 4:  # CHANGELOG and two manifests are written by then.
            raise PermissionError("locked by an editor")
        real_write(path, data)

    monkeypatch.setattr(bump_version, "atomic_write_bytes", failing_write)
    with pytest.raises(VersionError, match=r"^package.json を書き込めませんでした.*元に戻しました"):
        bump("9.0.0", root=repo, out=io.StringIO())
    assert {p: p.read_bytes() for p in repo.rglob("*") if p.is_file()} == snapshot


def test_a_malformed_version_in_a_file_names_the_file(repo):
    path = repo / "frontend/src-tauri/Cargo.toml"
    path.write_bytes(path.read_bytes().replace(f'version = "{papeer.__version__}"'.encode(), b'version = "0.3"', 1))
    with pytest.raises(VersionError, match="frontend/src-tauri/Cargo.toml"):
        bump("9.0.0", root=repo, out=io.StringIO())


def test_notes_without_a_changelog_is_an_error(tmp_path, monkeypatch, capsys):
    import tools.bump_version as bump_version

    monkeypatch.setattr(bump_version, "ROOT", tmp_path)
    assert main(["--notes", "0.3.0"]) == 1
    assert "CHANGELOG.md がありません" in capsys.readouterr().err


def test_notes_are_written_as_utf8(tmp_path, monkeypatch):
    import tools.bump_version as bump_version

    (tmp_path / CHANGELOG).write_text("# x\n\n## [Unreleased]\n\n## [0.3.0] - 2026-10-01\n\n### Added\n\n- 足した。\n",
                                      encoding="utf-8")
    monkeypatch.setattr(bump_version, "ROOT", tmp_path)
    assert main(["--notes", "0.3.0", "--output", str(tmp_path / "notes.md")]) == 0
    assert (tmp_path / "notes.md").read_bytes().decode("utf-8") == "### Added\n\n- 足した。\n"


def _with_inventory(repo):
    """A copy of the inventory made current for the copied lock files (whatever the repository's state)."""
    from tools.license_inventory import INVENTORY, SOURCE_FILES, refresh_source_hashes

    for relative in SOURCE_FILES:
        (repo / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, repo / relative)
    text = refresh_source_hashes((ROOT / INVENTORY).read_bytes().decode("utf-8"),
                                 {relative: (repo / relative).read_bytes() for relative in SOURCE_FILES})
    (repo / INVENTORY).parent.mkdir(parents=True, exist_ok=True)
    (repo / INVENTORY).write_bytes(text.encode("utf-8"))
    return repo / INVENTORY


def test_bump_keeps_a_current_license_inventory_current(repo):
    from tools.license_inventory import stale_sources

    inventory = _with_inventory(repo)
    before = json.loads(inventory.read_bytes())
    out = io.StringIO()
    bump("9.0.0", root=repo, out=out)
    after = json.loads(inventory.read_bytes())
    assert stale_sources(after, repo) == []
    # Only the hashes of the lock files carrying the version moved; the dependency rows stay as they are.
    moved = {row["path"] for row, old in zip(after["sourceFiles"], before["sourceFiles"]) if row != old}
    assert moved == {"uv.lock", "frontend/src-tauri/Cargo.lock"}
    assert {**after, "sourceFiles": None} == {**before, "sourceFiles": None}
    assert "ハッシュを更新しました" in out.getvalue()


def test_bump_leaves_a_stale_license_inventory_alone(repo):
    inventory = _with_inventory(repo)
    lock = repo / "frontend/pnpm-lock.yaml"
    lock.write_bytes(lock.read_bytes() + b"\n")  # A dependency changed without `just licenses`.
    original = inventory.read_bytes()
    out = io.StringIO()
    bump("9.0.0", root=repo, out=out)
    assert inventory.read_bytes() == original
    assert "just licenses" in out.getvalue()


def test_bump_refreshes_every_platforms_inventory(repo):
    from tools.license_inventory import TARGETS, stale_sources

    inventory = _with_inventory(repo)
    linux = repo / TARGETS["linux-x64"].inventory
    shutil.copy2(inventory, linux)
    out = io.StringIO()
    bump("9.0.0", root=repo, out=out)
    for path in (inventory, linux):
        assert stale_sources(json.loads(path.read_bytes()), repo) == []
    assert out.getvalue().count("ハッシュを更新しました") == 2
